import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import {
  DPAPI_ENCRYPT,
  DPAPI_DECRYPT,
  createCredentialVault,
  createWindowsDpapiVault,
  formatCredentialVaultStatus,
  resetCredentialVaultProbeCache,
  isVaultUndecryptable,
  type CredentialVault,
  type PowerShellRunner,
} from '../../src/brain/credential-vault.js'
import {
  migrateCredentialsToVault,
  resolveApiKey,
  setProviderKey,
  loadCredentials,
  saveCredentials,
  formatAuthStatus,
  CredentialsSchema,
} from '../../src/brain/credentials.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-vault-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-vault-proj-'))
  resetCredentialVaultProbeCache()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  resetCredentialVaultProbeCache()
})

const paths = () => resolveBrainPaths({ cwd: project, homeOverride: home })

/** Stands in for DPAPI: reversible, and (like DPAPI) machine-bound via a salt. */
function fakeDpapiRunner(
  options: { machine?: string; calls?: string[]; encryptOverride?: string } = {},
): PowerShellRunner {
  const machine = options.machine ?? 'machine-a'
  return (executable, script, input) => {
    options.calls?.push(executable)
    if (script === DPAPI_ENCRYPT) {
      if (options.encryptOverride !== undefined) {
        return { status: 0, stdout: options.encryptOverride, stderr: '' }
      }
      return {
        status: 0,
        stdout: Buffer.from(`${machine}:${input}`, 'utf8').toString('base64'),
        stderr: '',
      }
    }
    const decoded = Buffer.from(input, 'base64').toString('utf8')
    const prefix = `${machine}:`
    if (!decoded.startsWith(prefix)) {
      return { status: 1, stdout: '', stderr: 'Key not valid for use in specified state.' }
    }
    return { status: 0, stdout: decoded.slice(prefix.length), stderr: '' }
  }
}

const brokenRunner: PowerShellRunner = () => ({
  status: 1,
  stdout: '',
  stderr: 'Unable to find type [Security.Cryptography.ProtectedData].',
})

/** In-memory vault whose set/get can be made to fail on demand. */
function stubVault(behaviour: {
  available?: boolean
  setThrows?: boolean
  getThrows?: boolean
} = {}): CredentialVault {
  const values = new Map<string, string>()
  return {
    status: () =>
      behaviour.available === false
        ? { backend: 'unavailable', available: false, detail: 'stub vault is unavailable' }
        : { backend: 'linux-secret-service', available: true, detail: 'stub' },
    get: (reference) => {
      if (behaviour.getThrows) throw new Error('stub vault cannot decrypt')
      return values.get(reference) ?? null
    },
    set: (reference, value) => {
      if (behaviour.setThrows) throw new Error('stub vault cannot encrypt')
      values.set(reference, value)
    },
    delete: (reference) => {
      values.delete(reference)
    },
  }
}

// 1. The exact regression: the shipped one-liners referenced a type that Windows
// PowerShell 5.1 does not auto-load. String-level, so it fails on any platform.
describe('DPAPI PowerShell snippets', () => {
  it('load the assemblies that define ProtectedData on both PowerShell editions', () => {
    for (const script of [DPAPI_ENCRYPT, DPAPI_DECRYPT]) {
      expect(script).toContain('Add-Type -AssemblyName')
      expect(script).toContain('System.Security')
      expect(script).toContain('System.Security.Cryptography.ProtectedData')
    }
  })

  it("set \\$ErrorActionPreference='Stop' so failures can never exit 0 with empty stdout", () => {
    expect(DPAPI_ENCRYPT).toContain("$ErrorActionPreference='Stop'")
    expect(DPAPI_DECRYPT).toContain("$ErrorActionPreference='Stop'")
  })

  it('reference ProtectedData only after the assembly load', () => {
    for (const script of [DPAPI_ENCRYPT, DPAPI_DECRYPT]) {
      expect(script.indexOf('Add-Type')).toBeLessThan(
        script.indexOf('[Security.Cryptography.ProtectedData]'),
      )
    }
  })
})

// 2. Interpreter / capability selection.
describe('interpreter selection and capability probe', () => {
  it('prefers pwsh.exe when both interpreters are present', () => {
    const calls: string[] = []
    const vault = createCredentialVault(paths(), 'win32', {
      commandExists: () => true,
      run: fakeDpapiRunner({ calls }),
    })
    expect(vault.status().available).toBe(true)
    expect(calls[0]).toBe('pwsh.exe')
    expect(vault.status().detail).toContain('pwsh.exe')
  })

  it('falls back to powershell.exe when pwsh.exe is absent', () => {
    const calls: string[] = []
    const vault = createCredentialVault(paths(), 'win32', {
      commandExists: (command) => command === 'powershell.exe',
      run: fakeDpapiRunner({ calls }),
    })
    expect(vault.status().available).toBe(true)
    expect(calls).not.toContain('pwsh.exe')
    expect(calls[0]).toBe('powershell.exe')
  })

  it('reports unavailable with the real stderr when DPAPI does not work', () => {
    const vault = createCredentialVault(paths(), 'win32', {
      commandExists: () => true,
      run: brokenRunner,
    })
    const status = vault.status()
    expect(status.available).toBe(false)
    expect(status.detail).toContain('ProtectedData')
    expect(formatCredentialVaultStatus(vault)).toContain('unavailable')
    expect(formatCredentialVaultStatus(vault)).not.toContain('—')
  })

  it('probes at most once per process even across many status calls', () => {
    const calls: string[] = []
    const vault = createCredentialVault(paths(), 'win32', {
      commandExists: () => true,
      run: fakeDpapiRunner({ calls }),
    })
    vault.status()
    vault.status()
    vault.status()
    expect(calls).toHaveLength(2) // one encrypt + one decrypt, total
  })

  it('reports unavailable when no PowerShell exists at all', () => {
    const vault = createCredentialVault(paths(), 'win32', {
      commandExists: () => false,
      run: brokenRunner,
    })
    expect(vault.status().available).toBe(false)
    expect(vault.status().detail).toContain('PowerShell is unavailable')
  })
})

// 3. Silent-empty-blob path: a write that produced nothing must never be persisted.
describe('empty or invalid blobs', () => {
  it('refuses to store an entry when encryption produced no ciphertext', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    const vault = createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      // The probe must still pass, so only the real set() call yields blank output.
      (() => {
        let probed = false
        const good = fakeDpapiRunner()
        return ((executable, script, input) => {
          if (script === DPAPI_ENCRYPT && probed) return { status: 0, stdout: '  ', stderr: '' }
          if (script === DPAPI_DECRYPT) probed = true
          return good(executable, script, input)
        }) as PowerShellRunner
      })(),
    )
    expect(() => vault.set('provider/anthropic', 'sk-secret')).toThrow(/no usable ciphertext/)
    expect(existsSync(p.credentialVaultFile)).toBe(false)
  })

  it('treats a stored empty entry as an error, not as "not configured"', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    writeFileSync(p.credentialVaultFile, JSON.stringify({ 'provider/anthropic': '' }), 'utf8')
    const vault = createWindowsDpapiVault(p.credentialVaultFile, ['powershell.exe'], fakeDpapiRunner())
    let thrown: unknown
    try {
      vault.get('provider/anthropic')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeTruthy()
    expect(isVaultUndecryptable(thrown)).toBe(true)
    expect(vault.get('provider/kimi')).toBeNull() // genuinely absent stays null
  })
})

// 4. Portability: a blob written on machine A must produce an actionable message on B.
describe('cross-machine portability', () => {
  it('gives an actionable re-auth message instead of crashing on a foreign blob', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    const machineA = createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'laptop' }),
    )
    machineA.set('provider/anthropic', 'sk-ant-portable')
    expect(machineA.get('provider/anthropic')).toBe('sk-ant-portable')

    resetCredentialVaultProbeCache()
    const machineB = createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'desktop' }),
    )
    let thrown: unknown
    try {
      machineB.get('provider/anthropic')
    } catch (error) {
      thrown = error
    }
    expect(isVaultUndecryptable(thrown)).toBe(true)
    expect((thrown as Error).message).toContain('different machine')
    expect((thrown as Error).message).toContain('athena auth')
    expect((thrown as Error).message).not.toContain('sk-ant-portable')
  })

  it('resolveApiKey degrades to unresolved plus a warning for a foreign blob', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'laptop' }),
    ).set('provider/anthropic', 'sk-ant-portable')
    resetCredentialVaultProbeCache()
    const machineB = createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'desktop' }),
    )
    const creds = CredentialsSchema.parse({
      providers: { anthropic: { vaultRef: 'provider/anthropic' } },
      activeProvider: 'anthropic',
    })
    const warnings: string[] = []
    expect(resolveApiKey('anthropic', creds, {}, machineB, (m) => warnings.push(m))).toBeNull()
    expect(warnings.join('\n')).toContain('athena auth')
  })

  it('re-running auth on the second machine repairs the entry permanently', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'laptop' }),
    ).set('provider/anthropic', 'sk-ant-old')
    resetCredentialVaultProbeCache()
    const machineB = createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'desktop' }),
    )
    const creds = setProviderKey(p, 'anthropic', 'sk-ant-new', { vault: machineB })
    expect(creds.providers.anthropic).toEqual({ vaultRef: 'provider/anthropic' })
    expect(resolveApiKey('anthropic', creds, {}, machineB)).toEqual({
      key: 'sk-ant-new',
      source: 'vault',
    })
    // And it stays fixed on the next boot, with no re-auth loop.
    expect(resolveApiKey('anthropic', loadCredentials(p), {}, machineB)?.key).toBe('sk-ant-new')
  })

  it('formatAuthStatus names the unreadable state instead of claiming health', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'laptop' }),
    ).set('provider/anthropic', 'sk-ant-secret-value')
    resetCredentialVaultProbeCache()
    const machineB = createWindowsDpapiVault(
      p.credentialVaultFile,
      ['powershell.exe'],
      fakeDpapiRunner({ machine: 'desktop' }),
    )
    const out = formatAuthStatus(
      CredentialsSchema.parse({
        providers: { anthropic: { vaultRef: 'provider/anthropic' } },
        activeProvider: 'anthropic',
      }),
      'anthropic',
      {},
      machineB,
    )
    expect(out).toContain('UNREADABLE')
    expect(out).toContain('athena auth')
    expect(out).not.toContain('sk-ant-secret-value')
  })
})

// 5. The outage itself: migration must never be able to stop the program.
describe('migration is best effort, never a boot precondition', () => {
  it('survives a vault whose set throws, keeps the plaintext key, and warns', () => {
    const p = paths()
    saveCredentials(p, {
      providers: { anthropic: { apiKey: 'sk-ant-legacy' } },
      activeProvider: 'anthropic',
    })
    const before = readFileSync(p.credentialsFile, 'utf8')
    const warnings: string[] = []
    const result = migrateCredentialsToVault(p, loadCredentials(p), stubVault({ setThrows: true }), {
      onWarn: (m) => warnings.push(m),
    })
    expect(result.providers.anthropic).toEqual({ apiKey: 'sk-ant-legacy' })
    expect(readFileSync(p.credentialsFile, 'utf8')).toBe(before) // file untouched
    expect(warnings.join('\n')).toContain('UNENCRYPTED')
    // The key still resolves, which is the whole point: Athena stays usable.
    expect(resolveApiKey('anthropic', result, {})).toEqual({
      key: 'sk-ant-legacy',
      source: 'file',
    })
  })

  it('survives a vault whose status throws', () => {
    const p = paths()
    saveCredentials(p, {
      providers: { anthropic: { apiKey: 'sk-ant-legacy' } },
      activeProvider: 'anthropic',
    })
    const exploding: CredentialVault = {
      status: () => {
        throw new Error('boom')
      },
      get: () => null,
      set: () => {},
      delete: () => {},
    }
    const warnings: string[] = []
    const result = migrateCredentialsToVault(p, loadCredentials(p), exploding, {
      onWarn: (m) => warnings.push(m),
    })
    expect(result.providers.anthropic).toEqual({ apiKey: 'sk-ant-legacy' })
    expect(warnings.join('\n')).toContain('UNENCRYPTED')
  })

  it('survives a totally broken real Windows DPAPI backend', () => {
    const p = paths()
    saveCredentials(p, {
      providers: { anthropic: { apiKey: 'sk-ant-legacy' } },
      activeProvider: 'anthropic',
    })
    const vault = createCredentialVault(p, 'win32', {
      commandExists: () => true,
      run: brokenRunner,
    })
    const warnings: string[] = []
    const result = migrateCredentialsToVault(p, loadCredentials(p), vault, {
      onWarn: (m) => warnings.push(m),
    })
    expect(resolveApiKey('anthropic', result, {}, vault)?.key).toBe('sk-ant-legacy')
    expect(warnings.join('\n')).toContain('UNENCRYPTED')
    expect(existsSync(p.credentialVaultFile)).toBe(false)
  })

  it('never probes the vault when there is nothing to migrate', () => {
    const p = paths()
    const calls: string[] = []
    const vault = createCredentialVault(p, 'win32', {
      commandExists: () => true,
      run: fakeDpapiRunner({ calls }),
    })
    const creds = CredentialsSchema.parse({
      providers: { anthropic: { vaultRef: 'provider/anthropic' } },
      activeProvider: 'anthropic',
    })
    migrateCredentialsToVault(p, creds, vault)
    expect(calls).toHaveLength(0)
  })

  it('does not drop the plaintext key when the vault write cannot be read back', () => {
    const p = paths()
    saveCredentials(p, {
      providers: { anthropic: { apiKey: 'sk-ant-legacy' } },
      activeProvider: 'anthropic',
    })
    const amnesiac: CredentialVault = {
      status: () => ({ backend: 'linux-secret-service', available: true, detail: 'stub' }),
      get: () => null, // write "succeeds" but nothing is readable back
      set: () => {},
      delete: () => {},
    }
    const warnings: string[] = []
    const result = migrateCredentialsToVault(p, loadCredentials(p), amnesiac, {
      onWarn: (m) => warnings.push(m),
    })
    expect(result.providers.anthropic).toEqual({ apiKey: 'sk-ant-legacy' })
    expect(warnings.join('\n')).toContain('read-back')
  })
})

// 6. Fail loudly: the user must always know which storage mode they are in.
describe('plaintext fallback is announced', () => {
  it('warns when setProviderKey stores a key unencrypted because the vault is down', () => {
    const p = paths()
    const warnings: string[] = []
    const creds = setProviderKey(p, 'anthropic', 'sk-ant-plain', {
      vault: stubVault({ available: false }),
      onWarn: (m) => warnings.push(m),
    })
    expect(creds.providers.anthropic).toEqual({ apiKey: 'sk-ant-plain' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('UNENCRYPTED')
    expect(warnings[0]).toContain(p.credentialsFile)
    expect(warnings[0]).not.toContain('sk-ant-plain')
  })

  it('warns when the vault write itself fails', () => {
    const warnings: string[] = []
    const creds = setProviderKey(paths(), 'anthropic', 'sk-ant-plain', {
      vault: stubVault({ setThrows: true }),
      onWarn: (m) => warnings.push(m),
    })
    expect(creds.providers.anthropic).toEqual({ apiKey: 'sk-ant-plain' })
    expect(warnings.join('\n')).toContain('UNENCRYPTED')
  })

  it('stays silent when the vault works', () => {
    const warnings: string[] = []
    const creds = setProviderKey(paths(), 'anthropic', 'sk-ant-plain', {
      vault: stubVault(),
      onWarn: (m) => warnings.push(m),
    })
    expect(creds.providers.anthropic).toEqual({ vaultRef: 'provider/anthropic' })
    expect(warnings).toHaveLength(0)
  })

  it('resolveApiKey never throws when the vault get explodes', () => {
    const creds = CredentialsSchema.parse({
      providers: { anthropic: { vaultRef: 'provider/anthropic' } },
      activeProvider: 'anthropic',
    })
    const warnings: string[] = []
    expect(() =>
      resolveApiKey('anthropic', creds, {}, stubVault({ getThrows: true }), (m) =>
        warnings.push(m),
      ),
    ).not.toThrow()
    expect(warnings.join('\n')).toContain('cannot decrypt')
  })
})

// 7. The only test that can catch a PowerShell-version dependency: actually shell out.
describe.runIf(process.platform === 'win32')('real Windows DPAPI round trip', () => {
  it('encrypts and decrypts a sentinel through the shipped snippets', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    const vault = createCredentialVault(p, 'win32')
    const status = vault.status()
    expect(status.available).toBe(true)
    expect(status.backend).toBe('windows-dpapi')
    const sentinel = 'athena-test-sentinel-not-a-real-key'
    vault.set('provider/anthropic', sentinel)
    expect(readFileSync(p.credentialVaultFile, 'utf8')).not.toContain(sentinel)
    expect(vault.get('provider/anthropic')).toBe(sentinel)
    vault.delete('provider/anthropic')
    expect(vault.get('provider/anthropic')).toBeNull()
  }, 60_000)
})
