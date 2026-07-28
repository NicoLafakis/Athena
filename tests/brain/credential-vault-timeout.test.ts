// tests/brain/credential-vault-timeout.test.ts — every vault backend talks to the OS with
// a SYNCHRONOUS spawn, so a stalled helper would otherwise block boot forever. These tests
// pin the timeout shape Node actually produces (status null, stdout/stderr null, only
// `error.code === 'ETIMEDOUT'` naming the cause) and assert it degrades rather than throws.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync }))

const { resolveBrainPaths } = await import('../../src/brain/paths.js')
const {
  createCredentialVault,
  resetCredentialVaultProbeCache,
  isVaultUndecryptable,
  VAULT_SPAWN_TIMEOUT_MS,
} = await import('../../src/brain/credential-vault.js')
const { resolveApiKey, CredentialsSchema } = await import('../../src/brain/credentials.js')

/** Exactly what spawnSync returns when `timeout` fires: the child is killed, so there is
 *  no exit code and no captured output — only `error`. Code that reads `result.stderr`
 *  without a null guard throws a TypeError on this shape. */
function timeoutResult() {
  return {
    status: null,
    signal: 'SIGTERM' as const,
    stdout: null,
    stderr: null,
    pid: 1,
    output: [],
    error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  }
}

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-vault-timeout-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-vault-timeout-proj-'))
  spawnSync.mockReset()
  spawnSync.mockImplementation(() => timeoutResult())
  resetCredentialVaultProbeCache()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  resetCredentialVaultProbeCache()
})

const paths = () => resolveBrainPaths({ cwd: project, homeOverride: home })
const alwaysPresent = () => true

describe('credential vault — spawn timeouts', () => {
  it('passes the shared timeout to every spawn instead of blocking forever', () => {
    createCredentialVault(paths(), 'darwin', { commandExists: alwaysPresent }).get('provider/kimi')
    expect(spawnSync).toHaveBeenCalled()
    for (const call of spawnSync.mock.calls) {
      expect(call[2]).toMatchObject({ timeout: VAULT_SPAWN_TIMEOUT_MS })
    }
  })

  it('macOS keychain: a timed-out read degrades to "no entry", not a throw', () => {
    const vault = createCredentialVault(paths(), 'darwin', { commandExists: alwaysPresent })
    expect(vault.get('provider/kimi')).toBeNull()
    expect(() => vault.delete('provider/kimi')).not.toThrow()
  })

  it('macOS keychain: a timed-out write reports the timeout (not a TypeError on null stderr)', () => {
    const vault = createCredentialVault(paths(), 'darwin', { commandExists: alwaysPresent })
    // setProviderKey/migrateCredentialsToVault catch this and warn "stored UNENCRYPTED";
    // a TypeError from `null.trim()` would escape that contract as a crash.
    expect(() => vault.set('provider/kimi', 'secret-value')).toThrowError(
      new RegExp(`did not respond within ${VAULT_SPAWN_TIMEOUT_MS}ms`),
    )
    expect(() => vault.set('provider/kimi', 'secret-value')).not.toThrowError(TypeError)
  })

  it('Linux secret service: a timed-out lookup degrades to "no entry"', () => {
    const vault = createCredentialVault(paths(), 'linux', { commandExists: alwaysPresent })
    expect(vault.get('provider/kimi')).toBeNull()
    expect(() => vault.set('provider/kimi', 'secret-value')).toThrowError(
      /Secret Service write failed/,
    )
  })

  it('Windows DPAPI: a timed-out probe reports the vault unavailable', () => {
    const status = createCredentialVault(paths(), 'win32', {
      commandExists: alwaysPresent,
    }).status()
    expect(status.available).toBe(false)
    expect(status.backend).toBe('unavailable')
    expect(status.detail).toContain('did not respond within')
  })

  it('Windows DPAPI: a timeout is never cached as a verdict (stalls are transient)', () => {
    const vault = createCredentialVault(paths(), 'win32', { commandExists: alwaysPresent })
    expect(vault.status().available).toBe(false)
    const afterFirst = spawnSync.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    // A cached "unavailable" would make the second probe cost zero spawns and lock the
    // process out of a vault that is fine again a second later.
    expect(vault.status().available).toBe(false)
    expect(spawnSync.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('Windows DPAPI: a timed-out read warns and resolves as no key, and is NOT "undecryptable"', () => {
    const p = paths()
    mkdirSync(dirname(p.credentialVaultFile), { recursive: true })
    writeFileSync(
      p.credentialVaultFile,
      JSON.stringify({ 'provider/kimi': Buffer.from('blob').toString('base64') }) + '\n',
    )
    const vault = createCredentialVault(p, 'win32', { commandExists: alwaysPresent })

    let thrown: unknown
    try {
      vault.get('provider/kimi')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    // Reporting a stall as "encrypted on another machine" would tell the user to replace a
    // key that is almost certainly still valid.
    expect(isVaultUndecryptable(thrown)).toBe(false)

    const warnings: string[] = []
    const resolved = resolveApiKey(
      'kimi',
      CredentialsSchema.parse({ providers: { kimi: { vaultRef: 'provider/kimi' } } }),
      {},
      vault,
      (message) => warnings.push(message),
    )
    expect(resolved).toBeNull()
    expect(warnings.join('\n')).toContain('did not respond within')
  })
})
