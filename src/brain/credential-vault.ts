import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { BrainPaths } from './paths.js'
import { atomicWriteFileSync } from '../tools/files.js'

export interface CredentialVaultStatus {
  backend: 'windows-dpapi' | 'macos-keychain' | 'linux-secret-service' | 'unavailable'
  available: boolean
  detail: string
}

export interface CredentialVault {
  status(): CredentialVaultStatus
  get(reference: string): string | null
  set(reference: string, value: string): void
  delete(reference: string): void
}

/** Thrown when a stored blob exists but cannot be turned back into a secret. The
 *  overwhelmingly common cause is a vault file carried between machines or Windows
 *  user accounts: DPAPI CurrentUser blobs are bound to user+machine and are simply
 *  not decryptable elsewhere. Callers must treat this as "re-run `athena auth`",
 *  never as a crash and never as "not configured". */
export const VAULT_UNDECRYPTABLE = 'ATHENA_VAULT_UNDECRYPTABLE'

/** Every vault backend reaches the OS through a SYNCHRONOUS spawn, so a stalled helper
 *  (AMSI/antivirus scanning a PowerShell invocation, a `secret-tool` waiting on a dead
 *  D-Bus session, a keychain prompt with no one to answer it) blocks the entire process
 *  — including boot — with no recovery and no way to Ctrl-C out of it. Five seconds is
 *  far beyond any healthy DPAPI/keychain round trip, so exceeding it means "the backend
 *  is not answering", which the callers already know how to degrade from. */
export const VAULT_SPAWN_TIMEOUT_MS = 5_000

/** Interpreter stderr is multi-line and noisy; the user needs one readable sentence. */
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/** A spawnSync timeout does NOT look like a failed command: Node leaves `status` null,
 *  sets `signal` to the kill signal and reports the timeout only through `error.code`
 *  ('ETIMEDOUT'). It also leaves `stdout`/`stderr` null rather than '', so any check that
 *  reads `result.stderr.trim()` throws a TypeError instead of degrading. Both shapes are
 *  normalised here so callers can keep using their existing status checks. */
function spawnTimedOut(result: { error?: Error }): boolean {
  return (result.error as { code?: string } | undefined)?.code === 'ETIMEDOUT'
}

/** Non-null stderr, with the spawn-level failure (timeout, ENOENT) folded in — spawnSync
 *  reports those through `error`, never through the child's stderr. */
function spawnStderr(result: { error?: Error; stderr?: string | null }): string {
  const own = result.stderr ?? ''
  if (!result.error) return own
  const reason = spawnTimedOut(result)
    ? `the credential vault did not respond within ${VAULT_SPAWN_TIMEOUT_MS}ms and is being treated as unavailable`
    : result.error.message
  return own ? `${own}; ${reason}` : reason
}

export function vaultUndecryptableError(reference: string, rawDetail: string): Error {
  const detail = firstLine(rawDetail)
  return Object.assign(
    new Error(
      `The OS credential vault could not decrypt the stored secret for ${reference}. ` +
        `It was most likely encrypted on a different machine or user account. ` +
        `Run \`athena auth\` to re-enter the key on this machine (once, permanently).` +
        (detail ? ` [${detail}]` : ''),
    ),
    { code: VAULT_UNDECRYPTABLE },
  )
}

export function isVaultUndecryptable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === VAULT_UNDECRYPTABLE
}

function commandExists(command: string, platform = process.platform): boolean {
  const probe =
    platform === 'win32'
      ? spawnSync('where.exe', [command], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: VAULT_SPAWN_TIMEOUT_MS,
        })
      : spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
          stdio: 'ignore',
          timeout: VAULT_SPAWN_TIMEOUT_MS,
        })
  // A timeout leaves status null, so this already reads as "not present" -> the caller
  // builds an UnavailableVault and the whole run degrades to the plaintext path.
  return probe.status === 0
}

class UnavailableVault implements CredentialVault {
  constructor(private readonly detail: string) {}
  status(): CredentialVaultStatus {
    return { backend: 'unavailable', available: false, detail: this.detail }
  }
  get(): string | null {
    return null
  }
  set(): void {
    throw new Error(this.detail)
  }
  delete(): void {}
}

function parseEncryptedMap(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected object')
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
        if (typeof value !== 'string') throw new Error(`invalid entry ${key}`)
        return [key, value]
      }),
    )
  } catch (error) {
    throw new Error(`Invalid DPAPI vault ${file}: ${(error as Error).message}`)
  }
}

// Windows PowerShell 5.1 (desktop CLR) does NOT auto-load System.Security.dll, which is
// where [Security.Cryptography.ProtectedData] lives; PowerShell 7 (.NET) ships it as
// System.Security.Cryptography.ProtectedData instead. Loading BOTH names best-effort and
// swallowing the miss makes the snippet portable across every shipped PowerShell. The
// `Stop` preference then guarantees any residual failure is terminating, so we can never
// get the "exit 0 with empty stdout" shape that silently persists an unreadable blob.
const DPAPI_PRELUDE = [
  "$ErrorActionPreference='Stop';",
  "foreach($a in 'System.Security','System.Security.Cryptography.ProtectedData')",
  '{try{Add-Type -AssemblyName $a -ErrorAction Stop}catch{}}',
  ';',
].join('')

export const DPAPI_ENCRYPT = [
  DPAPI_PRELUDE,
  '$plain=[Console]::In.ReadToEnd();',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($plain);',
  '$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher));',
].join('')

export const DPAPI_DECRYPT = [
  DPAPI_PRELUDE,
  '$cipher=[Convert]::FromBase64String([Console]::In.ReadToEnd());',
  '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));',
].join('')

export interface PowerShellResult {
  status: number | null
  stdout: string
  stderr: string
  /** The interpreter never answered (see VAULT_SPAWN_TIMEOUT_MS). Distinct from a normal
   *  non-zero exit because it says nothing about the stored blob: a stall is transient and
   *  must never be cached as a verdict, nor reported as "encrypted on another machine". */
  timedOut?: boolean
}

/** Injectable so the vault's own logic is testable without spawning a real shell. */
export type PowerShellRunner = (
  executable: string,
  script: string,
  input: string,
) => PowerShellResult

const spawnPowerShell: PowerShellRunner = (executable, script, input) => {
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: VAULT_SPAWN_TIMEOUT_MS,
  })
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: spawnStderr(result),
    timedOut: spawnTimedOut(result),
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function looksLikeBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64.test(value)
}

type ProbeOutcome = { ok: true; executable: string } | { ok: false; detail: string }

/** Process-lifetime cache: a capability probe costs two PowerShell spawns, so it runs at
 *  most once per interpreter set per process, no matter how many vault instances exist. */
const probeCache = new Map<string, ProbeOutcome>()

/** Test seam only: forget the cached capability probe. */
export function resetCredentialVaultProbeCache(): void {
  probeCache.clear()
}

const PROBE_SENTINEL = 'athena-dpapi-probe'

class WindowsDpapiVault implements CredentialVault {
  constructor(
    private readonly file: string,
    /** In preference order. pwsh.exe (PowerShell 7) first, powershell.exe (5.1) second;
     *  whichever actually passes the round-trip probe is the one that gets used. */
    private readonly candidates: string[],
    private readonly run: PowerShellRunner = spawnPowerShell,
  ) {}

  /** Lazy + cached. Never called unless something actually needs the vault, so a boot
   *  that has nothing to migrate and nothing to decrypt pays zero PowerShell spawns. */
  private probe(): ProbeOutcome {
    const key = this.candidates.join('|')
    const cached = probeCache.get(key)
    if (cached) return cached
    const failures: string[] = []
    // A stall is a property of the moment, not of the machine, so a probe that only
    // failed because an interpreter timed out is answered but NOT cached: the next call
    // in this process gets a real attempt instead of a permanently poisoned verdict.
    let transient = false
    let outcome: ProbeOutcome = {
      ok: false,
      detail: 'No PowerShell interpreter is available for Windows DPAPI.',
    }
    for (const executable of this.candidates) {
      const encrypted = this.run(executable, DPAPI_ENCRYPT, PROBE_SENTINEL)
      if (encrypted.status !== 0 || !looksLikeBase64(encrypted.stdout.trim())) {
        transient ||= encrypted.timedOut === true
        failures.push(
          `${executable}: ${firstLine(encrypted.stderr) || 'encryption produced no output'}`,
        )
        continue
      }
      const decrypted = this.run(executable, DPAPI_DECRYPT, encrypted.stdout.trim())
      if (decrypted.status !== 0 || decrypted.stdout !== PROBE_SENTINEL) {
        transient ||= decrypted.timedOut === true
        failures.push(
          `${executable}: ${firstLine(decrypted.stderr) || 'decryption round trip mismatch'}`,
        )
        continue
      }
      outcome = { ok: true, executable }
      break
    }
    if (!outcome.ok && failures.length > 0) {
      outcome = { ok: false, detail: `Windows DPAPI is not usable. ${failures.join('; ')}` }
    }
    if (!transient) probeCache.set(key, outcome)
    return outcome
  }

  status(): CredentialVaultStatus {
    const probe = this.probe()
    if (!probe.ok) return { backend: 'unavailable', available: false, detail: probe.detail }
    return {
      backend: 'windows-dpapi',
      available: true,
      detail: `Secrets are encrypted for the current Windows user with DPAPI via ${probe.executable}.`,
    }
  }

  private executable(): string {
    const probe = this.probe()
    if (!probe.ok) throw new Error(probe.detail)
    return probe.executable
  }

  private protect(value: string): string {
    const result = this.run(this.executable(), DPAPI_ENCRYPT, value)
    if (result.timedOut) throw new Error(firstLine(result.stderr))
    if (result.status !== 0) throw new Error(`DPAPI encryption failed: ${firstLine(result.stderr)}`)
    const cipher = result.stdout.trim()
    // Exit 0 with blank/garbage stdout must NOT be persisted: storing "" is silent key
    // destruction, because a later read cannot tell it from "never configured".
    if (!looksLikeBase64(cipher)) {
      throw new Error(
        `DPAPI encryption produced no usable ciphertext${firstLine(result.stderr) ? `: ${firstLine(result.stderr)}` : '.'}`,
      )
    }
    return cipher
  }

  private unprotect(value: string, reference: string): string {
    const result = this.run(this.executable(), DPAPI_DECRYPT, value)
    // A stall says nothing about the blob, so it must NOT be reported as undecryptable:
    // that message tells the user to re-enter a key that is very likely still fine. Plain
    // Error instead, which every caller (resolveApiKey/formatAuthStatus/setProviderKey/
    // migrateCredentialsToVault) already routes into its non-fatal warn-and-degrade path.
    if (result.timedOut) throw new Error(firstLine(result.stderr))
    if (result.status !== 0) throw vaultUndecryptableError(reference, result.stderr.trim())
    return result.stdout
  }

  get(reference: string): string | null {
    const entries = parseEncryptedMap(this.file)
    if (!(reference in entries)) return null
    const encrypted = entries[reference] ?? ''
    if (!looksLikeBase64(encrypted.trim())) {
      throw vaultUndecryptableError(reference, 'the stored entry is empty or not valid Base64')
    }
    return this.unprotect(encrypted.trim(), reference)
  }

  set(reference: string, value: string): void {
    const entries = parseEncryptedMap(this.file)
    const cipher = this.protect(value)
    // Read-back before persisting: a partially working backend must never be able to
    // leave an entry on disk that cannot be turned back into the original secret.
    if (this.unprotect(cipher, reference) !== value) {
      throw new Error('DPAPI round trip did not return the original secret; refusing to store it.')
    }
    entries[reference] = cipher
    atomicWriteFileSync(this.file, JSON.stringify(entries, null, 2) + '\n')
  }

  delete(reference: string): void {
    const entries = parseEncryptedMap(this.file)
    if (!(reference in entries)) return
    delete entries[reference]
    atomicWriteFileSync(this.file, JSON.stringify(entries, null, 2) + '\n')
  }
}

/** Test seam: build a Windows vault with an injected runner and interpreter list. */
export function createWindowsDpapiVault(
  file: string,
  candidates: string[],
  run?: PowerShellRunner,
): CredentialVault {
  return new WindowsDpapiVault(file, candidates, run)
}

class MacOsKeychainVault implements CredentialVault {
  status(): CredentialVaultStatus {
    return {
      backend: 'macos-keychain',
      available: true,
      detail: 'Secrets are stored in the user login keychain.',
    }
  }
  get(reference: string): string | null {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', 'Athena CLI', '-a', reference, '-w'],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: VAULT_SPAWN_TIMEOUT_MS,
      },
    )
    // A timeout leaves status null and stdout null, so this reads as "no entry" — the
    // same non-fatal shape as a genuine miss, which resolveApiKey already degrades from.
    return result.status === 0 ? (result.stdout ?? '').replace(/\r?\n$/, '') : null
  }
  set(reference: string, value: string): void {
    const result = spawnSync(
      'security',
      ['add-generic-password', '-U', '-s', 'Athena CLI', '-a', reference, '-w', value],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: VAULT_SPAWN_TIMEOUT_MS,
      },
    )
    // spawnStderr, not result.stderr.trim(): on a timeout stderr is null, so the old form
    // threw a bare TypeError instead of the actionable "vault unavailable" message that
    // setProviderKey/migrateCredentialsToVault turn into a plaintext-fallback warning.
    if (result.status !== 0) throw new Error(`Keychain write failed: ${spawnStderr(result).trim()}`)
  }
  delete(reference: string): void {
    spawnSync('security', ['delete-generic-password', '-s', 'Athena CLI', '-a', reference], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: VAULT_SPAWN_TIMEOUT_MS,
    })
  }
}

class LinuxSecretServiceVault implements CredentialVault {
  status(): CredentialVaultStatus {
    return {
      backend: 'linux-secret-service',
      available: true,
      detail: 'Secrets are stored through Secret Service/libsecret.',
    }
  }
  get(reference: string): string | null {
    const result = spawnSync('secret-tool', ['lookup', 'service', 'athena-cli', 'account', reference], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      // A dead/absent D-Bus session makes secret-tool block forever rather than exit.
      timeout: VAULT_SPAWN_TIMEOUT_MS,
    })
    // Timeout -> status null, stdout null: reads as "no entry", the existing non-fatal miss.
    return result.status === 0 ? (result.stdout ?? '').replace(/\r?\n$/, '') : null
  }
  set(reference: string, value: string): void {
    const result = spawnSync(
      'secret-tool',
      ['store', '--label=Athena CLI', 'service', 'athena-cli', 'account', reference],
      {
        input: value,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: VAULT_SPAWN_TIMEOUT_MS,
      },
    )
    // spawnStderr, not result.stderr.trim(): stderr is null on a timeout, so the old form
    // threw a bare TypeError instead of the degrade-to-plaintext warning callers expect.
    if (result.status !== 0)
      throw new Error(`Secret Service write failed: ${spawnStderr(result).trim()}`)
  }
  delete(reference: string): void {
    spawnSync('secret-tool', ['clear', 'service', 'athena-cli', 'account', reference], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: VAULT_SPAWN_TIMEOUT_MS,
    })
  }
}

export interface CredentialVaultOptions {
  /** Test seams. */
  commandExists?: (command: string, platform: NodeJS.Platform) => boolean
  run?: PowerShellRunner
}

export function createCredentialVault(
  paths: BrainPaths,
  platform: NodeJS.Platform = process.platform,
  options: CredentialVaultOptions = {},
): CredentialVault {
  const exists = options.commandExists ?? commandExists
  if (platform === 'win32') {
    // PowerShell 7 first: it is the better-maintained runtime. 5.1 is the universal
    // fallback and, with the prelude above, works too. The probe decides, not the order.
    const candidates = ['pwsh.exe', 'powershell.exe'].filter((c) => exists(c, platform))
    return candidates.length > 0
      ? new WindowsDpapiVault(paths.credentialVaultFile, candidates, options.run)
      : new UnavailableVault('PowerShell is unavailable, so Windows DPAPI cannot be used.')
  }
  if (platform === 'darwin') {
    return exists('security', platform)
      ? new MacOsKeychainVault()
      : new UnavailableVault('macOS security command is unavailable.')
  }
  if (platform === 'linux') {
    return exists('secret-tool', platform)
      ? new LinuxSecretServiceVault()
      : new UnavailableVault('secret-tool is unavailable; install libsecret tools to enable OS-vault storage.')
  }
  return new UnavailableVault(`No credential-vault backend is implemented for ${platform}.`)
}

export function formatCredentialVaultStatus(vault: CredentialVault): string {
  const status = vault.status()
  return `Credential vault: ${status.available ? status.backend : 'unavailable'} - ${status.detail}`
}
