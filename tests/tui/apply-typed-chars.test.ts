import { describe, it, expect } from 'vitest'
import { applyTypedChars } from '../../src/tui/components/InputBox.js'

describe('applyTypedChars', () => {
  it('a lone @ enters mention mode anchored at its position', () => {
    const result = applyTypedChars('hi ', null, '@')
    expect(result.value).toBe('hi @')
    expect(result.mention).toEqual({ start: 3, index: 0 })
  })

  it('a bundled multi-character chunk starting with @ still triggers mention mode', () => {
    // Regression: Ink delivers more than one character per event whenever input
    // arrives faster than it's read (not just on an explicit clipboard paste) — a
    // naive `ch === '@'` check misses this entirely.
    const result = applyTypedChars('', null, '@alpha')
    expect(result.value).toBe('@alpha')
    expect(result.mention).toEqual({ start: 0, index: 0 })
  })

  it('plain text with no @ leaves mention state untouched', () => {
    const result = applyTypedChars('hi', null, ' there')
    expect(result.value).toBe('hi there')
    expect(result.mention).toBeNull()
  })

  it('characters typed while already in mention mode extend the query and reset the highlight', () => {
    const mention = { start: 0, index: 3 }
    const result = applyTypedChars('@fo', mention, 'o')
    expect(result.value).toBe('@foo')
    expect(result.mention).toEqual({ start: 0, index: 0 })
  })

  it('a space while in mention mode ends it, keeping the text typed so far', () => {
    const mention = { start: 0, index: 2 }
    const result = applyTypedChars('@foo', mention, ' ')
    expect(result.value).toBe('@foo ')
    expect(result.mention).toBeNull()
  })

  it('a bundled chunk can both end one mention (via space) and start a new one', () => {
    const mention = { start: 0, index: 0 }
    const result = applyTypedChars('@foo', mention, ' bar @baz')
    expect(result.value).toBe('@foo bar @baz')
    // The second @ starts a fresh mention at its own position in the final value.
    expect(result.mention).toEqual({ start: 9, index: 0 })
  })
})
