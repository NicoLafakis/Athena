// src/cli.ts — composition root: brain + engine + harness + TUI.
import { execSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { render } from 'ink'
import React from 'react'
import { resolveBrainPaths } from './brain/paths.js'
import { loadSettings, readProjectSettingsCapabilities } from './brain/settings.js'
import {
  normalizeModel,
  modelCapabilities,
  modelLabel,
  modelKeys,
  supportsEffort,
  EFFORTS,
  PROVIDERS,
  PROVIDER_IDS,
  normalizeProvider,
  type ProviderId,
  type Effort,
} from './brain/models.js'
import {
  loadCredentials,
  resolveApiKey,
  formatAuthStatus,
  migrateCredentialsToVault,
  type Credentials,
} from './brain/credentials.js'
import {
  createCredentialVault,
  formatCredentialVaultStatus,
  type CredentialVault,
} from './brain/credential-vault.js'
import { promptMasked, runAuthWizard, terminalIO } from './auth/wizard.js'
import { ClientHolder } from './engine/client-holder.js'
import { loadConstitution, loadMemoryIndex } from './brain/loader.js'
import {
  loadSkillsIndexWithPlugins,
  loadAgentsIndexWithPlugins,
  loadCommandsIndexWithPlugins,
  loadPluginRuntimeExtensions,
} from './brain/plugins.js'
import { importBrain } from './brain/import.js'
import { ensureBrainScaffold } from './harness/bootstrap.js'
import { PermissionEngine } from './harness/permissions.js'
import { ResourcePolicy } from './harness/resource-policy.js'
import {
  ProjectTrustStore,
  capabilityDigest,
  canonicalProjectPath,
  projectId,
  type ProjectCapability,
} from './harness/trust.js'
import { HookRunner } from './harness/hooks.js'
import { McpManager } from './harness/mcp.js'
import { Session, SessionStore, type SessionInfo } from './harness/sessions.js'
import { RunTraceWriter } from './harness/traces.js'
import { AgentOrchestrator } from './harness/agents.js'
import { PluginManager } from './harness/plugins.js'
import { Engine } from './engine/loop.js'
import { AnthropicClient } from './engine/client.js'
import type { ModelClient } from './engine/client.js'
import { FixtureModelClient } from './engine/fixture-client.js'
import { EngineEventBus } from './engine/events.js'
import {
  InteractionEventAdapter,
  InteractionService,
  type InteractionEventEnvelope,
} from './interaction/index.js'
import { createInteractionSnapshot } from './interaction/state.js'
import {
  captureExperienceBestEffort,
  ExperienceStore,
  retrieveGuidance,
} from './experience/index.js'
import { ContextManager } from './engine/context.js'
import { assembleSystemPrompt, findProjectContextFiles } from './engine/prompt.js'
import type { BrainPaths } from './brain/paths.js'
import type { ToolContext, ToolDefinition } from './engine/types.js'
import type { PermissionMode, RunLimits, SandboxMode } from './engine/types.js'
import { validateJsonOutput } from './engine/output-schema.js'
import { ToolRegistry } from './tools/registry.js'
import {
  readTool,
  writeTool,
  editTool,
  applyPatchTool,
  readImageTool,
  notebookEditTool,
  diagnosticsTool,
  globTool,
  grepTool,
  bashTool,
  powershellTool,
  taskOutputTool,
  todoTool,
  statusUpdateTool,
  memoryTool,
  webfetchTool,
  websearchTool,
  shutdownBackgroundTasks,
} from './tools/index.js'
import { makeSkillTool } from './tools/skill.js'
import { makeAgentTool } from './tools/agent.js'
import { App, PermissionBridge } from './tui/App.js'
import { SessionPicker } from './tui/components/SessionPicker.js'
import { parseSlash, type SlashCommand } from './tui/slash.js'
import {
  ReadlineLineInput,
  ScreenReaderPresentation,
  createAccessiblePermissionRequest,
  formatPermissionDiffDetail,
  permissionDiff,
  permissionDiffStats,
} from './presentation/index.js'
import type { LineInput } from './presentation/index.js'
import { getVersion } from './version.js'
import { admitCandidate, CandidateStore, reflectTraces } from './learning/candidates.js'
import { LearningEvaluator } from './learning/evaluation.js'
import { LearningMemoryStore } from './learning/memory.js'
import { PromotionManager } from './learning/promotion.js'
import { TraceWarehouse } from './learning/warehouse.js'
import { collectDiagnostics, formatDiagnostics } from './harness/diagnostics.js'
import { stalenessBootWarnings } from './harness/staleness.js'
export type AccessibilityPresentation = 'standard' | 'screen-reader'
export type VoiceModel = 'gpt-realtime-2.1-mini' | 'gpt-realtime-2.1'

const VOICE_MODELS: readonly VoiceModel[] = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1']
const DEFAULT_VOICE_MODEL: VoiceModel = 'gpt-realtime-2.1-mini'

export type CliCommand =
  | { command: 'run'; provider?: ProviderId; accessibility?: AccessibilityPresentation }
  | { command: 'resume'; provider?: ProviderId; accessibility?: AccessibilityPresentation }
  | { command: 'continue'; provider?: ProviderId; accessibility?: AccessibilityPresentation }
  | { command: 'help' }
  | { command: 'exec-help' }
  | { command: 'version' }
  | { command: 'doctor'; json: boolean }
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
    }
  | { command: 'import'; sourceDir: string; force: boolean }
  | { command: 'trust'; revoke: boolean; capabilities: ProjectCapability[] }
  | { command: 'exec'; provider?: ProviderId; options: ExecOptions }
  | {
      command: 'session'
      action: 'list' | 'checkpoints' | 'rewind' | 'fork' | 'rename' | 'search' | 'delete'
      args: string[]
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
  effort: Effort
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

const EXEC_USAGE =
  'Usage: athena exec [prompt] [--output text|json|jsonl] [--output-schema file] ' +
  '[--max-turns n] [--max-tool-calls n] [--max-tokens n] [--max-cost-usd n] ' +
  '[--timeout-ms n] [--max-concurrency n] [--permission-mode mode] [--sandbox mode] ' +
  '[--session|--resume id] [--provider id] [--model key] [--effort level]'

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
    effort: 'high',
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

const VOICE_USAGE =
  'Usage: athena voice [probe|auth] [--model gpt-realtime-2.1-mini|gpt-realtime-2.1] [--keyboard]'

function parseVoiceArgs(argv: string[]): CliCommand {
  let action: 'start' | 'probe' | 'auth' = 'start'
  let model: VoiceModel = DEFAULT_VOICE_MODEL
  let keyboard = false
  const rest = [...argv]
  if (rest[0] === 'probe' || rest[0] === 'auth') action = rest.shift() as 'probe' | 'auth'
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!
    if (arg === '--keyboard' && action === 'start') {
      keyboard = true
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
  return { command: 'voice', action, model, keyboard }
}

export function parseArgs(argv: string[]): CliCommand {
  if (argv[0] === 'exec') return parseExecArgs(argv.slice(1))
  if (argv[0] === 'voice') return parseVoiceArgs(argv.slice(1))
  if (argv[0] === 'doctor') {
    const unknown = argv.slice(1).find((arg) => arg !== '--json')
    return unknown
      ? { command: 'error', message: `Unknown doctor argument: ${unknown}` }
      : { command: 'doctor', json: argv.includes('--json') }
  }
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
    const actions = new Set(['list', 'checkpoints', 'rewind', 'fork', 'rename', 'search', 'delete'])
    if (!actions.has(action)) {
      return {
        command: 'error',
        message: 'Usage: athena session <list|checkpoints|rewind|fork|rename|search|delete> [args]',
      }
    }
    return {
      command: 'session',
      action: action as Extract<CliCommand, { command: 'session' }>['action'],
      args: argv.slice(2),
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
    if (!sourceDir || sourceDir.startsWith('--'))
      return { command: 'error', message: 'Usage: athena import <path> [--force]' }
    return { command: 'import', sourceDir, force: argv.includes('--force') }
  }
  if (argv[0] === 'auth') {
    let sub: 'wizard' | 'status' = 'wizard'
    let provider: ProviderId | undefined
    let accessibility: AccessibilityPresentation | undefined
    const rest = argv.slice(1)

    // Check for 'status' subcommand
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

    // Check for unexpected remaining args
    if (rest.length > 0) return { command: 'error', message: AUTH_USAGE }

    return {
      command: 'auth',
      sub,
      ...(provider ? { provider } : {}),
      ...(accessibility ? { accessibility } : {}),
    }
  }
  const rest = [...argv]
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

const AUTH_USAGE =
  `Usage: athena auth [status] [--provider <${PROVIDER_IDS.join('|')}>] ` +
  '[--accessibility screen-reader|standard]'

const HELP_TEXT = `athena — standalone terminal coding agent

Usage:
  athena                 new session in the current project
  athena exec [prompt]   non-interactive run; reads stdin when prompt is omitted
  athena exec --help     automation flags and budgets
  athena --continue      resume the most recent session here
  athena --resume        pick a past session
  athena --provider <${PROVIDER_IDS.join('|')}>  session-only provider override (first-time key setup adopts it as your default)
  athena --accessibility <screen-reader|standard>  session-only presentation override
  athena auth            add/replace API keys, switch the default provider
  athena auth status     show configured providers and redacted keys
  athena voice           listen locally for “Athena”, then use the OpenAI Realtime conductor
  athena voice --keyboard  equivalent stable-text input for keyboard/Braille use
  athena voice probe     round-trip local speech and verify the Realtime connection
  athena voice auth      securely save the per-machine OpenAI voice key
  athena doctor          inspect credentials, trust, dependencies, sandbox, and update status
  athena import <path>   one-time import of an ares-style brain (--force to merge)
  athena trust           trust this canonical project path
  athena trust --hooks   separately approve the current project hook definitions
  athena trust --mcp     separately approve the current project MCP definitions
  athena trust --revoke  revoke all trust for this project
  athena session list    manage durable sessions, checkpoints, rewind, and forks
  athena plugin list     manage installed plugins (install/update/enable/disable/remove/verify)
  athena learn candidates inspect governed learning candidates, held-out evals, canaries, and rollback
  athena --help          this help
  athena --version       print the installed version

In-session: /help /status /repeat /details /verbosity /clear /resume /compact /model /effort /provider /mode /tui /memory /skills /agents /quit. Esc interrupts a turn.
Custom commands: drop a .md file (with description/argument-hint frontmatter) into .athena/commands/ or ~/.athena/commands/ to add /<name>.
Plugins: use \`athena plugin install <directory-or-git-url>\`; managed bundles can contribute namespaced skills, agents, commands, hooks, MCP, and app metadata.`

function gitBranch(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return null
  }
}

/** `athena --resume` picker: renders a select list before mounting the App. Null = fresh session. */
function pickSession(sessions: SessionInfo[]): Promise<SessionInfo | null> {
  if (sessions.length === 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    const instance = render(
      React.createElement(SessionPicker, {
        sessions,
        onSelect: (s: SessionInfo) => {
          instance.unmount()
          resolve(s)
        },
        onCancel: () => {
          instance.unmount()
          resolve(null)
        },
      }),
    )
  })
}

/** Append-only equivalent of the Ink session picker. Empty input starts fresh. */
export async function pickSessionLine(
  sessions: SessionInfo[],
  input: LineInput,
  write: (line: string) => void = (line) => console.log(line),
): Promise<SessionInfo | null> {
  if (sessions.length === 0) return null
  const visible = sessions.slice(0, 20)
  write('Status: Choose a session by number, or press Enter for a fresh session.')
  visible.forEach((session, index) => {
    write(`${index + 1}. ${session.updatedAt.toISOString()} ${session.title}`)
  })
  for (;;) {
    const answer = (await input.readLine('Session: ')).trim()
    if (answer === '' || answer.toLowerCase() === 'q') return null
    const selected = visible[Number(answer) - 1]
    if (selected) return selected
    write(`Status: Enter a number from 1 to ${visible.length}, or press Enter for fresh.`)
  }
}

export type ScreenReaderCommandRoute =
  | 'shared-handler'
  | 'append-only-clear'
  | 'presentation-change'
  | 'exit'
  | 'submit-prompt'

/** Pure routing contract used by the append-only loop and parity tests. */
export function screenReaderCommandRoute(command: SlashCommand): ScreenReaderCommandRoute {
  if (command.kind === 'quit') return 'exit'
  if (command.kind === 'clear') return 'append-only-clear'
  if (command.kind === 'tui') return 'presentation-change'
  if (command.kind === 'custom') return 'submit-prompt'
  return 'shared-handler'
}

export interface ScreenReaderInterruptDependencies {
  abort(): void
  cancelInput(): boolean
  acknowledge(accepted: boolean): void
  closeInput(): void
}

/** Pure control handoff: active work cancels; idle input exits the line session. */
export function handleScreenReaderInterrupt(
  activeTurn: boolean,
  dependencies: ScreenReaderInterruptDependencies,
): 'turn-cancelled' | 'session-exit' {
  if (activeTurn) {
    dependencies.abort()
    dependencies.cancelInput()
    dependencies.acknowledge(true)
    return 'turn-cancelled'
  }
  dependencies.closeInput()
  return 'session-exit'
}

interface SlashDeps {
  bus: EngineEventBus
  engine: Engine
  gate: PermissionEngine
  contextManager: ContextManager
  client: ClientHolder
  store: SessionStore
  session: Session | null
  paths: BrainPaths
  credentialVault: CredentialVault
  interactionService?: InteractionService
  runId?: string
  permissionDetails?: (id: string) => string | null
  commands?: ReadonlyMap<string, { description: string; argumentHint: string | null }>
}

export function makeSlashHandler(deps: SlashDeps): (cmd: SlashCommand) => void {
  const {
    bus,
    engine,
    gate,
    contextManager,
    client,
    store,
    session,
    paths,
    credentialVault,
    interactionService,
    runId,
    permissionDetails,
    commands,
  } = deps
  const info = (message: string) => bus.emit({ type: 'info', message })
  return (cmd) => {
    switch (cmd.kind) {
      case 'help': {
        const customList =
          commands && commands.size > 0
            ? '\nCustom: ' +
              [...commands.entries()]
                .map(([name, c]) => `/${name}${c.argumentHint ? ` ${c.argumentHint}` : ''} - ${c.description}`)
                .join(', ')
            : ''
        info(
          `Commands: /help /status /repeat /details /verbosity <concise|balanced|detailed> /clear /resume /compact /model <${modelKeys(engine.getProvider()).join('|')}> /effort <low|medium|high|xhigh|max> /provider <${PROVIDER_IDS.join('|')}> /mode <normal|acceptEdits|plan|trusted> /tui <fullscreen|classic> /memory /skills /agents /quit\n` +
            '/clear clears the screen (transcript display only) — conversation context is unchanged; use /compact to shrink it.\n' +
            '/tui fullscreen switches to an alternate-screen buffer with a pinned input (like vim/htop); /tui classic returns to normal scrollback.\n' +
            '/model /provider /effort /mode /tui run with no argument open a picker to choose a value instead of requiring you to type one.' +
            customList,
        )
        break
      }
      case 'status':
        info(interactionService && runId
          ? interactionService.status(runId)
          : 'Status: semantic state is unavailable.')
        break
      case 'repeat':
        info(interactionService && runId
          ? interactionService.repeat(runId)
          : 'No material announcement is available. Use /status.')
        break
      case 'details': {
        const permissionMatch = /^permission\s+(.+)$/.exec(cmd.value)
        const permission = permissionMatch ? permissionDetails?.(permissionMatch[1]!) : null
        info(permission ?? (interactionService && runId
          ? interactionService.details(runId)
          : 'No material detail is available. Use /status.'))
        break
      }
      case 'verbosity': {
        const verbosity = cmd.value === 'concise' ? 'quiet' : cmd.value === 'detailed' ? 'verbose' : 'balanced'
        interactionService?.setVerbosity(verbosity)
        info(`Status: Announcement verbosity is ${cmd.value} for this session.`)
        break
      }
      case 'mode':
        gate.setMode(cmd.value)
        bus.emit({ type: 'status', patch: { mode: cmd.value } })
        info(`Permission mode: ${cmd.value}`)
        break
      case 'model': {
        const provider = engine.getProvider()
        const key = normalizeModel(provider, cmd.value)
        if (!key) {
          info(`Unknown model: ${cmd.value} (valid for ${provider}: ${modelKeys(provider).join(', ')})`)
          break
        }
        engine.setModel(key)
        bus.emit({ type: 'status', patch: { model: modelLabel(provider, key), modelKey: key } })
        info(
          supportsEffort(provider, key)
            ? `Model: ${modelLabel(provider, key)} (effort ${engine.getEffort()})`
            : `Model: ${modelLabel(provider, key)} - effort/extended thinking not applicable on this model.`,
        )
        break
      }
      case 'provider': {
        const p = normalizeProvider(cmd.value)
        if (!p) {
          info(`Unknown provider: ${cmd.value}, choose ${PROVIDER_IDS.join(' or ')}.`)
          break
        }
        if (p === engine.getProvider()) {
          info(`Already on ${PROVIDERS[p].label}.`)
          break
        }
        let resolved
        // Every resolveApiKey call site must pass a warning sink: a vault read that
        // fails (the cross-machine DPAPI blob case) resolves as "no key" plus a warning
        // instead of throwing, so without a sink the specific, actionable message is
        // swallowed and the user is told the key is simply "not configured".
        // Boot-time sites warn on stderr; inside a mounted TUI stderr is unreadable, so
        // the sink is the same transcript channel every other slash message uses.
        let vaultWarned = false
        const warnCredentials = (message: string): void => {
          vaultWarned = true
          info(message)
        }
        try {
          resolved = resolveApiKey(p, loadCredentials(paths), process.env, credentialVault, warnCredentials)
        } catch (err) {
          info((err as Error).message)
          break
        }
        if (!resolved && vaultWarned) {
          // The warning already named the cause and the fix (`athena auth`); adding the
          // generic "not configured" line on top of it would contradict it.
          break
        }
        if (!resolved) {
          info(
            `No API key configured for ${PROVIDERS[p].label}. Run \`athena auth\` (or restart with \`athena --provider ${p}\`) to add one.`,
          )
          break
        }
        client.swap(makeClient(p, resolved.key))
        engine.setProvider(p)
        engine.setModel(PROVIDERS[p].defaultModel)
        bus.emit({
          type: 'status',
          patch: { model: modelLabel(p, PROVIDERS[p].defaultModel), modelKey: PROVIDERS[p].defaultModel, provider: p },
        })
        info(
          `Provider: ${PROVIDERS[p].label}, model ${modelLabel(p, PROVIDERS[p].defaultModel)} (session-only; \`athena auth\` changes the default).`,
        )
        break
      }
      case 'effort': {
        engine.setEffort(cmd.value)
        bus.emit({ type: 'status', patch: { effort: cmd.value } })
        const provider = engine.getProvider()
        const key = engine.getModel()
        info(
          supportsEffort(provider, key)
            ? `Effort: ${cmd.value}`
            : `Effort set to ${cmd.value} - ${modelLabel(provider, key)} ignores it.`,
        )
        break
      }
      case 'compact':
        void (async () => {
          try {
            const { messages, summary } = await contextManager.compact(engine.getMessages(), (p) =>
              client.complete({ model: engine.getModelId(), prompt: p, maxTokens: 2048 }),
            )
            if (summary === '') {
              info('Nothing to compact yet.')
              return
            }
            engine.loadMessages(messages)
            session?.rewriteOrAppend(messages)
            bus.emit({ type: 'compaction', summary })
          } catch (err) {
            bus.emit({
              type: 'error',
              message: `Compaction failed: ${(err as Error).message}`,
              fatal: false,
            })
          }
        })()
        break
      case 'memory':
        info(loadMemoryIndex(paths) ?? '(no memory index)')
        break
      case 'skills': {
        const skills = loadSkillsIndexWithPlugins(paths)
        info(
          skills.length > 0
            ? skills.map((s) => `${s.name} — ${s.description}`).join('\n')
            : '(no skills defined)',
        )
        break
      }
      case 'agents': {
        const agents = loadAgentsIndexWithPlugins(paths)
        info(
          agents.length > 0
            ? agents.map((a) => `${a.name} — ${a.description}`).join('\n')
            : '(no agents defined)',
        )
        break
      }
      case 'resume': {
        const sessions = store.list().slice(0, 10)
        info(
          sessions.length > 0
            ? 'Recent sessions (restart with --resume to pick one):\n' +
                sessions
                  .map((s) => `${s.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} ${s.title}`)
                  .join('\n')
            : '(no sessions for this project yet)',
        )
        break
      }
      case 'error':
        info(cmd.value)
        break
      default:
        // 'clear', 'quit', and 'tui' are handled inside the App component.
        break
    }
  }
}

function makeClient(provider: ProviderId, key: string): ModelClient {
  const fixture = process.env['ATHENA_TEST_MODEL_SCRIPT']
  if (process.env['NODE_ENV'] === 'test' && fixture) return new FixtureModelClient(fixture)
  return new AnthropicClient(key, PROVIDERS[provider].baseURL ?? undefined, PROVIDERS[provider].authMode)
}

function describeCapability(
  capability: ProjectCapability,
  value: unknown,
): string {
  if (capability === 'hooks') {
    const hooks = Array.isArray(value) ? value : []
    return hooks
      .map((hook) => {
        const item = hook as Record<string, unknown>
        return `  ${String(item['event'] ?? '?')}: ${String(item['command'] ?? '?')}`
      })
      .join('\n')
  }
  return Object.entries((value ?? {}) as Record<string, unknown>)
    .map(([name, raw]) => {
      const item = (raw ?? {}) as Record<string, unknown>
      const args = Array.isArray(item['args']) ? item['args'].map(String) : []
      const envNames = Object.keys((item['env'] ?? {}) as Record<string, unknown>)
      return `  ${name}: ${String(item['command'] ?? '?')} ${args.join(' ')}\n    cwd: ${process.cwd()}\n    env names: ${envNames.join(', ') || '(none)'}`
    })
    .join('\n')
}

async function confirm(question: string): Promise<boolean> {
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    reader.close()
  }
}

async function resolveProjectTrust(
  paths: BrainPaths,
  cwd: string,
): Promise<{
  trusted: boolean
  allowProjectHooks: boolean
  allowProjectMcp: boolean
}> {
  if (!paths.projectBrainDir) {
    return { trusted: true, allowProjectHooks: true, allowProjectMcp: true }
  }
  const store = new ProjectTrustStore(paths.trustFile)
  let trusted = store.isTrusted(cwd)
  if (!trusted) {
    trusted = await confirm(
      `Trust project ${canonicalProjectPath(cwd)}? Project instructions and extensions are ignored until trusted.`,
    )
    if (trusted) store.trust(cwd)
  }
  if (!trusted) return { trusted: false, allowProjectHooks: false, allowProjectMcp: false }

  const capabilities = readProjectSettingsCapabilities(paths)
  const approved: Record<ProjectCapability, boolean> = { hooks: true, mcp: true }
  for (const capability of ['hooks', 'mcp'] as const) {
    const value = capability === 'hooks' ? capabilities.hooks : capabilities.mcpServers
    const present = capability === 'hooks'
      ? capabilities.hooks.length > 0
      : Object.keys(capabilities.mcpServers).length > 0
    if (!present) continue
    const digest = capabilityDigest(value)
    if (store.isCapabilityApproved(cwd, capability, digest)) continue
    const details = describeCapability(capability, value)
    const accepted = await confirm(
      `Approve project ${capability.toUpperCase()} configuration?\n${details}\nApproval is invalidated when it changes.`,
    )
    approved[capability] = accepted
    if (accepted) store.approveCapability(cwd, capability, digest)
  }
  return {
    trusted,
    allowProjectHooks: approved.hooks,
    allowProjectMcp: approved.mcp,
  }
}

function resolveStoredProjectTrust(
  paths: BrainPaths,
  cwd: string,
): {
  trusted: boolean
  allowProjectHooks: boolean
  allowProjectMcp: boolean
} {
  if (!paths.projectBrainDir) {
    return { trusted: true, allowProjectHooks: true, allowProjectMcp: true }
  }
  const store = new ProjectTrustStore(paths.trustFile)
  const trusted = store.isTrusted(cwd)
  if (!trusted) return { trusted: false, allowProjectHooks: false, allowProjectMcp: false }
  const capabilities = readProjectSettingsCapabilities(paths)
  return {
    trusted: true,
    allowProjectHooks:
      capabilities.hooks.length === 0 ||
      store.isCapabilityApproved(cwd, 'hooks', capabilityDigest(capabilities.hooks)),
    allowProjectMcp:
      Object.keys(capabilities.mcpServers).length === 0 ||
      store.isCapabilityApproved(cwd, 'mcp', capabilityDigest(capabilities.mcpServers)),
  }
}

function finalAssistantText(messages: MessageParam[]): string {
  const message = [...messages].reverse().find((item) => item.role === 'assistant')
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

async function readStdin(): Promise<string> {
  let value = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) value += chunk
  return value
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const paths = resolveBrainPaths({ cwd })
  const cmd = parseArgs(process.argv.slice(2))

  if (cmd.command === 'error') {
    console.error(cmd.message)
    process.exitCode = CLI_EXIT.usage
    return
  }
  if (cmd.command === 'help') {
    console.log(HELP_TEXT)
    return
  }
  if (cmd.command === 'exec-help') {
    console.log(EXEC_USAGE)
    return
  }
  if (cmd.command === 'version') {
    console.log(getVersion())
    return
  }
  if (cmd.command === 'doctor') {
    const report = collectDiagnostics(paths, cwd, getVersion())
    console.log(cmd.json ? JSON.stringify(report, null, 2) : formatDiagnostics(report))
    process.exitCode = report.checks.some((check) => check.status === 'error') ? 1 : 0
    return
  }
  if (cmd.command === 'import') {
    try {
      const report = await importBrain({ sourceDir: cmd.sourceDir, paths, force: cmd.force })
      console.log(
        `Imported ${report.copied.length} files (${report.rewritten.length} rewritten, ${report.flagged.length} flagged).`,
      )
      console.log(`Report: ${paths.brainDir}/import-report.md`)
    } catch (err) {
      console.error(`Import failed: ${(err as Error).message}`)
      process.exitCode = 1
    }
    return
  }
  if (cmd.command === 'trust') {
    if (!paths.projectBrainDir) {
      console.error(`No .athena project configuration exists in ${cwd}`)
      process.exitCode = 1
      return
    }
    const store = new ProjectTrustStore(paths.trustFile)
    if (cmd.revoke) {
      console.log(store.revoke(cwd) ? `Revoked trust for ${canonicalProjectPath(cwd)}` : 'Project was not trusted.')
      return
    }
    if (!store.isTrusted(cwd)) store.trust(cwd)
    const values = readProjectSettingsCapabilities(paths)
    for (const capability of cmd.capabilities) {
      const value = capability === 'hooks' ? values.hooks : values.mcpServers
      store.approveCapability(cwd, capability, capabilityDigest(value))
    }
    console.log(
      `Trusted ${canonicalProjectPath(cwd)}${
        cmd.capabilities.length ? `; approved ${cmd.capabilities.join(', ')}` : ''
      }`,
    )
    return
  }
  ensureBrainScaffold(paths)
  if (cmd.command === 'plugin') {
    const manager = new PluginManager(paths)
    const [target] = cmd.args
    try {
      switch (cmd.action) {
        case 'list':
          console.log(
            manager
              .list()
              .map(
                (plugin) =>
                  `${plugin.id}\t${plugin.version}\t${plugin.enabled ? 'enabled' : 'disabled'}\t` +
                  `${plugin.signatureVerified ? 'signed' : 'unsigned'}\t${plugin.source}`,
              )
              .join('\n'),
          )
          break
        case 'install': {
          if (!target) throw new Error('Usage: athena plugin install <directory-or-git-url> [--require-signature]')
          const installed = manager.install(target, { requireSignature: cmd.requireSignature })
          console.log(`Installed ${installed.id}@${installed.version} (${installed.digest.slice(0, 12)})`)
          break
        }
        case 'update': {
          if (!target) throw new Error('Usage: athena plugin update <id> [--require-signature]')
          const updated = manager.update(target, { requireSignature: cmd.requireSignature })
          console.log(`Updated ${updated.id}@${updated.version} (${updated.digest.slice(0, 12)})`)
          break
        }
        case 'enable':
        case 'disable':
          if (!target) throw new Error(`Usage: athena plugin ${cmd.action} <id>`)
          manager.setEnabled(target, cmd.action === 'enable')
          console.log(`${cmd.action === 'enable' ? 'Enabled' : 'Disabled'} ${target}`)
          break
        case 'remove':
          if (!target) throw new Error('Usage: athena plugin remove <id>')
          console.log(`Removed ${target}; recoverable copy: ${manager.remove(target)}`)
          break
        case 'verify':
          if (!target) throw new Error('Usage: athena plugin verify <id>')
          if (!manager.verify(target)) {
            console.error(`Plugin ${target} differs from its installed digest`)
            process.exitCode = 1
          } else {
            console.log(`Plugin ${target} verified`)
          }
          break
      }
    } catch (error) {
      console.error((error as Error).message)
      process.exitCode = CLI_EXIT.usage
    }
    return
  }
  if (cmd.command === 'learn') {
    const candidates = new CandidateStore(paths)
    const evaluator = new LearningEvaluator(paths)
    const promotions = new PromotionManager(paths)
    const [first, second] = cmd.args
    try {
      switch (cmd.action) {
        case 'traces':
          console.log(JSON.stringify(await new TraceWarehouse(paths.runsDir).list(), null, 2))
          break
        case 'reflect': {
          if (cmd.args.length === 0) throw new Error('Usage: athena learn reflect <run-id> [run-id...]')
          const candidate = await reflectTraces(paths, cmd.args)
          console.log(candidate.id)
          break
        }
        case 'add': {
          if (!first) throw new Error('Usage: athena learn add <candidate.json>')
          const candidate = await admitCandidate(
            paths,
            JSON.parse(await readFile(resolve(cwd, first), 'utf8')),
          )
          console.log(candidate.id)
          break
        }
        case 'candidates':
          console.log(
            candidates
              .list()
              .map(
                (candidate) =>
                  `${candidate.id}\t${candidate.status}\t${candidate.target}\t` +
                  `${candidate.confidence.toFixed(2)}\t${candidate.hypothesis.slice(0, 100)}`,
              )
              .join('\n'),
          )
          break
        case 'evaluate': {
          if (!first || !second) {
            throw new Error('Usage: athena learn evaluate <candidate-id> <suite.json>')
          }
          const comparison = await evaluator.evaluate(
            candidates.load(first),
            evaluator.loadSuite(resolve(cwd, second)),
            cwd,
          )
          console.log(JSON.stringify(comparison, null, 2))
          break
        }
        case 'promote': {
          if (!first) throw new Error('Usage: athena learn promote <candidate-id> --approve')
          const record = promotions.promoteCanary(first, cwd, cmd.approved)
          console.log(`Canary ${record.id} applied; run a canary evaluation before finalize.`)
          break
        }
        case 'canary': {
          if (!first || !second) throw new Error('Usage: athena learn canary <candidate-id> <suite.json>')
          const run = await evaluator.runCanary(
            candidates.load(first),
            evaluator.loadSuite(resolve(cwd, second)),
            cwd,
          )
          console.log(run.id)
          break
        }
        case 'finalize': {
          if (!first || !second) {
            throw new Error('Usage: athena learn finalize <candidate-id> <canary-run-id>')
          }
          console.log(promotions.finalize(first, second, cwd).id)
          break
        }
        case 'rollback':
          if (!first) throw new Error('Usage: athena learn rollback <candidate-id>')
          console.log(promotions.rollback(first, cwd).id)
          break
        case 'consolidate': {
          const claims = new LearningMemoryStore(paths).consolidate()
          console.log(`Consolidated ${claims.length} learned-memory claim(s).`)
          break
        }
        case 'lineage':
          console.log(
            JSON.stringify(
              {
                verification: promotions.verifyLineage(),
                records: promotions.lineage(),
              },
              null,
              2,
            ),
          )
          break
      }
    } catch (error) {
      console.error((error as Error).message)
      process.exitCode = CLI_EXIT.usage
    }
    return
  }
  if (cmd.command === 'session') {
    const store = new SessionStore(paths.sessionsDir, cwd)
    const [id, ...rest] = cmd.args
    try {
      switch (cmd.action) {
        case 'list':
          console.log(
            store.list().map((item) => `${item.id}\t${item.updatedAt.toISOString()}\t${item.title}`).join('\n'),
          )
          break
        case 'search':
          if (!id) throw new Error('Usage: athena session search <query>')
          console.log(
            store.search(cmd.args.join(' ')).map((item) => `${item.id}\t${item.title}`).join('\n'),
          )
          break
        case 'checkpoints':
          if (!id) throw new Error('Usage: athena session checkpoints <session-id>')
          console.log(
            store
              .checkpoints(id)
              .map((item) => `${item.id}\t${item.timestamp.toISOString()}\t${item.label}`)
              .join('\n'),
          )
          break
        case 'rewind':
          if (!id || !rest[0]) throw new Error('Usage: athena session rewind <session-id> <checkpoint-id>')
          store.rewind(id, rest[0])
          console.log(`Rewound ${id} to ${rest[0]}`)
          break
        case 'fork': {
          if (!id) throw new Error('Usage: athena session fork <session-id> [checkpoint-id]')
          const fork = store.fork(id, rest[0])
          console.log(fork.id)
          break
        }
        case 'rename':
          if (!id || rest.length === 0) throw new Error('Usage: athena session rename <session-id> <title>')
          store.rename(id, rest.join(' '))
          console.log(`Renamed ${id}`)
          break
        case 'delete':
          if (!id) throw new Error('Usage: athena session delete <session-id>')
          console.log(`Deleted ${id}; recoverable copy: ${store.delete(id)}`)
          break
      }
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = CLI_EXIT.usage
    }
    return
  }
  const credentialVault = createCredentialVault(paths)
  if (cmd.command === 'voice') {
    const {
      KeyboardVoiceCommandInput,
      WindowsWakeCommandInput,
      resolveVoiceKey,
      runVoiceProbe,
      runVoiceSession,
      saveVoiceKey,
      validateRealtimeKey,
    } = await import('./voice/index.js')
    if (process.env['ATHENA_VOICE_CHILD'] === '1') {
      console.error('Nested Athena voice processes are not allowed.')
      process.exitCode = CLI_EXIT.usage
      return
    }
    if (cmd.action === 'auth') {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('athena voice auth needs an interactive terminal.')
        process.exitCode = CLI_EXIT.usage
        return
      }
      try {
        const key = (await promptMasked('OpenAI API key for Athena voice (input hidden): ', {
          echoMask: false,
        })).trim()
        if (!key) throw new Error('No key entered; nothing was changed.')
        console.log(`Validating OpenAI Realtime access with ${cmd.model}…`)
        await validateRealtimeKey(key, { model: cmd.model })
        saveVoiceKey(credentialVault, key)
        console.log('OpenAI voice key saved to the OS credential vault and verified by readback.')
      } catch (error) {
        console.error((error as Error).message)
        process.exitCode = CLI_EXIT.provider
      }
      return
    }
    const resolvedVoice = resolveVoiceKey(
      process.env,
      credentialVault,
      (message) => console.error(message),
    )
    if (!resolvedVoice) {
      console.error('No OpenAI voice key found. Run `athena voice auth` or set OPENAI_API_KEY.')
      process.exitCode = CLI_EXIT.provider
      return
    }
    try {
      if (cmd.action === 'probe') {
        for (const line of await runVoiceProbe(resolvedVoice.key, cmd.model)) console.log(line)
        return
      }
      if (!process.stdout.isTTY || (cmd.keyboard && !process.stdin.isTTY)) {
        console.error('athena voice needs an interactive terminal; use normal `athena exec` for redirection.')
        process.exitCode = CLI_EXIT.usage
        return
      }
      const usageFile = join(paths.brainDir, 'voice-usage.jsonl')
      await runVoiceSession({
        apiKey: resolvedVoice.key,
        model: cmd.model,
        input: cmd.keyboard ? new KeyboardVoiceCommandInput() : new WindowsWakeCommandInput(),
        onUsage: (usage) => appendFileSync(
          usageFile,
          JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), model: cmd.model, usage }) + '\n',
          { encoding: 'utf8', mode: 0o600 },
        ),
      })
    } catch (error) {
      console.error(
        `Athena voice stopped: ${(error as Error).message} ` +
        'Run `athena voice probe` to test microphone, playback, and Realtime access.',
      )
      process.exitCode = CLI_EXIT.provider
    }
    return
  }
  if (cmd.command === 'auth') {
    if (cmd.sub === 'status') {
      try {
        const creds = loadCredentials(paths)
        console.log(formatAuthStatus(creds, creds.activeProvider, process.env, credentialVault))
        console.log(formatCredentialVaultStatus(credentialVault))
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
      return
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('athena auth needs an interactive terminal.')
      process.exitCode = 1
      return
    }
    const authPresentation = cmd.accessibility
      ?? loadSettings(paths, cmd.provider ?? 'anthropic').accessibility.presentation
    await runAuthWizard({
      paths,
      provider: cmd.provider,
      vault: credentialVault,
      io: terminalIO({ screenReader: authPresentation === 'screen-reader' }),
    })
    return
  }

  const isExec = cmd.command === 'exec'
  const explicitlyLineOriented = !isExec && 'accessibility' in cmd
    && cmd.accessibility === 'screen-reader'
  // Interactive commands need a real terminal; `exec` is the intentional
  // non-TTY surface. Explicit screen-reader mode is also line-oriented and can
  // safely consume redirected lines without mounting Ink.
  if (!isExec && !explicitlyLineOriented && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.log(HELP_TEXT)
    console.log('\n(interactive session skipped: not a TTY)')
    return
  }
  // Environment staleness, on stderr before Ink mounts (alt-screen entry happens later in a
  // useEffect, so pre-render stderr is genuinely visible). Filesystem checks only — no git,
  // no subprocess, nothing that can throw — and silent when everything is fresh.
  for (const warning of stalenessBootWarnings()) console.error(warning)
  const projectTrust = isExec
    ? resolveStoredProjectTrust(paths, cwd)
    : await resolveProjectTrust(paths, cwd)
  const effectivePaths: BrainPaths = projectTrust.trusted
    ? paths
    : { ...paths, projectBrainDir: null }
  // One line per distinct credential-path problem, on stderr, before the TUI mounts.
  // Deduped because key resolution runs several times below.
  const seenCredentialWarnings = new Set<string>()
  const warnCredentials = (message: string): void => {
    if (seenCredentialWarnings.has(message)) return
    seenCredentialWarnings.add(message)
    console.error(message)
  }
  let credentials: Credentials
  try {
    // Vault migration is best effort by construction (it cannot throw), so this catch
    // only ever sees genuine credentials-file errors: malformed JSON, I/O, permissions.
    credentials = migrateCredentialsToVault(paths, loadCredentials(paths), credentialVault, {
      onWarn: warnCredentials,
    })
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
    return
  }
  let provider: ProviderId = cmd.provider ?? credentials.activeProvider
  const authPresentation = isExec
    ? 'standard'
    : resolveAuthPresentation(
        cmd,
        loadSettings(paths, provider).accessibility.presentation,
      )
  let resolved = resolveApiKey(provider, credentials, process.env, credentialVault, warnCredentials)
  if (!resolved && cmd.provider === undefined) {
    // The default provider has no key but another one does (e.g. no credentials file
    // and only MOONSHOT_API_KEY set, while activeProvider defaults to anthropic):
    // adopt the keyed provider for the session instead of forcing the wizard.
    const withKey = PROVIDER_IDS.find((p) =>
      resolveApiKey(p, credentials, process.env, credentialVault, warnCredentials),
    )
    if (withKey) {
      provider = withKey
      resolved = resolveApiKey(provider, credentials, process.env, credentialVault, warnCredentials)!
      console.log(`Using ${PROVIDERS[provider].label} (only provider with a configured key).`)
    }
  }
  if (!resolved) {
    if (isExec) {
      console.error(`No API key found for ${PROVIDERS[provider].label}; run \`athena auth\`.`)
      process.exitCode = CLI_EXIT.provider
      return
    }
    if (
      cmd.provider === undefined &&
      PROVIDER_IDS.every(
        (p) => !resolveApiKey(p, credentials, process.env, credentialVault, warnCredentials),
      )
    ) {
      // True cold start: no --provider flag and no key anywhere. Run the FULL wizard
      // (provider pick included) and adopt whatever the user chose.
      console.log(`No API key configured yet. Let's set one up.`)
      const done = await runAuthWizard({
        paths,
        vault: credentialVault,
        io: terminalIO({ screenReader: authPresentation === 'screen-reader' }),
      })
      provider = done.provider
      resolved = { key: done.key, source: 'file' }
    } else {
      // A specific provider is implied (--provider flag, or another provider already
      // has a key): drop into the wizard scoped to it, then continue into the session.
      console.log(
        `No API key found for ${PROVIDERS[provider].label} - let's set one up. (This provider becomes your default; athena auth switches it.)`,
      )
      const done = await runAuthWizard({
        paths,
        provider,
        vault: credentialVault,
        io: terminalIO({ screenReader: authPresentation === 'screen-reader' }),
      })
      resolved = { key: done.key, source: 'file' }
    }
  }
  // Settings warnings (e.g. a model that is invalid for the active provider falling
  // back to the provider default) surface on stderr before the TUI mounts.
  const settings = loadSettings(paths, provider, (msg) => console.error(msg), {
    projectTrusted: projectTrust.trusted,
    allowProjectHooks: projectTrust.allowProjectHooks,
    allowProjectMcp: projectTrust.allowProjectMcp,
  })
  const pluginExtensions = loadPluginRuntimeExtensions(
    effectivePaths,
    (message) => console.error(message),
  )
  settings.hooks = [...pluginExtensions.hooks, ...settings.hooks]
  settings.mcpServers = { ...pluginExtensions.mcpServers, ...settings.mcpServers }
  if (isExec) {
    settings.permissionMode = cmd.options.permissionMode
    settings.sandboxMode = cmd.options.sandboxMode
    settings.effort = cmd.options.effort
    if (cmd.options.model) {
      const selected = normalizeModel(provider, cmd.options.model)
      if (!selected) {
        console.error(`Unknown model '${cmd.options.model}' for ${provider}: ${modelKeys(provider).join(', ')}`)
        process.exitCode = CLI_EXIT.usage
        return
      }
      settings.model = selected
    }
  }
  const presentationMode: AccessibilityPresentation = !isExec && 'accessibility' in cmd
    ? (cmd.accessibility ?? settings.accessibility.presentation)
    : settings.accessibility.presentation
  const screenInput = presentationMode === 'screen-reader' && !isExec
    ? new ReadlineLineInput()
    : null
  const screenPresentation = screenInput
    ? new ScreenReaderPresentation({
        input: screenInput,
        write: (chunk) => process.stdout.write(chunk),
      })
    : null
  let execPrompt: string | null = null
  let outputSchema: unknown = null
  if (isExec) {
    execPrompt = cmd.options.prompt
    if (execPrompt === null) {
      if (process.stdin.isTTY) {
        console.error(`${EXEC_USAGE}\nProvide a prompt argument or pipe one over stdin.`)
        process.exitCode = CLI_EXIT.usage
        return
      }
      execPrompt = (await readStdin()).trim()
    }
    if (execPrompt === '') {
      console.error('athena exec received an empty prompt')
      process.exitCode = CLI_EXIT.usage
      return
    }
    if (cmd.options.outputSchemaFile) {
      try {
        outputSchema = JSON.parse(
          await readFile(resolve(cwd, cmd.options.outputSchemaFile), 'utf8'),
        ) as unknown
      } catch (err) {
        console.error(`Cannot load output schema: ${(err as Error).message}`)
        process.exitCode = CLI_EXIT.usage
        return
      }
    }
  }
  // Directory-backed custom slash commands (.athena/commands, ~/.athena/commands). Name
  // collisions with a built-in command are skipped with a warning, never fatal.
  const commands = new Map(
    loadCommandsIndexWithPlugins(effectivePaths, (msg) => console.error(msg)).map((c) => [c.name, c]),
  )
  const resourcePolicy = new ResourcePolicy(cwd, settings.sandboxMode, [paths.brainDir])
  const gate = new PermissionEngine({
    mode: settings.permissionMode,
    allow: settings.allow,
    deny: settings.deny,
    cwd, // same coordinate system the tools resolve file_path against
    sandboxMode: settings.sandboxMode,
    resourcePolicy,
  })
  const hooks = new HookRunner(settings.hooks)
  const bus = new EngineEventBus()
  const trace = await RunTraceWriter.create(paths.runsDir, {
    cwd,
    provider,
    model: settings.model,
    mode: settings.permissionMode,
    sandbox: settings.sandboxMode,
  })
  trace.attach(bus)
  const pendingSemanticEvents: InteractionEventEnvelope[] = []
  const flushSemanticJsonl = () => {
    if (cmd.command !== 'exec' || cmd.options.output !== 'jsonl') return
    for (const event of pendingSemanticEvents.splice(0)) {
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        event: { type: 'interaction-event', envelope: event },
      }) + '\n')
    }
  }
  const interactionService = new InteractionService({
    verbosity: settings.accessibility.verbosity === 'concise'
      ? 'quiet'
      : settings.accessibility.verbosity === 'detailed'
        ? 'verbose'
        : 'balanced',
    tracePath: () => trace.file,
    onAnnouncement: (announcement) => {
      // The richer permission prompt immediately follows its semantic blocker; reading
      // both aloud would announce one decision twice.
      if (announcement.category !== 'permission') screenPresentation?.announce(announcement)
    },
    onDiagnostic: (diagnostic) => trace.append('interaction-diagnostic', diagnostic),
  })
  const experienceStore = new ExperienceStore(join(paths.brainDir, 'experience'))
  const interaction = new InteractionEventAdapter({
    runId: trace.runId,
    guidanceForRepeatedFailure: ({ runId, toolName }) => {
      const objective = interactionService.snapshot(runId)?.objective.value
        ?? interactionService.snapshot(trace.runId)?.objective.value
        ?? ''
      if (!objective) return []
      return retrieveGuidance(
        experienceStore.listExperiences(),
        experienceStore.listGuidance(),
        {
          projectScope: projectId(cwd),
          objective,
          tags: [toolName.toLowerCase()],
          limit: 3,
          charBudget: 2_048,
        },
      )
    },
    onEnvelope: (event) => {
      const result = interactionService.accept(event)
      if (!result.accepted) return
      trace.recordInteraction(event)
      if (cmd.command === 'exec' && cmd.options.output === 'jsonl') {
        pendingSemanticEvents.push(event)
      }
      if (result.announcement) {
        trace.recordAnnouncement(result.announcement, {
          coalesced: result.coalesced ?? false,
          occurrences: result.occurrences ?? 1,
        })
      }
    },
  })
  interaction.attach(bus)
  const store = new SessionStore(paths.sessionsDir, cwd)

  const registry = new ToolRegistry()
  for (const t of [
    readTool,
    writeTool,
    editTool,
    applyPatchTool,
    readImageTool,
    notebookEditTool,
    diagnosticsTool,
    globTool,
    grepTool,
    bashTool,
    powershellTool,
    taskOutputTool, // read-only poll over background shell tasks; flows to sub-agents via the base registry
    todoTool,
    statusUpdateTool,
    memoryTool,
    webfetchTool,
    websearchTool,
  ]) {
    registry.register(t as ToolDefinition<never>)
  }
  // Skill is read-only and part of the base registry so sub-agents can receive it
  // under tool restriction; register it before Agent (which nests one level only).
  registry.register(makeSkillTool(effectivePaths) as ToolDefinition<never>)

  // MCP: connect to configured servers and mount their tools into the BASE registry
  // BEFORE the orchestrator is built, so sub-agents inherit them under restriction.
  // Connection failures are non-fatal (handled inside connectAll); an empty config is a no-op.
  const mcp = new McpManager()
  await mcp.connectAll(settings.mcpServers, registry, (m) => bus.emit({ type: 'info', message: m }))

  let systemPrompt = assembleSystemPrompt({
    constitution: loadConstitution(effectivePaths),
    memoryIndex: loadMemoryIndex(effectivePaths),
    projectContext: projectTrust.trusted ? findProjectContextFiles(cwd) : [],
    toolGuidance:
      'Use Read before Write/Edit. Prefer Grep/Glob over shell find. Keep tool outputs focused.',
    skills: loadSkillsIndexWithPlugins(effectivePaths, (msg) => console.error(msg)),
    environment: {
      cwd,
      platform: process.platform,
      gitBranch: gitBranch(cwd),
      date: new Date().toISOString().slice(0, 10),
    },
  })
  if (outputSchema !== null) {
    systemPrompt +=
      '\n\nReturn the final answer as JSON only, with no Markdown fence, matching this JSON Schema:\n' +
      JSON.stringify(outputSchema)
  }
  const client = new ClientHolder(makeClient(provider, resolved.key))
  const orchestrator = new AgentOrchestrator({
    defs: loadAgentsIndexWithPlugins(effectivePaths, (msg) => console.error(msg)),
    clientFactory: () => client,
    baseRegistry: registry,
    gate,
    hooks,
    defaultModel: () => engine.getModel(), // thunk: /model mid-session reaches sub-agents
    defaultProvider: () => engine.getProvider(), // thunk: /provider mid-session reaches sub-agents
    defaultEffort: () => engine.getEffort(), // thunk: /effort mid-session reaches sub-agents
    systemPromptBase: systemPrompt,
    runStoreDir: paths.agentRunsDir,
    traceRootDir: paths.runsDir,
    limits: isExec
      ? {
          ...cmd.options.limits,
          maxModelCalls: Math.min(cmd.options.limits.maxModelCalls ?? 50, 50),
          maxToolCalls: Math.min(cmd.options.limits.maxToolCalls ?? 100, 100),
          maxConcurrency: Math.min(cmd.options.limits.maxConcurrency ?? 2, 2),
        }
      : undefined,
  })
  registry.register(makeAgentTool(orchestrator) as ToolDefinition<never>)

  // Session selection: run = fresh; continue = latest here (or fresh); resume = picker (or fresh).
  let session: Session | null = null
  let history: MessageParam[] = []
  if (cmd.command === 'exec') {
    if (cmd.options.resumeId) {
      history = store.resume(cmd.options.resumeId)
      const found = store.list().find((item) => item.id === cmd.options.resumeId)
      if (!found) throw new Error(`No session ${cmd.options.resumeId}`)
      session = new Session(cmd.options.resumeId, found.file, history.length)
    } else if (cmd.options.persistSession) {
      session = store.create()
    }
  } else if (cmd.command === 'continue') {
    const latest = store.continueLatest()
    if (latest) {
      history = latest.messages
      const found = store.list().find((s) => s.id === latest.id)!
      session = new Session(latest.id, found.file, history.length)
    } else {
      session = store.create()
    }
  } else if (cmd.command === 'resume') {
    const picked = screenInput
      ? await pickSessionLine(store.list(), screenInput)
      : await pickSession(store.list())
    if (picked) {
      history = store.resume(picked.id)
      session = new Session(picked.id, picked.file, history.length)
    } else {
      session = store.create()
    }
  } else {
    session = store.create()
  }

  // Event journal: errors, turn completions (with usage), and compactions land in the
  // session file so a crash is diagnosable from disk. A failed journal write must never
  // crash or recurse — swallow it here, no bus emit from inside the subscriber.
  bus.on((e) => {
    if (e.type === 'error' || e.type === 'turn-done' || e.type === 'compaction') {
      try {
        session?.appendEvent(e)
      } catch {
        /* journaling is best-effort */
      }
    }
  })

  const bridge = new PermissionBridge()
  const permissionDetails = new Map<string, string>()
  const activeCapabilities = modelCapabilities(provider, settings.model)
  const contextManager = new ContextManager({
    modelWindowTokens: activeCapabilities.contextWindowTokens,
  })
  const toolContext: ToolContext = {
    cwd,
    brainDir: paths.brainDir,
    projectBrainDir: effectivePaths.projectBrainDir,
    fileReadRegistry: new Set(),
    fileReadHashes: new Map(),
    todos: [],
    emit: (event) => bus.emit(event),
    abortSignal: new AbortController().signal,
    resolvePath: (path, access) => resourcePolicy.resolvePath(path, access),
    sandboxMode: settings.sandboxMode,
    runId: trace.runId,
  }
  const engine = new Engine({
    client,
    bus,
    registry,
    gate,
    hooks,
    contextManager,
    toolContext,
    provider,
    model: settings.model,
    effort: settings.effort,
    systemPrompt,
    maxTokens: settings.maxOutputTokens ?? activeCapabilities.maxOutputTokens,
    preflightContext: true,
    limits: isExec
      ? cmd.options.limits
      : {
          maxModelCalls: 200,
          maxToolCalls: 1_000,
          maxTokens: 10_000_000,
          maxCostUsd: 50,
          maxDurationMs: 4 * 60 * 60_000,
          maxConcurrency: 4,
        },
    askUser: isExec
      ? undefined
      : async (req) => {
          if (!screenPresentation) return bridge.ask(req)
          const diff = permissionDiff(req, cwd)
          if (diff) {
            permissionDetails.set(req.id, formatPermissionDiffDetail(diff))
            if (permissionDetails.size > 100) permissionDetails.delete(permissionDetails.keys().next().value!)
          }
          return screenPresentation.requestPermission(createAccessiblePermissionRequest({
            ...req,
            ...(diff ? { diff: permissionDiffStats(diff) } : {}),
          }))
        },
    onMessagesChanged: (messages) => {
      // A full disk / locked file must not kill the TUI mid-turn.
      try {
        session?.rewriteOrAppend(messages)
      } catch (err) {
        bus.emit({
          type: 'error',
          message: `Session write failed: ${(err as Error).message}`,
          fatal: false,
        })
      }
    },
  })
  hooks.configure({
    invokeMcpTool: async (name, invocation, signal) => {
      const tool = registry.get(name)
      if (!tool || !name.startsWith('mcp__')) throw new Error(`Unknown MCP hook tool "${name}"`)
      const parsed = tool.schema.safeParse(invocation.payload)
      if (!parsed.success) throw new Error(`Invalid MCP hook input: ${parsed.error.message}`)
      const decision = gate.check({
        toolName: name,
        input: parsed.data,
        readOnly: tool.readOnly,
        summary: `Hook invokes ${name}`,
      })
      if (decision.decision !== 'allow') {
        throw new Error(`MCP hook tool permission denied: ${decision.reason}`)
      }
      const result = await tool.execute(parsed.data as never, {
        ...toolContext,
        abortSignal: signal,
      })
      if (result.isError) throw new Error(result.output)
      return result.output
    },
    evaluatePrompt: async (prompt, invocation, signal) => {
      const capabilities = modelCapabilities(engine.getProvider(), engine.getModel())
      return client.complete({
        model: capabilities.id,
        prompt:
          `${prompt}\n\nReturn a HookDecision JSON object only.\n\nInvocation:\n` +
          JSON.stringify(invocation),
        maxTokens: Math.min(2_048, capabilities.maxOutputTokens),
        signal,
      })
    },
    invokeAgent: async (agentName, prompt, _invocation, signal) => {
      const definition = orchestrator.getDef(agentName)
      if (!definition) throw new Error(`Unknown hook agent "${agentName}"`)
      const result = await orchestrator.runAgent(definition, prompt, {
        ...toolContext,
        abortSignal: signal,
      })
      if (result.isError) throw new Error(result.output)
      return result.output
    },
  })
  if (history.length > 0) engine.loadMessages(history)

  await hooks.run('SessionStart', { cwd })
  let sessionEnded = false
  const endSession = async (reason: string) => {
    if (sessionEnded) return
    sessionEnded = true
    await hooks.run('SessionEnd', { cwd, reason, run: engine.getRunResult() })
  }

  if (isExec) {
    let permissionDenied = false
    let wroteText = false
    const unsubscribe = bus.on((event) => {
      if (
        event.type === 'tool-result' &&
        event.isError &&
        event.output.startsWith('Permission denied:')
      ) {
        permissionDenied = true
      }
      if (cmd.options.output === 'jsonl') {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, event }) + '\n')
        flushSemanticJsonl()
      } else if (cmd.options.output === 'text') {
        if (event.type === 'assistant-text') {
          wroteText = true
          process.stdout.write(event.delta)
        } else if (event.type === 'error') {
          process.stderr.write(`${event.message}\n`)
        }
      }
    })
    trace.recordPrompt(execPrompt!)
    interaction.recordUserObjective(execPrompt!, 'prompt:exec')
    flushSemanticJsonl()
    let result
    try {
      result = await engine.runTurn(execPrompt!)
    } finally {
      shutdownBackgroundTasks(trace.runId)
      unsubscribe()
      interaction.detach()
      await endSession('exec-complete')
      await mcp.closeAll()
    }
    const output = finalAssistantText(engine.getMessages())
    let outputValue: unknown
    let schemaErrors: string[] = []
    if (outputSchema !== null) {
      const validation = validateJsonOutput(output, outputSchema)
      outputValue = validation.value
      schemaErrors = validation.errors
    }
    let exitCode: number = CLI_EXIT.success
    if (schemaErrors.length > 0) exitCode = CLI_EXIT.outputSchema
    else if (permissionDenied) exitCode = CLI_EXIT.permission
    else if (result.status === 'limit') exitCode = CLI_EXIT.limit
    else if (result.status === 'aborted') exitCode = CLI_EXIT.aborted
    else if (result.status === 'error') exitCode = CLI_EXIT.provider

    await trace.close(result)
    await captureExperienceBestEffort(trace.file, experienceStore)
    const envelope = {
      schemaVersion: 1,
      runId: trace.runId,
      sessionId: session?.id ?? null,
      status: result.status,
      reason: result.reason,
      exitCode,
      output,
      outputValue,
      schemaErrors,
      usage: result.usage,
      traceFile: trace.file,
    }
    if (cmd.options.output === 'json') {
      process.stdout.write(JSON.stringify(envelope) + '\n')
    } else if (cmd.options.output === 'jsonl') {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, event: { type: 'exec-result', ...envelope } }) + '\n')
    } else {
      if (wroteText) process.stdout.write('\n')
      if (!wroteText && output) process.stdout.write(output + '\n')
      if (schemaErrors.length > 0) process.stderr.write(`Output schema failed: ${schemaErrors.join('; ')}\n`)
    }
    process.exitCode = exitCode
    return
  }

  // Last-resort crash handlers: state is no longer trusted after an escaped
  // exception. Record a bounded diagnostic, cancel the active run, close MCP
  // transports, and terminate non-zero instead of continuing in undefined state.
  let crashing = false
  const crashHandler = (err: unknown) => {
    if (crashing) return
    crashing = true
    const message = err instanceof Error ? err.message : String(err)
    const stack = (err instanceof Error ? (err.stack ?? message) : message).slice(0, 100_000)
    try {
      appendFileSync(join(paths.brainDir, 'crash.log'), `${new Date().toISOString()} ${stack}\n`, 'utf8')
    } catch {
      /* the crash log failing must not itself crash */
    }
    bus.emit({ type: 'error', message: `Internal crash (logged to crash.log): ${message}`, fatal: true })
    engine.abort()
    void (async () => {
      shutdownBackgroundTasks(trace.runId)
      await Promise.allSettled([
        endSession('crash'),
        mcp.closeAll(),
        trace.close(engine.getRunResult()),
      ])
      process.exit(1)
    })()
  }
  process.on('unhandledRejection', crashHandler)
  process.on('uncaughtException', crashHandler)

  if (screenPresentation && screenInput) {
    const slashHandler = makeSlashHandler({
      bus,
      engine,
      gate,
      contextManager,
      client,
      store,
      session,
      paths,
      credentialVault,
      interactionService,
      runId: trace.runId,
      permissionDetails: (id) => permissionDetails.get(id) ?? null,
      commands,
    })
    const unsubscribeScreen = bus.on((event) => {
      if (event.type === 'info') {
        screenPresentation.showDetails({ id: `info:${Date.now()}`, text: event.message })
      }
    })
    let activeTurn = false
    let exitRequested = false
    const onSigint = () => {
      const result = handleScreenReaderInterrupt(activeTurn, {
        abort: () => engine.abort(),
        cancelInput: () => screenPresentation.cancelPendingInput(),
        acknowledge: (accepted) => screenPresentation.acknowledgeCancellation(accepted),
        closeInput: () => screenInput.close(),
      })
      if (result === 'session-exit') exitRequested = true
    }
    process.on('SIGINT', onSigint)
    await screenPresentation.start(
      interactionService.snapshot(trace.runId)
        ?? createInteractionSnapshot(trace.runId, new Date().toISOString()),
    )
    try {
      while (!exitRequested) {
        let text: string
        try {
          text = (await screenPresentation.prompt({ id: `prompt:${Date.now()}`, label: 'You' })).trim()
        } catch {
          break
        }
        if (!text) continue
        const slash = parseSlash(text, commands)
        const route = slash ? screenReaderCommandRoute(slash) : 'submit-prompt'
        if (route === 'exit') break
        if (route === 'append-only-clear') {
          bus.emit({
            type: 'info',
            message: 'Append-only screen-reader mode keeps native scrollback; nothing was cleared.',
          })
          continue
        }
        if (route === 'presentation-change' && slash?.kind === 'tui') {
          bus.emit({
            type: 'info',
            message: `Presentation changes take effect at startup. Restart with --accessibility ${slash.value === 'fullscreen' ? 'standard' : 'screen-reader'}.`,
          })
          continue
        }
        if (route === 'shared-handler' && slash) {
          slashHandler(slash)
          continue
        }
        const prompt = slash?.kind === 'custom' ? slash.expandedPrompt : text
        trace.recordPrompt(prompt)
        interaction.recordUserObjective(prompt, `prompt:${Date.now()}`)
        activeTurn = true
        try {
          await engine.runTurn(prompt)
          const output = finalAssistantText(engine.getMessages())
          if (output) screenPresentation.writeAssistantText(output)
        } catch (error) {
          bus.emit({ type: 'error', message: `Turn crashed: ${(error as Error).message}`, fatal: true })
        } finally {
          activeTurn = false
        }
      }
    } finally {
      process.off('SIGINT', onSigint)
      unsubscribeScreen()
      await screenPresentation.close(engine.getRunResult())
      shutdownBackgroundTasks(trace.runId)
      interaction.detach()
      await endSession('interactive-exit')
      await mcp.closeAll()
      await trace.close(engine.getRunResult())
      await captureExperienceBestEffort(trace.file, experienceStore)
    }
    return
  }

  const instance = render(
    React.createElement(App, {
      bus,
      status: {
        cwd,
        gitBranch: gitBranch(cwd),
        model: modelLabel(provider, settings.model),
        modelKey: settings.model,
        provider,
        effort: settings.effort,
        mode: gate.getMode(),
        contextPct: Math.round(contextManager.usedFraction() * 100),
      },
      onSubmit: async (text: string) => {
        trace.recordPrompt(text)
        interaction.recordUserObjective(text, `prompt:${Date.now()}`)
        await engine.runTurn(text)
      },
      onAbort: () => engine.abort(),
      permissionBridge: bridge,
      commands,
      agents: orchestrator.listDefs(),
      initialMessages: history,
      onSlash: makeSlashHandler({
        bus,
        engine,
        gate,
        contextManager,
        client,
        store,
        session,
        paths,
        credentialVault,
        interactionService,
        runId: trace.runId,
        permissionDetails: (id) => permissionDetails.get(id) ?? null,
        commands,
      }),
    }),
  )
  // main() owns the TUI lifetime: an Ink render-phase failure rejects here and is
  // reported by the main().catch below instead of dying as an unhandled rejection.
  // closeAll runs on the normal exit path (and on a render-phase error) so spawned
  // MCP server processes are torn down rather than leaked.
  try {
    await instance.waitUntilExit()
  } finally {
    shutdownBackgroundTasks(trace.runId)
    interaction.detach()
    await endSession('interactive-exit')
    await mcp.closeAll()
    await trace.close(engine.getRunResult())
    await captureExperienceBestEffort(trace.file, experienceStore)
  }
}

// Run only when invoked as the CLI entry (bin/athena.js, tsx src/cli.ts, dist/cli.js) —
// importing this module from tests must not launch the TUI or scaffold ~/.athena.
const entryBase = process.argv[1] ? basename(process.argv[1]) : ''
if (['athena', 'athena.js', 'athena.cmd', 'cli.js', 'cli.mjs', 'cli.ts'].includes(entryBase)) {
  // Top-level error boundary: malformed settings.json, a vanished session file, etc.
  // must exit with a clean message, not an unhandled-rejection stack trace.
  main().catch((err: Error) => {
    console.error(err.message)
    process.exitCode = CLI_EXIT.internal
  })
}
