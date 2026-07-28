// src/tui/App.tsx
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Box, useApp, useInput, useStdout } from 'ink'
import type { EngineEventBus } from '../engine/events.js'
import type { EngineEvent, TodoItem, PermissionMode } from '../engine/types.js'
import { Transcript, type TranscriptEntry } from './components/Transcript.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { StatusLine } from './components/StatusLine.js'
import { Banner, bannerRowCount } from './components/Banner.js'
import { TodoPanel } from './components/TodoPanel.js'
import { useInputBox } from './components/InputBox.js'
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
import { popupLayout } from './popupWindow.js'
import type { ProviderId, Effort } from '../brain/models.js'
import { estimateEntryRows, shiftWindowEnd, truncateRowsWithNotice, wrappedRowCount } from './viewport.js'
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
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

// Fixed per-sibling row budgets used below to size Banner/TodoPanel/PermissionDialog
// against the ACTUAL terminal size in fullscreen mode. This matters because only the
// Transcript-wrapping Box has overflow="hidden" (see the render tree below) — Banner,
// TodoPanel, PermissionDialog, InputBox, and StatusLine are all siblings of a fixed
// height={rows} column Box with no overflow protection of their own — and so are the three
// overlay popups (ArgPickerPopup here, MentionPopup/SlashMenuPopup inside InputBox), whose
// window/row math lives in popupWindow.ts and whose height reaches this budget via
// argPickerLayout and InputBox's onHeightChange respectively. If their combined
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
const TODO_BORDER_ROWS = 2 // TodoPanel's border top+bottom (borderStyle="round").
const DIALOG_BORDER_ROWS = 2 // PermissionDialog's border top+bottom (borderStyle="round").
// Transcript never drops below this many rows even when TodoPanel/PermissionDialog are
// competing for space. Safe to shrink this far (and no further matters) because
// Transcript's own wrapping Box is the one sibling with overflow="hidden" — this floor
// is purely about leaving a shred of visible context, not about avoiding corruption.
const MIN_TRANSCRIPT_ROWS = 3
// Pessimistic placeholder hidden-counts used ONLY to size the "+N more" notice
// reservation below (see dialogChromeRows/todoBudgetRows) — NOT real data. The reservation
// has to cover whatever the real (unknown at budget time) hidden count will produce.
const DIFF_NOTICE_PLACEHOLDER_HIDDEN = 999_999
const TODO_NOTICE_PLACEHOLDER_HIDDEN = 999

/** Rows to reserve for a truncation notice whose hidden count isn't known yet.
 *
 *  NOT simply `wrappedRowCount(noticeText(placeholder))`. That assumed the notice text
 *  grows monotonically with the hidden count, so a generously large placeholder would
 *  always over-reserve. It does not: both diffNoticeText and todoNoticeText FALL BACK to a
 *  short one-row form once the verbose form would exceed two rows (itself a fix for an
 *  earlier round of this same bug). Past that threshold a BIGGER count therefore yields a
 *  SHORTER notice — so the 999/999999 placeholder quietly reserved 1 row on a narrow
 *  terminal while the real "+1 more (widen terminal or …)" still rendered the 2-row
 *  verbose form. One row over budget, and in fullscreen's fixed-height column one row over
 *  is a corrupted frame.
 *
 *  Measuring BOTH ends of the range covers every count in between: the verbose form's
 *  length is monotonic in digits, and it is only ever chosen when it fits in two rows, so
 *  the worst case is always at one end or the other, never strictly inside. */
function noticeReserveRows(
  noticeText: (hiddenCount: number, columns: number) => string,
  placeholder: number,
  columns: number,
): number {
  return Math.max(
    wrappedRowCount(noticeText(1, columns), columns),
    wrappedRowCount(noticeText(placeholder, columns), columns),
  )
}
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
// Rows of context carried over between PageUp/PageDown steps, so a page step never leaves
// the reader without a line of overlap to re-orient against (the same one-line overlap
// less/vim/most pagers keep).
const SCROLL_OVERLAP_ROWS = 1

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
  /** Reconstructed session history. The TUI and Engine must begin from the same
   * durable state so a resumed model never sees context hidden from the user. */
  initialMessages?: MessageParam[]
}

export function transcriptEntriesFromMessages(messages: MessageParam[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const toolEntries = new Map<string, number>()
  for (const message of messages) {
    if (typeof message.content === 'string') {
      entries.push({
        kind: message.role === 'assistant' ? 'assistant' : 'user',
        text: message.content,
      })
      continue
    }
    for (const raw of message.content) {
      const block = raw as {
        type: string
        text?: string
        id?: string
        name?: string
        input?: unknown
        tool_use_id?: string
        content?: unknown
        is_error?: boolean
      }
      if (block.type === 'text' && block.text) {
        entries.push({
          kind: message.role === 'assistant' ? 'assistant' : 'user',
          text: block.text,
        })
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolEntries.set(block.id, entries.length)
        entries.push({
          kind: 'tool',
          id: block.id,
          name: block.name,
          input: block.input,
          output: null,
          isError: false,
        })
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const index = toolEntries.get(block.tool_use_id)
        if (index === undefined) continue
        const current = entries[index]
        if (current?.kind === 'tool') {
          entries[index] = {
            ...current,
            output:
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content),
            isError: block.is_error === true,
          }
        }
      }
    }
  }
  return entries
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
  initialMessages = [],
}: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>(() =>
    transcriptEntriesFromMessages(initialMessages),
  )
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
  // Seeded from the prop, then kept live by 'status' events (/mode, /model, per-turn ctx%).
  const [status, setStatus] = useState<AppStatus>(statusProp)
  // Second-level value picker for a bare pickable command (/model /provider /effort
  // /mode /tui) — see detectBarePickableCommand/handleSubmit below. null = not showing.
  const [argPicker, setArgPicker] = useState<ArgPickerState | null>(null)
  // Transcript scroll position, as the EXCLUSIVE entry index the render window ends at.
  // null = following the live tail (the default, and exactly the pre-scrolling behavior:
  // new messages keep the view pinned to the bottom). A number means the user has scrolled
  // up, and new messages must NOT yank the view back down — which an entry-index anchor
  // gives for free, since appending at the tail can't move an index that points behind it
  // (see viewport.ts's sliceToRows/shiftWindowEnd for why the anchor is an index rather
  // than a row offset measured from the bottom). Fullscreen-only: classic mode has native
  // scrollback and never virtualizes.
  const [scrollEnd, setScrollEnd] = useState<number | null>(null)
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
          // A scroll anchor that outlived the transcript it indexed into would leave the
          // view parked on entries that no longer exist; snap back to the live tail.
          setScrollEnd(null)
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

  // Permission review takes visual priority over ambient decoration/status: a pending
  // dialog gets the space Banner/TodoPanel would otherwise occupy instead of competing
  // with them for it. Classic mode is untouched — native scrollback already handles
  // overflow fine there, so nothing here is gated on `fullscreen` alone without also
  // checking `pending`.
  const dialogPendingFullscreen = fullscreen && pending !== null

  // Scroll window end, RE-CLAMPED on every render rather than cached: `entries` can only
  // ever grow (append) or reset to empty (/clear), and `rows`/`columns` change under the
  // app's feet on every terminal resize, so a stored index is only ever trustworthy
  // relative to the history that exists right now. Recomputing here is what makes a stale
  // anchor structurally impossible — the same discipline availableRows below already
  // follows for the row budget. undefined = pinned to the live tail.
  const windowEnd =
    scrollEnd === null || entries.length === 0
      ? undefined
      : Math.min(Math.max(scrollEnd, 1), entries.length)
  // How many entries sit below the viewport — drives StatusLine's "… N more below" notice.
  // Computed BEFORE statusLineRows on purpose: the notice is part of the status line's
  // text, so its own wrapped height has to be inside that measurement or it becomes an
  // unbudgeted row in a column whose only overflow-protected sibling is the Transcript.
  const scrolledBelow = windowEnd === undefined ? 0 : entries.length - windowEnd

  // StatusLine is a fixed footer, but its content (cwd/branch/model/mode/ctx%) is
  // arbitrary-length text with NO border/padding stealing width, so it's measured against
  // the full terminal width — see the file-header comment on why this can't just be "1".
  const statusLineRows = wrappedRowCount(statusLineText({ ...status, busy, scrolledBelow }), columns)

  // Banner is ambient branding, so it steps aside on a terminal too short to fit it
  // alongside the pinned input row, the status line and the Transcript floor — the same
  // "the fixed chrome wins, decoration yields" rule dialogPendingFullscreen already
  // applies, just for a size constraint rather than a pending dialog. Without this, every
  // budget below would start from a negative allowance on a very short terminal.
  // Measured, not assumed to be 4: the banner's info row carries the cwd and its Greek-key
  // rules have a minimum width, so both can wrap on a narrow terminal — see bannerRowCount.
  const bannerProps = { version: getVersion(), model: status.model, cwd: status.cwd, columns }
  const bannerRowsNeeded = bannerRowCount(bannerProps)
  const bannerFits = rows - statusLineRows - bannerRowsNeeded - MIN_TRANSCRIPT_ROWS >= 1
  const showBanner = fullscreen && !dialogPendingFullscreen && bannerFits
  const bannerRows = showBanner ? bannerRowsNeeded : 0

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

  // Ceiling handed DOWN to InputBox for its text lines plus whichever of its two overlay
  // popups (MentionPopup/SlashMenuPopup) is open — both of which are unclipped siblings in
  // this column, which is exactly why they can't be left to render however tall they like
  // (see InputBox's maxRows/onHeightChange docs). Deliberately computed WITHOUT reference
  // to `inputRows`, TodoPanel or ArgPickerPopup: those three are budgeted below FROM the
  // height InputBox reports back, so letting this ceiling depend on them in turn would
  // close a feedback loop (popup opens -> panel shrinks -> more room -> popup grows -> …)
  // instead of settling. The precedence that fixes the loop is simply: StatusLine and the
  // Transcript floor first, then Banner/BusyIndicator, then InputBox, then everything
  // else out of what InputBox actually used.
  const inputMaxRows = fullscreen
    ? Math.max(rows - statusLineRows - bannerRows - busyIndicatorRows - MIN_TRANSCRIPT_ROWS, 1)
    : undefined

  // The input box is driven from a HOOK rather than rendered as an opaque child, so its
  // height is a value in this render pass instead of a number reported back one commit
  // later. Everything below (argPickerLayout, maxDiffLines, todoBudgetRows, availableRows)
  // is budgeted from `inputRows`, and every one of those siblings is unclipped: a height
  // that arrives a frame late means a frame drawn to a budget that no longer holds, which
  // Ink/Yoga resolves by shrinking and OVERWRITING lines rather than clipping them — a
  // corrupted frame whose row count is still exactly `rows`. See useInputBox's doc comment
  // for the full failure mode. `element` is rendered in its usual place at the bottom of
  // the column below; only the measurement had to move up here.
  //
  // `disabled` deliberately stays keyed on `argPicker` (the state) rather than on
  // argPickerLayout (computed just below from `inputRows`): reading the layout here would
  // reintroduce the very cycle the hook removes. The invisible-picker case that gate was
  // meant to cover is handled instead by cancelling the picker outright — see the effect
  // further down.
  //
  // busy included: a prompt submitted mid-turn would start a second runTurn and interleave
  // a user message between a tool_use and its tool_result. argPicker included: no new
  // keystrokes while the picker owns Up/Down/Enter/Esc.
  const input = useInputBox({
    onSubmit: handleSubmit,
    disabled: busy || pending !== null || argPicker !== null,
    cwd: status.cwd,
    commands,
    agents,
    columns,
    maxRows: inputMaxRows,
  })
  const inputRows = input.rows

  // ArgPickerPopup is an App-level sibling (App owns the picker's state and key handling,
  // so it can't live inside InputBox), and it is budgeted here EXPLICITLY, exactly like
  // TodoPanel and PermissionDialog — not excused by an argument that it can't coexist with
  // them. The one exclusion that remains is enforced structurally rather than asserted:
  // `showArgPicker` is gated on !dialogPendingFullscreen, the same gate that hides Banner
  // and TodoPanel, so "picker and dialog never share the screen" is a property of what
  // renders rather than a claim in a comment. `argPickerRows` is then derived from the
  // SAME layout object the component draws from (popupWindow.ts), so reserved height and
  // rendered height cannot drift apart; a tight budget shrinks the picker's visible window
  // (with its existing "… N more" notice) and, at the extreme, hides it outright.
  const showArgPicker = argPicker !== null && !dialogPendingFullscreen
  const argPickerOptions = argPicker ? pickerOptions(argPicker.kind, status.provider) : []
  const argPickerLayout =
    showArgPicker && argPicker
      ? popupLayout(
          argPickerOptions.length,
          argPicker.index,
          fullscreen
            ? Math.max(rows - statusLineRows - inputRows - bannerRows - busyIndicatorRows - MIN_TRANSCRIPT_ROWS, 0)
            : undefined,
        )
      : null
  const argPickerRows = argPickerLayout?.rows ?? 0

  // Active only while the second-level value picker is actually ON SCREEN — Up/Down move
  // the cursor (clamped to the current option list), Escape cancels with no dispatch, Enter
  // confirms and dispatches through onSlash (or applyTuiMode for 'tui', which App already
  // handles locally rather than forwarding to the engine — see handleSubmit's /tui branch
  // above). Kept as its own useInput rather than folded into the Escape-to-abort one below
  // so each stays readable on its own.
  //
  // `isActive` is keyed on argPickerLayout (did it DRAW), not on argPicker (is it armed) —
  // which is also why this hook sits here, below the layout, rather than up with the other
  // handlers. A picker that is armed but not drawn owns nothing: it can't be seen, so it
  // must not be able to swallow Up/Down/Enter/Esc from whatever the user IS looking at.
  // Two ways that happens — a permission dialog claiming the screen (showArgPicker is
  // false, and the dialog should get those keys back), and a terminal too short for even a
  // one-row picker (the effect below then cancels it outright and says so).
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
    { isActive: argPickerLayout !== null },
  )

  // A picker that WANTS the screen but can't fit on it is cancelled outright rather than
  // left armed-but-invisible. Armed-but-invisible was a dead end for the user: nothing
  // draws, yet InputBox is disabled (its `disabled` includes `argPicker !== null`), so the
  // input box loses its cursor and stops accepting keystrokes with no visible cause and no
  // stated way out. Escape did recover, but nothing said so — strictly worse than the
  // mention/slash popups' "step aside" behavior, which at least leaves typing working.
  //
  // Cancelling (rather than gating `disabled` on the layout) is what keeps ONE source of
  // truth: `argPicker !== null` then always means "the picker is up", so the InputBox
  // disable, the key handler above, and what's drawn can't disagree — and it avoids
  // feeding argPickerLayout, which is derived from the input box's own height, back into
  // the input box's props. The info line names the typed fallback, since the command is
  // still perfectly usable with an explicit argument.
  //
  // Deliberately NOT fired when the picker is merely yielding to a permission dialog
  // (showArgPicker false): that's a temporary, explained-by-what's-on-screen hand-off, and
  // the picker should come back when the dialog resolves.
  useEffect(() => {
    if (!showArgPicker || argPicker === null || argPickerLayout !== null) return
    setArgPicker(null)
    bus.emit({
      type: 'info',
      message: `Not enough room to show the /${argPicker.kind} picker — resize the terminal, or set it directly with "/${argPicker.kind} <value>".`,
    })
  }, [showArgPicker, argPicker, argPickerLayout, bus])

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
      noticeReserveRows(diffNoticeText, DIFF_NOTICE_PLACEHOLDER_HIDDEN, dialogTextColumns)
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
  const todoNoticeReserveRows = noticeReserveRows(
    todoNoticeText,
    TODO_NOTICE_PLACEHOLDER_HIDDEN,
    todoTextColumns,
  )
  // ArgPickerPopup's rows come out of the same pool, subtracted here so the picker and the
  // panel can coexist (a bare /model typed while the model is mid-TodoWrite is an everyday
  // combination, and `todos.length > 0` is entirely independent of `busy`/`pending`).
  const todoBudgetRows =
    rows -
    statusLineRows -
    inputRows -
    bannerRows -
    busyIndicatorRows -
    argPickerRows -
    MIN_TRANSCRIPT_ROWS -
    TODO_BORDER_ROWS -
    todoNoticeReserveRows
  // Below one content row there is no such thing as a "smaller" TodoPanel — its border
  // alone costs TODO_BORDER_ROWS — so it steps aside entirely rather than rendering a
  // 2-row frame the budget can't pay for. Same yield-to-the-fixed-chrome rule as
  // `bannerFits` above.
  const showTodoPanel =
    todos.length > 0 && !dialogPendingFullscreen && (!fullscreen || todoBudgetRows >= 1)
  const maxTodoRows = fullscreen && showTodoPanel ? Math.max(todoBudgetRows, 0) : undefined

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
          rows - statusLineRows - inputRows - bannerRows - busyIndicatorRows - argPickerRows - todoRowsUsed,
          MIN_TRANSCRIPT_ROWS,
        )

  // Write the clamp back into state as well, so a resize or a /clear can't leave the app
  // reporting "scrolled" while actually rendering the tail. Functional update: when the
  // clamp is a no-op React bails out and no extra render happens.
  useEffect(() => {
    setScrollEnd((prev) => {
      if (prev === null) return null
      if (entries.length === 0) return null
      const clamped = Math.min(Math.max(prev, 1), entries.length)
      return clamped >= entries.length ? null : clamped
    })
  }, [entries.length, rows, columns])

  // The transcript's row estimator, measured at the CURRENT terminal width — the exact
  // same function (and the same width) Transcript itself slices with below, so a page step
  // and the window it produces can never disagree about how tall an entry is.
  const entryRowsOf = useCallback(
    (entry: TranscriptEntry): number => estimateEntryRows(entry, columns),
    [columns],
  )

  // Transcript scrolling. Fullscreen-only: classic mode leaves the terminal's native
  // scrollback intact, so hijacking PageUp/PageDown there would take away the scrolling
  // the user already has. Deliberately NOT gated on `busy` — reading back through the
  // transcript while a turn streams is the main reason this exists.
  //
  // Home/End are unreachable: Ink's useInput key object surfaces no home/end booleans, and
  // it blanks `input` for every key its parser names (home/end included), so those keys
  // are indistinguishable from F1-F12 at the useInput seam. Ctrl+Home/Ctrl+End fare no
  // better — the parser maps both to name 'home'/'end' with ctrl set, which Ink then
  // collapses to the same empty-input/ctrl-only shape. Ctrl+PageUp/Ctrl+PageDown ARE
  // distinguishable (key.pageUp/key.pageDown survive with key.ctrl alongside them), so
  // they carry the jump-to-top/jump-to-live bindings instead.
  const pageRows = Math.max((availableRows ?? MIN_TRANSCRIPT_ROWS) - SCROLL_OVERLAP_ROWS, 1)
  useInput(
    (_ch, key) => {
      if (key.pageUp) {
        if (entries.length === 0) return
        setScrollEnd((prev) => {
          const from = prev ?? entries.length
          return key.ctrl ? 1 : shiftWindowEnd(entries, entryRowsOf, from, -pageRows)
        })
        return
      }
      if (key.pageDown) {
        if (key.ctrl) {
          setScrollEnd(null)
          return
        }
        setScrollEnd((prev) => {
          if (prev === null) return null
          const next = shiftWindowEnd(entries, entryRowsOf, prev, pageRows)
          // Paging past the last entry resumes following the live tail, rather than
          // freezing on an index that later messages would scroll away from.
          return next >= entries.length ? null : next
        })
      }
    },
    { isActive: fullscreen && argPicker === null },
  )

  return (
    <Box flexDirection="column" height={fullscreen ? rows : undefined}>
      {/* Fixed header row, fullscreen-only — reserved for full-session branding rather
          than a one-shot splash (mirrors StatusLine's fixed footer below). Classic mode
          skips it entirely: it's native scrollback that a repainting banner would only
          clutter on every turn, and classic already has the compact status line for
          at-a-glance model/cwd. Also hidden whenever a permission dialog is pending (see
          showBanner above) — the dialog gets visual priority, not ambient branding. */}
      {showBanner && <Banner {...bannerProps} />}
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
        <Transcript entries={entries} maxRows={availableRows} windowEnd={windowEnd} columns={columns} />
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
          since App doesn't reach InputBox's internal render. It is budgeted explicitly
          (argPickerLayout/argPickerRows above), like every other unclipped sibling in
          this column; a null layout means the budget couldn't fit even a one-row picker,
          in which case it draws nothing and costs nothing. */}
      {showArgPicker && argPicker && argPickerLayout && (
        <ArgPickerPopup
          title={pickerTitle(argPicker.kind)}
          options={argPickerOptions}
          index={argPicker.index}
          currentValue={currentValueFor(argPicker.kind)}
          layout={argPickerLayout}
          columns={columns}
        />
      )}
      {/* Built by useInputBox above (see the comment there): rendered here, measured up
          there, so every budget in between is computed from the height this very frame
          commits to rather than the previous frame's. */}
      {input.element}
      <StatusLine {...status} busy={busy} scrolledBelow={scrolledBelow} />
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
    case 'tool-progress':
      return prev.map((entry) =>
        entry.kind === 'tool' && entry.id === e.id
          ? {
              ...entry,
              output: `${entry.output ?? ''}${e.delta}`.slice(-30_000),
            }
          : entry,
      )
    case 'background-output': {
      const id = `background:${e.taskId}`
      const existing = prev.findIndex((entry) => entry.kind === 'system' && entry.id === id)
      if (existing === -1) {
        return [...prev, { kind: 'system', id, text: `[${e.taskId}] ${e.delta}` }]
      }
      return prev.map((entry, index) =>
        index === existing && entry.kind === 'system'
          ? { ...entry, text: `${entry.text}${e.delta}`.slice(-30_000) }
          : entry,
      )
    }
    case 'compaction':
      return [...prev, { kind: 'system', text: `Context compacted. ${e.summary.slice(0, 200)}` }]
    case 'info':
      return [...prev, { kind: 'system', text: e.message }]
    case 'error':
      return [...prev, { kind: 'system', text: `Error: ${e.message}` }]
    case 'child-status':
      return [
        ...prev,
        {
          kind: 'system',
          text: `Agent ${e.agent} (${e.runId.slice(0, 8)}): ${e.status}`,
        },
      ]
    case 'child-text':
      return [
        ...prev,
        {
          kind: 'system',
          text: `[${e.agent} ${e.runId.slice(0, 8)}] ${e.delta}`,
        },
      ]
    case 'child-tool-request':
      return [
        ...prev,
        {
          kind: 'system',
          text: `[${e.agent} ${e.runId.slice(0, 8)}] ${e.name} started`,
        },
      ]
    case 'child-tool-result':
      return [
        ...prev,
        {
          kind: 'system',
          text: `[${e.agent} ${e.runId.slice(0, 8)}] ${e.name} ${e.isError ? 'failed' : 'finished'}`,
        },
      ]
    default:
      return prev
  }
}
