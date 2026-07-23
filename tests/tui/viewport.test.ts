import { describe, it, expect } from 'vitest'
import { sliceToRows, estimateEntryRows } from '../../src/tui/viewport.js'
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
