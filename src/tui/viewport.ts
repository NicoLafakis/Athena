// src/tui/viewport.ts — pure viewport virtualization for fullscreen-mode Transcript
// rendering. Classic mode never calls into this file: native scrollback handles history,
// so Transcript renders the full `entries` array unchanged (see components/Transcript.tsx).
import type { TranscriptEntry } from './components/Transcript.js'

/** Rough estimate of how many terminal rows one transcript entry will occupy once
 *  rendered. This is a virtualization-window heuristic, not a pixel-exact layout
 *  measurement (Ink/Yoga still does the real wrapping) — it deliberately errs toward
 *  over-counting so the window stays comfortably inside the terminal height rather than
 *  spilling the pinned input box off-screen. */
export function estimateEntryRows(entry: TranscriptEntry, columns = 80): number {
  const wrappedLines = (text: string): number => {
    let total = 0
    for (const line of text.split('\n')) total += Math.max(1, Math.ceil((line.length || 1) / columns))
    return total
  }
  switch (entry.kind) {
    case 'user':
      return wrappedLines(entry.text)
    case 'assistant':
      return wrappedLines(entry.text)
    case 'system':
      return 1
    case 'tool':
      // Header line (name/input) plus the (wrapped) output body, if any.
      return 1 + (entry.output ? wrappedLines(entry.output) : 0)
  }
}

/** Returns the longest suffix of `entries` whose estimated total row count fits within
 *  `maxRows`, always keeping at least the single most recent entry (even if it alone
 *  exceeds maxRows) so the transcript is never blanked out entirely. Generic over the
 *  row-estimator so it's unit-testable without constructing real TranscriptEntry values. */
export function sliceToRows<T>(entries: readonly T[], rows: (entry: T) => number, maxRows: number): T[] {
  if (entries.length === 0) return []
  const last = entries[entries.length - 1] as T
  if (maxRows <= 0) return [last]
  let total = 0
  let start = entries.length
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as T
    const r = Math.max(1, rows(entry))
    if (total > 0 && total + r > maxRows) break
    total += r
    start = i
  }
  return entries.slice(start)
}
