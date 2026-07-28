import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Box, Text } from 'ink'
import { createElement } from 'react'
import {
  sliceToRows,
  shiftWindowEnd,
  estimateEntryRows,
  displayWidth,
  truncateTextToRows,
  wrappedRowCount,
} from '../../src/tui/viewport.js'
import { popupLine } from '../../src/tui/popupWindow.js'
import type { TranscriptEntry } from '../../src/tui/components/Transcript.js'

describe('sliceToRows', () => {
  it('returns everything when it all fits', () => {
    const entries = ['a', 'b', 'c']
    expect(sliceToRows(entries, () => 1, 10)).toEqual(['a', 'b', 'c'])
  })

  it('keeps only the most recent entries that fit within maxRows', () => {
    const entries = ['a', 'b', 'c', 'd', 'e']
    // 2 rows each, budget 5: two entries (4 rows) fit, a third (6 rows) would not.
    expect(sliceToRows(entries, () => 2, 5)).toEqual(['d', 'e'])
  })

  it('always keeps at least the single most recent entry, even if it alone exceeds maxRows', () => {
    expect(sliceToRows(['a', 'b'], () => 100, 5)).toEqual(['b'])
  })

  it('returns an empty array for an empty input', () => {
    expect(sliceToRows([], () => 1, 10)).toEqual([])
  })

  it('maxRows <= 0 still keeps the most recent entry rather than blanking the transcript', () => {
    expect(sliceToRows(['a', 'b'], () => 1, 0)).toEqual(['b'])
  })

  it('render/memory cost stays flat: window size never grows with history length', () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `entry-${i}`)
    expect(sliceToRows(long, () => 1, 20)).toHaveLength(20)
  })
})

describe('sliceToRows with a scrolled window end', () => {
  const entries = ['a', 'b', 'c', 'd', 'e']

  it('windowEnd === entries.length is byte-for-byte the pinned-to-tail default', () => {
    expect(sliceToRows(entries, () => 1, 3, entries.length)).toEqual(sliceToRows(entries, () => 1, 3))
  })

  it('ends the window at the given exclusive index', () => {
    expect(sliceToRows(entries, () => 1, 3, 4)).toEqual(['b', 'c', 'd'])
    expect(sliceToRows(entries, () => 1, 3, 3)).toEqual(['a', 'b', 'c'])
  })

  it('packs backward by ROWS, not by entry count, from the scrolled end', () => {
    // 2 rows each, budget 5: two entries fit, a third would not.
    expect(sliceToRows(entries, () => 2, 5, 4)).toEqual(['c', 'd'])
  })

  it('clamps a window end below 1 up to 1 rather than blanking the transcript', () => {
    expect(sliceToRows(entries, () => 1, 3, 0)).toEqual(['a'])
    expect(sliceToRows(entries, () => 1, 3, -10)).toEqual(['a'])
  })

  it('clamps a window end past the tail back down to the tail', () => {
    expect(sliceToRows(entries, () => 1, 2, 99)).toEqual(['d', 'e'])
  })

  it('still keeps one entry when the entry at the window end alone exceeds maxRows', () => {
    expect(sliceToRows(entries, () => 100, 5, 3)).toEqual(['c'])
  })

  it('a scrolled window is unmoved by entries appended after it (no yank to the tail)', () => {
    const before = sliceToRows(entries, () => 1, 3, 3)
    const grown = [...entries, 'f', 'g']
    expect(sliceToRows(grown, () => 1, 3, 3)).toEqual(before)
  })

  it('cost stays proportional to the viewport, not to history length', () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `entry-${i}`)
    let measured = 0
    const rows = (): number => {
      measured += 1
      return 1
    }
    expect(sliceToRows(long, rows, 20, 2_500)).toHaveLength(20)
    expect(measured).toBeLessThanOrEqual(21) // the window plus the one that didn't fit
  })
})

describe('shiftWindowEnd', () => {
  const entries = Array.from({ length: 10 }, (_, i) => `e${i}`)
  const one = (): number => 1

  it('scrolls up by the requested number of rows', () => {
    expect(shiftWindowEnd(entries, one, 10, -3)).toBe(7)
  })

  it('scrolls back down by the requested number of rows', () => {
    expect(shiftWindowEnd(entries, one, 7, 3)).toBe(10)
  })

  it('round-trips: up then down by the same amount returns to where it started', () => {
    const up = shiftWindowEnd(entries, one, 10, -4)
    expect(shiftWindowEnd(entries, one, up, 4)).toBe(10)
  })

  it('clamps at the top to 1, never emptying the window', () => {
    expect(shiftWindowEnd(entries, one, 3, -99)).toBe(1)
    expect(shiftWindowEnd(entries, one, 1, -1)).toBe(1)
  })

  it('clamps at the bottom to the live tail', () => {
    expect(shiftWindowEnd(entries, one, 8, 99)).toBe(10)
    expect(shiftWindowEnd(entries, one, 10, 5)).toBe(10)
  })

  it('accounts for multi-row entries: a tall entry consumes a whole page step on its own', () => {
    const tall = (entry: string): number => (entry === 'e9' ? 50 : 1)
    expect(shiftWindowEnd(entries, tall, 10, -10)).toBe(9)
  })

  it('lands on an entry boundary at or PAST the requested rows, never mid-entry', () => {
    const two = (): number => 2
    // 3 rows requested, 2 rows per entry: two entries (4 rows) must leave the window.
    expect(shiftWindowEnd(entries, two, 10, -3)).toBe(8)
  })

  it('clamps a nonsense incoming window end before moving it', () => {
    expect(shiftWindowEnd(entries, one, 999, -1)).toBe(9)
    expect(shiftWindowEnd(entries, one, -999, -1)).toBe(1)
  })

  it('is a no-op on an empty transcript', () => {
    expect(shiftWindowEnd([], one, 0, -5)).toBe(0)
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
})
