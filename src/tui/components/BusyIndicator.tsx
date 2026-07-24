// src/tui/components/BusyIndicator.tsx — ambient "the model is working" feedback for the
// gap between submitting a turn and the first streamed delta arriving, which can run many
// seconds during extended-thinking or tool-heavy turns. Before this component the only
// signal was a static "(esc to interrupt)" string tacked onto StatusLine — nothing
// animated, no elapsed time, nothing that visibly changes to tell "alive" from "hung".
import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'

// Same braille spinner glyph set ToolCard.tsx already uses for in-flight tool calls — kept
// identical rather than inventing a second spinner style so "something is happening" reads
// consistently across the whole TUI.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Within the requested ~100-150ms tick range; slower than ToolCard's 80ms since this is
// ambient turn-level status rather than a busy per-tool-call cue.
const TICK_MS = 120

const PHRASE = 'Thinking…'
const HINT = '(esc to interrupt)'

/** Compact elapsed-time text: "Ns" under a minute, "M:SS" at or beyond it — never more
 *  than a handful of characters so this stays a single, short line. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Plain-text (no ANSI/Ink markup) render of the whole indicator line — a single source
 *  of truth shared with the component's own render below, exactly the same pattern
 *  StatusLine's statusLineText/statusLineParts split uses, so App.tsx's fullscreen row
 *  budgeting (see wrappedRowCount in viewport.ts) measures the SAME string this component
 *  actually renders rather than assuming it's always exactly one row. `frame` defaults to
 *  the first spinner glyph since every frame is the same single-column width — only
 *  `elapsedMs` actually changes this text's length as a turn runs long. */
export function busyIndicatorText(elapsedMs: number, frame = 0): string {
  return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${PHRASE} ${formatElapsed(elapsedMs)} · ${HINT}`
}

export interface BusyIndicatorProps {
  /** Date.now() timestamp captured once by App.tsx when the turn began (see submitTurn's
   *  turnStartRef) — NOT recomputed from this component's own mount time, so the elapsed
   *  counter keeps counting from the true turn start even if this component is briefly
   *  unmounted (e.g. a permission dialog takes over the same screen space mid-turn — see
   *  App.tsx's `busy && pending === null` visibility gate) and remounts afterward. */
  startedAt: number
}

/** Renders while (and only while) a turn is actively running with nothing blocking it —
 *  see App.tsx's `busy && pending === null` condition, mirroring InputBox's own
 *  `disabled={busy || pending !== null}` "is something blocking normal input" gate. Dim/
 *  muted styling throughout (like StatusLine's own dim text) so this reads as ambient
 *  status, not an alert. */
export function BusyIndicator({ startedAt }: BusyIndicatorProps) {
  const [frame, setFrame] = useState(0)
  // Derived from Date.now() on every tick rather than incremented by a fixed step, so
  // there's no drift if the interval fires a little late (GC pause, busy event loop, etc.)
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
      setElapsedMs(Date.now() - startedAt)
    }, TICK_MS)
    // Cleared on every unmount (turn finishes, aborted, or a permission dialog takes
    // over) AND re-run fresh on remount — never more than one interval alive at a time,
    // so a second turn starting can never stack a second ticker.
    return () => clearInterval(timer)
  }, [startedAt])

  return (
    <Box>
      <Text dimColor>{busyIndicatorText(elapsedMs, frame)}</Text>
    </Box>
  )
}
