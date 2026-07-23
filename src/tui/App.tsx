// src/tui/App.tsx
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Box, useApp, useInput, useStdout } from 'ink'
import type { EngineEventBus } from '../engine/events.js'
import type { EngineEvent, TodoItem, PermissionMode } from '../engine/types.js'
import { Transcript, type TranscriptEntry } from './components/Transcript.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { StatusLine } from './components/StatusLine.js'
import { TodoPanel } from './components/TodoPanel.js'
import { InputBox } from './components/InputBox.js'
import { parseSlash, type SlashCommand, type CustomCommandDef } from './slash.js'
import { createFullscreenController } from './fullscreen.js'

// Rows reserved below the transcript's flexible area in fullscreen mode: status line (1)
// plus headroom for the input box growing to a couple of wrapped lines and an occasional
// todo panel/permission dialog. Approximate on purpose — Transcript's own virtualization
// is a heuristic too (see viewport.ts), and the overflow:hidden wrapper below clips
// anything the estimate undershoots rather than letting it push the input off-screen.
const FULLSCREEN_RESERVED_ROWS = 6
const FALLBACK_ROWS = 24

export type PermissionAnswer = 'allow-once' | 'allow-always' | 'deny'

export interface PendingPermission {
  toolName: string
  input: unknown
  summary: string
  reason: string
  resolve: (a: PermissionAnswer) => void
}

/** Bridges the Engine's askUser callback into React state.
 *  Concurrent asks (e.g. parallel sub-agents) queue and present one dialog at a time. */
export class PermissionBridge {
  private setter: ((p: PendingPermission | null) => void) | null = null
  private current: PendingPermission | null = null
  private readonly queue: PendingPermission[] = []

  bind(setter: (p: PendingPermission | null) => void): void {
    this.setter = setter
  }

  /** Passed to Engine as askUser. */
  ask(req: { toolName: string; input: unknown; summary: string; reason: string }): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      if (!this.setter) {
        resolve('deny') // headless: fail safe
        return
      }
      const pending: PendingPermission = {
        ...req,
        resolve: (a) => {
          this.current = this.queue.shift() ?? null
          this.setter?.(this.current)
          resolve(a)
        },
      }
      if (this.current) {
        this.queue.push(pending) // one dialog at a time: never clobber the pending ask
      } else {
        this.current = pending
        this.setter(pending)
      }
    })
  }

  /** Abort path: deny the current and all queued asks so no dialog survives a dead turn. */
  cancelAll(): void {
    // Clear the queue BEFORE resolving: each wrapped resolve advances the (now empty)
    // queue, so nothing stale gets re-presented.
    const all = [this.current, ...this.queue.splice(0)].filter(
      (p): p is PendingPermission => p !== null,
    )
    this.current = null
    this.setter?.(null)
    for (const p of all) p.resolve('deny')
  }
}

export interface AppStatus {
  cwd: string
  gitBranch: string | null
  model: string
  effort: string
  mode: PermissionMode
  contextPct: number
}

export interface AppProps {
  bus: EngineEventBus
  status: AppStatus
  onSubmit: (text: string) => Promise<void>
  onSlash: (cmd: SlashCommand) => void
  onAbort: () => void
  permissionBridge: PermissionBridge
  /** Directory-backed custom commands (see brain/loader.js loadCommandsIndex), keyed by name.
   *  Optional so existing callers/tests that don't wire any stay unaffected. */
  commands?: ReadonlyMap<string, CustomCommandDef>
}

/** Live terminal row count, kept in sync with resize events. Ink's `useStdout` exposes
 *  the actual stream it's rendering to (`process.stdout`, or a test double under
 *  ink-testing-library — where `.rows` is undefined, hence the fallback). */
function useTerminalRows(): number {
  const { stdout } = useStdout()
  const [rows, setRows] = useState(() => stdout?.rows ?? FALLBACK_ROWS)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => setRows(stdout.rows ?? FALLBACK_ROWS)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  return rows
}

export function App({
  bus,
  status: statusProp,
  onSubmit,
  onSlash,
  onAbort,
  permissionBridge,
  commands,
}: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [pending, setPending] = useState<PendingPermission | null>(null)
  const [busy, setBusy] = useState(false)
  // Seeded from the prop, then kept live by 'status' events (/mode, /model, per-turn ctx%).
  const [status, setStatus] = useState<AppStatus>(statusProp)
  const { exit } = useApp()

  // Fullscreen (alternate-screen) TUI mode: an additive, opt-in toggle via /tui
  // fullscreen | classic. Classic (false) is the default and the existing rendering
  // path — nothing below this block runs any differently when it stays false.
  const [fullscreen, setFullscreen] = useState(false)
  const { stdout } = useStdout()
  const fullscreenController = useMemo(() => createFullscreenController(stdout), [stdout])
  const rows = useTerminalRows()

  useEffect(() => {
    if (!fullscreen) return
    fullscreenController.enter()
    // Runs on toggling back to classic AND on unmount (e.g. /quit, Ctrl+C) — either way
    // the alternate screen must never be left active once this effect stops owning it.
    return () => fullscreenController.exit()
  }, [fullscreen, fullscreenController])

  // Belt-and-suspenders: dispose this controller's process-exit/signal restore hook when
  // the component itself goes away, independent of the fullscreen toggle above.
  useEffect(() => () => fullscreenController.dispose(), [fullscreenController])

  useEffect(() => {
    permissionBridge.bind(setPending)
  }, [permissionBridge])

  useEffect(
    () =>
      bus.on((e: EngineEvent) => {
        setEntries((prev) => reduceEvent(prev, e)) // pure reducer, unit-testable
        if (e.type === 'todo-update') setTodos(e.todos)
        if (e.type === 'status') setStatus((prev) => ({ ...prev, ...e.patch }))
        if (e.type === 'turn-done' || (e.type === 'error' && e.fatal)) setBusy(false)
      }),
    [bus],
  )

  useInput((_ch, key) => {
    if (key.escape && busy) {
      onAbort()
      // No permission dialog may survive a dead turn (queued sub-agent asks included).
      permissionBridge.cancelAll()
    }
  })

  // Shared by a plain user message and an expanded custom-command prompt: both must
  // enter the engine the exact same way (transcript entry, busy flag, crash handling).
  const submitTurn = useCallback(
    async (text: string) => {
      setEntries((prev) => [...prev, { kind: 'user', text }])
      setBusy(true)
      try {
        await onSubmit(text)
      } catch (err) {
        // A rejected turn must surface in the transcript, not become an unhandled
        // rejection (Node >=15 kills the process). fatal:true also resets busy above.
        bus.emit({ type: 'error', message: `Turn crashed: ${(err as Error).message}`, fatal: true })
      }
    },
    [onSubmit, bus],
  )

  const handleSubmit = useCallback(
    async (text: string) => {
      const slash = parseSlash(text, commands)
      if (slash) {
        if (slash.kind === 'quit') exit()
        else if (slash.kind === 'clear') {
          // Display-only: the engine's message history (and the session file) keep
          // the full conversation — /compact is the tool that shrinks context.
          setEntries([])
          bus.emit({
            type: 'info',
            message: 'Screen cleared (transcript display only) — conversation context is unchanged.',
          })
        } else if (slash.kind === 'custom') {
          // Custom commands are just a prompt-template expansion in front of an
          // ordinary turn — reuse the exact same engine path as free-typed text.
          await submitTurn(slash.expandedPrompt)
        } else if (slash.kind === 'tui') {
          // Purely a TUI presentation concern (like /clear): no engine involvement.
          if (slash.value === 'fullscreen') {
            if (!fullscreenController.supported) {
              bus.emit({
                type: 'info',
                message: 'Fullscreen mode needs an interactive terminal; staying in classic mode.',
              })
            } else {
              setFullscreen(true)
              bus.emit({
                type: 'info',
                message: 'Fullscreen mode enabled (alternate screen buffer). /tui classic to return.',
              })
            }
          } else {
            setFullscreen(false)
            bus.emit({ type: 'info', message: 'Classic mode restored (native scrollback).' })
          }
        } else if (busy && (slash.kind === 'compact' || slash.kind === 'model' || slash.kind === 'provider')) {
          // Mutating engine state mid-turn corrupts the in-flight transcript.
          bus.emit({
            type: 'info',
            message: `/${slash.kind} is unavailable while a turn is running — finish or Esc the current turn first.`,
          })
        } else onSlash(slash)
        return
      }
      await submitTurn(text)
    },
    [onSlash, exit, busy, bus, commands, submitTurn, fullscreenController],
  )

  // Fullscreen-only: bound the Transcript's render window to what actually fits above the
  // input/status row(s), so render/memory cost stays flat no matter how long the session
  // gets. Classic mode passes maxRows=undefined and Transcript renders everything, exactly
  // as before — native scrollback still does the heavy lifting there.
  const availableRows = fullscreen ? Math.max(rows - FULLSCREEN_RESERVED_ROWS, 3) : undefined

  return (
    <Box flexDirection="column" height={fullscreen ? rows : undefined}>
      {/* flexGrow + justifyContent="flex-end" pins whatever fits at the bottom of the
          flexible area (just above the input), and overflow="hidden" clips anything the
          virtualization estimate undershoots instead of pushing the input off-screen.
          Classic mode gets none of this — flexGrow/height stay undefined, matching the
          previous unconstrained top-down layout exactly. */}
      <Box
        flexDirection="column"
        flexGrow={fullscreen ? 1 : undefined}
        justifyContent={fullscreen ? 'flex-end' : 'flex-start'}
        overflow={fullscreen ? 'hidden' : 'visible'}
      >
        <Transcript entries={entries} maxRows={availableRows} />
      </Box>
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {pending && <PermissionDialog pending={pending} cwd={status.cwd} />}
      {/* busy included: a prompt submitted mid-turn would start a second runTurn
          and interleave a user message between a tool_use and its tool_result. */}
      <InputBox
        onSubmit={handleSubmit}
        disabled={busy || pending !== null}
        cwd={status.cwd}
        commands={commands}
      />
      <StatusLine {...status} busy={busy} />
    </Box>
  )
}

/** Pure event -> transcript reducer: appends/extends assistant text, opens/closes tool cards. */
export function reduceEvent(prev: TranscriptEntry[], e: EngineEvent): TranscriptEntry[] {
  switch (e.type) {
    case 'assistant-text': {
      const last = prev.at(-1)
      if (last?.kind === 'assistant')
        return [...prev.slice(0, -1), { ...last, text: last.text + e.delta }]
      return [...prev, { kind: 'assistant', text: e.delta }]
    }
    case 'tool-request':
      return [...prev, { kind: 'tool', id: e.id, name: e.name, input: e.input, output: null, isError: false }]
    case 'tool-result':
      return prev.map((entry) =>
        entry.kind === 'tool' && entry.id === e.id
          ? { ...entry, output: e.output, isError: e.isError }
          : entry,
      )
    case 'compaction':
      return [...prev, { kind: 'system', text: `Context compacted. ${e.summary.slice(0, 200)}` }]
    case 'info':
      return [...prev, { kind: 'system', text: e.message }]
    case 'error':
      return [...prev, { kind: 'system', text: `Error: ${e.message}` }]
    default:
      return prev
  }
}
