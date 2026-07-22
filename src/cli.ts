// src/cli.ts — composition root: brain + engine + harness + TUI.
import { execSync } from 'node:child_process'
import { basename } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { render } from 'ink'
import React from 'react'
import { resolveBrainPaths } from './brain/paths.js'
import { loadSettings } from './brain/settings.js'
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
  todoTool,
  memoryTool,
  webfetchTool,
  websearchTool,
} from './tools/index.js'
import { makeAgentTool } from './tools/agent.js'
import { App, PermissionBridge } from './tui/App.js'
import { SessionPicker } from './tui/components/SessionPicker.js'
import type { SlashCommand } from './tui/slash.js'

export type CliCommand =
  | { command: 'run' }
  | { command: 'resume' }
  | { command: 'continue' }
  | { command: 'help' }
  | { command: 'import'; sourceDir: string; force: boolean }
  | { command: 'error'; message: string }

export function parseArgs(argv: string[]): CliCommand {
  if (argv[0] === 'import') {
    const sourceDir = argv[1]
    if (!sourceDir || sourceDir.startsWith('--'))
      return { command: 'error', message: 'Usage: athena import <path> [--force]' }
    return { command: 'import', sourceDir, force: argv.includes('--force') }
  }
  const known = new Set(['--help', '-h', '--resume', '--continue'])
  const unknown = argv.find((a) => !known.has(a))
  if (unknown) return { command: 'error', message: `Unknown argument: ${unknown} (try --help)` }
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help' }
  if (argv.includes('--resume')) return { command: 'resume' }
  if (argv.includes('--continue')) return { command: 'continue' }
  return { command: 'run' }
}

const HELP_TEXT = `athena — standalone terminal coding agent

Usage:
  athena                 new session in the current project
  athena --continue      resume the most recent session here
  athena --resume        pick a past session
  athena import <path>   one-time import of an ares-style brain (--force to merge)
  athena --help          this help

In-session: /help /clear /resume /compact /model /mode /memory /skills /agents /quit. Esc interrupts a turn.`

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
  client: AnthropicClient
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
          'Commands: /help /clear /resume /compact /model <id> /mode <normal|acceptEdits|plan|trusted> /memory /skills /agents /quit',
        )
        break
      case 'mode':
        gate.setMode(cmd.value)
        info(`Permission mode: ${cmd.value}`)
        break
      case 'model':
        engine.setModel(cmd.value)
        info(`Model: ${cmd.value}`)
        break
      case 'compact':
        void (async () => {
          try {
            const { messages, summary } = await contextManager.compact(engine.getMessages(), (p) =>
              client.complete({ model: engine.getModel(), prompt: p, maxTokens: 2048 }),
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

  // Interactive commands need a real terminal; headless invocations get help instead of a hung TUI.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(HELP_TEXT)
    console.log('\n(interactive session skipped: not a TTY)')
    return
  }
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ANTHROPIC_API_KEY is not set. Export it and re-run.')
    process.exitCode = 1
    return
  }

  const settings = loadSettings(paths)
  const gate = new PermissionEngine({
    mode: settings.permissionMode,
    allow: settings.allow,
    deny: settings.deny,
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
    todoTool,
    memoryTool,
    webfetchTool,
    websearchTool,
  ]) {
    registry.register(t as ToolDefinition<never>)
  }

  const systemPrompt = assembleSystemPrompt({
    constitution: loadConstitution(paths),
    memoryIndex: loadMemoryIndex(paths),
    projectContext: findProjectContextFiles(cwd),
    toolGuidance:
      'Use Read before Write/Edit. Prefer Grep/Glob over shell find. Keep tool outputs focused.',
    environment: {
      cwd,
      platform: process.platform,
      gitBranch: gitBranch(cwd),
      date: new Date().toISOString().slice(0, 10),
    },
  })
  const client = new AnthropicClient(process.env['ANTHROPIC_API_KEY'])
  const orchestrator = new AgentOrchestrator({
    defs: loadAgentsIndex(paths),
    clientFactory: () => client,
    baseRegistry: registry,
    gate,
    hooks,
    defaultModel: settings.model,
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
    model: settings.model,
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

  render(
    React.createElement(App, {
      bus,
      status: {
        cwd,
        gitBranch: gitBranch(cwd),
        model: settings.model,
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
