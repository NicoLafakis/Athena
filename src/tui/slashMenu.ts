// src/tui/slashMenu.ts
// Pure logic behind the live "/" popup in InputBox: the combined built-in + custom +
// plugin command catalog, and filtering it against whatever's been typed after the
// '/' so far. Kept Ink-free and side-effect-free so it's unit-testable without
// rendering anything — same rationale as fileMention.ts's split from
// MentionPopup.tsx. This is UI-only: it never touches parseSlash/dispatch (slash.ts).
import type { CustomCommandDef } from './slash.js'

export type SlashCommandSource = 'builtin' | 'custom' | 'plugin'

export interface SlashMenuEntry {
  name: string
  description: string
  source: SlashCommandSource
}

/** Built-in commands the popup should always offer, in the same order as
 *  RESERVED_COMMAND_NAMES (brain/loader.ts) — kept in sync manually since this list
 *  also carries a human-readable one-line description for the popup, which the
 *  reserved-name Set doesn't need. */
export const BUILTIN_SLASH_COMMANDS: readonly SlashMenuEntry[] = [
  { name: 'help', description: 'Show available commands', source: 'builtin' },
  { name: 'clear', description: 'Clear the transcript display (context is kept)', source: 'builtin' },
  { name: 'resume', description: 'Resume a past session', source: 'builtin' },
  { name: 'compact', description: 'Summarize and shrink the conversation context', source: 'builtin' },
  { name: 'memory', description: 'Show the memory index', source: 'builtin' },
  { name: 'skills', description: 'List available skills', source: 'builtin' },
  { name: 'agents', description: 'List available agents', source: 'builtin' },
  { name: 'quit', description: 'Exit Athena', source: 'builtin' },
  { name: 'model', description: 'Switch the active model', source: 'builtin' },
  { name: 'provider', description: 'Switch the active provider', source: 'builtin' },
  { name: 'effort', description: 'Set reasoning effort (low|medium|high|xhigh|max)', source: 'builtin' },
  { name: 'mode', description: 'Set permission mode (normal|acceptEdits|plan|trusted)', source: 'builtin' },
  { name: 'tui', description: 'Toggle fullscreen (alternate-screen) TUI mode', source: 'builtin' },
]

const BUILTIN_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name))

/** Unions the built-ins with whatever directory-backed/plugin commands are threaded
 *  through from brain/loader.js + brain/plugins.js (App's `commands` prop). Plugin
 *  entries are namespaced `<plugin-id>:<name>` by construction (plugins.ts) — that
 *  colon is the sole signal used to tag an entry 'plugin' rather than 'custom' for the
 *  popup's visual treatment, matching how plugins.ts itself reasons about namespacing. */
export function buildSlashCatalog(commands?: ReadonlyMap<string, CustomCommandDef>): SlashMenuEntry[] {
  const catalog = [...BUILTIN_SLASH_COMMANDS]
  if (commands) {
    for (const [name, def] of commands) {
      if (BUILTIN_NAMES.has(name)) continue // defensive: built-ins can never be shadowed
      catalog.push({ name, description: def.description, source: name.includes(':') ? 'plugin' : 'custom' })
    }
  }
  return catalog
}

/** Filters the catalog by whatever follows the '/' so far. Prefix (not fuzzy)
 *  matching, by design: command names are short, deliberate tokens the user is
 *  narrowing down (not long file paths recalled from memory, where fileMention.ts's
 *  fuzzy Fuse.js ranking earns its keep) — Claude Code's confirmed "filters as you
 *  type" reads as a narrowing prefix filter, and fuzzy scoring here would be
 *  surprising (e.g. 'c' matching 'compact' while the user is typing toward 'clear').
 *  An empty query returns the full catalog unfiltered (built-ins first in their fixed
 *  order, then custom/plugin entries in Map-iteration order) so the popup isn't blank
 *  the instant '/' is typed. */
export function filterSlashCommands(catalog: readonly SlashMenuEntry[], query: string): SlashMenuEntry[] {
  if (query === '') return [...catalog]
  const q = query.toLowerCase()
  return catalog.filter((entry) => entry.name.toLowerCase().startsWith(q))
}
