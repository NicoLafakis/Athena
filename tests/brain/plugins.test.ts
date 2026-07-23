import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import {
  discoverPlugins,
  loadSkillsIndexWithPlugins,
  loadAgentsIndexWithPlugins,
  loadCommandsIndexWithPlugins,
} from '../../src/brain/plugins.js'

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

describe('discoverPlugins', () => {
  it('returns [] when the plugins dir does not exist', () => {
    const found = discoverPlugins(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(found).toEqual([])
  })

  it('finds a plugin directory with no manifest — id defaults to the directory name', () => {
    mkdirSync(join(home, '.athena', 'plugins', 'acme-tools'), { recursive: true })
    const found = discoverPlugins(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 'acme-tools', manifest: null })
  })

  it('reads plugin.json for id/name/version/description when present', () => {
    const dir = join(home, '.athena', 'plugins', 'acme-tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({ id: 'acme', name: 'Acme Tools', version: '1.0.0', description: 'Acme stuff' }),
    )
    const found = discoverPlugins(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('acme') // manifest id overrides the directory name
    expect(found[0]!.manifest).toEqual({
      id: 'acme',
      name: 'Acme Tools',
      version: '1.0.0',
      description: 'Acme stuff',
    })
  })

  it('falls back to the directory name and warns on a malformed plugin.json', () => {
    const dir = join(home, '.athena', 'plugins', 'acme-tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), '{ not valid json')
    const warnings: string[] = []
    const found = discoverPlugins(resolveBrainPaths({ cwd: project, homeOverride: home }), (m) =>
      warnings.push(m),
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('acme-tools')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('acme-tools')
  })
})

describe('loadSkillsIndexWithPlugins', () => {
  it('namespaces a plugin skill under <plugin-id>:<name>', () => {
    const skillDir = join(home, '.athena', 'plugins', 'acme-tools', 'skills')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'helper.md'),
      '---\nname: helper\ndescription: Plugin helper skill\n---\nBody.\n',
    )
    const idx = loadSkillsIndexWithPlugins(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx).toHaveLength(1)
    expect(idx[0]).toMatchObject({ name: 'acme-tools:helper', description: 'Plugin helper skill' })
  })

  it('supports the skills/<name>/SKILL.md layout inside a plugin, same as the personal dir', () => {
    const skillDir = join(home, '.athena', 'plugins', 'acme-tools', 'skills', 'deep-dive')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: deep-dive\ndescription: Deep dive skill\n---\nBody.\n',
    )
    const idx = loadSkillsIndexWithPlugins(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx.map((s) => s.name)).toEqual(['acme-tools:deep-dive'])
  })

  it('a plugin skill sharing a bare name with a personal skill does NOT override the bare name, but coexists under its namespaced key', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const personalSkills = join(home, '.athena', 'skills')
    mkdirSync(personalSkills, { recursive: true })
    writeFileSync(join(personalSkills, 'dup.md'), '---\nname: dup\ndescription: personal\n---\nbody')
    const pluginSkills = join(home, '.athena', 'plugins', 'acme-tools', 'skills')
    mkdirSync(pluginSkills, { recursive: true })
    writeFileSync(join(pluginSkills, 'dup.md'), '---\nname: dup\ndescription: plugin\n---\nbody')
    const idx = loadSkillsIndexWithPlugins(paths)
    // The bare name still resolves to the personal entry...
    expect(idx.find((s) => s.name === 'dup')).toMatchObject({ name: 'dup', description: 'personal' })
    // ...and the plugin's entry is still reachable under its namespaced key, not dropped.
    expect(idx.find((s) => s.name === 'acme-tools:dup')).toMatchObject({
      name: 'acme-tools:dup',
      description: 'plugin',
    })
    expect(idx).toHaveLength(2)
  })

  it('a plugin skill with a unique name IS available under its namespaced key alongside personal skills', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const personalSkills = join(home, '.athena', 'skills')
    mkdirSync(personalSkills, { recursive: true })
    writeFileSync(join(personalSkills, 'mine.md'), '---\nname: mine\ndescription: personal\n---\nbody')
    const pluginSkills = join(home, '.athena', 'plugins', 'acme-tools', 'skills')
    mkdirSync(pluginSkills, { recursive: true })
    writeFileSync(join(pluginSkills, 'helper.md'), '---\nname: helper\ndescription: plugin\n---\nbody')
    const idx = loadSkillsIndexWithPlugins(paths)
    expect(idx.map((s) => s.name).sort()).toEqual(['acme-tools:helper', 'mine'])
  })
})

describe('loadAgentsIndexWithPlugins', () => {
  it('namespaces plugin agents; a bare-name collision with a personal agent does not drop the plugin entry — both coexist under their own keys', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const personalAgents = join(home, '.athena', 'agents')
    mkdirSync(personalAgents, { recursive: true })
    writeFileSync(
      join(personalAgents, 'dup.md'),
      '---\nname: dup\ndescription: personal agent\n---\nPersonal prompt.\n',
    )
    const pluginAgents = join(home, '.athena', 'plugins', 'acme-tools', 'agents')
    mkdirSync(pluginAgents, { recursive: true })
    writeFileSync(
      join(pluginAgents, 'dup.md'),
      '---\nname: dup\ndescription: plugin agent\n---\nPlugin prompt.\n',
    )
    writeFileSync(
      join(pluginAgents, 'reviewer.md'),
      '---\nname: reviewer\ndescription: plugin reviewer\ntools: Read, Grep\n---\nReview prompt.\n',
    )
    const idx = loadAgentsIndexWithPlugins(paths)
    // The bare name still resolves to the personal entry...
    expect(idx.find((a) => a.name === 'dup')!.description).toBe('personal agent')
    // ...the colliding plugin entry is still reachable under its namespaced key...
    const namespacedDup = idx.find((a) => a.name === 'acme-tools:dup')!
    expect(namespacedDup.description).toBe('plugin agent')
    // ...and a uniquely-named plugin agent is namespaced as usual.
    const reviewer = idx.find((a) => a.name === 'acme-tools:reviewer')!
    expect(reviewer.tools).toEqual(['Read', 'Grep'])
    expect(reviewer.systemPrompt).toContain('Review prompt.')
    expect(idx.map((a) => a.name).sort()).toEqual(['acme-tools:dup', 'acme-tools:reviewer', 'dup'])
  })

  it('a project-level agent also wins the bare name over a same-named plugin agent, which still coexists namespaced', () => {
    // resolveBrainPaths snapshots projectBrainDir via existsSync at call time, so the
    // project .athena dir must exist BEFORE resolving paths.
    mkdirSync(join(project, '.athena', 'agents'), { recursive: true })
    writeFileSync(
      join(project, '.athena', 'agents', 'dup.md'),
      '---\nname: dup\ndescription: project agent\n---\nProject prompt.\n',
    )
    const pluginAgents = join(home, '.athena', 'plugins', 'acme-tools', 'agents')
    mkdirSync(pluginAgents, { recursive: true })
    writeFileSync(
      join(pluginAgents, 'dup.md'),
      '---\nname: dup\ndescription: plugin agent\n---\nPlugin prompt.\n',
    )
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const idx = loadAgentsIndexWithPlugins(paths)
    expect(idx).toHaveLength(2)
    expect(idx.find((a) => a.name === 'dup')).toMatchObject({ name: 'dup', description: 'project agent' })
    expect(idx.find((a) => a.name === 'acme-tools:dup')).toMatchObject({
      name: 'acme-tools:dup',
      description: 'plugin agent',
    })
  })
})

describe('loadCommandsIndexWithPlugins', () => {
  it('namespaces plugin commands; a bare-name collision with a personal command does not drop the plugin entry — both coexist under their own keys', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const personalCommands = join(home, '.athena', 'commands')
    mkdirSync(personalCommands, { recursive: true })
    writeFileSync(
      join(personalCommands, 'standup.md'),
      '---\ndescription: personal standup\n---\nPersonal body.',
    )
    const pluginCommands = join(home, '.athena', 'plugins', 'acme-tools', 'commands')
    mkdirSync(pluginCommands, { recursive: true })
    writeFileSync(join(pluginCommands, 'standup.md'), '---\ndescription: plugin standup\n---\nPlugin body.')
    writeFileSync(
      join(pluginCommands, 'release-notes.md'),
      '---\ndescription: plugin release notes\nargument-hint: [version]\n---\nRelease body for $ARGUMENTS.',
    )
    const idx = loadCommandsIndexWithPlugins(paths)
    expect(idx.map((c) => c.name).sort()).toEqual([
      'acme-tools:release-notes',
      'acme-tools:standup',
      'standup',
    ])
    // The bare name still resolves to the personal entry...
    expect(idx.find((c) => c.name === 'standup')!.description).toBe('personal standup')
    // ...and the colliding plugin command is still reachable under its namespaced key.
    expect(idx.find((c) => c.name === 'acme-tools:standup')!.description).toBe('plugin standup')
    const releaseNotes = idx.find((c) => c.name === 'acme-tools:release-notes')!
    expect(releaseNotes.argumentHint).toBe('[version]')
    expect(releaseNotes.template).toBe('Release body for $ARGUMENTS.')
  })

  it('a plugin command sharing a name with a built-in is namespaced normally (never a bare-name collision)', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const pluginCommands = join(home, '.athena', 'plugins', 'acme-tools', 'commands')
    mkdirSync(pluginCommands, { recursive: true })
    writeFileSync(join(pluginCommands, 'help.md'), '---\ndescription: plugin help\n---\nPlugin help body.')
    const idx = loadCommandsIndexWithPlugins(paths)
    expect(idx.map((c) => c.name)).toEqual(['acme-tools:help'])
  })

  it('an explicit frontmatter name in a plugin command is namespaced too', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const pluginCommands = join(home, '.athena', 'plugins', 'acme-tools', 'commands')
    mkdirSync(pluginCommands, { recursive: true })
    writeFileSync(
      join(pluginCommands, 'file-name.md'),
      '---\nname: real-name\ndescription: d\n---\nbody',
    )
    const idx = loadCommandsIndexWithPlugins(paths)
    expect(idx.map((c) => c.name)).toEqual(['acme-tools:real-name'])
  })
})
