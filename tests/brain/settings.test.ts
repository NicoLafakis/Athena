import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { loadSettings, SettingsSchema, makeSettingsSchema } from '../../src/brain/settings.js'

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

describe('loadSettings', () => {
  it('returns schema defaults when no settings.json exists', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const s = loadSettings(paths)
    expect(s.model).toBe(SettingsSchema.parse({}).model)
    expect(s.permissionMode).toBe('normal')
    expect(s.allow).toEqual([])
  })

  it('defaults model to sonnet and effort to high; normalizes a legacy model id', () => {
    expect(SettingsSchema.parse({}).model).toBe('sonnet')
    expect(SettingsSchema.parse({}).effort).toBe('high')
    expect(SettingsSchema.parse({ model: 'claude-opus-4-8' }).model).toBe('opus')
  })

  it('project settings override global scalars and concatenate rule arrays', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'),
      JSON.stringify({ model: 'haiku', allow: ['Read(**)'] }))
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(join(project, '.athena', 'settings.json'),
      JSON.stringify({ model: 'opus', allow: ['Bash(git:*)'] }))
    const s = loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(s.model).toBe('opus')
    expect(s.allow).toEqual(['Read(**)', 'Bash(git:*)'])
  })

  it('rule/hook arrays are always defined and never aliased across loads', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'),
      JSON.stringify({ allow: ['Read(**)'], hooks: [{ event: 'Stop', command: 'echo hi' }] }))
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const s1 = loadSettings(paths)
    const s2 = loadSettings(paths)
    expect(s1.allow).toBeDefined()
    expect(s1.deny).toEqual([])
    expect(s1.hooks).toHaveLength(1)
    s1.allow.push('Bash(rm:*)')
    s1.deny.push('Edit(**)')
    s1.hooks[0]!.command = 'mutated'
    expect(s2.allow).toEqual(['Read(**)'])
    expect(s2.deny).toEqual([])
    expect(s2.hooks[0]!.command).toBe('echo hi')
  })

  it('schema defaults do not alias arrays between parses', () => {
    const d1 = SettingsSchema.parse({})
    const d2 = SettingsSchema.parse({})
    d1.allow.push('X')
    d1.deny.push('Y')
    d1.hooks.push({ event: 'Stop', command: 'z', timeoutMs: 1 })
    expect(d2.allow).toEqual([])
    expect(d2.deny).toEqual([])
    expect(d2.hooks).toEqual([])
  })

  it('defaults mcpServers to an empty object and fills per-server arg/env defaults', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    expect(loadSettings(paths).mcpServers).toEqual({})

    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      join(home, '.athena', 'settings.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'node' } } }),
    )
    const s = loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(s.mcpServers['fs']).toEqual({ command: 'node', args: [], env: {} })
  })

  it('project mcpServers wins wholesale over global', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      join(home, '.athena', 'settings.json'),
      JSON.stringify({ mcpServers: { a: { command: 'global-a' } } }),
    )
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(
      join(project, '.athena', 'settings.json'),
      JSON.stringify({ mcpServers: { b: { command: 'project-b' } } }),
    )
    const s = loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(Object.keys(s.mcpServers)).toEqual(['b']) // global 'a' replaced, not merged
    expect(s.mcpServers['b']!.command).toBe('project-b')
  })

  it('throws a readable error on invalid settings', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ permissionMode: 'yolo' }))
    expect(() => loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home })))
      .toThrow(/permissionMode/)
  })

  it('throws a readable error on malformed JSON', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), '{ not json')
    expect(() => loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home })))
      .toThrow(/Malformed JSON/)
  })
})

describe('provider-scoped model validation', () => {
  it('anthropic schema accepts the four family names and normalizes legacy ids', () => {
    const schema = makeSettingsSchema('anthropic')
    expect(schema.parse({ model: 'fable' }).model).toBe('fable')
    expect(schema.parse({ model: 'claude-opus-4-8' }).model).toBe('opus')
    expect(schema.parse({}).model).toBe('sonnet')
  })

  it('kimi schema accepts kimi keys and defaults to kimi-k3', () => {
    const schema = makeSettingsSchema('kimi')
    expect(schema.parse({ model: 'kimi-k2.7-code' }).model).toBe('kimi-k2.7-code')
    expect(schema.parse({ model: 'kimi-k3[1m]' }).model).toBe('kimi-k3')
    expect(schema.parse({}).model).toBe('kimi-k3')
  })

  it('rejects cross-provider keys with an error naming the provider and valid keys', () => {
    expect(() => makeSettingsSchema('kimi').parse({ model: 'sonnet' })).toThrow(
      /unknown model 'sonnet' for provider 'kimi'.*kimi-k3/,
    )
    expect(() => makeSettingsSchema('anthropic').parse({ model: 'kimi-k3' })).toThrow(
      /unknown model 'kimi-k3' for provider 'anthropic'.*haiku, sonnet, opus, fable/,
    )
  })

  it('loadSettings validates against the provider it is given', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ model: 'opus' }))
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    expect(loadSettings(paths, 'anthropic').model).toBe('opus')
    // Invalid-for-provider must NEVER throw (settings.json is scaffolded with an
    // anthropic model; a throw here is a permanent crash loop for every Kimi run).
    const warnings: string[] = []
    const s = loadSettings(paths, 'kimi', (m) => warnings.push(m))
    expect(s.model).toBe('kimi-k3')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('opus')
    expect(warnings[0]).toContain('kimi')
  })

  it('scaffold parity: model sonnet under kimi falls back to kimi-k3 with one warning', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ model: 'sonnet' }))
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const warnings: string[] = []
    const s = loadSettings(paths, 'kimi', (m) => warnings.push(m))
    expect(s.model).toBe('kimi-k3')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('sonnet')
    expect(warnings[0]).toContain('kimi')
  })

  it('the same file under anthropic returns sonnet with no warning', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ model: 'sonnet' }))
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const warnings: string[] = []
    expect(loadSettings(paths, 'anthropic', (m) => warnings.push(m)).model).toBe('sonnet')
    expect(warnings).toEqual([])
  })
})
