import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Box, Text } from 'ink'
import { createElement } from 'react'
import {
  sliceToAnchor,
  shiftAnchor,
  estimateEntryRows,
  displayWidth,
  tailTextToRows,
  truncateTextToRows,
  wrappedRowCount,
} from '../../src/tui/viewport.js'
import { popupLine } from '../../src/tui/popupWindow.js'
import type { TranscriptEntry } from '../../src/tui/components/Transcript.js'

describe('sliceToAnchor', () => {
  it('returns everything when it all fits', () => {
    const entries = ['a', 'b', 'c']
    expect(sliceToAnchor(entries, () => 1, 10, null)).toEqual({
      items: ['a', 'b', 'c'],
      clipFirstRows: 0,
      clipLastRows: 0,
    })
  })

  it('packs backward from the tail within maxRows, clipping the top entry into spare rows', () => {
    const entries = ['a', 'b', 'c', 'd', 'e']
    // 2 rows each, budget 5: d+e (4 rows) fit whole, and c contributes its last row
    // rather than leaving a row unused — row-granularity at the window's top edge.
    expect(sliceToAnchor(entries, () => 2, 5, null)).toEqual({
      items: ['c', 'd', 'e'],
      clipFirstRows: 1,
      clipLastRows: 0,
    })
  })

  it('clips an oversized anchor entry to its tail rows instead of dropping it', () => {
    const window = sliceToAnchor(['a', 'b'], () => 100, 5, null)
    expect(window.items).toEqual(['b'])
    expect(window.clipFirstRows).toBe(95)
    expect(window.clipLastRows).toBe(0)
  })

  it('returns an empty window for an empty input', () => {
    expect(sliceToAnchor([], () => 1, 10, null).items).toEqual([])
  })

  it('maxRows <= 0 still keeps the most recent entry rather than blanking the transcript', () => {
    expect(sliceToAnchor(['a', 'b'], () => 1, 0, null).items).toEqual(['b'])
  })

  it('render/memory cost stays flat: window size never grows with history length', () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `entry-${i}`)
    expect(sliceToAnchor(long, () => 1, 20, null).items).toHaveLength(20)
  })

  it('a scrolled anchor ends the window inside the indexed entry', () => {
    const entries = ['a', 'b', 'c', 'd', 'e']
    expect(sliceToAnchor(entries, () => 1, 3, { index: 3, clip: 0 }).items).toEqual(['b', 'c', 'd'])
    expect(sliceToAnchor(entries, () => 1, 3, { index: 2, clip: 0 }).items).toEqual(['a', 'b', 'c'])
  })

  it('clip rows come off the anchor entry bottom (row-precise, not entry-granular)', () => {
    // A 10-row entry whose window bottom rests 6 rows above its tail, budget 4:
    // rows [0..4) show — clipFirst 0, clipLast 6.
    const window = sliceToAnchor(['big'], () => 10, 4, { index: 0, clip: 6 })
    expect(window).toEqual({ items: ['big'], clipFirstRows: 0, clipLastRows: 6 })
  })

  it('the middle of a screen-taller entry is reachable — the regression this fixes', () => {
    // 30-row entry under 10 singles, budget 5, bottom edge 20 rows above the tall
    // entry's bottom: the window shows tall rows [7..12) — its middle.
    const entries = ['tall', 's1', 's2']
    const rows = (e: string): number => (e === 'tall' ? 30 : 1)
    const window = sliceToAnchor(entries, rows, 5, { index: 0, clip: 20 })
    expect(window).toEqual({ items: ['tall'], clipFirstRows: 5, clipLastRows: 20 })
  })

  it('clips the top entry from above when it only partially fits', () => {
    // budget 4 from the tail: c(1) + b(1) fit whole; a(10 rows) contributes its last 2.
    const rows = (e: string): number => (e === 'a' ? 10 : 1)
    const window = sliceToAnchor(['a', 'b', 'c'], rows, 4, null)
    expect(window).toEqual({ items: ['a', 'b', 'c'], clipFirstRows: 8, clipLastRows: 0 })
  })

  it('never slices a non-clippable entry mid-body', () => {
    const rows = (e: string): number => (e === 'a' ? 10 : 1)
    const window = sliceToAnchor(['a', 'b', 'c'], rows, 4, null, () => false)
    expect(window).toEqual({ items: ['b', 'c'], clipFirstRows: 0, clipLastRows: 0 })
  })

  it('clamps a nonsense anchor into range instead of blanking the transcript', () => {
    const entries = ['a', 'b', 'c']
    expect(sliceToAnchor(entries, () => 1, 2, { index: 99, clip: 0 }).items).toEqual(['b', 'c'])
    expect(sliceToAnchor(entries, () => 1, 2, { index: -5, clip: 0 }).items).toEqual(['a'])
  })

  it('a scrolled window is unmoved by entries appended after it (no yank to the tail)', () => {
    const entries = ['a', 'b', 'c', 'd', 'e']
    const before = sliceToAnchor(entries, () => 1, 3, { index: 2, clip: 0 })
    const grown = [...entries, 'f', 'g']
    expect(sliceToAnchor(grown, () => 1, 3, { index: 2, clip: 0 })).toEqual(before)
  })

  it('cost stays proportional to the viewport, not to history length', () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `entry-${i}`)
    let measured = 0
    const rows = (): number => {
      measured += 1
      return 1
    }
    expect(sliceToAnchor(long, rows, 20, { index: 2_499, clip: 0 }).items).toHaveLength(20)
    expect(measured).toBeLessThanOrEqual(21) // the window plus the one that didn't fit
  })
})

describe('shiftAnchor', () => {
  const entries = Array.from({ length: 10 }, (_, i) => `e${i}`)
  const one = (): number => 1

  it('scrolls up by the requested number of rows', () => {
    expect(shiftAnchor(entries, one, null, -3, 5)).toEqual({ index: 6, clip: 0 })
  })

  it('scrolling down to the live tail returns null (resume follow)', () => {
    expect(shiftAnchor(entries, one, { index: 6, clip: 0 }, 3, 5)).toBeNull()
  })

  it('round-trips: up then down by the same amount returns to the tail', () => {
    const up = shiftAnchor(entries, one, null, -4, 5)
    expect(shiftAnchor(entries, one, up, 4, 5)).toBeNull()
  })

  it('clamps at the top with the first content row at the window top', () => {
    // budget 5 over 10 one-row entries: the topmost position shows e0..e4.
    expect(shiftAnchor(entries, one, null, -99, 5)).toEqual({ index: 4, clip: 0 })
    expect(shiftAnchor(entries, one, { index: 1, clip: 0 }, -99, 5)).toEqual({ index: 4, clip: 0 })
  })

  it('is a no-op (null) when the whole history already fits the viewport', () => {
    expect(shiftAnchor(['a', 'b'], one, null, -1, 5)).toBeNull()
  })

  it('walks through a tall entry interior row by row', () => {
    const tall = (entry: string): number => (entry === 'e9' ? 50 : 1)
    // 9 singles + a 50-row tail entry, total 59: up 10 from the tail lands 10 rows
    // above the tall entry's bottom.
    expect(shiftAnchor(entries, tall, null, -10, 5)).toEqual({ index: 9, clip: 10 })
  })

  it('clamps a nonsense incoming anchor before moving it', () => {
    expect(shiftAnchor(entries, one, { index: 999, clip: 0 }, -1, 5)).toEqual({ index: 8, clip: 0 })
    expect(shiftAnchor(entries, one, { index: -5, clip: 99 }, -1, 5)).toEqual({ index: 4, clip: 0 })
  })

  it('is a no-op on an empty transcript', () => {
    expect(shiftAnchor([], one, null, -5, 5)).toBeNull()
  })
})

/** Rows a string ACTUALLY occupies once Ink has laid it out at `width` columns — the
 *  ground truth these budgets exist to predict. Every non-ASCII case below is checked
 *  against this rather than against a character count, because a character count is
 *  exactly the assumption under test. */
function renderedRows(text: string, width: number): number {
  const { lastFrame, unmount } = render(
    createElement(Box, { width }, createElement(Text, null, text)),
  )
  const frame = lastFrame() ?? ''
  unmount()
  return frame.split('\n').length
}

// A CJK filename, an emoji-bearing agent description, or a project path with either in it
// all reach the budget-critical popupLine/truncateTextToRows path (an '@' mention result, a
// command description read from user-authored frontmatter). Measuring them by
// `text.length` counts UTF-16 code units: full-width CJK is 2 COLUMNS per code unit, so a
// "one row" line was up to twice as wide as the budget believed and Ink wrapped it to 2+
// rows — reproducing the original unclipped-sibling overflow exactly.
describe('display-width awareness (non-ASCII)', () => {
  const CJK = '日本語のファイル名' // 9 code units, 18 columns
  const EMOJI_ZWJ = '👩‍💻' // 5 code units, 1 grapheme, 2 columns
  const ASTRAL = '🚀' // surrogate PAIR: 2 code units, 2 columns

  it('measures columns, not UTF-16 code units', () => {
    expect(CJK.length).toBe(9)
    expect(displayWidth(CJK)).toBe(18)
    expect(displayWidth(ASTRAL)).toBe(2)
    expect(displayWidth('plain ascii')).toBe('plain ascii'.length)
  })

  it('wrappedRowCount agrees with what Ink actually renders for CJK', () => {
    // 18 columns of text in a 10-column box is two rows, not the one a length check saw.
    expect(wrappedRowCount(CJK, 10)).toBe(2)
    expect(wrappedRowCount(CJK, 10)).toBe(renderedRows(CJK, 10))
  })

  it('truncateTextToRows holds CJK to the requested rows when rendered', () => {
    for (const width of [6, 10, 12, 20]) {
      const out = truncateTextToRows(CJK, width, 1)
      expect(renderedRows(out, width), `CJK at width ${width} -> ${out}`).toBe(1)
    }
  })

  it('a mixed ASCII/CJK string at a narrow width still renders within the ceiling', () => {
    const mixed = 'src/日本語/component-with-a-long-name/インデックス.tsx'
    for (const width of [12, 24, 40]) {
      expect(renderedRows(truncateTextToRows(mixed, width, 1), width)).toBe(1)
      expect(renderedRows(truncateTextToRows(mixed, width, 2), width)).toBeLessThanOrEqual(2)
    }
  })

  it('never splits a surrogate pair, even when the boundary lands mid-pair', () => {
    // Odd ASCII prefix + astral chars: a code-unit slice at any width lands inside a pair
    // for half of these, producing a lone surrogate.
    for (let prefix = 0; prefix <= 4; prefix++) {
      const text = 'a'.repeat(prefix) + ASTRAL.repeat(8)
      for (let width = 4; width <= 14; width++) {
        const out = truncateTextToRows(text, width, 1)
        // A high surrogate not followed by a low one, or a low one not preceded by a high
        // one — either is a severed pair.
        expect(out, `prefix ${prefix} width ${width}`).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
        expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
        expect(renderedRows(out, width)).toBe(1)
      }
    }
  })

  it('keeps a ZWJ emoji sequence whole rather than severing it into components', () => {
    const text = `${EMOJI_ZWJ.repeat(6)} done`
    for (let width = 4; width <= 16; width++) {
      const out = truncateTextToRows(text, width, 1)
      // Either the whole sequence survives or it is dropped — never a bare 👩 or 💻 left
      // behind, and never a dangling joiner, from a cut inside the joiner run.
      const women = [...out.matchAll(/\u{1F469}/gu)].length
      const laptops = [...out.matchAll(/\u{1F4BB}/gu)].length
      expect(women, `width ${width} -> ${out}`).toBe(laptops)
      expect(out).not.toContain('‍…')
      expect(out.endsWith('‍')).toBe(false)
      expect(renderedRows(out, width)).toBe(1)
    }
  })

  it('popupLine holds a CJK/emoji popup row to exactly one rendered row', () => {
    const rows = [
      `[agent] レビュー担当 — コードレビューを行うエージェントです`,
      `[file] src/コンポーネント/とても長いファイル名.tsx`,
      `[agent] ship-it 🚀🚀🚀 — deploys ${'everything '.repeat(6)}`,
    ]
    for (const row of rows) {
      for (const columns of [16, 30, 40, 80]) {
        expect(renderedRows(popupLine(row, columns), columns), `${row} @ ${columns}`).toBe(1)
      }
    }
  })
})

describe('estimateEntryRows', () => {
  it('counts a one-line user/assistant/system entry as 1 row', () => {
    expect(estimateEntryRows({ kind: 'user', text: 'hi' })).toBe(1)
    expect(estimateEntryRows({ kind: 'assistant', text: 'hi' })).toBe(1)
    expect(estimateEntryRows({ kind: 'system', text: 'anything' })).toBe(1)
  })

  it('counts embedded newlines as separate rows', () => {
    expect(estimateEntryRows({ kind: 'assistant', text: 'line1\nline2\nline3' })).toBe(3)
  })

  it('wraps long lines by the given column width', () => {
    const text = 'x'.repeat(85) // > 80 default columns -> wraps to 2 rows
    expect(estimateEntryRows({ kind: 'user', text })).toBe(2)
    expect(estimateEntryRows({ kind: 'user', text: 'x'.repeat(85) }, 100)).toBe(1)
  })

  it('a tool entry with no output is just its header row', () => {
    const entry: TranscriptEntry = { kind: 'tool', id: '1', name: 'Bash', input: {}, output: null, isError: false }
    expect(estimateEntryRows(entry)).toBe(1)
  })

  it('a tool entry with output adds its wrapped row count', () => {
    const entry: TranscriptEntry = {
      kind: 'tool',
      id: '1',
      name: 'Bash',
      input: {},
      output: 'out1\nout2',
      isError: false,
    }
    expect(estimateEntryRows(entry)).toBe(3) // 1 header + 2 output lines
  })

  it('a thinking entry measures its prefixed, tail-capped display text', () => {
    expect(estimateEntryRows({ kind: 'thinking', text: 'short' })).toBe(1)
    // 20 distinct lines tail-cap to 8 rows (7 kept + the … indicator).
    const long = Array.from({ length: 20 }, (_, i) => `reasoning step ${i}`).join('\n')
    expect(estimateEntryRows({ kind: 'thinking', text: long })).toBe(8)
    // The prefix columns count: a line that fills the width still wraps after the prefix.
    const wide = 'x'.repeat(78) // + 2-col prefix = 80 -> exactly 1 row at 80 columns
    expect(estimateEntryRows({ kind: 'thinking', text: wide }, 80)).toBe(1)
    const wider = 'x'.repeat(79) // + prefix wraps to 2
    expect(estimateEntryRows({ kind: 'thinking', text: wider }, 80)).toBe(2)
  })

  it('tailTextToRows keeps the tail within budget and flags the cut head', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n')
    const result = tailTextToRows(text, 80, 4)
    const rows = result.split('\n')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toBe('…')
    expect(rows.slice(1)).toEqual(['line-7', 'line-8', 'line-9'])
    expect(tailTextToRows('fits', 80, 4)).toBe('fits')
  })
})
