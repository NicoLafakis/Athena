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
import {
  loadSettings,
  readProjectSettingsCapabilities,
  SettingsSchema,
  type Settings,
} from './brain/settings.js'
import { FileLedgerStore } from './brain/vmp-ledger.js'
import {
  normalizeModel,
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
import { runAuthWizard, terminalIO } from './auth/wizard.js'
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
import { PermissionEngine, resolveTrustBootstrap } from './harness/permissions.js'
import { ProtectedPaths } from './harness/protected-paths.js'
import { ResourcePolicy } from './harness/resource-policy.js'
import {
  ProjectTrustStore,
  capabilityDigest,
  canonicalProjectPath,
  type ProjectCapability,
} from './harness/trust.js'
import { Session, SessionStore, type SessionInfo } from './harness/sessions.js'
import { HarnessSessionController } from './harness/controller.js'
import { PluginManager } from './harness/plugins.js'
import { Engine } from './engine/loop.js'
import { AnthropicClient } from './engine/client.js'
import { OpenAIClient } from './engine/openai-client.js'
import type { ModelClient } from './engine/client.js'
import { FixtureModelClient } from './engine/fixture-client.js'
import { makeTelemetryRecorder, type TelemetryRecorder } from './engine/telemetry.js'
import { EngineEventBus } from './engine/events.js'
import {
  InteractionService,
  type InteractionEventEnvelope,
} from './interaction/index.js'
import { createInteractionSnapshot } from './interaction/state.js'
import { captureExperienceBestEffort } from './experience/index.js'
import { ContextManager } from './engine/context.js'
import type { BrainPaths } from './brain/paths.js'
import type { PermissionMode, RunLimits, SandboxMode } from './engine/types.js'
import { validateJsonOutput } from './engine/output-schema.js'
import { shutdownBackgroundTasks } from './tools/index.js'
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
import {
  collectDiagnostics,
  formatDiagnostics,
  type PermissionPosture,
} from './harness/diagnostics.js'
import { stalenessBootWarnings } from './harness/staleness.js'
import { configureVmp, getVmpStatus, printVmpReport, startVmpServer } from './harness/vmp.js'
import { ContinuityStore } from './continuity/store.js'
import {
  formatContinuityEpisode,
  formatContinuitySearch,
  formatContinuityStatus,
} from './continuity/presentation.js'
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
  | { command: 'watch'; path?: string; statusOnly?: boolean }
  | { command: 'vmp'; sub: 'report' | 'server' | 'status' | 'configure'; url?: string; keyHash?: string; port?: number }
  | { command: 'exec'; provider?: ProviderId; options: ExecOptions }
  | {
      command: 'session'
      action: 'list' | 'checkpoints' | 'rewind' | 'fork' | 'rename' | 'search' | 'delete'
      args: string[]
    }
  | {
      command: 'memory'
      action: 'rebuild' | 'status' | 'timeline' | 'search' | 'show'
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
  if (argv[0] === 'watch') {
    const statusOnly = argv.includes('--status')
    const pathArg = argv.slice(1).find((a) => !a.startsWith('-'))
    return { command: 'watch', path: pathArg, statusOnly }
  }
  if (argv[0] === 'vmp') {
    const sub = argv[1] ?? 'status'
    const actions = new Set(['report', 'server', 'status', 'configure'])
    if (!actions.has(sub)) {
      return { command: 'error', message: 'Usage: athena vmp <report|server|status|configure> [--url <url>] [--key-hash <hash>] [--port <n>]' }
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
      return { command: 'error', message: 'Usage: athena vmp configure --url <report-url> --key-hash <sha256-hash>' }
    }
    return { command: 'vmp', sub: sub as Extract<CliCommand, { command: 'vmp' }>['sub'], url, keyHash, port }
  }
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
  if (argv[0] === 'memory') {
    const action = argv[1] ?? 'status'
    const actions = new Set(['rebuild', 'status', 'timeline', 'search', 'show'])
    if (!actions.has(action)) {
      return {
        command: 'error',
        message: 'Usage: athena memory <rebuild|status|timeline|search|show> [query|episode-id] [--project <project-id>]',
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
      } else if (arg.startsWith('--')) {
        return { command: 'error', message: `Unknown memory argument: ${arg}` }
      } else {
        args.push(arg)
      }
    }
    if (['rebuild', 'status'].includes(action) && args.length > 0) {
      return { command: 'error', message: `Usage: athena memory ${action}` }
    }
    if (action === 'show' && args.length !== 1) {
      return { command: 'error', message: 'Usage: athena memory show <episode-id>' }
    }
    if (action === 'search' && args.length === 0) {
      return { command: 'error', message: 'Usage: athena memory search <query> [--project <project-id>]' }
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
  athena voice           hands-free “Athena” wake conversation (pastes/sets up the OpenAI key on first run)
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
  athena session list    manage durable sessions, checkpoints, rewind, and forks
  athena memory          inspect cross-project conversation continuity
  athena memory rebuild  rebuild the local linked episode index
  athena memory search   find prior conversations by time or topic
  athena memory show     inspect an episode with source-linked messages
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
  vmpRecorder?: TelemetryRecorder
  continuityStore?: ContinuityStore
  timeZone?: string
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
    vmpRecorder,
    continuityStore,
    timeZone,
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
        client.swap(makeClient(p, resolved.key, vmpRecorder))
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
      case 'memory': {
        if (!cmd.action) {
          info(loadMemoryIndex(paths) ?? '(no memory index)')
          break
        }
        const memoryStore = continuityStore ?? new ContinuityStore(paths.continuityDir, { onWarn: info })
        if (cmd.action === 'status') {
          info(formatContinuityStatus(memoryStore))
        } else if (cmd.action === 'rebuild') {
          const result = memoryStore.rebuild(paths.sessionsDir)
          info(`Indexed ${result.episodeCount} episode(s) from ${result.sessionCount} session(s).`)
        } else if (cmd.action === 'search' || cmd.action === 'timeline') {
          info(formatContinuitySearch(memoryStore, paths.sessionsDir, {
            action: cmd.action,
            query: cmd.value ?? '',
            ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
            ...(timeZone ? { timeZone } : {}),
          }))
        } else {
          info(formatContinuityEpisode(memoryStore, paths.sessionsDir, cmd.value ?? ''))
        }
        break
      }
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

function makeClient(provider: ProviderId, key: string, recorder?: TelemetryRecorder): ModelClient {
  const fixture = process.env['ATHENA_TEST_MODEL_SCRIPT']
  if (process.env['NODE_ENV'] === 'test' && fixture) return new FixtureModelClient(fixture)
  if (provider === 'openai') {
    return new OpenAIClient(key, PROVIDERS[provider].baseURL ?? undefined, provider, recorder)
  }
  return new AnthropicClient(
    key,
    PROVIDERS[provider].baseURL ?? undefined,
    PROVIDERS[provider].authMode,
    provider,
    recorder,
  )
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

/** Explicit-registry trust only: the defaulted `trusted=true` a project without
 *  `.athena/` receives must never bootstrap trusted mode (that would make every
 *  directory shell-trusted). */
function explicitProjectTrust(paths: BrainPaths, cwd: string): boolean {
  if (!paths.projectBrainDir) return false
  return new ProjectTrustStore(paths.trustFile).isTrusted(cwd)
}

/**
 * The posture `athena doctor` reports: settings plus the trust bootstrap, i.e.
 * what an interactive session in this cwd would actually run with. Never throws
 * — a doctor command that dies on malformed settings is useless precisely when
 * it is needed, so a load failure degrades to the schema defaults.
 */
function doctorPosture(paths: BrainPaths, cwd: string): PermissionPosture {
  let settings: Settings
  try {
    settings = loadSettings(paths, 'anthropic', undefined, { projectTrusted: false })
  } catch {
    settings = SettingsSchema.parse({})
  }
  const bootstrap = resolveTrustBootstrap({
    permissionMode: settings.permissionMode,
    sandboxMode: settings.sandboxMode,
    explicitlyTrusted: explicitProjectTrust(paths, cwd),
  })
  return {
    permissionMode: bootstrap.permissionMode,
    sandboxMode: bootstrap.sandboxMode,
    protectedPaths: ProtectedPaths.from(settings.protectedPaths),
  }
}

/** Fold the trust bootstrap into loaded settings; the notice is loud on purpose. */
function applyTrustBootstrap(settings: Settings, paths: BrainPaths, cwd: string): void {
  const bootstrap = resolveTrustBootstrap({
    permissionMode: settings.permissionMode,
    sandboxMode: settings.sandboxMode,
    explicitlyTrusted: explicitProjectTrust(paths, cwd),
  })
  settings.permissionMode = bootstrap.permissionMode
  settings.sandboxMode = bootstrap.sandboxMode
  if (bootstrap.notice) console.error(bootstrap.notice)
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
    const report = collectDiagnostics(paths, cwd, getVersion(), { posture: doctorPosture(paths, cwd) })
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
  if (cmd.command === 'vmp') {
    const settings = loadSettings(paths, 'anthropic')
    try {
      switch (cmd.sub) {
        case 'status': {
          const status = await getVmpStatus(paths, settings)
          console.log(`VMP connector: ${status.enabled ? 'enabled' : 'disabled'}`)
          if (status.reportUrl) console.log(`Report URL: ${status.reportUrl}`)
          console.log(`Key hash configured: ${status.keyHashConfigured ? 'yes' : 'no'}`)
          console.log(`Ledger entries: ${status.ledgerEntries}`)
          break
        }
        case 'report': {
          await printVmpReport(paths)
          break
        }
        case 'configure': {
          if (!cmd.url || !cmd.keyHash) {
            console.error('Usage: athena vmp configure --url <report-url> --key-hash <sha256-hash>')
            process.exitCode = CLI_EXIT.usage
            break
          }
          configureVmp(paths, settings, { reportUrl: cmd.url, keyHash: cmd.keyHash })
          console.log('VMP connector configured. VMP can now pull reports from this app.')
          break
        }
        case 'server': {
          await startVmpServer(paths, settings.vmp, cmd.port)
          // Server runs until SIGINT.
          await new Promise<void>((resolve) => {
            process.on('SIGINT', () => {
              console.error('\nVMP server stopping.')
              resolve()
            })
          })
          break
        }
      }
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = 1
    }
    return
  }
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
  if (cmd.command === 'memory') {
    const store = new ContinuityStore(paths.continuityDir, { onWarn: (warning) => console.error(warning) })
    try {
      if (cmd.action === 'rebuild') {
        const result = store.rebuild(paths.sessionsDir)
        console.log(`Indexed ${result.episodeCount} episode(s) from ${result.sessionCount} session(s).`)
        for (const warning of result.warnings) console.error(warning)
        return
      }
      if (cmd.action === 'status') {
        console.log(formatContinuityStatus(store))
        return
      }

      let timeZone: string | undefined
      try {
        timeZone = loadSettings(paths, 'anthropic', (warning) => console.error(warning), { projectTrusted: false }).timeZone
      } catch {
        console.error('The configured timezone could not be loaded; memory dates will use the inferred OS timezone.')
      }

      if (cmd.action === 'search' || cmd.action === 'timeline') {
        console.log(formatContinuitySearch(store, paths.sessionsDir, {
          action: cmd.action,
          query: cmd.args.join(' '),
          ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
          ...(timeZone ? { timeZone } : {}),
        }))
        return
      }

      console.log(formatContinuityEpisode(store, paths.sessionsDir, cmd.args[0]!))
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
      VoiceAttentionBridge,
      VoiceTelemetry,
      WindowsPersistentWakeInput,
      ensureVoiceKey,
      playListeningCue,
      playStandbyCue,
      runVoiceProbe,
      runVoiceSession,
      saveVoiceKey,
      validateRealtimeKey,
    } = await import('./voice/index.js')
    const promptVisibleLine = async (question: string): Promise<string> => {
      const { createInterface } = await import('node:readline/promises')
      const reader = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return (await reader.question(question)).trim()
      } finally {
        reader.close()
      }
    }
    const VOICE_KEY_PROMPT =
      'Paste your OpenAI API key and press Enter ' +
      '(visible while pasting; validated, then stored in your OS credential vault): '
    if (cmd.action === 'auth') {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('athena voice auth needs an interactive terminal.')
        process.exitCode = CLI_EXIT.usage
        return
      }
      try {
        const key = await promptVisibleLine(VOICE_KEY_PROMPT)
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
    let resolvedVoice
    try {
      resolvedVoice = await ensureVoiceKey({
        env: process.env,
        vault: credentialVault,
        onWarn: (message) => console.error(message),
        validate: (key) => {
          console.log(`Validating OpenAI Realtime access with ${cmd.model}…`)
          return validateRealtimeKey(key, { model: cmd.model })
        },
        ...(process.stdin.isTTY && process.stdout.isTTY
          ? {
            prompt: () => promptVisibleLine(
              `No OpenAI voice key is configured on this machine yet.\n${VOICE_KEY_PROMPT}`,
            ),
          }
          : {}),
      })
    } catch (error) {
      console.error((error as Error).message)
      process.exitCode = CLI_EXIT.provider
      return
    }
    if (!resolvedVoice) {
      console.error(
        'No OpenAI voice key found. Set OPENAI_API_KEY, or run `athena voice` ' +
        'in an interactive terminal to paste one.',
      )
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
      let credentials: Credentials
      try {
        credentials = loadCredentials(paths)
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
        return
      }
      const projectTrust = resolveStoredProjectTrust(paths, cwd)
      const effectivePaths: BrainPaths = projectTrust.trusted ? paths : { ...paths, projectBrainDir: null }
      const provider = credentials.activeProvider
      const settings = loadSettings(paths, provider, (msg) => console.error(msg), {
        projectTrusted: projectTrust.trusted,
        allowProjectHooks: projectTrust.allowProjectHooks,
        allowProjectMcp: projectTrust.allowProjectMcp,
      })
      applyTrustBootstrap(settings, paths, cwd)
      const voiceVmpLedger = settings.vmp.enabled ? FileLedgerStore.forPaths(paths) : undefined
      const voiceVmpRecorder = makeTelemetryRecorder(voiceVmpLedger)
      const resolvedKey = resolveApiKey(provider, credentials, process.env, credentialVault, () => {})
      if (!resolvedKey) {
        console.error(`No API key found for ${PROVIDERS[provider].label}; run \`athena auth\`.`)
        process.exitCode = CLI_EXIT.provider
        return
      }
      const harnessClient = makeClient(provider, resolvedKey.key, voiceVmpRecorder)
      const usageFile = join(paths.brainDir, 'voice-usage.jsonl')
      // Cost, latency, and lifecycle meters — scalars and IDs only, never a transcript.
      // Constructed before the bridge and the wake listener because both report into it.
      const voiceTelemetry = new VoiceTelemetry({
        model: cmd.model,
        artifact: 'voice-usage.jsonl',
        write: (line) => appendFileSync(usageFile, line, { encoding: 'utf8', mode: 0o600 }),
        onWarn: (message) => console.error(message),
      })
      // Running `athena voice` is itself a request for spoken output, so `directSpeech:
      // off` (the TUI default) becomes `supplemental` here rather than muting the one
      // mode with no screen to fall back on. Supplemental still yields routine speech to
      // an active screen reader and keeps blocking states audible.
      const attention = new VoiceAttentionBridge({
        cwd,
        ownership: settings.accessibility.directSpeech === 'off'
          ? 'supplemental'
          : settings.accessibility.directSpeech,
        screenReaderActive: settings.accessibility.presentation === 'screen-reader',
        telemetry: voiceTelemetry,
      })
      const controller = await HarnessSessionController.create({
        paths,
        effectivePaths,
        cwd,
        provider,
        client: harnessClient,
        settings,
        projectTrust,
        persistSession: true,
        askUser: attention.askUser,
        onAnnouncement: (announcement) => attention.announce(announcement),
      })
      // Ctrl+C is the documented immediate keyboard fallback, and without a handler the
      // process dies before `controller.close` runs — losing the SessionEnd hook and the
      // trace's closing record, which are the evidence a shut-down session is meant to
      // keep. Abort the turn, release the microphone, and let the normal teardown run.
      // A second Ctrl+C is the hard escape for a teardown that is itself stuck.
      let voiceInterrupted = false
      function onVoiceSigint(): void {
        if (voiceInterrupted) {
          process.exit(CLI_EXIT.aborted)
          return
        }
        voiceInterrupted = true
        console.error('Athena voice stopping: aborting the current turn and closing the session.')
        controller.abort()
        voiceInput.close()
      }
      const voiceInput = cmd.keyboard
        ? new KeyboardVoiceCommandInput({ onInterrupt: onVoiceSigint })
        : new WindowsPersistentWakeInput({
          onWarn: (message) => console.error(message),
          telemetry: voiceTelemetry,
          onListening: () => {
            console.log('Athena: listening…')
            void playListeningCue().catch(() => {})
          },
        })
      process.on('SIGINT', onVoiceSigint)
      try {
        await runVoiceSession({
          apiKey: resolvedVoice.key,
          model: cmd.model,
          controller,
          attention,
          persona: loadConstitution(paths) ?? undefined,
          input: voiceInput,
          onStandby: cmd.keyboard
            ? undefined
            : () => {
              console.log('Athena: wake standby')
              void playStandbyCue().catch(() => {})
            },
          telemetry: voiceTelemetry,
        })
      } catch (error) {
        // An interrupt tears the wake listener down on purpose; reporting that as a voice
        // failure would send the user to `athena voice probe` for something they did.
        if (!voiceInterrupted) throw error
      } finally {
        process.off('SIGINT', onVoiceSigint)
        attention.close()
        await controller.close(voiceInterrupted ? 'interrupted' : 'shutdown')
      }
      if (voiceInterrupted) {
        console.log(
          `Athena voice stopped. Session ${controller.session.id} is preserved; ` +
          'pick it up with `athena --resume`.',
        )
        process.exitCode = CLI_EXIT.aborted
      }
    } catch (error) {
      console.error(
        `Athena voice stopped: ${(error as Error).message} ` +
        'Run `athena voice probe` to test microphone, playback, and Realtime access.',
      )
      process.exitCode = CLI_EXIT.provider
    }
    return
  }
  if (cmd.command === 'watch') {
    const {
      probeFilesystemWatch,
      runForegroundFilesystemWatch,
      WatchStore,
      createExplicitFilesystemWatch,
    } = await import('./harness/watchers/index.js')
    const probe = await probeFilesystemWatch()
    if (cmd.statusOnly) {
      console.log(`Watch backend: ${probe.backend} (${probe.available ? 'available' : 'unavailable'})`)
      console.log(`Detail: ${probe.detail}`)
      console.log(`Recovery command: ${probe.recoveryCommand}`)
      return
    }
    const targetPath = resolve(cwd, cmd.path ?? '.')
    const resourcePolicy = new ResourcePolicy(cwd, 'workspace-write', [paths.brainDir])
    const store = new WatchStore(paths.watchesFile)
    const watchDef = store.upsert(createExplicitFilesystemWatch({
      requestedBy: 'user',
      projectRoot: cwd,
      resource: targetPath,
      policy: resourcePolicy,
    }))
    console.log(`Athena watching ${targetPath} (watch ID ${watchDef.id}). Press Ctrl+C to stop.`)
    const controller = new AbortController()
    const handleSigint = () => {
      console.log('\nStopping watch.')
      controller.abort()
    }
    process.on('SIGINT', handleSigint)
    const handle = runForegroundFilesystemWatch({
      watchId: watchDef.id,
      resourcePath: targetPath,
      signal: controller.signal,
      onObservation: (obs) => {
        console.log(`[${obs.observedAt}] Watch ${obs.watchId}: ${obs.summary}`)
      },
      onFailure: (warn) => {
        console.error(warn)
      },
    })
    await new Promise<void>((res) => {
      controller.signal.addEventListener('abort', () => {
        handle.close()
        process.removeListener('SIGINT', handleSigint)
        res()
      })
    })
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
    // and only MOONSHOT_API_KEY set, while activeProvider defaults to openai):
    // adopt the keyed provider for the session instead of forcing the wizard.
    const withKey = PROVIDER_IDS.find((p) =>
      resolveApiKey(p, credentials, process.env, credentialVault, warnCredentials),
    )
    if (withKey) {
      provider = withKey
      resolved = resolveApiKey(provider, credentials, process.env, credentialVault, warnCredentials)!
      // stderr, never stdout: `athena exec --output json` must emit pure envelopes.
      console.error(`Using ${PROVIDERS[provider].label} (only provider with a configured key).`)
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
  // Trusted-project bootstrap: effective trusted mode (+ unrestricted shell on win32).
  // exec keeps its explicit flag-driven defaults instead (headless contract).
  if (!isExec) applyTrustBootstrap(settings, paths, cwd)
  const vmpLedger = settings.vmp.enabled ? FileLedgerStore.forPaths(paths) : undefined
  const vmpRecorder = makeTelemetryRecorder(vmpLedger)
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
  const bridge = new PermissionBridge()
  const permissionDetails = new Map<string, string>()
  // Session selection the controller cannot express as a bare id: `--continue` takes the
  // latest session for this project, `--resume` asks. Handed over as a callback so the
  // picker still mounts at the point in startup it always has — after the plugin, skill,
  // and agent warnings have printed on stderr rather than racing them onto its frame.
  const selectSession = cmd.command === 'continue'
    ? async (store: SessionStore) => {
        const latest = store.continueLatest()
        if (!latest) return null
        // `continueLatest` and `list` are two separate directory scans, so a delete landing
        // between them (a concurrent Athena, `/delete`) leaves an id with no file. A fresh
        // session beats a crash on the way in, but say so rather than quietly ignoring the ask.
        const found = store.list().find((s) => s.id === latest.id)
        if (!found) {
          console.error(`Session ${latest.id} disappeared while starting; starting a fresh session instead.`)
          return null
        }
        return { id: latest.id, file: found.file, messages: latest.messages }
      }
    : cmd.command === 'resume'
      ? async (store: SessionStore) => {
          const picked = screenInput
            ? await pickSessionLine(store.list(), screenInput)
            : await pickSession(store.list())
          if (!picked) return null
          return { id: picked.id, file: picked.file, messages: store.resume(picked.id) }
        }
      : undefined
  // One session composition for every path: exec, the append-only screen-reader loop, the
  // Ink TUI below, and `athena voice` above all build the same controller.
  const controller = await HarnessSessionController.create({
    paths,
    effectivePaths,
    cwd,
    provider,
    client: makeClient(provider, resolved.key, vmpRecorder),
    settings,
    projectTrust,
    limits: isExec ? cmd.options.limits : undefined,
    outputSchema,
    resumeId: isExec ? (cmd.options.resumeId ?? undefined) : undefined,
    persistSession: isExec ? cmd.options.persistSession : true,
    selectSession,
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
    onAnnouncement: (announcement) => {
      // The richer permission prompt immediately follows its semantic blocker; reading
      // both aloud would announce one decision twice.
      if (announcement.category !== 'permission') screenPresentation?.announce(announcement)
    },
    onEnvelope: (event) => {
      if (cmd.command === 'exec' && cmd.options.output === 'jsonl') {
        pendingSemanticEvents.push(event)
      }
    },
  })
  const {
    bus,
    engine,
    gate,
    trace,
    mcp,
    interaction,
    interactionService,
    experienceStore,
    contextManager,
    orchestrator,
    client,
    session,
    sessionStore: store,
  } = controller

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
      await controller.endSession('exec-complete')
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
      sessionId: controller.sessionPersisted ? session.id : null,
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
        controller.endSession('crash'),
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
      vmpRecorder,
      continuityStore: controller.continuityStore,
      ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
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
      await controller.endSession('interactive-exit')
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
      initialMessages: controller.initialMessages,
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
        vmpRecorder,
        continuityStore: controller.continuityStore,
        ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
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
    await controller.endSession('interactive-exit')
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
