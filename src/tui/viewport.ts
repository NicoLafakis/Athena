// src/tui/viewport.ts — pure viewport virtualization for fullscreen-mode Transcript
// rendering. Classic mode never calls into this file: native scrollback handles history,
// so Transcript renders the full `entries` array unchanged (see components/Transcript.tsx).
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { TranscriptEntry } from './components/Transcript.js'

/** Printable-ASCII fast path. For text in this range one UTF-16 code unit is exactly one
 *  terminal column, so `.length` IS the display width and the (comparatively expensive,
 *  grapheme-segmenting) string-width call can be skipped. Everything the TUI measures is
 *  overwhelmingly in this range — status segments, todo text, file paths, command
 *  descriptions — so the general path below only gets paid for when it's actually needed. */
const PRINTABLE_ASCII_ONLY = /^[\x20-\x7E]*$/

/** Terminal COLUMNS a single (newline-free) run of text occupies. Not `text.length`:
 *  `.length` counts UTF-16 code units, which disagrees with the terminal on both sides —
 *  CJK/full-width characters and most emoji occupy TWO columns each, while an astral
 *  character (emoji, rare CJK) costs two code units, and a ZWJ sequence or a combining
 *  mark costs several while still occupying one or two columns. Ink measures the real
 *  thing (string-width, via widest-line/wrap-ansi), so every budget here has to as well —
 *  a `.length` check let a CJK or emoji-bearing line pass as "one row" and then wrap to
 *  two, which is precisely the silent overflow the whole row-budget system exists to make
 *  impossible. */
export function displayWidth(text: string): number {
  return PRINTABLE_ASCII_ONLY.test(text) ? text.length : stringWidth(text)
}

/** Grapheme clusters of `text`, so a truncation boundary can never land in the middle of
 *  a surrogate pair, a ZWJ emoji sequence, or a combining mark — slicing by code unit
 *  produces a lone surrogate (rendered as a replacement character, and of unpredictable
 *  width), slicing by code point still severs "👩‍💻" into three pieces. */
const GRAPHEME_SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
function graphemes(text: string): string[] {
  return GRAPHEME_SEGMENTER
    ? Array.from(GRAPHEME_SEGMENTER.segment(text), (s) => s.segment)
    : Array.from(text) // code points: still surrogate-safe, just not ZWJ-safe
}

/** Terminal rows a chunk of plain text will occupy once wrapped to `columns` width:
 *  splits on embedded newlines first (each explicit line wraps independently), then
 *  measures each line. Shared by estimateEntryRows (Transcript) and App.tsx's fixed-chrome
 *  row budgets (StatusLine, PermissionDialog's summary/reason/header/footer, TodoPanel's
 *  item text) — every one of those needs to react to the ACTUAL current terminal width
 *  instead of assuming its text is always exactly one row regardless of length, column
 *  count, or script.
 *
 *  Lines that fit in `columns` display columns are 1 row by definition and short-circuit.
 *  Anything longer goes through the SAME wrapper Ink itself uses (wrap-ansi with
 *  `{trim: false, hard: true}` — see ink/build/wrap-text.js), rather than a
 *  `Math.ceil(length / width)` approximation. That approximation was wrong in two
 *  independent directions: it counted UTF-16 code units instead of display columns (see
 *  displayWidth above), and it ignored the fact that wrapping breaks at WHITESPACE, so
 *  text narrower than `columns * n` can still need n+1 rows ("aaaaa bbbbb ccccc" is 17
 *  columns but three rows at width 10). Measuring with the real wrapper makes both classes
 *  of undercount structurally impossible instead of merely unlikely. */
export function wrappedRowCount(text: string, columns: number): number {
  const width = Math.max(columns, 1)
  let total = 0
  for (const line of text.split('\n')) {
    total +=
      displayWidth(line) <= width ? 1 : wrapAnsi(line, width, { trim: false, hard: true }).split('\n').length
  }
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
      // Measured, not assumed to be 1. System lines are ordinary wrap-eligible text and
      // routinely run past a terminal width — "/clear"'s explanation, a compaction
      // summary, an error, a streamed background-task line, the "not enough room for the
      // /model picker" notice. Hardcoding 1 here undercounted the transcript window by a
      // row per long system entry.
      return wrappedLines(entry.text)
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
 *  PermissionDialog's summary/reason a hard ceiling regardless of how long the underlying
 *  tool-input text is (the engine truncates `summary` to ~120 chars, which alone can still
 *  wrap to several rows at a narrow terminal), and to hold every popup row to exactly one
 *  row (popupWindow.ts's popupLine).
 *
 *  The ceiling is enforced by MEASURING with wrappedRowCount rather than by a character
 *  arithmetic that stands in for it: the result is the longest grapheme prefix that still
 *  measures within `maxRows`, found by binary search (wrapped row count is monotonic in
 *  prefix length, so the search is exact, not a heuristic). Two things this gets right
 *  that `text.slice(0, columns * maxRows - 1)` did not: the budget is display COLUMNS, not
 *  UTF-16 code units — a CJK or emoji-bearing string is up to twice as wide as its
 *  `.length` suggests and would silently wrap past the ceiling — and the cut lands on a
 *  grapheme boundary, so it can never split a surrogate pair or a ZWJ emoji sequence into
 *  garbage of unpredictable width. */
export function truncateTextToRows(text: string, columns: number, maxRows: number): string {
  const width = Math.max(columns, 1)
  const rows = Math.max(Math.trunc(maxRows), 0)
  if (rows <= 0) return ''
  if (wrappedRowCount(text, width) <= rows) return text
  // "…" is one column wide, so with rows >= 1 and width >= 1 the empty-prefix candidate
  // always fits — the search can never come back with "nothing renderable".
  const cells = graphemes(text)
  let lo = 0
  let hi = cells.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (wrappedRowCount(`${cells.slice(0, mid).join('')}…`, width) <= rows) lo = mid
    else hi = mid - 1
  }
  return `${cells.slice(0, lo).join('')}…`
}

/** Returns the longest run of `entries` ENDING at `windowEnd` (exclusive) whose estimated
 *  total row count fits within `maxRows`, always keeping at least the single entry
 *  immediately before `windowEnd` (even if it alone exceeds maxRows) so the transcript is
 *  never blanked out entirely. Generic over the row-estimator so it's unit-testable
 *  without constructing real TranscriptEntry values.
 *
 *  `windowEnd` defaults to `entries.length` — i.e. pinned to the live tail, which is
 *  exactly the pre-scrolling behavior and the only thing classic mode/the default call
 *  site ever needs. Scrolling (see shiftWindowEnd below and App.tsx's scrollEnd state)
 *  works purely by moving that exclusive end index BACKWARD; the window is still packed
 *  backward from it with the same row math, so there is only ever one row-measurement
 *  implementation. Anchoring the scroll position to an ENTRY INDEX rather than to a
 *  row-offset-from-the-bottom is deliberate: appending new entries at the tail then
 *  cannot move a scrolled-up window (no "yank to bottom"), and it keeps the per-render
 *  cost proportional to the viewport rather than to total history length. */
export function sliceToRows<T>(
  entries: readonly T[],
  rows: (entry: T) => number,
  maxRows: number,
  windowEnd: number = entries.length,
): T[] {
  if (entries.length === 0) return []
  const end = Math.min(Math.max(Math.trunc(windowEnd), 1), entries.length)
  const last = entries[end - 1] as T
  if (maxRows <= 0) return [last]
  let total = 0
  let start = end
  for (let i = end - 1; i >= 0; i--) {
    const entry = entries[i] as T
    const r = Math.max(1, rows(entry))
    if (total > 0 && total + r > maxRows) break
    total += r
    start = i
  }
  return entries.slice(start, end)
}

/** Moves a `sliceToRows` window end by approximately `deltaRows` rows — negative scrolls
 *  UP (drops entries off the bottom of the window), positive scrolls DOWN (adds them back)
 *  — and returns the new exclusive end index, clamped to [1, entries.length] so the window
 *  can never be emptied or run past the live tail. Entry-granular by construction: an
 *  entry is the smallest unit that can enter or leave the window, so a page step lands on
 *  the first entry boundary at or past the requested row count rather than mid-entry.
 *  Measurement goes through the caller's `rows` estimator — the SAME one Transcript slices
 *  with — so a page step and the window it produces can never disagree about how tall
 *  anything is. */
export function shiftWindowEnd<T>(
  entries: readonly T[],
  rows: (entry: T) => number,
  windowEnd: number,
  deltaRows: number,
): number {
  if (entries.length === 0) return 0
  let end = Math.min(Math.max(Math.trunc(windowEnd), 1), entries.length)
  let moved = 0
  const wanted = Math.abs(deltaRows)
  if (deltaRows < 0) {
    while (end > 1 && moved < wanted) {
      moved += Math.max(1, rows(entries[end - 1] as T))
      end -= 1
    }
  } else {
    while (end < entries.length && moved < wanted) {
      moved += Math.max(1, rows(entries[end] as T))
      end += 1
    }
  }
  return end
}
