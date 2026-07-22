// src/tui/slash.ts
import type { PermissionMode } from '../engine/types.js'

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
  | { kind: 'mode'; value: PermissionMode }
  | { kind: 'error'; value: string }

const MODES = new Set(['normal', 'acceptEdits', 'plan', 'trusted'])
const BARE = new Set(['help', 'clear', 'resume', 'compact', 'memory', 'skills', 'agents', 'quit'])

export function parseSlash(input: string): SlashCommand | null {
  if (!input.startsWith('/')) return null
  const [cmd = '', ...rest] = input.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')
  if (BARE.has(cmd)) return { kind: cmd } as SlashCommand
  if (cmd === 'model')
    return arg ? { kind: 'model', value: arg } : { kind: 'error', value: 'Usage: /model <model-id>' }
  if (cmd === 'mode') {
    if (!MODES.has(arg)) return { kind: 'error', value: `Unknown mode: ${arg || '(none)'}` }
    return { kind: 'mode', value: arg as PermissionMode }
  }
  return { kind: 'error', value: `Unknown command: /${cmd}` }
}
