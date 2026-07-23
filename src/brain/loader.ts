import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrainPaths } from './paths.js'

export interface SkillIndexEntry {
  name: string
  description: string
  file: string
}
export interface CommandDef {
  name: string
  description: string
  argumentHint: string | null
  template: string
  file: string
}

/** Built-in slash command names — a directory-defined command sharing one of these
 *  names is skipped (never shadows a built-in). Kept in sync with tui/slash.ts. */
export const RESERVED_COMMAND_NAMES = new Set([
  'help',
  'clear',
  'resume',
  'compact',
  'memory',
  'skills',
  'agents',
  'quit',
  'model',
  'provider',
  'effort',
  'mode',
])

export interface AgentDef {
  name: string
  description: string
  tools: string[] | null // null = all tools (minus Agent, enforced in Task 12)
  model: string | null
  systemPrompt: string
  file: string
}

export function parseFrontmatter(src: string): { attrs: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!match) return { attrs: {}, body: src }
  const attrs: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) attrs[kv[1]!.toLowerCase()] = kv[2]!.trim()
  }
  return { attrs, body: src.slice(match[0].length) }
}

export function loadConstitution(paths: BrainPaths): string | null {
  return existsSync(paths.constitutionFile) ? readFileSync(paths.constitutionFile, 'utf8') : null
}

export function loadMemoryIndex(paths: BrainPaths): string | null {
  return existsSync(paths.memoryIndexFile) ? readFileSync(paths.memoryIndexFile, 'utf8') : null
}

function skillFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      const skillMd = join(full, 'SKILL.md')
      if (existsSync(skillMd)) out.push(skillMd)
    } else if (entry.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

export function loadSkillsIndex(paths: BrainPaths): SkillIndexEntry[] {
  const byName = new Map<string, SkillIndexEntry>()
  const dirs = [paths.skillsDir]
  if (paths.projectBrainDir) dirs.push(join(paths.projectBrainDir, 'skills'))
  for (const dir of dirs) {
    for (const file of skillFilesIn(dir)) {
      const { attrs } = parseFrontmatter(readFileSync(file, 'utf8'))
      const name = attrs['name']
      if (!name) continue
      byName.set(name, { name, description: attrs['description'] ?? '', file })
    }
  }
  return [...byName.values()]
}

export function loadAgentsIndex(paths: BrainPaths): AgentDef[] {
  const byName = new Map<string, AgentDef>()
  const dirs = [paths.agentsDir]
  if (paths.projectBrainDir) dirs.push(join(paths.projectBrainDir, 'agents'))
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const file = join(dir, entry)
      const { attrs, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      const name = attrs['name']
      if (!name) continue
      byName.set(name, {
        name,
        description: attrs['description'] ?? '',
        tools: attrs['tools']
          ? attrs['tools']
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : null,
        model: attrs['model'] ?? null,
        systemPrompt: body.trim(),
        file,
      })
    }
  }
  return [...byName.values()]
}

/** Directory-backed custom slash commands: `<brainDir>/commands/<name>.md` (global) and
 *  `<projectBrainDir>/commands/<name>.md` (project, overrides global on name collision) —
 *  same precedence convention as loadSkillsIndex/loadAgentsIndex. Frontmatter: `name`
 *  (optional, defaults to the filename), `description`, `argument-hint` (optional). The
 *  markdown body is the prompt template, expanded against parsed arguments at parse time.
 *  A file whose (explicit or derived) name collides with a built-in command is skipped
 *  with a warning — built-ins can never be shadowed. */
export function loadCommandsIndex(paths: BrainPaths, warn?: (message: string) => void): CommandDef[] {
  const byName = new Map<string, CommandDef>()
  const dirs = [paths.commandsDir]
  if (paths.projectBrainDir) dirs.push(join(paths.projectBrainDir, 'commands'))
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const file = join(dir, entry)
      const { attrs, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      const name = attrs['name'] ?? entry.slice(0, -3)
      if (RESERVED_COMMAND_NAMES.has(name)) {
        warn?.(`Skipping custom command '/${name}' (${file}): that name is a built-in command.`)
        continue
      }
      byName.set(name, {
        name,
        description: attrs['description'] ?? '',
        argumentHint: attrs['argument-hint'] ?? null,
        template: body.trim(),
        file,
      })
    }
  }
  return [...byName.values()]
}
