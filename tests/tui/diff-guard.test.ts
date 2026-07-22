import { describe, it, expect } from 'vitest'
import { diffLines } from '../../src/tui/components/DiffPreview.js'

describe('diffLines large-input guard', () => {
  it('still computes a real LCS diff for small inputs', () => {
    const out = diffLines('a\nb\nc', 'a\nx\nc')
    expect(out).toEqual([
      { tag: ' ', line: 'a' },
      { tag: '-', line: 'b' },
      { tag: '+', line: 'x' },
      { tag: ' ', line: 'c' },
    ])
  })

  it('falls back to a plain old/new listing when either side exceeds 500 lines', () => {
    const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
    const small = 'line 0\nline 1'
    const start = Date.now()
    const out = diffLines(big, small)
    expect(Date.now() - start).toBeLessThan(1000)
    // Plain listing: all old lines as '-', then all new lines as '+', no context matching.
    expect(out).toHaveLength(602)
    expect(out.slice(0, 600).every((l) => l.tag === '-')).toBe(true)
    expect(out.slice(600).every((l) => l.tag === '+')).toBe(true)
  })
})
