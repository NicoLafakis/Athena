// tests/tui/popup-window.test.ts — unit tests for the shared popup row math
// (src/tui/popupWindow.ts) that MentionPopup, SlashMenuPopup and ArgPickerPopup all now
// render from. Two properties matter and are asserted here directly, because the whole
// fullscreen row budget in App.tsx leans on them:
//
//  1. `rows` is EXACT: it equals chrome + visible items + whichever scroll notices the
//     component will actually draw. If it over-reports the budget wastes space; if it
//     UNDER-reports, an unclipped sibling overflows and Ink/Yoga corrupts the frame.
//  2. `rows` never exceeds `maxRows`, for every (total, index, maxRows) combination —
//     including the degenerate ones where the honest answer is "don't draw at all".
import { describe, it, expect } from 'vitest'
import {
  POPUP_CHROME_ROWS,
  POPUP_WINDOW,
  popupLayout,
  popupLine,
  popupTextColumns,
} from '../../src/tui/popupWindow.js'

/** Independently recomputes the height a popup drawn from `layout` actually renders as,
 *  from the component's own render shape (border + title + notices + items) rather than
 *  from popupLayout's arithmetic — so this is a real cross-check, not a restatement. */
function renderedRows(total: number, layout: { start: number; count: number }): number {
  if (layout.count === 0) return POPUP_CHROME_ROWS // empty state: the notice replaces the title
  const earlier = layout.start > 0 ? 1 : 0
  const more = layout.start + layout.count < total ? 1 : 0
  return POPUP_CHROME_ROWS + layout.count + earlier + more
}

describe('popupLayout — unbounded (classic mode)', () => {
  it('reproduces the pre-budget window: a full POPUP_WINDOW slice anchored on the cursor', () => {
    const layout = popupLayout(20, 0)
    expect(layout).toEqual({ start: 0, count: POPUP_WINDOW, rows: POPUP_CHROME_ROWS + POPUP_WINDOW + 1 })
  })

  it('keeps the cursor visible when it is past the first window, without running off the end', () => {
    const layout = popupLayout(20, 19)
    expect(layout?.start).toBe(20 - POPUP_WINDOW)
    expect(layout?.count).toBe(POPUP_WINDOW)
    // "… N earlier" shows, "… N more" does not (the window ends at the last item).
    expect(layout?.rows).toBe(POPUP_CHROME_ROWS + POPUP_WINDOW + 1)
  })

  it('a list shorter than the window draws entirely, with no notices at all', () => {
    expect(popupLayout(3, 1)).toEqual({ start: 0, count: 3, rows: POPUP_CHROME_ROWS + 3 })
  })

  it('an empty list is the 3-row empty state, never null', () => {
    expect(popupLayout(0, 0)).toEqual({ start: 0, count: 0, rows: POPUP_CHROME_ROWS })
  })
})

describe('popupLayout — budgeted (fullscreen mode)', () => {
  it('shrinks the visible window rather than overflowing when the budget is tight', () => {
    // 11 rows = chrome(3) + 7 items + 1 "… N more" notice: one item fewer than the full
    // window, which is exactly the graceful-degradation behavior the budget needs.
    const layout = popupLayout(20, 0, 11)
    expect(layout).toEqual({ start: 0, count: 7, rows: 11 })
  })

  it('degrades all the way down to a single visible item', () => {
    expect(popupLayout(20, 0, 5)).toEqual({ start: 0, count: 1, rows: 5 })
  })

  it('returns null (draw nothing, reserve nothing) when not even one item plus its notice fits', () => {
    expect(popupLayout(20, 0, 4)).toBeNull()
    expect(popupLayout(20, 0, POPUP_CHROME_ROWS)).toBeNull()
    expect(popupLayout(20, 0, 0)).toBeNull()
  })

  it('the empty state still fits in exactly POPUP_CHROME_ROWS, and vanishes below it', () => {
    expect(popupLayout(0, 0, POPUP_CHROME_ROWS)?.rows).toBe(POPUP_CHROME_ROWS)
    expect(popupLayout(0, 0, POPUP_CHROME_ROWS - 1)).toBeNull()
  })

  it('never exceeds the budget, and always reports the height it will really render as', () => {
    for (const total of [0, 1, 2, 5, 8, 9, 20, 200]) {
      for (const index of [0, 1, 4, 7, 8, 19, Math.max(total - 1, 0)]) {
        for (const maxRows of [0, 1, 3, 4, 5, 6, 9, 12, 13, 40]) {
          const layout = popupLayout(total, index, maxRows)
          if (layout === null) continue
          expect(layout.rows).toBeLessThanOrEqual(maxRows)
          expect(layout.rows).toBe(renderedRows(total, layout))
          expect(layout.start).toBeGreaterThanOrEqual(0)
          expect(layout.start + layout.count).toBeLessThanOrEqual(total)
          // The cursor stays visible whenever anything is drawn at all.
          if (layout.count > 0 && index < total) {
            const clampedIndex = Math.min(Math.max(index, 0), total - 1)
            if (clampedIndex >= layout.start) {
              expect(clampedIndex).toBeLessThan(layout.start + layout.count)
            }
          }
        }
      }
    }
  })
})

describe('popupLine', () => {
  it('holds a long line to exactly one row at the popup s inner width', () => {
    const width = popupTextColumns(40)
    const line = popupLine('x'.repeat(500), width)
    expect(line.length).toBeLessThanOrEqual(width)
    expect(line.endsWith('…')).toBe(true)
  })

  it('flattens embedded line breaks and tabs so nothing wraps for a non-length reason', () => {
    expect(popupLine('a\nb\tc', 40)).toBe('a b c')
  })

  it('leaves ordinary runs of spaces alone (fixed-width markers stay aligned)', () => {
    expect(popupLine('  opus', 40)).toBe('  opus')
    expect(popupLine('● opus', 40)).toBe('● opus')
  })

  it('leaves a line that already fits untouched', () => {
    expect(popupLine('/model — switch model', 60)).toBe('/model — switch model')
  })
})
