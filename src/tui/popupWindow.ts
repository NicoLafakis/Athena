// src/tui/popupWindow.ts — shared, budget-aware window/row math for the three overlay
// popups (MentionPopup's '@' picker, SlashMenuPopup's live "/" menu, ArgPickerPopup's
// second-level value picker). All three render the identical shape — a borderStyle="round"
// paddingX={1} column containing a title line, an optional "… N earlier" notice, up to
// POPUP_WINDOW item rows, and an optional "… N more" notice — so they share ONE row-math
// implementation here rather than each re-deriving its own window slice.
//
// This exists because a popup is an UNCLIPPED sibling in fullscreen mode's fixed-height
// column (see the file-header comment in App.tsx): every row it renders has to come out of
// the same exact row budget Banner/TodoPanel/PermissionDialog/StatusLine already do, and
// the budget has zero slack. Two properties make that possible:
//
//  1. `popupLayout` is the single source of truth for BOTH what gets rendered and how tall
//     it is, so the number a component draws and the number the budget reserves can never
//     disagree (the same discipline App.tsx's entryRowsOf/Transcript pairing already
//     follows). It shrinks the visible window to fit `maxRows`, and returns null when even
//     a one-row popup wouldn't fit — a popup showing fewer items (or, at the extreme,
//     stepping aside entirely) is correct; a corrupted frame is not.
//  2. `popupLine` truncates every rendered line to exactly one row at the popup's actual
//     inner width, so "one item = one row" is a fact rather than an assumption. Without it
//     a single long file path or command description would silently wrap to 2+ rows and
//     blow the budget — the exact failure mode wrappedRowCount was introduced for
//     elsewhere (see viewport.ts).
import { truncateTextToRows } from './viewport.js'

/** Maximum item rows any popup draws at once, regardless of how much room is available —
 *  a scroll window, not a budget. Was duplicated as a private `WINDOW = 8` in each of the
 *  three popup components. */
export const POPUP_WINDOW = 8

/** Rows every popup spends before a single item is drawn: borderStyle="round" top+bottom
 *  (1 row each, never wraps) plus the always-present title line (kept to exactly 1 row by
 *  popupLine below). Also the exact height of a popup's "nothing matched" empty state,
 *  where the empty-state text takes the title line's place. */
export const POPUP_CHROME_ROWS = 3

/** Columns eaten by borderStyle="round" (1 col each side) + paddingX={1} (1 col each side)
 *  before any popup text starts wrapping — same accounting as TodoPanel's
 *  TODO_HORIZONTAL_CHROME_COLS. */
export const POPUP_HORIZONTAL_CHROME_COLS = 4

export interface PopupLayout {
  /** Index of the first item to render (inclusive). */
  start: number
  /** How many items to render. 0 means the empty state (POPUP_CHROME_ROWS tall). */
  count: number
  /** EXACT number of terminal rows the popup will occupy once rendered — chrome, the
   *  visible items, and whichever "… N earlier"/"… N more" notices apply. */
  rows: number
}

/** Inner text width a popup actually renders into at the given terminal width. */
export function popupTextColumns(columns: number): number {
  return Math.max(columns - POPUP_HORIZONTAL_CHROME_COLS, 1)
}

/** One popup line, guaranteed to occupy exactly one row at `columns` width: line breaks
 *  and tabs (an agent description read from frontmatter can carry either) are flattened to
 *  single spaces first so nothing wraps for a reason a length check wouldn't catch, then
 *  the text is truncated with a trailing "…" via viewport.ts's truncateTextToRows rather
 *  than a second truncation implementation. Ordinary runs of spaces are deliberately left
 *  alone — the popups use fixed-width leading markers ("● " vs "  ") for alignment. */
export function popupLine(text: string, columns: number): string {
  return truncateTextToRows(text.replace(/[\r\n\t\v\f]+/gu, ' '), columns, 1)
}

/** Picks the largest window (up to POPUP_WINDOW items) around `index` that fits within
 *  `maxRows` TOTAL rows — chrome and scroll notices included — and reports exactly how
 *  tall the result renders as.
 *
 *  `maxRows === undefined` means unbounded (classic mode, where native scrollback makes
 *  fixed-height layout a non-issue) and reproduces the pre-budget behavior exactly: a full
 *  POPUP_WINDOW-item window positioned by the same start formula the three components each
 *  used to inline.
 *
 *  Returns null when the popup can't be drawn usefully at all (fewer than
 *  POPUP_CHROME_ROWS + 1 rows available, or POPUP_CHROME_ROWS for an empty state). Callers
 *  must then render nothing and budget zero rows — stepping aside, exactly like Banner and
 *  TodoPanel already do when a PermissionDialog claims the screen. */
export function popupLayout(total: number, index: number, maxRows?: number): PopupLayout | null {
  // Rows left for items + scroll notices after chrome. The unbounded case uses the widest
  // value the loop below can ever need (a full window plus both notices), so it always
  // settles on the first, largest candidate.
  const body = maxRows === undefined ? POPUP_WINDOW + 2 : maxRows - POPUP_CHROME_ROWS
  if (body < 0) return null
  // Empty state: the "no matches" line replaces the title, so chrome alone is the height.
  if (total <= 0) return { start: 0, count: 0, rows: POPUP_CHROME_ROWS }
  if (body < 1) return null
  for (let count = Math.min(POPUP_WINDOW, total); count >= 1; count--) {
    // Same start formula all three popups used inline, generalized from the fixed
    // POPUP_WINDOW to the (possibly shrunken) count: keep `index` visible, and never run
    // the window past either end of the list.
    const start = Math.min(Math.max(0, index - count + 1), Math.max(0, total - count))
    const notices = (start > 0 ? 1 : 0) + (start + count < total ? 1 : 0)
    if (count + notices <= body) return { start, count, rows: POPUP_CHROME_ROWS + count + notices }
  }
  return null
}
