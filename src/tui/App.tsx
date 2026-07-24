// src/tui/App.tsx
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Box, useApp, useInput, useStdout } from 'ink'
import type { EngineEventBus } from '../engine/events.js'
import type { EngineEvent, TodoItem, PermissionMode } from '../engine/types.js'
import { Transcript, type TranscriptEntry } from './components/Transcript.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { StatusLine } from './components/StatusLine.js'
import { Banner } from './components/Banner.js'
import { TodoPanel } from './components/TodoPanel.js'
import { InputBox } from './components/InputBox.js'
import { BusyIndicator, busyIndicatorText } from './components/BusyIndicator.js'
import { ArgPickerPopup } from './components/ArgPickerPopup.js'
import { parseSlash, type SlashCommand, type CustomCommandDef, type TuiMode } from './slash.js'
import {
  PICKABLE_KINDS,
  pickerOptions,
  currentOptionIndex,
  pickerTitle,
  type PickableKind,
  type ArgPickerState,
} from './argPicker.js'
import { createFullscreenController } from './fullscreen.js'
import type { ProviderId, Effort } from '../brain/models.js'
import { truncateRowsWithNotice, wrappedRowCount } from './viewport.js'
import {
  PERMISSION_HEADER_TEXT,
  PERMISSION_FOOTER_TEXT,
  DIALOG_HORIZONTAL_CHROME_COLS,
  DIALOG_SUMMARY_MAX_ROWS,
  DIALOG_REASON_MAX_ROWS,
} from './components/PermissionDialog.js'
import { diffNoticeText } from './components/DiffPreview.js'
import { todoLineText, todoNoticeText, TODO_HORIZONTAL_CHROME_COLS } from './components/TodoPanel.js'
import { statusLineText } from './components/StatusLine.js'
import type { AgentMentionSource } from './agentMention.js'
import { getVersion } from '../version.js'

// Fixed per-sibling row budgets used below to size Banner/TodoPanel/PermissionDialog
// against the ACTUAL terminal size in fullscreen mode. This matters because only the
// Transcript-wrapping Box has overflow="hidden" (see the render tree below) — Banner,
// TodoPanel, PermissionDialog, InputBox, and StatusLine are all siblings of a fixed
// height={rows} column Box with no overflow protection of their own. If their combined
// natural content size ever exceeds `rows`, Ink/Yoga doesn't clip or reflow gracefully —
// it corrupts the frame (dropped/interleaved lines, headers pushed off, etc.), which is
// exactly what this whole block exists to make structurally impossible: every dynamic
// (variable-content) sibling below is bounded to a computed budget with an explicit "+N
// more" notice rather than left to render however much content it naturally wants.
//
// Text-bearing chrome (StatusLine's segments, PermissionDialog's header/summary/
// reason/footer, each todo's line) is measured with wrappedRowCount against the ACTUAL
// current terminal width rather than assumed to always be exactly one row — a long cwd,
// a long tool-input summary (the engine truncates it to ~120 chars, which alone exceeds
// most terminal widths), or a long todo can all wrap to 2+ rows, and a narrower terminal
// (a common 40-80 column split pane) makes this the norm rather than the exception.
// Getting this wrong is exactly how the original corruption bug happened, just for
// content Ink/Yoga wraps instead of content that overflows a line count — see
// wrappedRowCount in viewport.ts, which estimateEntryRows (Transcript) already used this
// exact approach for.
//
// Border/padding rows and columns below (BANNER_ROWS, *_BORDER_ROWS, *_HORIZONTAL_CHROME)
// are the one part that's genuinely fixed regardless of content or terminal width — a
// borderStyle="round" edge is always exactly 1 row/column, never wraps.
const BANNER_ROWS = 4 // Banner.tsx always renders exactly 4 rows (border, wordmark, border, info line).
const TODO_BORDER_ROWS = 2 // TodoPanel's border top+bottom (borderStyle="round").
const DIALOG_BORDER_ROWS = 2 // PermissionDialog's border top+bottom (borderStyle="round").
// Transcript never drops below this many rows even when TodoPanel/PermissionDialog are
// competing for space. Safe to shrink this far (and no further matters) because
// Transcript's own wrapping Box is the one sibling with overflow="hidden" — this floor
// is purely about leaving a shred of visible context, not about avoiding corruption.
const MIN_TRANSCRIPT_ROWS = 3
// Pessimistic placeholder hidden-counts used ONLY to size the "+N more" notice
// reservation below (see dialogChromeRows/todoChromeRows) — NOT real data. Using a
// placeholder rather than the real (usually much smaller) hidden count means the
// reservation covers the worst realistic case regardless of how many diff lines/todos
// actually end up hidden: diffNoticeText/todoNoticeText are otherwise monotonic in the
// hidden count's digit length, so reserving for a generously large placeholder is always
// >= whatever the real notice will actually need.
const DIFF_NOTICE_PLACEHOLDER_HIDDEN = 999_999
const TODO_NOTICE_PLACEHOLDER_HIDDEN = 999
// Pessimistic placeholder elapsed time used ONLY to size BusyIndicator's row reservation
// below — NOT the real elapsed time. App.tsx never sees BusyIndicator's actual (ticking)
// elapsed-ms state, since that state lives inside the component and updates on its own
// interval independent of App's render cycle — so, same idea as the two notice
// placeholders above, the budget is computed against a generously large stand-in
// (~999 minutes) that's always >= however long busyIndicatorText's "M:SS" text can
// realistically grow for any turn a human would actually wait out.
const BUSY_ELAPSED_PLACEHOLDER_MS = 999 * 60_000
const FALLBACK_ROWS = 24
const FALLBACK_COLUMNS = 80

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
  /** Display label (e.g. "Sonnet 5") — used unchanged by StatusLine/Banner. */
  model: string
  /** Raw model key (e.g. "sonnet") — needed to highlight the current row in the /model
   *  picker without re-deriving it from `model` (labels aren't guaranteed reversible). */
  modelKey: string
  provider: ProviderId
  effort: string
  mode: PermissionMode
  contextPct: number
}

/** Bare (no trailing argument, per-command-name) match against the 5 slash commands
 *  whose value is an enumerable/fixed set — see argPicker.ts's PICKABLE_KINDS, the
 *  single source of truth this reuses rather than re-listing the names. Case-sensitive
 *  and trims only surrounding whitespace, mirroring parseSlash's own case-sensitivity
 *  (slash.ts) rather than inventing a looser match here. Exported for direct unit
 *  testing without mounting the component. */
export function detectBarePickableCommand(text: string): PickableKind | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const name = trimmed.slice(1)
  return PICKABLE_KINDS.has(name) ? (name as PickableKind) : null
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
  /** Invocable agents (AgentOrchestrator.listDefs(), plugin-aware — see cli.ts), threaded
   *  straight through to InputBox's combined '@' picker the same way `commands` is.
   *  Optional so existing callers/tests that don't wire any stay unaffected. */
  agents?: readonly AgentMentionSource[]
}

/** Live terminal row/column count, kept in sync with resize events. Ink's `useStdout`
 *  exposes the actual stream it's rendering to (`process.stdout`, or a test double under
 *  ink-testing-library — where `.rows`/`.columns` are undefined, hence the fallbacks). */
function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout()
  const [size, setSize] = useState(() => ({
    rows: stdout?.rows ?? FALLBACK_ROWS,
    columns: stdout?.columns ?? FALLBACK_COLUMNS,
  }))
  useEffect(() => {
    if (!stdout) return
    const onResize = () =>
      setSize({ rows: stdout.rows ?? FALLBACK_ROWS, columns: stdout.columns ?? FALLBACK_COLUMNS })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  return size
}

export function App({
  bus,
  status: statusProp,
  onSubmit,
  onSlash,
  onAbort,
  permissionBridge,
  commands,
  agents,
}: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [pending, setPending] = useState<PendingPermission | null>(null)
  const [busy, setBusy] = useState(false)
  // Turn-start reference for BusyIndicator's elapsed-time counter: a ref (not state)
  // because it must be readable synchronously the moment `busy` flips true, and mutating
  // it must never itself trigger a re-render. Set once per turn in submitTurn, right
  // before setBusy(true) — NOT recomputed from BusyIndicator's own render/mount timing,
  // which would drift if the component is briefly unmounted mid-turn (see the
  // `busy && pending === null` visibility gate below) and would reset to 0 on remount.
  const turnStartRef = useRef(0)
  // InputBox's actual current row count (it can grow past 1 via backslash-continuation —
  // see InputBox's onHeightChange). Used to size the fullscreen PermissionDialog/TodoPanel
  // budgets below against reality instead of a static guess.
  const [inputRows, setInputRows] = useState(1)
  // Seeded from the prop, then kept live by 'status' events (/mode, /model, per-turn ctx%).
  const [status, setStatus] = useState<AppStatus>(statusProp)
  // Second-level value picker for a bare pickable command (/model /provider /effort
  // /mode /tui) — see detectBarePickableCommand/handleSubmit below. null = not showing.
  const [argPicker, setArgPicker] = useState<ArgPickerState | null>(null)
  const { exit } = useApp()

  // Fullscreen (alternate-screen) TUI mode: /tui fullscreen | classic still toggles it
  // either way mid-session, but the DEFAULT is now TTY-gated rather than hard-coded to
  // classic. `useStdout()` reads Ink's StdoutContext, which is a plain React context value
  // (not something populated later by an effect), so it — and therefore
  // `fullscreenController.supported` derived from it — is already correct on the very
  // first render, before the `fullscreen` useState initializer below runs. Ordering
  // matters here: the controller must be constructed first so its `.supported` value
  // exists in time to seed the state's lazy initializer on the same render.
  const { stdout } = useStdout()
  const fullscreenController = useMemo(() => createFullscreenController(stdout), [stdout])
  // Real interactive TTY -> default fullscreen. Anything else (piped output, CI, and
  // ink-testing-library's stdout test double, which never sets `.isTTY`) -> default
  // classic, exactly as before — this is why the change doesn't require touching most
  // existing tests.
  const [fullscreen, setFullscreen] = useState(() => fullscreenController.supported)
  const { rows, columns } = useTerminalSize()

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

  // Purely a TUI presentation concern (like /clear): no engine involvement. Factored out
  // of handleSubmit's /tui branch so the picker's Enter-confirm path (see the argPicker
  // useInput below) can apply the same toggle without duplicating it.
  const applyTuiMode = useCallback(
    (value: TuiMode) => {
      if (value === 'fullscreen') {
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
    },
    [bus, fullscreenController],
  )

  // The value a picker of the given kind should open pre-selecting — read straight off
  // live `status` (kept current by 'status' events, see the bus.on effect above) for
  // everything except 'tui', which isn't part of AppStatus (it's purely local `fullscreen`
  // state, same as applyTuiMode above).
  const currentValueFor = useCallback(
    (kind: PickableKind): string => {
      switch (kind) {
        case 'model':
          return status.modelKey
        case 'provider':
          return status.provider
        case 'effort':
          return status.effort
        case 'mode':
          return status.mode
        case 'tui':
          return fullscreen ? 'fullscreen' : 'classic'
      }
    },
    [status, fullscreen],
  )

  // Shared by a plain user message and an expanded custom-command prompt: both must
  // enter the engine the exact same way (transcript entry, busy flag, crash handling).
  const submitTurn = useCallback(
    async (text: string) => {
      setEntries((prev) => [...prev, { kind: 'user', text }])
      turnStartRef.current = Date.now()
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
      // Bare pickable-command interception takes priority over parseSlash entirely — a
      // history-recalled "/model" or a slash-menu Tab/Enter hand-off (InputBox) both
      // arrive here as plain text, converging on this same check alongside a
      // directly-typed-and-Entered "/model". An explicit argument (e.g. "/model opus")
      // never matches (trailing text fails the exact-name check), so it falls straight
      // through to parseSlash below exactly as before.
      const barePickable = detectBarePickableCommand(text)
      if (barePickable) {
        if (busy && (barePickable === 'model' || barePickable === 'provider')) {
          // Same busy-guard as compact/model/provider below — mutating engine state
          // mid-turn corrupts the in-flight transcript. effort/mode/tui deliberately
          // stay ungated here, matching that existing asymmetry.
          bus.emit({
            type: 'info',
            message: `/${barePickable} is unavailable while a turn is running — finish or Esc the current turn first.`,
          })
          return
        }
        setArgPicker({
          kind: barePickable,
          index: currentOptionIndex(pickerOptions(barePickable, status.provider), currentValueFor(barePickable)),
        })
        return
      }
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
          applyTuiMode(slash.value)
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
    [onSlash, exit, busy, bus, commands, submitTurn, applyTuiMode, status, currentValueFor],
  )

  // Active only while the second-level value picker is open — Up/Down move the cursor
  // (clamped to the current option list), Escape cancels with no dispatch, Enter
  // confirms and dispatches through onSlash (or applyTuiMode for 'tui', which App
  // already handles locally rather than forwarding to the engine — see handleSubmit's
  // /tui branch above). Kept as its own useInput rather than folded into the
  // Escape-to-abort one below so each stays readable on its own.
  useInput(
    (_ch, key) => {
      if (!argPicker) return
      const options = pickerOptions(argPicker.kind, status.provider)
      if (key.escape) {
        setArgPicker(null)
        return
      }
      if (key.upArrow) {
        setArgPicker({ ...argPicker, index: Math.max(0, argPicker.index - 1) })
        return
      }
      if (key.downArrow) {
        setArgPicker({ ...argPicker, index: Math.min(options.length - 1, argPicker.index + 1) })
        return
      }
      if (key.return) {
        const selected = options[argPicker.index]
        setArgPicker(null)
        if (!selected) return
        switch (argPicker.kind) {
          case 'model':
            onSlash({ kind: 'model', value: selected.value })
            break
          case 'provider':
            onSlash({ kind: 'provider', value: selected.value })
            break
          case 'effort':
            onSlash({ kind: 'effort', value: selected.value as Effort })
            break
          case 'mode':
            onSlash({ kind: 'mode', value: selected.value as PermissionMode })
            break
          case 'tui':
            applyTuiMode(selected.value as TuiMode)
            break
        }
      }
    },
    { isActive: argPicker !== null },
  )

  // Permission review takes visual priority over ambient decoration/status: a pending
  // dialog gets the space Banner/TodoPanel would otherwise occupy instead of competing
  // with them for it. Classic mode is untouched — native scrollback already handles
  // overflow fine there, so nothing here is gated on `fullscreen` alone without also
  // checking `pending`.
  const dialogPendingFullscreen = fullscreen && pending !== null
  const showBanner = fullscreen && !dialogPendingFullscreen
  const showTodoPanel = todos.length > 0 && !dialogPendingFullscreen
  const bannerRows = showBanner ? BANNER_ROWS : 0

  // The busy indicator shows only while a turn is actually running with nothing blocking
  // it — mirrors InputBox's own `disabled={busy || pending !== null}` "is something
  // blocking normal input" condition. A pending permission dialog means the model isn't
  // "working", it's waiting on the user, so the indicator (and the row budget it'd
  // otherwise reserve) steps aside for the dialog exactly like Banner/TodoPanel already
  // do via dialogPendingFullscreen above.
  const showBusyIndicator = busy && pending === null
  // Like StatusLine below, this is a borderless plain-text line measured against the
  // FULL terminal width (no HORIZONTAL_CHROME_COLS to subtract) — see busyIndicatorText's
  // own doc comment for why BUSY_ELAPSED_PLACEHOLDER_MS (not the real, ticking elapsed
  // value App.tsx never sees) is what gets measured here.
  const busyIndicatorRows = showBusyIndicator
    ? wrappedRowCount(busyIndicatorText(BUSY_ELAPSED_PLACEHOLDER_MS), columns)
    : 0

  // StatusLine is a fixed footer, but its content (cwd/branch/model/mode/ctx%) is
  // arbitrary-length text with NO border/padding stealing width, so it's measured against
  // the full terminal width — see the file-header comment on why this can't just be "1".
  const statusLineRows = wrappedRowCount(statusLineText({ ...status, busy }), columns)

  // Real remaining-rows budget for PermissionDialog's diff view: terminal rows minus
  // StatusLine's ACTUAL wrapped height minus InputBox's ACTUAL current height minus a
  // floor reserved for Transcript minus the dialog's own chrome. dialogChromeRows is the
  // ACTUAL wrapped row count of the header/summary/reason/footer text (see
  // dialogTextColumns below) PLUS a reservation for the "+N more" notice, computed via
  // diffNoticeText with a pessimistic placeholder hidden-count — so `maxDiffLines` below
  // is a pure CONTENT-only budget (DiffPreview doesn't need to steal a row from it for
  // its own notice; the room is already set aside here). Whatever's left is exactly how
  // many diff lines DiffPreview may render before it must show that notice instead of
  // trusting Yoga/Ink to clip (or corrupt) whatever doesn't fit. undefined in classic mode
  // (or when nothing's pending) — DiffPreview falls back to its own static cap.
  //
  // Critically, the header/footer text is NEVER truncated, and summary/reason are only
  // ever truncated to a small, bounded number of rows (DIALOG_SUMMARY_MAX_ROWS/
  // DIALOG_REASON_MAX_ROWS — see PermissionDialog.tsx), never hidden outright — so
  // however tight the budget gets, "Permission required" always renders in full and the
  // diff view (or, in the most extreme case, a shred of Transcript) is what shrinks.
  //
  // Both the summary/reason cap AND the notice-reservation matter here: an independent
  // re-verification found that reserving a flat "1 row" for an UNCONDITIONALLY-verbose
  // notice message (and leaving summary/reason uncapped) could make the dialog's chrome
  // ALONE too tall for a real 40-column terminal, corrupting the frame even with zero
  // diff content shown.
  const dialogTextColumns = Math.max(columns - DIALOG_HORIZONTAL_CHROME_COLS, 1)
  const dialogChromeRows = pending
    ? DIALOG_BORDER_ROWS +
      wrappedRowCount(PERMISSION_HEADER_TEXT, dialogTextColumns) +
      Math.min(wrappedRowCount(pending.summary, dialogTextColumns), DIALOG_SUMMARY_MAX_ROWS) +
      Math.min(wrappedRowCount(pending.reason, dialogTextColumns), DIALOG_REASON_MAX_ROWS) +
      wrappedRowCount(PERMISSION_FOOTER_TEXT, dialogTextColumns) +
      wrappedRowCount(diffNoticeText(DIFF_NOTICE_PLACEHOLDER_HIDDEN, dialogTextColumns), dialogTextColumns)
    : 0
  const maxDiffLines = dialogPendingFullscreen
    ? Math.max(rows - statusLineRows - inputRows - MIN_TRANSCRIPT_ROWS - dialogChromeRows, 0)
    : undefined

  // Same idea for TodoPanel's row budget, when it's the one actually showing. Mutually
  // exclusive with the dialog budget above in fullscreen mode (TodoPanel is hidden
  // whenever a dialog is pending), so the two never compete for the same rows. A todo
  // item's own text can also wrap (see todoRowsOf/todoLineText), so this is a ROW budget
  // handed to TodoPanel, not an item-count budget — TodoPanel does its own per-item
  // wrapped-row accounting against the same effective width. Like the dialog above, the
  // budget already reserves room for TodoPanel's own "+N more" notice (see
  // todoNoticeText), so TodoPanel doesn't need to steal a row from it either.
  const todoTextColumns = Math.max(columns - TODO_HORIZONTAL_CHROME_COLS, 1)
  const todoRowsOf = (todo: TodoItem): number => wrappedRowCount(todoLineText(todo), todoTextColumns)
  const todoNoticeReserveRows = wrappedRowCount(
    todoNoticeText(TODO_NOTICE_PLACEHOLDER_HIDDEN, todoTextColumns),
    todoTextColumns,
  )
  const maxTodoRows =
    fullscreen && showTodoPanel
      ? Math.max(
          rows -
            statusLineRows -
            inputRows -
            bannerRows -
            busyIndicatorRows -
            MIN_TRANSCRIPT_ROWS -
            TODO_BORDER_ROWS -
            todoNoticeReserveRows,
          0,
        )
      : undefined

  // Fullscreen-only: bound the Transcript's render window to what actually fits above the
  // input/status row(s), so render/memory cost stays flat no matter how long the session
  // gets. Classic mode passes maxRows=undefined and Transcript renders everything, exactly
  // as before — native scrollback still does the heavy lifting there.
  //
  // A pending dialog claims all remaining space by design (see dialogPendingFullscreen
  // above), so Transcript drops straight to its floor rather than being estimated.
  // Otherwise, TodoPanel's actual (possibly wrapped, possibly truncated) row count is
  // subtracted, so a short todo list still leaves Transcript the generous majority of the
  // screen exactly as before this fix — only a todo list too big to fit forces Transcript
  // to the floor.
  const todoRowsUsed = showTodoPanel
    ? (() => {
        if (maxTodoRows === undefined) {
          return TODO_BORDER_ROWS + todos.reduce((sum, t) => sum + todoRowsOf(t), 0)
        }
        const { shown, hiddenCount } = truncateRowsWithNotice(todos, todoRowsOf, maxTodoRows)
        const noticeRows =
          hiddenCount > 0 ? wrappedRowCount(todoNoticeText(hiddenCount, todoTextColumns), todoTextColumns) : 0
        return TODO_BORDER_ROWS + shown.reduce((sum, t) => sum + todoRowsOf(t), 0) + noticeRows
      })()
    : 0
  const availableRows = !fullscreen
    ? undefined
    : dialogPendingFullscreen
      ? MIN_TRANSCRIPT_ROWS
      : Math.max(
          rows - statusLineRows - inputRows - bannerRows - busyIndicatorRows - todoRowsUsed,
          MIN_TRANSCRIPT_ROWS,
        )

  return (
    <Box flexDirection="column" height={fullscreen ? rows : undefined}>
      {/* Fixed header row, fullscreen-only — reserved for full-session branding rather
          than a one-shot splash (mirrors StatusLine's fixed footer below). Classic mode
          skips it entirely: it's native scrollback that a repainting banner would only
          clutter on every turn, and classic already has the compact status line for
          at-a-glance model/cwd. Also hidden whenever a permission dialog is pending (see
          showBanner above) — the dialog gets visual priority, not ambient branding. */}
      {showBanner && <Banner version={getVersion()} model={status.model} cwd={status.cwd} columns={columns} />}
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
      {/* Hidden whenever a permission dialog is pending in fullscreen (see showTodoPanel
          above) — same visual-priority reasoning as the banner. Classic mode is
          unaffected: showTodoPanel only ever differs from `todos.length > 0` when
          `fullscreen` is true. maxRows is undefined in classic mode (unbounded, as
          before); in fullscreen it bounds the panel to what's actually left, wrapping
          included. */}
      {showTodoPanel && <TodoPanel todos={todos} maxRows={maxTodoRows} columns={columns} />}
      {pending && (
        <PermissionDialog pending={pending} cwd={status.cwd} maxDiffLines={maxDiffLines} columns={columns} />
      )}
      {/* Only while a turn is actually running and nothing's blocking it (see
          showBusyIndicator above) — hidden the instant a permission dialog takes over,
          since the model is waiting on the user then, not "working". Mounting IS "turn
          started" from this component's own perspective (see BusyIndicator's spinner/
          tick effect), but the elapsed counter itself is driven by the stable
          turnStartRef timestamp below, not remount timing, so a dialog interruption
          mid-turn doesn't reset it back to 0. */}
      {showBusyIndicator && <BusyIndicator startedAt={turnStartRef.current} />}
      {/* Second-level value picker for a bare pickable command — same region
          SlashMenuPopup/MentionPopup already occupy inside InputBox, just one level up
          since App doesn't reach InputBox's internal render. Row-budget note: this
          popup, like those two, is deliberately NOT accounted for in the fullscreen
          row-budget math above — safe only because it can never be open at the same
          time as a pending PermissionDialog or a busy turn (see the disabled prop
          below: InputBox itself goes inert the moment argPicker is non-null, and
          argPicker can only ever be opened from handleSubmit, which is only reachable
          while InputBox was NOT already disabled). */}
      {argPicker && (
        <ArgPickerPopup
          title={pickerTitle(argPicker.kind)}
          options={pickerOptions(argPicker.kind, status.provider)}
          index={argPicker.index}
          currentValue={currentValueFor(argPicker.kind)}
        />
      )}
      {/* busy included: a prompt submitted mid-turn would start a second runTurn
          and interleave a user message between a tool_use and its tool_result.
          argPicker included: no new keystrokes while the picker owns Up/Down/Enter/Esc. */}
      <InputBox
        onSubmit={handleSubmit}
        disabled={busy || pending !== null || argPicker !== null}
        cwd={status.cwd}
        commands={commands}
        agents={agents}
        onHeightChange={setInputRows}
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
