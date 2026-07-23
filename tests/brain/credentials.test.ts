import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import {
  loadCredentials,
  saveCredentials,
  setProviderKey,
  resolveApiKey,
  redactKey,
  CredentialsSchema,
} from '../../src/brain/credentials.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-proj-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

const paths = () => resolveBrainPaths({ cwd: project, homeOverride: home })

describe('credentials load/save', () => {
  it('paths expose credentialsFile under the brain dir', () => {
    expect(paths().credentialsFile).toBe(join(home, '.athena', 'credentials.json'))
  })

  it('missing file loads schema defaults (no providers, anthropic active)', () => {
    const creds = loadCredentials(paths())
    expect(creds.providers).toEqual({})
    expect(creds.activeProvider).toBe('anthropic')
  })

  it('save + load round-trips and setProviderKey updates activeProvider', () => {
    const p = paths()
    saveCredentials(p, {
      providers: { anthropic: { apiKey: 'sk-ant-file-key' } },
      activeProvider: 'anthropic',
    })
    expect(loadCredentials(p).providers.anthropic?.apiKey).toBe('sk-ant-file-key')

    const next = setProviderKey(p, 'kimi', 'sk-kimi-key')
    expect(next.activeProvider).toBe('kimi')
    expect(next.providers.anthropic?.apiKey).toBe('sk-ant-file-key') // merged, not replaced
    expect(loadCredentials(p).providers.kimi?.apiKey).toBe('sk-kimi-key')
    expect(existsSync(p.credentialsFile)).toBe(true)
  })

  it('applies 0o600 on POSIX (best-effort no-op on Windows)', () => {
    const p = paths()
    setProviderKey(p, 'anthropic', 'sk-ant-x')
    if (process.platform !== 'win32') {
      expect(statSync(p.credentialsFile).mode & 0o777).toBe(0o600)
    } else {
      expect(existsSync(p.credentialsFile)).toBe(true)
    }
  })

  it('malformed JSON throws an actionable error naming the file and athena auth', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(p.credentialsFile, '{ not json', 'utf8')
    expect(() => loadCredentials(p)).toThrow(/credentials\.json/)
    expect(() => loadCredentials(p)).toThrow(/athena auth/)
  })

  it('unknown providers are rejected with a clear error', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      p.credentialsFile,
      JSON.stringify({ providers: { openai: { apiKey: 'x' } }, activeProvider: 'anthropic' }),
      'utf8',
    )
    expect(() => loadCredentials(p)).toThrow(/openai/)
    expect(() => loadCredentials(p)).toThrow(/athena auth/)
  })

  it('setProviderKey regenerates over a malformed file instead of throwing', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(p.credentialsFile, '{ not json', 'utf8')
    const creds = setProviderKey(p, 'anthropic', 'sk-ant-new')
    expect(creds.providers.anthropic?.apiKey).toBe('sk-ant-new')
    expect(loadCredentials(p).activeProvider).toBe('anthropic')
  })

  it('setProviderKey rethrows I/O errors (credentialsFile is a directory)', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    mkdirSync(p.credentialsFile) // credentialsFile is now a directory, not a file
    expect(() => setProviderKey(p, 'anthropic', 'sk-ant-x')).toThrow()
  })

  it('loadCredentials rejects unknown top-level keys (typo in activeProvider)', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      p.credentialsFile,
      JSON.stringify({ activProvider: 'kimi', providers: {} }),
      'utf8',
    )
    expect(() => loadCredentials(p)).toThrow(/activProvider/)
    expect(() => loadCredentials(p)).toThrow(/athena auth/)
  })
})

describe('resolveApiKey (env over file, per provider)', () => {
  const creds = CredentialsSchema.parse({
    providers: { anthropic: { apiKey: 'sk-ant-from-file' }, kimi: { apiKey: 'sk-kimi-from-file' } },
    activeProvider: 'anthropic',
  })

  it('env var wins over the file, per provider', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-from-env' }
    expect(resolveApiKey('anthropic', creds, env)).toEqual({ key: 'sk-ant-from-env', source: 'env' })
    expect(resolveApiKey('kimi', creds, env)).toEqual({ key: 'sk-kimi-from-file', source: 'file' })
  })

  it('falls back to the file, and to null when neither exists', () => {
    expect(resolveApiKey('anthropic', creds, {})).toEqual({ key: 'sk-ant-from-file', source: 'file' })
    expect(resolveApiKey('kimi', CredentialsSchema.parse({}), {})).toBeNull()
  })

  it('MOONSHOT_API_KEY is the kimi env var', () => {
    expect(resolveApiKey('kimi', creds, { MOONSHOT_API_KEY: 'sk-kimi-env' })).toEqual({
      key: 'sk-kimi-env',
      source: 'env',
    })
  })
})

describe('redactKey', () => {
  it('keeps only prefix and last 4 chars', () => {
    expect(redactKey('sk-ant-api03-abcdefabc4')).toBe('sk-ant...abc4')
  })
  it('never leaks short keys', () => {
    expect(redactKey('short')).toBe('***')
    expect(redactKey('')).toBe('***')
  })
  it('boundary: length 17 collapses to ***', () => {
    expect(redactKey('12345678901234567')).toBe('***')
  })
  it('boundary: length 18 shows redacted form', () => {
    expect(redactKey('123456789012345678')).toBe('123456...5678')
  })
})
