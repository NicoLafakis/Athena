import {
  EFFORTS,
  PROVIDER_IDS,
  normalizeProvider,
  type Effort,
  type ProviderId,
} from '../brain/models.js'
import type { PermissionMode, RunLimits, SandboxMode } from '../engine/types.js'
import type { ProjectCapability } from '../harness/trust.js'

export type AccessibilityPresentation = 'standard' | 'screen-reader'
export type VoiceModel =
  | 'gpt-realtime-2.1-mini'
  | 'gpt-realtime-2.1'
  | 'gpt-live-1.1'
  | 'gpt-live-1'

const VOICE_MODELS: readonly VoiceModel[] = [
  'gpt-live-1.1',
  'gpt-live-1',
  'gpt-realtime-2.1-mini',
  'gpt-realtime-2.1',
]
const DEFAULT_VOICE_MODEL: VoiceModel = 'gpt-live-1.1'
const SEMANTIC_MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CliCommand =
  | { command: 'run'; provider?: ProviderId; accessibility?: AccessibilityPresentation }
  | { command: 'resume'; provider?: ProviderId; accessibility?: AccessibilityPresentation }
  | { command: 'continue'; provider?: ProviderId; accessibility?: AccessibilityPresentation }
  | { command: 'help' }
  | { command: 'exec-help' }
  | { command: 'version' }
  | { command: 'doctor'; json: boolean }
  | { command: 'journal'; args: string[] }
  | {
      command: 'auth'
      sub: 'wizard' | 'status'
      provider?: ProviderId
      accessibility?: AccessibilityPresentation
    }
  | {
      command: 'voice'
      action: 'start' | 'probe' | 'auth'
      model: VoiceModel
      keyboard: boolean
      tui?: boolean
      wakeWord?: boolean
    }
  | { command: 'import'; sourceDir: string; force: boolean }
  | { command: 'trust'; revoke: boolean; capabilities: ProjectCapability[] }
  | { command: 'watch'; path?: string; statusOnly?: boolean }
  | {
      command: 'vmp'
      sub: 'report' | 'server' | 'status' | 'configure'
      url?: string
      keyHash?: string
      port?: number
    }
  | { command: 'exec'; provider?: ProviderId; options: ExecOptions }
  | {
      command: 'session'
      action: 'list' | 'checkpoints' | 'rewind' | 'fork' | 'rename' | 'search' | 'delete' | 'restore'
      args: string[]
    }
  | {
      command: 'memory'
      action: 'rebuild' | 'status' | 'timeline' | 'search' | 'show' | 'rollup' | 'rank' | 'candidates' | 'review' | 'forget' | 'hygiene'
      args: string[]
      projectId?: string
    }
  | {
      command: 'plugin'
      action: 'list' | 'install' | 'update' | 'enable' | 'disable' | 'remove' | 'verify'
      args: string[]
      requireSignature: boolean
    }
  | {
      command: 'learn'
      action:
        | 'traces'
        | 'reflect'
        | 'add'
        | 'candidates'
        | 'evaluate'
        | 'promote'
        | 'canary'
        | 'finalize'
        | 'rollback'
        | 'consolidate'
        | 'lineage'
      args: string[]
      approved: boolean
    }
  | { command: 'error'; message: string }

export function resolveAuthPresentation(
  command: Extract<CliCommand, { command: 'run' | 'resume' | 'continue' }>,
  persisted: AccessibilityPresentation,
): AccessibilityPresentation {
  return command.accessibility ?? persisted
}

export type ExecOutputMode = 'text' | 'json' | 'jsonl'

export interface ExecOptions {
  prompt: string | null
  output: ExecOutputMode
  outputSchemaFile: string | null
  persistSession: boolean
  resumeId: string | null
  permissionMode: PermissionMode
  sandboxMode: SandboxMode
  model: string | null
  effort: Effort | null
  limits: RunLimits
}

export const CLI_EXIT = {
  success: 0,
  usage: 2,
  permission: 3,
  limit: 4,
  outputSchema: 5,
  provider: 10,
  internal: 70,
  aborted: 130,
} as const

export const EXEC_USAGE =
  'Usage: athena exec [prompt] [--output text|json|jsonl] [--output-schema file] ' +
  '[--max-turns n] [--max-tool-calls n] [--max-tokens n] [--max-cost-usd n] ' +
  '[--timeout-ms n] [--max-concurrency n] [--permission-mode mode] [--sandbox mode] ' +
  '[--session|--resume id] [--provider id] [--model key] [--effort level]'

const VOICE_USAGE =
  'Usage: athena voice [probe|auth] [--model gpt-live-1.1|gpt-live-1|gpt-realtime-2.1|gpt-realtime-2.1-mini] [--keyboard] [--tui] [--wake-word]'

const AUTH_USAGE =
  `Usage: athena auth [status] [--provider <${PROVIDER_IDS.join('|')}>] ` +
  '[--accessibility screen-reader|standard]'

export const HELP_TEXT = `athena — standalone terminal coding agent

Usage:
  athena                 live full-duplex voice HUD + orbital brain scan (gpt-live-1.1)
  athena tui             classic text TUI session in the current project
  athena exec [prompt]   non-interactive run; reads stdin when prompt is omitted
  athena exec --help     automation flags and budgets
  athena --continue      resume the most recent session here
  athena --resume        pick a past session
  athena --provider <${PROVIDER_IDS.join('|')}>  session-only provider override (first-time key setup adopts it as your default)
  athena --accessibility <screen-reader|standard>  session-only presentation override
  athena auth            add/replace API keys, switch the default provider
  athena auth status     show configured providers and redacted keys
  athena voice           hands-free live voice conversation (defaults to gpt-live-1.1; sets up the OpenAI key on first run)
  athena voice --keyboard  equivalent stable-text input for keyboard/Braille use
  athena voice probe     round-trip local speech and verify the Realtime connection
  athena voice auth      replace the saved per-machine OpenAI voice key
  athena doctor          inspect credentials, trust, dependencies, sandbox, and update status
  athena vmp status      show Vibe Monitor Plus connector configuration
  athena vmp report      print the current usage report JSON for VMP
  athena vmp server      start a local HTTP server that serves the VMP report
  athena vmp configure --url <url> --key-hash <hash>  save VMP connector settings
  athena import <path>   one-time import of an ares-style brain (--force to merge)
  athena trust           trust this canonical project path
  athena trust --hooks   separately approve the current project hook definitions
  athena trust --mcp     separately approve the current project MCP definitions
  athena trust --revoke  revoke all trust for this project
  athena session list           manage durable sessions, checkpoints, rewind, and forks
  athena session delete <id>    move a session to recoverable trash and suppress its recall
  athena session restore <id>   restore a recoverable session and reindex its history
  athena memory          inspect cross-project conversation continuity
  athena memory rebuild  rebuild the local linked episode index
  athena memory search   find prior conversations by time or topic
  athena memory rank     preview ranked local continuity layers for a query
  athena memory candidates generate and list source-linked inferred candidates for review
  athena memory review   explicitly promote or reject a semantic memory candidate
  athena memory forget   erase derived semantic text while preserving its source session
  athena memory show     inspect an episode with source-linked messages
  athena memory rollup   show source-linked day/week/month/quarter/year summaries
  athena plugin list     manage installed plugins (install/update/enable/disable/remove/verify)
  athena learn candidates inspect governed learning candidates, held-out evals, canaries, and rollback
  athena journal status  inspect opt-in daily reflection, source-linked memory, relationships and budgets
  athena journal enable [--time 09:00] [--timezone America/New_York] [--no-model]  enable in-app capture/consolidation
  athena --help          this help
  athena --version       print the installed version

In-session: /help /status /repeat /details /verbosity /clear /resume /compact /model /effort /provider /mode /tui /memory /memory rank <query> /memory candidates /memory review <memory-id> <promote|reject> /memory forget <memory-id> /skills /agents /quit. Esc interrupts a turn.
Custom commands: drop a .md file (with description/argument-hint frontmatter) into .athena/commands/ or ~/.athena/commands/ to add /<name>.
Plugins: use \`athena plugin install <directory-or-git-url>\`; managed bundles can contribute namespaced skills, agents, commands, hooks, MCP, and app metadata.`

function parseNumberFlag(
  flag: string,
  raw: string | undefined,
  allowZero = false,
): number | string {
  if (raw === undefined) return `${flag} requires a value`
  const value = Number(raw)
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    return `${flag} requires ${allowZero ? 'a non-negative' : 'a positive'} number`
  }
  return value
}

function parseExecArgs(argv: string[]): CliCommand {
  const options: ExecOptions = {
    prompt: null,
    output: 'text',
    outputSchemaFile: null,
    persistSession: false,
    resumeId: null,
    permissionMode: 'normal',
    sandboxMode: 'workspace-write',
    model: null,
    effort: null,
    limits: {
      maxModelCalls: 50,
      maxToolCalls: 200,
      maxTokens: 2_000_000,
      maxCostUsd: 10,
      maxDurationMs: 30 * 60_000,
      maxConcurrency: 4,
    },
  }
  let provider: ProviderId | undefined
  const prompt: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const value = argv[index + 1]
    if (!arg.startsWith('-')) {
      prompt.push(arg)
      continue
    }
    if (arg === '--session') {
      options.persistSession = true
      continue
    }
    if (arg === '--output') {
      if (!['text', 'json', 'jsonl'].includes(value ?? '')) {
        return { command: 'error', message: '--output needs text, json, or jsonl' }
      }
      options.output = value as ExecOutputMode
      index++
      continue
    }
    if (arg === '--output-schema') {
      if (!value) return { command: 'error', message: '--output-schema requires a file' }
      options.outputSchemaFile = value
      index++
      continue
    }
    if (arg === '--resume') {
      if (!value) return { command: 'error', message: '--resume requires a session id' }
      options.resumeId = value
      options.persistSession = true
      index++
      continue
    }
    if (arg === '--provider') {
      const parsed = value ? normalizeProvider(value) : null
      if (!parsed) {
        return {
          command: 'error',
          message: `--provider needs one of: ${PROVIDER_IDS.join(', ')}`,
        }
      }
      provider = parsed
      index++
      continue
    }
    if (arg === '--model') {
      if (!value) return { command: 'error', message: '--model requires a key or model id' }
      options.model = value
      index++
      continue
    }
    if (arg === '--effort') {
      if (!value || !EFFORTS.includes(value as Effort)) {
        return { command: 'error', message: `--effort needs one of: ${EFFORTS.join(', ')}` }
      }
      options.effort = value as Effort
      index++
      continue
    }
    if (arg === '--permission-mode') {
      if (!value || !['normal', 'acceptEdits', 'plan', 'trusted'].includes(value)) {
        return { command: 'error', message: '--permission-mode needs normal, acceptEdits, plan, or trusted' }
      }
      options.permissionMode = value as PermissionMode
      index++
      continue
    }
    if (arg === '--sandbox') {
      if (!value || !['read-only', 'workspace-write', 'unrestricted'].includes(value)) {
        return { command: 'error', message: '--sandbox needs read-only, workspace-write, or unrestricted' }
      }
      options.sandboxMode = value as SandboxMode
      index++
      continue
    }
    const limitFlag: Record<string, { key: keyof RunLimits; allowZero?: boolean }> = {
      '--max-turns': { key: 'maxModelCalls' },
      '--max-tool-calls': { key: 'maxToolCalls', allowZero: true },
      '--max-tokens': { key: 'maxTokens' },
      '--max-cost-usd': { key: 'maxCostUsd' },
      '--timeout-ms': { key: 'maxDurationMs' },
      '--max-concurrency': { key: 'maxConcurrency' },
    }
    const limit = limitFlag[arg]
    if (limit) {
      const parsed = parseNumberFlag(arg, value, limit.allowZero)
      if (typeof parsed === 'string') return { command: 'error', message: parsed }
      options.limits[limit.key] = parsed
      index++
      continue
    }
    if (arg === '--help' || arg === '-h') return { command: 'exec-help' }
    return { command: 'error', message: `Unknown exec argument: ${arg}\n${EXEC_USAGE}` }
  }
  options.prompt = prompt.length > 0 ? prompt.join(' ') : null
  return { command: 'exec', provider, options }
}

function parseVoiceArgs(argv: string[]): CliCommand {
  let action: 'start' | 'probe' | 'auth' = 'start'
  let model: VoiceModel = DEFAULT_VOICE_MODEL
  let keyboard = false
  let tui = false
  let wakeWord = false
  const rest = [...argv]
  if (rest[0] === 'probe' || rest[0] === 'auth') action = rest.shift() as 'probe' | 'auth'
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!
    if (arg === '--keyboard' && action === 'start') {
      keyboard = true
      continue
    }
    if (arg === '--tui' && action === 'start') {
      tui = true
      continue
    }
    if (arg === '--wake-word' && action === 'start') {
      wakeWord = true
      continue
    }
    if (arg === '--model') {
      const value = rest[index + 1]
      if (!VOICE_MODELS.includes(value as VoiceModel)) {
        return { command: 'error', message: VOICE_USAGE }
      }
      model = value as VoiceModel
      index++
      continue
    }
    return { command: 'error', message: VOICE_USAGE }
  }
  return {
    command: 'voice',
    action,
    model,
    keyboard,
    ...(tui ? { tui: true } : {}),
    ...(wakeWord ? { wakeWord: true } : {}),
  }
}

export function parseArgs(argv: string[]): CliCommand {
  if (argv.length === 0) return parseVoiceArgs([])
  if (argv[0] === 'exec') return parseExecArgs(argv.slice(1))
  if (argv[0] === 'voice') return parseVoiceArgs(argv.slice(1))
  if (argv[0] === 'watch') {
    const statusOnly = argv.includes('--status')
    const pathArg = argv.slice(1).find((a) => !a.startsWith('-'))
    return { command: 'watch', path: pathArg, statusOnly }
  }
  if (argv[0] === 'vmp') {
    const sub = argv[1] ?? 'status'
    const actions = new Set(['report', 'server', 'status', 'configure'])
    if (!actions.has(sub)) {
      return {
        command: 'error',
        message: 'Usage: athena vmp <report|server|status|configure> [--url <url>] [--key-hash <hash>] [--port <n>]',
      }
    }
    const rest = argv.slice(2)
    let url: string | undefined
    let keyHash: string | undefined
    let port = 8080
    for (let index = 0; index < rest.length;) {
      const flag = rest[index]
      const value = rest[index + 1]
      if (flag === '--url') {
        if (!value) return { command: 'error', message: '--url requires a value' }
        url = value
        rest.splice(index, 2)
        continue
      }
      if (flag === '--key-hash') {
        if (!value) return { command: 'error', message: '--key-hash requires a value' }
        keyHash = value
        rest.splice(index, 2)
        continue
      }
      if (flag === '--port') {
        const parsed = value ? Number(value) : Number.NaN
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
          return { command: 'error', message: '--port requires a valid port number' }
        }
        port = parsed
        rest.splice(index, 2)
        continue
      }
      return { command: 'error', message: `Unknown vmp argument: ${flag}` }
    }
    if (sub === 'configure' && (!url || !keyHash)) {
      return {
        command: 'error',
        message: 'Usage: athena vmp configure --url <report-url> --key-hash <sha256-hash>',
      }
    }
    return { command: 'vmp', sub: sub as Extract<CliCommand, { command: 'vmp' }>['sub'], url, keyHash, port }
  }
  if (argv[0] === 'doctor') {
    const unknown = argv.slice(1).find((arg) => arg !== '--json')
    return unknown
      ? { command: 'error', message: `Unknown doctor argument: ${unknown}` }
      : { command: 'doctor', json: argv.includes('--json') }
  }
  if (argv[0] === 'journal') return { command: 'journal', args: argv.slice(1) }
  if (argv[0] === 'learn') {
    const action = argv[1] ?? 'candidates'
    const actions = new Set([
      'traces',
      'reflect',
      'add',
      'candidates',
      'evaluate',
      'promote',
      'canary',
      'finalize',
      'rollback',
      'consolidate',
      'lineage',
    ])
    if (!actions.has(action)) {
      return {
        command: 'error',
        message:
          'Usage: athena learn <traces|reflect|add|candidates|evaluate|promote|canary|finalize|rollback|consolidate|lineage>',
      }
    }
    const rest = argv.slice(2)
    const unknown = rest.find((arg) => arg.startsWith('--') && arg !== '--approve')
    if (unknown) return { command: 'error', message: `Unknown learn argument: ${unknown}` }
    return {
      command: 'learn',
      action: action as Extract<CliCommand, { command: 'learn' }>['action'],
      args: rest.filter((arg) => arg !== '--approve'),
      approved: rest.includes('--approve'),
    }
  }
  if (argv[0] === 'plugin') {
    const action = argv[1] ?? 'list'
    const actions = new Set(['list', 'install', 'update', 'enable', 'disable', 'remove', 'verify'])
    if (!actions.has(action)) {
      return {
        command: 'error',
        message: 'Usage: athena plugin <list|install|update|enable|disable|remove|verify> [source|id]',
      }
    }
    const rest = argv.slice(2)
    const unknown = rest.find((arg) => arg.startsWith('--') && arg !== '--require-signature')
    if (unknown) return { command: 'error', message: `Unknown plugin argument: ${unknown}` }
    return {
      command: 'plugin',
      action: action as Extract<CliCommand, { command: 'plugin' }>['action'],
      args: rest.filter((arg) => arg !== '--require-signature'),
      requireSignature: rest.includes('--require-signature'),
    }
  }
  if (argv[0] === 'session') {
    const action = argv[1] ?? 'list'
    const actions = new Set(['list', 'checkpoints', 'rewind', 'fork', 'rename', 'search', 'delete', 'restore'])
    if (!actions.has(action)) {
      return {
        command: 'error',
        message: 'Usage: athena session <list|checkpoints|rewind|fork|rename|search|delete|restore> [args]',
      }
    }
    return {
      command: 'session',
      action: action as Extract<CliCommand, { command: 'session' }>['action'],
      args: argv.slice(2),
    }
  }
  if (argv[0] === 'memory') {
    const action = argv[1] ?? 'status'
    const actions = new Set(['rebuild', 'status', 'timeline', 'search', 'show', 'rollup', 'rank', 'candidates', 'review', 'forget', 'hygiene'])
    if (!actions.has(action)) {
      return {
        command: 'error',
        message: 'Usage: athena memory <rebuild|status|timeline|search|rank|show|rollup|candidates|review|forget|hygiene> [query|episode-id|granularity|memory-id] [--project <project-id>]',
      }
    }
    const args: string[] = []
    let projectId: string | undefined
    const rest = argv.slice(2)
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!
      if (arg === '--project') {
        const value = rest[index + 1]
        if (!value || value.startsWith('--')) return { command: 'error', message: '--project requires a project ID' }
        projectId = value
        index++
      } else if (action === 'review' && (arg === '--list' || arg === '--keep' || arg === '--tombstone')) {
        args.push(arg)
      } else if (arg.startsWith('--')) {
        return { command: 'error', message: `Unknown memory argument: ${arg}` }
      } else {
        args.push(arg)
      }
    }
    if (['rebuild', 'status', 'hygiene'].includes(action) && args.length > 0) {
      return { command: 'error', message: `Usage: athena memory ${action}` }
    }
    if (action === 'candidates' && (projectId !== undefined || args.length > 0)) {
      return { command: 'error', message: 'Usage: athena memory candidates' }
    }
    if (action === 'review') {
      const isFreeTextFlag =
        (args[0] === '--list' && args.length === 1) ||
        (args[0] === '--keep' && args.length === 2) ||
        (args[0] === '--tombstone' && args.length >= 2)
      const isSemanticReview =
        args.length === 2 && SEMANTIC_MEMORY_ID.test(args[0]!) && ['promote', 'reject'].includes(args[1]!)
      if (projectId !== undefined || (!isFreeTextFlag && !isSemanticReview)) {
        return {
          command: 'error',
          message: 'Usage: athena memory review <memory-id> <promote|reject> | --list | --keep <path> | --tombstone <path> [reason]',
        }
      }
    }
    if (action === 'forget' && (
      projectId !== undefined || args.length !== 1 || !SEMANTIC_MEMORY_ID.test(args[0]!)
    )) {
      return { command: 'error', message: 'Usage: athena memory forget <memory-id>' }
    }
    if (action === 'show' && args.length !== 1) {
      return { command: 'error', message: 'Usage: athena memory show <episode-id>' }
    }
    if (action === 'search' && args.length === 0) {
      return { command: 'error', message: 'Usage: athena memory search <query> [--project <project-id>]' }
    }
    if (action === 'rank' && args.length === 0) {
      return { command: 'error', message: 'Usage: athena memory rank <query> [--project <project-id>]' }
    }
    if (action === 'rollup' &&
      (projectId !== undefined || args.length > 1 || (args.length === 1 && !['day', 'week', 'month', 'quarter', 'year'].includes(args[0]!)))) {
      return { command: 'error', message: 'Usage: athena memory rollup [day|week|month|quarter|year]' }
    }
    return {
      command: 'memory',
      action: action as Extract<CliCommand, { command: 'memory' }>['action'],
      args,
      ...(projectId ? { projectId } : {}),
    }
  }
  if (argv[0] === 'trust') {
    const known = new Set(['--revoke', '--hooks', '--mcp', '--all'])
    const unknown = argv.slice(1).find((arg) => !known.has(arg))
    if (unknown) return { command: 'error', message: `Unknown trust argument: ${unknown}` }
    if (argv.includes('--revoke') && argv.some((arg) => ['--hooks', '--mcp', '--all'].includes(arg))) {
      return { command: 'error', message: 'Usage: athena trust [--hooks|--mcp|--all] | --revoke' }
    }
    const capabilities: ProjectCapability[] = []
    if (argv.includes('--hooks') || argv.includes('--all')) capabilities.push('hooks')
    if (argv.includes('--mcp') || argv.includes('--all')) capabilities.push('mcp')
    return { command: 'trust', revoke: argv.includes('--revoke'), capabilities }
  }
  if (argv[0] === 'import') {
    const sourceDir = argv[1]
    if (!sourceDir || sourceDir.startsWith('--')) {
      return { command: 'error', message: 'Usage: athena import <path> [--force]' }
    }
    return { command: 'import', sourceDir, force: argv.includes('--force') }
  }
  if (argv[0] === 'auth') {
    let sub: 'wizard' | 'status' = 'wizard'
    let provider: ProviderId | undefined
    let accessibility: AccessibilityPresentation | undefined
    const rest = argv.slice(1)

    if (rest[0] === 'status') {
      sub = 'status'
      rest.shift()
    }

    for (let index = 0; index < rest.length;) {
      const flag = rest[index]
      const value = rest[index + 1]
      if (flag === '--provider') {
        if (sub === 'status' || !value) return { command: 'error', message: AUTH_USAGE }
        const parsed = normalizeProvider(value)
        if (!parsed) {
          return { command: 'error', message: `--provider needs one of: ${PROVIDER_IDS.join(', ')}` }
        }
        provider = parsed
        rest.splice(index, 2)
        continue
      }
      if (flag === '--accessibility') {
        if (sub === 'status' || (value !== 'screen-reader' && value !== 'standard')) {
          return { command: 'error', message: AUTH_USAGE }
        }
        accessibility = value
        rest.splice(index, 2)
        continue
      }
      index++
    }

    if (rest.length > 0) return { command: 'error', message: AUTH_USAGE }

    return {
      command: 'auth',
      sub,
      ...(provider ? { provider } : {}),
      ...(accessibility ? { accessibility } : {}),
    }
  }
  const rest = argv[0] === 'tui' ? argv.slice(1) : [...argv]
  let provider: ProviderId | undefined
  let accessibility: AccessibilityPresentation | undefined
  const pi = rest.indexOf('--provider')
  if (pi !== -1) {
    const value = rest[pi + 1]
    const p = value ? normalizeProvider(value) : null
    if (!p) return { command: 'error', message: `--provider needs one of: ${PROVIDER_IDS.join(', ')}` }
    provider = p
    rest.splice(pi, 2)
  }
  const ai = rest.indexOf('--accessibility')
  if (ai !== -1) {
    const value = rest[ai + 1]
    if (value !== 'screen-reader' && value !== 'standard') {
      return { command: 'error', message: '--accessibility needs screen-reader or standard' }
    }
    accessibility = value
    rest.splice(ai, 2)
  }
  const known = new Set(['--help', '-h', '--version', '-v', '--resume', '--continue'])
  const unknown = rest.find((a) => !known.has(a))
  if (unknown) return { command: 'error', message: `Unknown argument: ${unknown} (try --help)` }
  if (rest.includes('--help') || rest.includes('-h')) return { command: 'help' }
  if (rest.includes('--version') || rest.includes('-v')) return { command: 'version' }
  if (rest.includes('--resume')) return { command: 'resume', provider, ...(accessibility ? { accessibility } : {}) }
  if (rest.includes('--continue')) return { command: 'continue', provider, ...(accessibility ? { accessibility } : {}) }
  return { command: 'run', provider, ...(accessibility ? { accessibility } : {}) }
}
