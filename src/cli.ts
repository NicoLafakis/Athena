// src/cli.ts — composition root: brain + engine + harness + TUI.
import { execSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { render } from 'ink'
import React from 'react'
import { resolveBrainPaths } from './brain/paths.js'
import { loadSettings } from './brain/settings.js'
import {
  normalizeModel,
  modelLabel,
  modelKeys,
  supportsEffort,
  PROVIDERS,
  PROVIDER_IDS,
  normalizeProvider,
  type ProviderId,
} from './brain/models.js'
import {
  loadCredentials,
  resolveApiKey,
  formatAuthStatus,
  type Credentials,
} from './brain/credentials.js'
import { runAuthWizard } from './auth/wizard.js'
import { ClientHolder } from './engine/client-holder.js'
import {
  loadConstitution,
  loadMemoryIndex,
  loadSkillsIndex,
  loadAgentsIndex,
} from './brain/loader.js'
import { importBrain } from './brain/import.js'
import { ensureBrainScaffold } from './harness/bootstrap.js'
import { PermissionEngine } from './harness/permissions.js'
import { HookRunner } from './harness/hooks.js'
import { McpManager } from './harness/mcp.js'
import { Session, SessionStore, type SessionInfo } from './harness/sessions.js'
import { AgentOrchestrator } from './harness/agents.js'
import { Engine } from './engine/loop.js'
import { AnthropicClient } from './engine/client.js'
import { EngineEventBus } from './engine/events.js'
import { ContextManager } from './engine/context.js'
import { assembleSystemPrompt, findProjectContextFiles } from './engine/prompt.js'
import type { BrainPaths } from './brain/paths.js'
import type { ToolDefinition } from './engine/types.js'
import { ToolRegistry } from './tools/registry.js'
import {
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  powershellTool,
  taskOutputTool,
  todoTool,
  memoryTool,
  webfetchTool,
  websearchTool,
} from './tools/index.js'
import { makeSkillTool } from './tools/skill.js'
import { makeAgentTool } from './tools/agent.js'
import { App, PermissionBridge } from './tui/App.js'
import { SessionPicker } from './tui/components/SessionPicker.js'
import type { SlashCommand } from './tui/slash.js'

export type CliCommand =
  | { command: 'run'; provider?: ProviderId }
  | { command: 'resume'; provider?: ProviderId }
  | { command: 'continue'; provider?: ProviderId }
  | { command: 'help' }
  | { command: 'auth'; sub: 'wizard' | 'status'; provider?: ProviderId }
  | { command: 'import'; sourceDir: string; force: boolean }
  | { command: 'error'; message: string }

export function parseArgs(argv: string[]): CliCommand {
  if (argv[0] === 'import') {
    const sourceDir = argv[1]
    if (!sourceDir || sourceDir.startsWith('--'))
      return { command: 'error', message: 'Usage: athena import <path> [--force]' }
    return { command: 'import', sourceDir, force: argv.includes('--force') }
  }
  if (argv[0] === 'auth') {
    let sub: 'wizard' | 'status' = 'wizard'
    let provider: ProviderId | undefined
    const rest = argv.slice(1)

    // Check for 'status' subcommand
    if (rest[0] === 'status') {
      sub = 'status'
      rest.shift()
    }

    // Check for --provider flag
    if (rest.length > 0 && rest[0] === '--provider') {
      // --provider is not allowed on status; only on wizard
      if (sub === 'status') return { command: 'error', message: AUTH_USAGE }
      const value = rest[1]
      if (!value) return { command: 'error', message: AUTH_USAGE }
      const p = normalizeProvider(value)
      if (!p) return { command: 'error', message: `--provider needs one of: ${PROVIDER_IDS.join(', ')}` }
      provider = p
      rest.splice(0, 2)
    }

    // Check for unexpected remaining args
    if (rest.length > 0) return { command: 'error', message: AUTH_USAGE }

    return { command: 'auth', sub, provider }
  }
  const rest = [...argv]
  let provider: ProviderId | undefined
  const pi = rest.indexOf('--provider')
  if (pi !== -1) {
    const value = rest[pi + 1]
    const p = value ? normalizeProvider(value) : null
    if (!p) return { command: 'error', message: `--provider needs one of: ${PROVIDER_IDS.join(', ')}` }
    provider = p
    rest.splice(pi, 2)
  }
  const known = new Set(['--help', '-h', '--resume', '--continue'])
  const unknown = rest.find((a) => !known.has(a))
  if (unknown) return { command: 'error', message: `Unknown argument: ${unknown} (try --help)` }
  if (rest.includes('--help') || rest.includes('-h')) return { command: 'help' }
  if (rest.includes('--resume')) return { command: 'resume', provider }
  if (rest.includes('--continue')) return { command: 'continue', provider }
  return { command: 'run', provider }
}

const AUTH_USAGE = 'Usage: athena auth [status] [--provider <anthropic|kimi>]'

const HELP_TEXT = `athena — standalone terminal coding agent

Usage:
  athena                 new session in the current project
  athena --continue      resume the most recent session here
  athena --resume        pick a past session
  athena --provider <anthropic|kimi>  session-only provider override (combines with the above)
  athena auth            add/replace API keys, switch the default provider
  athena auth status     show configured providers and redacted keys
  athena import <path>   one-time import of an ares-style brain (--force to merge)
  athena --help          this help

In-session: /help /clear /resume /compact /model /effort /provider /mode /memory /skills /agents /quit. Esc interrupts a turn.`

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

interface SlashDeps {
  bus: EngineEventBus
  engine: Engine
  gate: PermissionEngine
  contextManager: ContextManager
  client: ClientHolder
  store: SessionStore
  session: Session | null
  paths: BrainPaths
}

export function makeSlashHandler(deps: SlashDeps): (cmd: SlashCommand) => void {
  const { bus, engine, gate, contextManager, client, store, session, paths } = deps
  const info = (message: string) => bus.emit({ type: 'info', message })
  return (cmd) => {
    switch (cmd.kind) {
      case 'help':
        info(
          'Commands: /help /clear /resume /compact /model <haiku|sonnet|opus|fable> /effort <low|medium|high|xhigh|max> /provider <anthropic|kimi> /mode <normal|acceptEdits|plan|trusted> /memory /skills /agents /quit\n' +
            '/clear clears the screen (transcript display only) — conversation context is unchanged; use /compact to shrink it.',
        )
        break
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
        bus.emit({ type: 'status', patch: { model: modelLabel(provider, key) } })
        info(
          supportsEffort(provider, key)
            ? `Model: ${modelLabel(provider, key)} (effort ${engine.getEffort()})`
            : `Model: ${modelLabel(provider, key)} — effort/extended thinking not applicable on this model.`,
        )
        break
      }
      case 'provider': {
        const p = normalizeProvider(cmd.value)
        if (!p) {
          info(`Unknown provider: ${cmd.value} — choose ${PROVIDER_IDS.join(' or ')}.`)
          break
        }
        if (p === engine.getProvider()) {
          info(`Already on ${PROVIDERS[p].label}.`)
          break
        }
        let resolved
        try {
          resolved = resolveApiKey(p, loadCredentials(paths))
        } catch (err) {
          info((err as Error).message)
          break
        }
        if (!resolved) {
          info(
            `No API key configured for ${PROVIDERS[p].label} — run \`athena auth\` (or restart with \`athena --provider ${p}\`) to add one.`,
          )
          break
        }
        client.swap(makeClient(p, resolved.key))
        engine.setProvider(p)
        engine.setModel(PROVIDERS[p].defaultModel)
        bus.emit({ type: 'status', patch: { model: modelLabel(p, PROVIDERS[p].defaultModel) } })
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
            : `Effort set to ${cmd.value} — ${modelLabel(provider, key)} ignores it.`,
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
        const skills = loadSkillsIndex(paths)
        info(
          skills.length > 0
            ? skills.map((s) => `${s.name} — ${s.description}`).join('\n')
            : '(no skills defined)',
        )
        break
      }
      case 'agents': {
        const agents = loadAgentsIndex(paths)
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
        // 'clear' and 'quit' are handled inside the App component.
        break
    }
  }
}

function makeClient(provider: ProviderId, key: string): AnthropicClient {
  return new AnthropicClient(key, PROVIDERS[provider].baseURL ?? undefined)
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const paths = resolveBrainPaths({ cwd })
  ensureBrainScaffold(paths)
  const cmd = parseArgs(process.argv.slice(2))

  if (cmd.command === 'error') {
    console.error(cmd.message)
    process.exitCode = 1
    return
  }
  if (cmd.command === 'help') {
    console.log(HELP_TEXT)
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
  if (cmd.command === 'auth') {
    if (cmd.sub === 'status') {
      try {
        const creds = loadCredentials(paths)
        console.log(formatAuthStatus(creds, creds.activeProvider))
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
    await runAuthWizard({ paths, provider: cmd.provider })
    return
  }

  // Interactive commands need a real terminal; headless invocations get help instead of a hung TUI.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(HELP_TEXT)
    console.log('\n(interactive session skipped: not a TTY)')
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
  const provider: ProviderId = cmd.provider ?? credentials.activeProvider
  let resolved = resolveApiKey(provider, credentials)
  if (!resolved) {
    // First run (or a provider selected via --provider that has no key yet): drop into
    // the wizard scoped to that provider, then continue straight into the session.
    console.log(
      `No API key found for ${PROVIDERS[provider].label} - let's set one up. (This provider becomes your default; athena auth switches it.)`,
    )
    const done = await runAuthWizard({ paths, provider })
    resolved = { key: done.key, source: 'file' }
  }
  const settings = loadSettings(paths, provider)
  const gate = new PermissionEngine({
    mode: settings.permissionMode,
    allow: settings.allow,
    deny: settings.deny,
    cwd, // same coordinate system the tools resolve file_path against
  })
  const hooks = new HookRunner(settings.hooks)
  const bus = new EngineEventBus()
  const store = new SessionStore(paths.sessionsDir, cwd)

  const registry = new ToolRegistry()
  for (const t of [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
    powershellTool,
    taskOutputTool, // read-only poll over background shell tasks; flows to sub-agents via the base registry
    todoTool,
    memoryTool,
    webfetchTool,
    websearchTool,
  ]) {
    registry.register(t as ToolDefinition<never>)
  }
  // Skill is read-only and part of the base registry so sub-agents can receive it
  // under tool restriction; register it before Agent (which nests one level only).
  registry.register(makeSkillTool(paths) as ToolDefinition<never>)

  // MCP: connect to configured servers and mount their tools into the BASE registry
  // BEFORE the orchestrator is built, so sub-agents inherit them under restriction.
  // Connection failures are non-fatal (handled inside connectAll); an empty config is a no-op.
  const mcp = new McpManager()
  await mcp.connectAll(settings.mcpServers, registry, (m) => bus.emit({ type: 'info', message: m }))

  const systemPrompt = assembleSystemPrompt({
    constitution: loadConstitution(paths),
    memoryIndex: loadMemoryIndex(paths),
    projectContext: findProjectContextFiles(cwd),
    toolGuidance:
      'Use Read before Write/Edit. Prefer Grep/Glob over shell find. Keep tool outputs focused.',
    skills: loadSkillsIndex(paths),
    environment: {
      cwd,
      platform: process.platform,
      gitBranch: gitBranch(cwd),
      date: new Date().toISOString().slice(0, 10),
    },
  })
  const client = new ClientHolder(makeClient(provider, resolved.key))
  const orchestrator = new AgentOrchestrator({
    defs: loadAgentsIndex(paths),
    clientFactory: () => client,
    baseRegistry: registry,
    gate,
    hooks,
    defaultModel: () => engine.getModel(), // thunk: /model mid-session reaches sub-agents
    defaultProvider: () => engine.getProvider(), // thunk: /provider mid-session reaches sub-agents
    defaultEffort: () => engine.getEffort(), // thunk: /effort mid-session reaches sub-agents
    systemPromptBase: systemPrompt,
  })
  registry.register(makeAgentTool(orchestrator) as ToolDefinition<never>)

  // Session selection: run = fresh; continue = latest here (or fresh); resume = picker (or fresh).
  let session: Session
  let history: MessageParam[] = []
  if (cmd.command === 'continue') {
    const latest = store.continueLatest()
    if (latest) {
      history = latest.messages
      const found = store.list().find((s) => s.id === latest.id)!
      session = new Session(latest.id, found.file, history.length)
    } else {
      session = store.create()
    }
  } else if (cmd.command === 'resume') {
    const picked = await pickSession(store.list())
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
        session.appendEvent(e)
      } catch {
        /* journaling is best-effort */
      }
    }
  })

  const bridge = new PermissionBridge()
  const contextManager = new ContextManager({ modelWindowTokens: 200_000 })
  const engine = new Engine({
    client,
    bus,
    registry,
    gate,
    hooks,
    contextManager,
    toolContext: {
      cwd,
      brainDir: paths.brainDir,
      projectBrainDir: paths.projectBrainDir,
      fileReadRegistry: new Set(),
      todos: [],
      emit: (e) => bus.emit(e),
      abortSignal: new AbortController().signal, // replaced per-turn by the engine's own signal
    },
    provider,
    model: settings.model,
    effort: settings.effort,
    systemPrompt,
    maxTokens: 8192,
    askUser: (req) => bridge.ask(req),
    onMessagesChanged: (messages) => {
      // A full disk / locked file must not kill the TUI mid-turn.
      try {
        session.rewriteOrAppend(messages)
      } catch (err) {
        bus.emit({
          type: 'error',
          message: `Session write failed: ${(err as Error).message}`,
          fatal: false,
        })
      }
    },
  })
  if (history.length > 0) engine.loadMessages(history)

  await hooks.run('SessionStart', { cwd })

  // Last-resort crash handlers: an escaped rejection or exception must land on disk
  // and surface in the TUI, not kill the process (Node >=15 default). Never exit here.
  const crashHandler = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? message) : message
    try {
      appendFileSync(join(paths.brainDir, 'crash.log'), `${new Date().toISOString()} ${stack}\n`, 'utf8')
    } catch {
      /* the crash log failing must not itself crash */
    }
    bus.emit({ type: 'error', message: `Internal crash (logged to crash.log): ${message}`, fatal: true })
  }
  process.on('unhandledRejection', crashHandler)
  process.on('uncaughtException', crashHandler)

  const instance = render(
    React.createElement(App, {
      bus,
      status: {
        cwd,
        gitBranch: gitBranch(cwd),
        model: modelLabel(provider, settings.model),
        effort: settings.effort,
        mode: gate.getMode(),
        contextPct: Math.round(contextManager.usedFraction() * 100),
      },
      onSubmit: (text: string) => engine.runTurn(text),
      onAbort: () => engine.abort(),
      permissionBridge: bridge,
      onSlash: makeSlashHandler({
        bus,
        engine,
        gate,
        contextManager,
        client,
        store,
        session,
        paths,
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
    await mcp.closeAll()
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
    process.exitCode = 1
  })
}
