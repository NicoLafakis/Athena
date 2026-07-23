import { describe, it, expect } from 'vitest'
import { beginSlashComposition } from '../../src/tui/components/InputBox.js'

describe('beginSlashComposition', () => {
  it('a lone "/" arms the menu with an empty query', () => {
    const result = beginSlashComposition('/')
    expect(result.value).toBe('/')
    expect(result.slash).toEqual({ index: 0 })
    expect(result.rest).toBe('')
  })

  it('a bundled multi-character chunk with no whitespace stays fully composing', () => {
    // Regression: fast typing can deliver a whole word ("/compact") in one Ink input
    // event, just like the '@' case in applyTypedChars.
    const result = beginSlashComposition('/compact')
    expect(result.value).toBe('/compact')
    expect(result.slash).toEqual({ index: 0 })
    expect(result.rest).toBe('')
  })

  it('whitespace in the chunk ends composition and hands back the remainder', () => {
    const result = beginSlashComposition('/tui fullscreen')
    expect(result.value).toBe('/tui')
    expect(result.slash).toEqual({ index: 0 })
    expect(result.rest).toBe(' fullscreen')
  })

  it('the remainder includes the whitespace character itself', () => {
    const result = beginSlashComposition('/a ')
    expect(result.value).toBe('/a')
    expect(result.rest).toBe(' ')
  })
})
