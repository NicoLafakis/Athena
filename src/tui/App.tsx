// src/tui/App.tsx
import { useEffect, useState, useCallback } from 'react'
import { Box, useApp, useInput } from 'ink'
import type { EngineEventBus } from '../engine/events.js'
import type { EngineEvent, TodoItem, PermissionMode } from '../engine/types.js'
import { Transcript, type TranscriptEntry } from './components/Transcript.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { StatusLine } from './components/StatusLine.js'
import { TodoPanel } from './components/TodoPanel.js'
import { InputBox } from './components/InputBox.js'
import { parseSlash, type SlashCommand } from './slash.js'

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
}

export function App({ bus, status, onSubmit, onSlash, onAbort, permissionBridge }: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [pending, setPending] = useState<PendingPermission | null>(null)
  const [busy, setBusy] = useState(false)
  const { exit } = useApp()

  useEffect(() => {
    permissionBridge.bind(setPending)
  }, [permissionBridge])

  useEffect(
    () =>
      bus.on((e: EngineEvent) => {
        setEntries((prev) => reduceEvent(prev, e)) // pure reducer, unit-testable
        if (e.type === 'todo-update') setTodos(e.todos)
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

  const handleSubmit = useCallback(
    async (text: string) => {
      const slash = parseSlash(text)
      if (slash) {
        if (slash.kind === 'quit') exit()
        else if (slash.kind === 'clear') setEntries([])
        else if (busy && (slash.kind === 'compact' || slash.kind === 'model')) {
          // Mutating engine state mid-turn corrupts the in-flight transcript.
          bus.emit({
            type: 'info',
            message: `/${slash.kind} is unavailable while a turn is running — finish or Esc the current turn first.`,
          })
        } else onSlash(slash)
        return
      }
      setEntries((prev) => [...prev, { kind: 'user', text }])
      setBusy(true)
      await onSubmit(text)
    },
    [onSubmit, onSlash, exit, busy, bus],
  )

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {pending && <PermissionDialog pending={pending} />}
      <InputBox onSubmit={handleSubmit} disabled={pending !== null} />
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
