// src/brain/plugins.ts
//
// Plugin bundles: third-party skills/agents/commands dropped into
// `~/.athena/plugins/<plugin-id>/{skills,agents,commands}/`, using the exact same
// per-kind file format and frontmatter parsing as the personal/project brain dirs
// (see brain/loader.js). An optional `plugin.json` manifest at the plugin root carries
// metadata (id/name/version/description); directory layout alone is authoritative, so a
// plugin with no manifest still loads fine (id defaults to the directory name).
//
// Priority cascade: a plugin can never claim a bare name that already exists at project
// or personal level, because a plugin entry is ALWAYS exposed under its namespaced key
// `<plugin-id>:<name>`, never under the bare `<name>`. That alone is what makes
// installing a plugin unable to silently change existing behavior — there is no bare-name
// collision to defend against, since the two keys can never be equal. So every discovered
// plugin entry is added under its namespaced key regardless of what bare names already
// exist in `core`; the bare name (if any) keeps resolving to the personal/project entry,
// and the plugin's feature remains separately reachable via `<plugin-id>:<name>`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrainPaths } from './paths.js'
import {
  skillFilesIn,
  parseSkillFile,
  parseAgentFile,
  parseCommandFile,
  loadSkillsIndex,
  loadAgentsIndex,
  loadCommandsIndex,
  type SkillIndexEntry,
  type AgentDef,
  type CommandDef,
} from './loader.js'

export interface PluginManifest {
  id: string
  name: string | null
  version: string | null
  description: string | null
}

export interface DiscoveredPlugin {
  id: string
  dir: string
  manifest: PluginManifest | null
}

/** Scans `<brainDir>/plugins/*` for plugin bundles. A subdirectory is a plugin whether
 *  or not it has a `plugin.json` — layout alone is authoritative. When present, the
 *  manifest's own `id` field overrides the directory name. A malformed plugin.json is a
 *  non-fatal warning; the plugin still loads with the directory name as its id. */
export function discoverPlugins(paths: BrainPaths, warn?: (message: string) => void): DiscoveredPlugin[] {
  const root = paths.pluginsDir
  if (!existsSync(root)) return []
  const out: DiscoveredPlugin[] = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory()) continue
    let manifest: PluginManifest | null = null
    const manifestFile = join(dir, 'plugin.json')
    if (existsSync(manifestFile)) {
      try {
        const raw = JSON.parse(readFileSync(manifestFile, 'utf8')) as Partial<PluginManifest>
        manifest = {
          id: raw.id ?? entry,
          name: raw.name ?? null,
          version: raw.version ?? null,
          description: raw.description ?? null,
        }
      } catch (err) {
        warn?.(
          `Plugin '${entry}': malformed plugin.json (${(err as Error).message}); using the directory name as its id.`,
        )
      }
    }
    out.push({ id: manifest?.id ?? entry, dir, manifest })
  }
  return out
}

/** Merges plugin-sourced entries on top of an already-resolved personal+project `core`
 *  index. Every plugin entry is renamed to `<plugin-id>:<name>` and added — there is no
 *  check against `core`'s bare names, because the namespaced key can never equal a bare
 *  one, so there is nothing for a plugin to silently override. The only thing guarded
 *  against here is a true duplicate: the same plugin id producing the same name twice
 *  (e.g. across its own personal/project-shaped dirs), which would otherwise collide on
 *  the same namespaced key — first one discovered wins. */
function mergeWithPlugins<T extends { name: string }>(
  core: T[],
  pluginEntries: Array<{ pluginId: string; entry: T }>,
): T[] {
  const out = [...core]
  const seen = new Set<string>()
  for (const { pluginId, entry } of pluginEntries) {
    const namespaced = `${pluginId}:${entry.name}`
    if (seen.has(namespaced)) continue
    seen.add(namespaced)
    out.push({ ...entry, name: namespaced })
  }
  return out
}

/** loadSkillsIndex, plugin-aware: personal/project skills exactly as before, plus every
 *  plugin skill (`<plugin-id>/skills/...`), always exposed as `<plugin-id>:<name>`
 *  regardless of whether that bare name also exists at personal/project level. */
export function loadSkillsIndexWithPlugins(
  paths: BrainPaths,
  warn?: (message: string) => void,
): SkillIndexEntry[] {
  const core = loadSkillsIndex(paths)
  const pluginEntries: Array<{ pluginId: string; entry: SkillIndexEntry }> = []
  for (const plugin of discoverPlugins(paths, warn)) {
    for (const file of skillFilesIn(join(plugin.dir, 'skills'))) {
      const entry = parseSkillFile(file)
      if (entry) pluginEntries.push({ pluginId: plugin.id, entry })
    }
  }
  return mergeWithPlugins(core, pluginEntries)
}

/** loadAgentsIndex, plugin-aware — same namespacing as loadSkillsIndexWithPlugins. */
export function loadAgentsIndexWithPlugins(
  paths: BrainPaths,
  warn?: (message: string) => void,
): AgentDef[] {
  const core = loadAgentsIndex(paths)
  const pluginEntries: Array<{ pluginId: string; entry: AgentDef }> = []
  for (const plugin of discoverPlugins(paths, warn)) {
    const dir = join(plugin.dir, 'agents')
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const def = parseAgentFile(join(dir, entry))
      if (def) pluginEntries.push({ pluginId: plugin.id, entry: def })
    }
  }
  return mergeWithPlugins(core, pluginEntries)
}

/** loadCommandsIndex, plugin-aware — same namespacing as loadSkillsIndexWithPlugins.
 *  RESERVED_COMMAND_NAMES is deliberately not re-checked here: a plugin command's final
 *  name is always `<plugin-id>:<name>`, which can never equal a bare built-in name. */
export function loadCommandsIndexWithPlugins(
  paths: BrainPaths,
  warn?: (message: string) => void,
): CommandDef[] {
  const core = loadCommandsIndex(paths, warn)
  const pluginEntries: Array<{ pluginId: string; entry: CommandDef }> = []
  for (const plugin of discoverPlugins(paths, warn)) {
    const dir = join(plugin.dir, 'commands')
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const file = join(dir, entry)
      const def = parseCommandFile(file, entry.slice(0, -3))
      pluginEntries.push({ pluginId: plugin.id, entry: def })
    }
  }
  return mergeWithPlugins(core, pluginEntries)
}
