// src/tui/slash.ts
import type { PermissionMode } from '../engine/types.js'
import { BARE_SLASH_COMMANDS } from '../brain/commands.js'
import { EFFORTS, type Effort } from '../brain/models.js'

/** Minimal shape parseSlash (and the live "/" menu — see tui/slashMenu.ts) need from
 *  brain/loader.js's CommandDef — kept structural (rather than importing the type) so
 *  this file stays framework/layer-agnostic. `description` isn't read by parseSlash
 *  itself; it rides along because every real caller (loader.ts's CommandDef) already
 *  carries it, and InputBox/slashMenu.ts need it for the popup without inventing a
 *  second near-duplicate structural type. */
export interface CustomCommandDef {
  description: string
  template: string
}

export type SlashCommand =
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'resume' }
  | { kind: 'compact' }
  | {
      kind: 'memory'
      action?: 'status' | 'rebuild' | 'timeline' | 'search' | 'show' | 'rollup' | 'rank' | 'candidates' | 'review' | 'forget' | 'hygiene'
      value?: string
      projectId?: string
    }
  | { kind: 'skills' }
  | { kind: 'agents' }
  | { kind: 'status' }
  | { kind: 'cost' }
  | { kind: 'repeat' }
  | { kind: 'details'; value: string }
  | { kind: 'verbosity'; value: 'concise' | 'balanced' | 'detailed' }
  | { kind: 'search'; query: string; page: number }
  | { kind: 'quit' }
  | { kind: 'model'; value: string }
  | { kind: 'provider'; value: string }
  | { kind: 'effort'; value: Effort }
  | { kind: 'mode'; value: PermissionMode }
  | { kind: 'tui'; value: TuiMode }
  | { kind: 'custom'; name: string; expandedPrompt: string }
  | { kind: 'error'; value: string }

/** 'classic' = content appended to native scrollback; the fallback on a non-TTY stream
 *  and the explicit opt-out via /tui classic. 'fullscreen' = alternate-screen buffer with
 *  a pinned input and a virtualized transcript; the default on a real interactive
 *  terminal (see App.tsx). */
export type TuiMode = 'classic' | 'fullscreen'

const MODES = new Set(['normal', 'acceptEdits', 'plan', 'trusted'])
const EFFORT_SET = new Set<string>(EFFORTS)
const TUI_MODES = new Set(['classic', 'fullscreen'])
const SEMANTIC_MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
  if (cmd === 'memory') {
    if (rest.length === 0) return { kind: 'memory' }
    const action = rest[0]
    if (!['status', 'rebuild', 'timeline', 'search', 'show', 'rollup', 'rank', 'candidates', 'review', 'forget', 'hygiene'].includes(action!)) {
      return { kind: 'error', value: 'Usage: /memory [status|rebuild|hygiene|timeline [range]|search <query>|rank <query>|show <episode-id>|rollup [day|week|month|quarter|year]|candidates|review <memory-id> <promote|reject>|--list|forget <memory-id>]' }
    }
    const valueParts: string[] = []
    let projectId: string | undefined
    for (let index = 1; index < rest.length; index++) {
      if (rest[index] === '--project') {
        const next = rest[index + 1]
        if (!next || next.startsWith('--')) return { kind: 'error', value: '/memory --project requires a project ID' }
        projectId = next
        index++
      } else if (action === 'review' && (rest[index] === '--list' || rest[index] === '--keep' || rest[index] === '--tombstone')) {
        valueParts.push(rest[index]!)
      } else if (rest[index]!.startsWith('--')) {
        return { kind: 'error', value: `Unknown /memory argument: ${rest[index]}` }
      } else {
        valueParts.push(rest[index]!)
      }
    }
    const value = valueParts.join(' ')
    if (action === 'candidates' && (projectId !== undefined || valueParts.length !== 0)) {
      return { kind: 'error', value: 'Usage: /memory candidates' }
    }
    if (action === 'review') {
      const isFreeTextFlag =
        (valueParts[0] === '--list' && valueParts.length === 1) ||
        (valueParts[0] === '--keep' && valueParts.length === 2) ||
        (valueParts[0] === '--tombstone' && valueParts.length >= 2)
      const isSemantic =
        valueParts.length === 2 &&
        SEMANTIC_MEMORY_ID.test(valueParts[0]!) &&
        ['promote', 'reject'].includes(valueParts[1]!)
      if (projectId !== undefined || (!isFreeTextFlag && !isSemantic)) {
        return {
          kind: 'error',
          value: valueParts[0]?.startsWith('--')
            ? 'Usage: /memory review --list | --keep <path> | --tombstone <path> [reason]'
            : 'Usage: /memory review <memory-id> <promote|reject>',
        }
      }
    }
    if (action === 'forget' && (
      projectId !== undefined || valueParts.length !== 1 || !SEMANTIC_MEMORY_ID.test(valueParts[0]!)
    )) {
      return { kind: 'error', value: 'Usage: /memory forget <memory-id>' }
    }
    if ((action === 'status' || action === 'rebuild' || action === 'hygiene') && value) {
      return { kind: 'error', value: `Usage: /memory ${action}` }
    }
    if ((action === 'search' || action === 'rank' || action === 'show') && !value) {
      const valueName = action === 'search' || action === 'rank' ? 'query' : 'episode-id'
      return { kind: 'error', value: `Usage: /memory ${action} <${valueName}>` }
    }
    if (action === 'show' && valueParts.length !== 1) {
      return { kind: 'error', value: 'Usage: /memory show <episode-id>' }
    }
    if (action === 'rollup' &&
      (projectId !== undefined || valueParts.length > 1 ||
        (valueParts.length === 1 && !['day', 'week', 'month', 'quarter', 'year'].includes(valueParts[0]!)))) {
      return { kind: 'error', value: 'Usage: /memory rollup [day|week|month|quarter|year]' }
    }
    return {
      kind: 'memory',
      action: action as Extract<SlashCommand, { kind: 'memory' }>['action'],
      ...(value ? { value } : {}),
      ...(projectId ? { projectId } : {}),
    }
  }
  if (BARE_SLASH_COMMANDS.has(cmd)) return { kind: cmd } as SlashCommand
  if (cmd === 'model')
    return arg
      ? { kind: 'model', value: arg }
      : { kind: 'error', value: 'Usage: /model <name>' }
  if (cmd === 'provider')
    return arg
      ? { kind: 'provider', value: arg }
      : { kind: 'error', value: 'Usage: /provider <name>' }
  if (cmd === 'effort') {
    if (!arg) return { kind: 'error', value: `Usage: /effort <${EFFORTS.join('|')}> (model-specific)` }
    if (!EFFORT_SET.has(arg)) return { kind: 'error', value: `Unknown effort: ${arg}` }
    return { kind: 'effort', value: arg as Effort }
  }
  if (cmd === 'mode') {
    if (!MODES.has(arg)) return { kind: 'error', value: `Unknown mode: ${arg || '(none)'}` }
    return { kind: 'mode', value: arg as PermissionMode }
  }
  if (cmd === 'tui') {
    if (!TUI_MODES.has(arg)) return { kind: 'error', value: `Usage: /tui <fullscreen|classic>` }
    return { kind: 'tui', value: arg as TuiMode }
  }
  if (cmd === 'search') {
    let page = 1
    const queryParts: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--page') {
        const rawPage = Number(rest[i + 1])
        if (!Number.isInteger(rawPage) || rawPage < 1) {
          return { kind: 'error', value: 'Usage: /search <query> [--page <n>]' }
        }
        page = rawPage
        i++
      } else {
        queryParts.push(rest[i]!)
      }
    }
    const query = queryParts.join(' ').trim()
    if (!query) return { kind: 'error', value: 'Usage: /search <query> [--page <n>]' }
    return { kind: 'search', query, page }
  }
  if (cmd === 'details') return { kind: 'details', value: arg }
  if (cmd === 'verbosity') {
    if (!['concise', 'balanced', 'detailed'].includes(arg)) {
      return { kind: 'error', value: 'Usage: /verbosity <concise|balanced|detailed>' }
    }
    return { kind: 'verbosity', value: arg as 'concise' | 'balanced' | 'detailed' }
  }
  const custom = commands?.get(cmd)
  if (custom) {
    return { kind: 'custom', name: cmd, expandedPrompt: expandCommandTemplate(custom.template, rest, arg) }
  }
  return { kind: 'error', value: `Unknown command: /${cmd}` }
}
