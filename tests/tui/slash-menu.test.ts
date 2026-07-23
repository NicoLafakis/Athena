import { describe, it, expect } from 'vitest'
import {
  buildSlashCatalog,
  filterSlashCommands,
  BUILTIN_SLASH_COMMANDS,
  type SlashMenuEntry,
} from '../../src/tui/slashMenu.js'
import type { CustomCommandDef } from '../../src/tui/slash.js'

function registry(entries: Record<string, string>): Map<string, CustomCommandDef> {
  return new Map(Object.entries(entries).map(([name, description]) => [name, { description, template: '' }]))
}

describe('buildSlashCatalog', () => {
  it('with no commands map, returns exactly the built-ins in their fixed order', () => {
    const catalog = buildSlashCatalog()
    expect(catalog).toEqual(BUILTIN_SLASH_COMMANDS)
  })

  it('unions in personal/project custom commands, tagged "custom"', () => {
    const commands = registry({ standup: 'Write a standup update.' })
    const catalog = buildSlashCatalog(commands)
    expect(catalog).toContainEqual({
      name: 'standup',
      description: 'Write a standup update.',
      source: 'custom',
    })
    expect(catalog.length).toBe(BUILTIN_SLASH_COMMANDS.length + 1)
  })

  it('tags plugin-namespaced entries (name contains ":") as "plugin"', () => {
    const commands = registry({ 'myplugin:deploy': 'Deploy the thing.' })
    const catalog = buildSlashCatalog(commands)
    expect(catalog).toContainEqual({
      name: 'myplugin:deploy',
      description: 'Deploy the thing.',
      source: 'plugin',
    })
  })

  it('a custom command sharing a built-in name never shadows the built-in', () => {
    // Defensive: RESERVED_COMMAND_NAMES (brain/loader.ts) already prevents this at
    // load time, but buildSlashCatalog guards independently too.
    const commands = registry({ help: 'A rogue custom help.' })
    const catalog = buildSlashCatalog(commands)
    const helpEntries = catalog.filter((e) => e.name === 'help')
    expect(helpEntries).toHaveLength(1)
    expect(helpEntries[0]!.source).toBe('builtin')
  })
})

describe('filterSlashCommands', () => {
  const catalog = buildSlashCatalog(
    registry({ standup: 'Write a standup update.', 'myplugin:deploy': 'Deploy the thing.' }),
  )

  it('empty query returns the full catalog, unfiltered', () => {
    expect(filterSlashCommands(catalog, '')).toEqual(catalog)
  })

  it('filters by case-insensitive name prefix', () => {
    const result = filterSlashCommands(catalog, 'mo')
    expect(result.map((e) => e.name)).toEqual(['model', 'mode'])
  })

  it('prefix matching does not fuzzy-match unrelated commands', () => {
    // 'c' should not surface e.g. 'skills' or 'agents' — only names actually
    // starting with 'c'.
    const result = filterSlashCommands(catalog, 'c')
    expect(result.map((e) => e.name).sort()).toEqual(['clear', 'compact'])
  })

  it('matches a custom command by its own name', () => {
    const result = filterSlashCommands(catalog, 'stand')
    expect(result.map((e) => e.name)).toEqual(['standup'])
  })

  it('matches a plugin command by its full namespaced key, not just the suffix', () => {
    expect(filterSlashCommands(catalog, 'deploy')).toEqual([])
    expect(filterSlashCommands(catalog, 'myplugin')).toEqual([
      { name: 'myplugin:deploy', description: 'Deploy the thing.', source: 'plugin' },
    ])
  })

  it('no match returns an empty array', () => {
    expect(filterSlashCommands(catalog, 'zzz')).toEqual([])
  })

  it('is case-insensitive', () => {
    const result = filterSlashCommands(catalog, 'HEL')
    expect(result.map((e: SlashMenuEntry) => e.name)).toEqual(['help'])
  })
})
