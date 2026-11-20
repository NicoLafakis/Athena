/** Built-in slash commands that take no arguments. */
export const BARE_SLASH_COMMANDS = new Set<string>([
  'help',
  'clear',
  'resume',
  'compact',
  'memory',
  'skills',
  'agents',
  'status',
  'cost',
  'repeat',
  'quit',
])

/** Built-in slash commands that accept arguments. */
export const ARG_SLASH_COMMANDS = new Set<string>([
  'details',
  'verbosity',
  'search',
  'model',
  'provider',
  'effort',
  'mode',
  'tui',
])

/**
 * Single source of truth for all built-in slash command names.
 * A directory-defined custom command sharing one of these names is skipped so
 * built-ins can never be shadowed.
 */
export const RESERVED_COMMAND_NAMES = new Set<string>([
  ...BARE_SLASH_COMMANDS,
  ...ARG_SLASH_COMMANDS,
])
