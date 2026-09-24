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

/** Physical rows of `text` wrapped to `columns` — the exact same wrap math
 *  wrappedRowCount measures with, returned as slices so callers can clip by row. */
export function wrapToRows(text: string, columns: number): string[] {
  const width = Math.max(columns, 1)
  return text
    .split('\n')
    .flatMap((line) =>
      displayWidth(line) <= width ? [line] : wrapAnsi(line, width, { trim: false, hard: true }).split('\n'),
    )
}

/** Tail-keeping mirror of truncateTextToRows: when `text` wraps past `maxRows`, keep
 *  its LAST rows and let a leading `…` say the head was cut (the `…` line counts
 *  against the budget, so the result never exceeds `maxRows`). Used for thinking
 *  entries, where the newest reasoning is the useful end. */
export function tailTextToRows(text: string, columns: number, maxRows: number): string {
  const rows = Math.max(Math.trunc(maxRows), 0)
  if (rows <= 0) return ''
  if (rows === 1) return '…'
  const physical = wrapToRows(text, columns)
  if (physical.length <= rows) return text
  return ['…', ...physical.slice(-(rows - 1))].join('\n')
}

/** Hard row ceiling for one thinking entry; the tail is what survives the cap. */
export const THINKING_ENTRY_MAX_ROWS = 8

/** The exact string a thinking transcript entry renders: tail-capped body, every line
 *  prefixed with `· ` (two columns — the body is measured at `columns - 2` so the
 *  prefixed lines fit `columns`). estimateEntryRows measures THIS string, so the
 *  virtualization window and the component can never disagree about its height. */
export function thinkingDisplayText(text: string, columns: number): string {
  const body = tailTextToRows(text, Math.max(columns - 2, 1), THINKING_ENTRY_MAX_ROWS)
  return body
    .split('\n')
    .map((line) => `· ${line}`)
    .join('\n')
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
    case 'thinking':
      // The component renders thinkingDisplayText verbatim — measure that string,
      // prefix and tail-cap included, never the raw reasoning text.
      return wrappedLines(thinkingDisplayText(entry.text, columns))
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

/** Scroll position for the fullscreen transcript. The window's first visible row is
 *  `offset` rows down from the start of `entries[index]`; null means pinned to the live
 *  tail. This top-relative anchor stays put when a streaming tail entry grows below the
 *  viewport. */
export interface ScrollAnchor {
  index: number
  offset: number
}

export interface TranscriptWindow<T> {
  items: T[]
  /** Rows dropped from the TOP of items[0] (a partially visible first entry). */
  clipFirstRows: number
  /** Rows dropped from the BOTTOM of the last item (the anchor entry's clipped tail). */
  clipLastRows: number
}

/** Row-granular window slicing. A non-null anchor identifies the first visible row, so
 *  later rows streaming into the same entry cannot move the viewport. With no anchor we
 *  pack backward from the live tail. `canClip` marks entries that may be sliced mid-body;
 *  a bordered ToolCard stays whole. Measurement goes through the caller's `rows`
 *  estimator — the SAME one Transcript renders with — so a page step and its window
 *  cannot disagree about entry height. */
export function sliceToAnchor<T>(
  entries: readonly T[],
  rows: (entry: T) => number,
  maxRows: number,
  anchor: ScrollAnchor | null,
  canClip: (entry: T) => boolean = () => true,
): TranscriptWindow<T> {
  if (entries.length === 0) return { items: [], clipFirstRows: 0, clipLastRows: 0 }
  const rowsOf = (entry: T): number => Math.max(1, rows(entry))
  const budget = Math.max(Math.trunc(maxRows), 1)
  if (anchor !== null) {
    const index = Math.min(Math.max(Math.trunc(anchor.index), 0), entries.length - 1)
    let offset = Math.max(Math.trunc(anchor.offset), 0)
    let remaining = budget
    let clipFirst = 0
    const items: T[] = []
    let clipLast = 0
    for (let i = index; i < entries.length && remaining > 0; i++) {
      const entry = entries[i] as T
      const height = rowsOf(entry)
      if (offset >= height) {
        offset -= height
        continue
      }
      const available = height - offset
      if (!canClip(entry) && (offset > 0 || available > remaining)) break
      const take = Math.min(available, remaining)
      if (take <= 0) break
      if (items.length === 0) clipFirst = offset
      items.push(entry)
      remaining -= take
      clipLast = available - take
      if (clipLast > 0) break
      offset = 0
    }
    return { items, clipFirstRows: clipFirst, clipLastRows: clipLast }
  }

  const index = entries.length - 1
  const anchorRows = rowsOf(entries[index] as T)
  const take = Math.min(anchorRows, budget)
  let start = index
  let clipFirst = anchorRows - take
  let remaining = budget - take
  for (let i = index - 1; i >= 0 && remaining > 0; i--) {
    const entry = entries[i] as T
    const height = rowsOf(entry)
    if (height <= remaining) {
      start = i
      remaining -= height
      continue
    }
    if (canClip(entry)) {
      start = i
      clipFirst = height - remaining
    }
    break
  }
  return { items: entries.slice(start, index + 1), clipFirstRows: clipFirst, clipLastRows: 0 }
}

/** Moves the first-visible-row anchor by `deltaRows` (negative up, positive down).
 *  Paging up clamps to the transcript start; paging down to the live viewport returns
 *  null and resumes follow-the-tail. The anchor is top-relative within an entry, so
 *  appending lines to that entry does not shift the reader. */
export function shiftAnchor<T>(
  entries: readonly T[],
  rows: (entry: T) => number,
  anchor: ScrollAnchor | null,
  deltaRows: number,
  maxRows: number,
  canClip: (entry: T) => boolean = () => true,
): ScrollAnchor | null {
  if (entries.length === 0) return null
  const rowsOf = (i: number): number => Math.max(1, rows(entries[i] as T))
  let total = 0
  for (let i = 0; i < entries.length; i++) total += rowsOf(i)
  let position: number
  if (anchor) {
    const index = Math.min(Math.max(Math.trunc(anchor.index), 0), entries.length - 1)
    const offset = Math.min(Math.max(Math.trunc(anchor.offset), 0), rowsOf(index) - 1)
    position = offset
    for (let i = 0; i < index; i++) position += rowsOf(i)
    position = Math.min(position, Math.max(0, total - Math.max(Math.trunc(maxRows), 1)))
  } else {
    position = Math.max(0, total - Math.max(Math.trunc(maxRows), 1))
  }
  const tailPosition = Math.max(0, total - Math.max(Math.trunc(maxRows), 1))
  let next = Math.min(Math.max(position + Math.trunc(deltaRows), 0), tailPosition)
  if (anchor && next >= tailPosition) return null
  if (next <= 0 && tailPosition === 0) return null
  let acc = 0
  for (let i = 0; i < entries.length; i++) {
    const r = rowsOf(i)
    if (next < acc + r) {
      const offset = next - acc
      if (!canClip(entries[i] as T) && (offset > 0 || r > Math.max(Math.trunc(maxRows), 1))) {
        if (deltaRows > 0) {
          const after = acc + r
          if (after >= tailPosition) return null
          acc = after
          next = after
          continue
        }
        for (let previous = i - 1; previous >= 0; previous--) {
          const previousEntry = entries[previous] as T
          if (canClip(previousEntry)) return { index: previous, offset: rowsOf(previous) - 1 }
          if (rowsOf(previous) <= Math.max(Math.trunc(maxRows), 1)) return { index: previous, offset: 0 }
        }
        return null
      }
      return { index: i, offset }
    }
    acc += r
  }
  return null
}
