// src/tui/slash.ts
import type { PermissionMode } from '../engine/types.js'
import { EFFORTS, type Effort } from '../brain/models.js'

/** Minimal shape parseSlash needs from brain/loader.js's CommandDef — kept structural
 *  (rather than importing the type) so this file stays framework/layer-agnostic. */
export interface CustomCommandDef {
  template: string
}

export type SlashCommand =
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'resume' }
  | { kind: 'compact' }
  | { kind: 'memory' }
  | { kind: 'skills' }
  | { kind: 'agents' }
  | { kind: 'quit' }
  | { kind: 'model'; value: string }
  | { kind: 'provider'; value: string }
  | { kind: 'effort'; value: Effort }
  | { kind: 'mode'; value: PermissionMode }
  | { kind: 'custom'; name: string; expandedPrompt: string }
  | { kind: 'error'; value: string }

const MODES = new Set(['normal', 'acceptEdits', 'plan', 'trusted'])
const EFFORT_SET = new Set<string>(EFFORTS)
const BARE = new Set(['help', 'clear', 'resume', 'compact', 'memory', 'skills', 'agents', 'quit'])

/** Substitutes $0, $1, ... (positional args) and $ARGUMENTS (the full argument string,
 *  space-joined) into a custom command's template body. */
export function expandCommandTemplate(template: string, args: string[], argumentsJoined: string): string {
  return template
    .replace(/\$ARGUMENTS/g, argumentsJoined)
    .replace(/\$(\d+)/g, (_m, d: string) => args[Number(d)] ?? '')
}

export function parseSlash(
  input: string,
  commands?: ReadonlyMap<string, CustomCommandDef>,
): SlashCommand | null {
  if (!input.startsWith('/')) return null
  const [cmd = '', ...rest] = input.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')
  if (BARE.has(cmd)) return { kind: cmd } as SlashCommand
  if (cmd === 'model')
    return arg
      ? { kind: 'model', value: arg }
      : { kind: 'error', value: 'Usage: /model <name>' }
  if (cmd === 'provider')
    return arg
      ? { kind: 'provider', value: arg }
      : { kind: 'error', value: 'Usage: /provider <name>' }
  if (cmd === 'effort') {
    if (!arg) return { kind: 'error', value: 'Usage: /effort <low|medium|high|xhigh|max>' }
    if (!EFFORT_SET.has(arg)) return { kind: 'error', value: `Unknown effort: ${arg}` }
    return { kind: 'effort', value: arg as Effort }
  }
  if (cmd === 'mode') {
    if (!MODES.has(arg)) return { kind: 'error', value: `Unknown mode: ${arg || '(none)'}` }
    return { kind: 'mode', value: arg as PermissionMode }
  }
  const custom = commands?.get(cmd)
  if (custom) {
    return { kind: 'custom', name: cmd, expandedPrompt: expandCommandTemplate(custom.template, rest, arg) }
  }
  return { kind: 'error', value: `Unknown command: /${cmd}` }
}
