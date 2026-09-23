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
    expect(s.jev.enabled).toBe(true)
    expect(s.allow).toEqual([])
    expect(s.accessibility).toEqual({
      presentation: 'standard',
      verbosity: 'balanced',
      progressAnnouncements: 'milestones',
      progressIntervalMs: 60_000,
      directSpeech: 'off',
    })
  })

  it('deep-fills partial global accessibility settings without aliasing defaults', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      join(home, '.athena', 'settings.json'),
      JSON.stringify({ accessibility: { presentation: 'screen-reader', verbosity: 'detailed' } }),
    )
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const first = loadSettings(paths)
    const second = loadSettings(paths)

    expect(first.accessibility).toEqual({
      presentation: 'screen-reader',
      verbosity: 'detailed',
      progressAnnouncements: 'milestones',
      progressIntervalMs: 60_000,
      directSpeech: 'off',
    })
    first.accessibility.presentation = 'standard'
    expect(second.accessibility.presentation).toBe('screen-reader')
  })

  it('ignores project accessibility settings and keeps the global user preference', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      join(home, '.athena', 'settings.json'),
      JSON.stringify({ accessibility: { presentation: 'screen-reader', verbosity: 'concise' } }),
    )
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(
      join(project, '.athena', 'settings.json'),
      JSON.stringify({
        accessibility: {
          presentation: 'standard',
          verbosity: 'detailed',
          directSpeech: 'supplemental',
        },
      }),
    )
    const warnings: string[] = []
    const settings = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
      'anthropic',
      (warning) => warnings.push(warning),
    )

    expect(settings.accessibility.presentation).toBe('screen-reader')
    expect(settings.accessibility.verbosity).toBe('concise')
    expect(settings.accessibility.directSpeech).toBe('off')
    expect(warnings).toContain(
      'Project settings cannot override global accessibility preferences; ignoring project accessibility.',
    )
  })

  it('warns and uses safe defaults when optional global accessibility settings are malformed', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      join(home, '.athena', 'settings.json'),
      JSON.stringify({ accessibility: { presentation: 'telepathy', progressIntervalMs: -1 } }),
    )
    const warnings: string[] = []
    const settings = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
      'anthropic',
      (warning) => warnings.push(warning),
    )

    expect(settings.accessibility.presentation).toBe('standard')
    expect(settings.accessibility.progressIntervalMs).toBe(60_000)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Global accessibility settings')
    expect(warnings[0]).toContain('using safe defaults')
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

  it('loads the global IANA timezone for continuity and ignores project timezone overrides', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ timeZone: 'Europe/Paris' }))
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(join(project, '.athena', 'settings.json'), JSON.stringify({ timeZone: 'America/Los_Angeles' }))
    const warnings: string[] = []
    const settings = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
      'anthropic',
      (warning) => warnings.push(warning),
    )

    expect(settings.timeZone).toBe('Europe/Paris')
    expect(warnings).toContain('Project settings cannot override the global user timezone; ignoring project timeZone.')
  })

  it('keeps Jev enablement global so an individual project cannot opt into provider calls', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ jev: { enabled: true } }))
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(join(project, '.athena', 'settings.json'), JSON.stringify({ jev: { enabled: false } }))
    const warnings: string[] = []

    const settings = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
      'anthropic',
      (warning) => warnings.push(warning),
    )

    expect(settings.jev.enabled).toBe(true)
    expect(warnings).toContain('Project settings cannot override global Jev decision settings; ignoring project jev.')
  })

  it('drops an invalid optional global timezone and reports the OS fallback', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ timeZone: 'Mars/Olympus_Mons' }))
    const warnings: string[] = []
    const settings = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
      'anthropic',
      (warning) => warnings.push(warning),
    )

    expect(settings.timeZone).toBeUndefined()
    expect(warnings[0]).toContain('OS local timezone will be inferred')
  })

  it('protectedPaths defaults to empty and concatenates global-first', () => {
    expect(SettingsSchema.parse({}).protectedPaths).toEqual([])
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'),
      JSON.stringify({ protectedPaths: ['C:\\Golden'] }))
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(join(project, '.athena', 'settings.json'),
      JSON.stringify({ protectedPaths: ['C:\\AlsoGolden'] }))
    const s = loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home }))
    // Concatenated, not replaced: a project can only ADD to the fence. There is
    // no shape of project settings that removes a protected directory, which is
    // why this needs no stripping the way trusted/unrestricted do.
    expect(s.protectedPaths).toEqual(['C:\\Golden', 'C:\\AlsoGolden'])
  })

  it('safe untrusted mode ignores all project settings', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ model: 'haiku' }))
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(
      join(project, '.athena', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        permissionMode: 'trusted',
        hooks: [{ event: 'SessionStart', command: 'malicious' }],
        mcpServers: { bad: { command: 'malicious' } },
      }),
    )
    const settings = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
      'anthropic',
      undefined,
      { projectTrusted: false },
    )
    expect(settings.model).toBe('haiku')
    expect(settings.permissionMode).toBe('normal')
    expect(settings.hooks).toEqual([])
    expect(settings.mcpServers).toEqual({})
  })

  it('project settings cannot select trusted or unrestricted modes', () => {
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(
      join(project, '.athena', 'settings.json'),
      JSON.stringify({ permissionMode: 'trusted', sandboxMode: 'unrestricted' }),
    )
    const warnings: string[] = []
    const settings = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
      'anthropic',
      (warning) => warnings.push(warning),
    )
    expect(settings.permissionMode).toBe('normal')
    expect(settings.sandboxMode).toBe('workspace-write')
    expect(warnings).toHaveLength(2)
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
    expect(s1.hooks[0]!.type).toBe('command')
    if (s1.hooks[0]!.type === 'command') s1.hooks[0]!.command = 'mutated'
    expect(s2.allow).toEqual(['Read(**)'])
    expect(s2.deny).toEqual([])
    expect(s2.hooks[0]).toMatchObject({ type: 'command', command: 'echo hi', version: 1 })
  })

  it('schema defaults do not alias arrays between parses', () => {
    const d1 = SettingsSchema.parse({})
    const d2 = SettingsSchema.parse({})
    d1.allow.push('X')
    d1.deny.push('Y')
    d1.hooks.push({
      type: 'command',
      version: 1,
      event: 'Stop',
      command: 'z',
      timeoutMs: 1,
      maxOutputChars: 100_000,
    })
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
    expect(s.mcpServers['fs']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      envAllowlist: [],
      maxOutputChars: 100_000,
      discoveryLimit: 200,
    })
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
    expect(s.mcpServers['b']).toMatchObject({ transport: 'stdio', command: 'project-b' })
  })

  it('parses bounded Streamable HTTP and OAuth client-credentials settings', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      join(home, '.athena', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            transport: 'http',
            url: 'https://mcp.example.com/v1',
            bearerTokenEnv: 'REMOTE_MCP_TOKEN',
            oauth: {
              flow: 'client_credentials',
              clientIdEnv: 'REMOTE_MCP_CLIENT_ID',
              clientSecretEnv: 'REMOTE_MCP_CLIENT_SECRET',
              scope: 'tools.read',
            },
          },
        },
      }),
    )
    const remote = loadSettings(
      resolveBrainPaths({ cwd: project, homeOverride: home }),
    ).mcpServers['remote']
    expect(remote).toMatchObject({
      transport: 'http',
      url: 'https://mcp.example.com/v1',
      allowPrivateNetwork: false,
      discoveryLimit: 200,
    })
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
