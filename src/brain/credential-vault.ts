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

function commandExists(command: string, platform = process.platform): boolean {
  const probe =
    platform === 'win32'
      ? spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true })
      : spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
          stdio: 'ignore',
        })
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

const DPAPI_ENCRYPT = [
  '$plain=[Console]::In.ReadToEnd();',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($plain);',
  '$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher));',
].join('')

const DPAPI_DECRYPT = [
  '$cipher=[Convert]::FromBase64String([Console]::In.ReadToEnd());',
  '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));',
].join('')

class WindowsDpapiVault implements CredentialVault {
  constructor(
    private readonly file: string,
    private readonly powershell: string,
  ) {}

  status(): CredentialVaultStatus {
    return {
      backend: 'windows-dpapi',
      available: true,
      detail: 'Secrets are encrypted for the current Windows user with DPAPI.',
    }
  }

  private protect(value: string): string {
    const result = spawnSync(
      this.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', DPAPI_ENCRYPT],
      { input: value, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    if (result.status !== 0) throw new Error(`DPAPI encryption failed: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }

  private unprotect(value: string): string {
    const result = spawnSync(
      this.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', DPAPI_DECRYPT],
      { input: value, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    if (result.status !== 0) throw new Error(`DPAPI decryption failed: ${result.stderr.trim()}`)
    return result.stdout
  }

  get(reference: string): string | null {
    const encrypted = parseEncryptedMap(this.file)[reference]
    return encrypted ? this.unprotect(encrypted) : null
  }

  set(reference: string, value: string): void {
    const entries = parseEncryptedMap(this.file)
    entries[reference] = this.protect(value)
    atomicWriteFileSync(this.file, JSON.stringify(entries, null, 2) + '\n')
  }

  delete(reference: string): void {
    const entries = parseEncryptedMap(this.file)
    if (!(reference in entries)) return
    delete entries[reference]
    atomicWriteFileSync(this.file, JSON.stringify(entries, null, 2) + '\n')
  }
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
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    return result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : null
  }
  set(reference: string, value: string): void {
    const result = spawnSync(
      'security',
      ['add-generic-password', '-U', '-s', 'Athena CLI', '-a', reference, '-w', value],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    if (result.status !== 0) throw new Error(`Keychain write failed: ${result.stderr.trim()}`)
  }
  delete(reference: string): void {
    spawnSync('security', ['delete-generic-password', '-s', 'Athena CLI', '-a', reference], {
      stdio: 'ignore',
      windowsHide: true,
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
    })
    return result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : null
  }
  set(reference: string, value: string): void {
    const result = spawnSync(
      'secret-tool',
      ['store', '--label=Athena CLI', 'service', 'athena-cli', 'account', reference],
      { input: value, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    if (result.status !== 0) throw new Error(`Secret Service write failed: ${result.stderr.trim()}`)
  }
  delete(reference: string): void {
    spawnSync('secret-tool', ['clear', 'service', 'athena-cli', 'account', reference], {
      stdio: 'ignore',
      windowsHide: true,
    })
  }
}

export function createCredentialVault(
  paths: BrainPaths,
  platform: NodeJS.Platform = process.platform,
): CredentialVault {
  if (platform === 'win32') {
    const powershell = commandExists('powershell.exe', platform)
      ? 'powershell.exe'
      : commandExists('pwsh.exe', platform)
        ? 'pwsh.exe'
        : null
    return powershell
      ? new WindowsDpapiVault(paths.credentialVaultFile, powershell)
      : new UnavailableVault('PowerShell is unavailable, so Windows DPAPI cannot be used.')
  }
  if (platform === 'darwin') {
    return commandExists('security', platform)
      ? new MacOsKeychainVault()
      : new UnavailableVault('macOS security command is unavailable.')
  }
  if (platform === 'linux') {
    return commandExists('secret-tool', platform)
      ? new LinuxSecretServiceVault()
      : new UnavailableVault('secret-tool is unavailable; install libsecret tools to enable OS-vault storage.')
  }
  return new UnavailableVault(`No credential-vault backend is implemented for ${platform}.`)
}

export function formatCredentialVaultStatus(vault: CredentialVault): string {
  const status = vault.status()
  return `Credential vault: ${status.available ? status.backend : 'unavailable'} — ${status.detail}`
}
