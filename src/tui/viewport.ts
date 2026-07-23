// src/tui/viewport.ts — pure viewport virtualization for fullscreen-mode Transcript
// rendering. Classic mode never calls into this file: native scrollback handles history,
// so Transcript renders the full `entries` array unchanged (see components/Transcript.tsx).
import type { TranscriptEntry } from './components/Transcript.js'

/** Estimated terminal rows a chunk of plain text will occupy once wrapped to `columns`
 *  width: splits on embedded newlines first (each explicit line wraps independently),
 *  then Math.ceil's each line's length against the width, minimum 1 row per line. This is
 *  a virtualization/layout-budget heuristic, not a pixel-exact measurement (Ink/Yoga still
 *  does the real wrapping) — it deliberately errs toward OVER-counting so a too-small
 *  budget is the failure mode, never a too-large one that lets content silently overflow
 *  into an unprotected sibling. Shared by estimateEntryRows (Transcript) and App.tsx's
 *  fixed-chrome row budgets (StatusLine, PermissionDialog's summary/reason/header/footer,
 *  TodoPanel's item text) — every one of those needs to react to the ACTUAL current
 *  terminal width instead of assuming its text is always exactly one row regardless of
 *  length or column count. */
export function wrappedRowCount(text: string, columns: number): number {
  const width = Math.max(columns, 1)
  let total = 0
  for (const line of text.split('\n')) total += Math.max(1, Math.ceil((line.length || 1) / width))
  return total
}

/** Rough estimate of how many terminal rows one transcript entry will occupy once
 *  rendered. This is a virtualization-window heuristic, not a pixel-exact layout
 *  measurement (Ink/Yoga still does the real wrapping) — it deliberately errs toward
 *  over-counting so the window stays comfortably inside the terminal height rather than
 *  spilling the pinned input box off-screen. */
export function estimateEntryRows(entry: TranscriptEntry, columns = 80): number {
  const wrappedLines = (text: string): number => wrappedRowCount(text, columns)
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

/** Packs `items` from the front, stopping once the next one wouldn't fit within `budget`
 *  rows, where `rowsOf` returns how many rows a given item actually renders as (so a
 *  wrapped multi-row item, e.g. a long todo line at a narrow terminal width, counts as
 *  more than one). `budget` is a CONTENT-only budget — it does NOT reserve room for a
 *  "+N more" notice itself; the caller is responsible for reserving that separately
 *  (see App.tsx's dialogChromeRows/todoChromeRows, which fold in a notice-row estimate
 *  computed from the actual notice text via wrappedRowCount) and for rendering the notice
 *  whenever `hiddenCount > 0`. This split exists because the notice's own row count
 *  depends on its text length at the current terminal width (see diffNoticeText/
 *  todoNoticeText), which the caller can reserve for pessimistically up front — reserving
 *  a fixed "1 row" here regardless of actual notice length was exactly the second
 *  instance of the fullscreen layout-corruption bug: a verbose notice wrapping to 2-3
 *  rows silently blew through a budget that assumed it was always 1. This generalizes
 *  truncateWithNotice below (which is just this with a constant rowsOf) to the case where
 *  each item's own row count varies with content length and terminal width. */
export function truncateRowsWithNotice<T>(
  items: readonly T[],
  rowsOf: (item: T) => number,
  budget: number,
): { shown: T[]; hiddenCount: number } {
  const cap = Math.max(budget, 0)
  const shown: T[] = []
  let used = 0
  for (const item of items) {
    const r = Math.max(1, rowsOf(item))
    if (used + r > cap) break
    used += r
    shown.push(item)
  }
  return { shown, hiddenCount: items.length - shown.length }
}

/** Slices `items` down to at most `budget` entries (a CONTENT-only budget — see
 *  truncateRowsWithNotice above for why the notice's own row reservation is the caller's
 *  responsibility, not baked in here). Shared by DiffPreview (diff lines, always exactly
 *  one row each) and callers that don't need per-item row variance. */
export function truncateWithNotice<T>(
  items: readonly T[],
  budget: number,
): { shown: T[]; hiddenCount: number } {
  return truncateRowsWithNotice(items, () => 1, budget)
}

/** Truncates a single (assumed newline-free) chunk of text, with a trailing "…", so it
 *  never wraps to more than `maxRows` rows at `columns` width — used to give
 *  PermissionDialog's summary/reason a hard ceiling regardless of how long the
 *  underlying tool-input text is (the engine truncates `summary` to ~120 chars, which
 *  alone can still wrap to several rows at a narrow terminal). Deliberately conservative:
 *  truncates at exactly `columns * maxRows` characters, which — being an exact multiple
 *  of the width — always wraps to precisely `maxRows` rows, never one more. */
export function truncateTextToRows(text: string, columns: number, maxRows: number): string {
  const width = Math.max(columns, 1)
  const maxChars = Math.max(width * Math.max(maxRows, 0), 0)
  if (text.length <= maxChars) return text
  return maxChars > 0 ? `${text.slice(0, maxChars - 1)}…` : ''
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
