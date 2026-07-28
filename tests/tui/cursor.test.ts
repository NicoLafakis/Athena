// tests/tui/cursor.test.ts — direct unit tests for the InputBox's cursor arithmetic
// (src/tui/cursor.ts). Everything here is pure index math over a flat string that may
// contain '\n', which is exactly the kind of logic where an off-by-one silently corrupts
// the UI (a cursor one past where it should be deletes the wrong character) rather than
// throwing, so the boundaries are asserted explicitly rather than sampled.
import { describe, it, expect } from 'vitest'
import {
  clampCursor,
  cursorRowCol,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  insertAt,
  isWordBackspaceKey,
  lineEnd,
  lineStart,
  nextWordBoundary,
  prevWordBoundary,
} from '../../src/tui/cursor.js'

describe('clampCursor', () => {
  it('keeps an in-range index untouched and pins out-of-range ones to the ends', () => {
    expect(clampCursor('hello', 2)).toBe(2)
    expect(clampCursor('hello', -5)).toBe(0)
    expect(clampCursor('hello', 99)).toBe(5)
    expect(clampCursor('hello', 5)).toBe(5) // end-of-text is a VALID cursor position
  })

  it('falls back to end-of-text for a non-finite index', () => {
    expect(clampCursor('hello', Number.NaN)).toBe(5)
  })
})

describe('prevWordBoundary', () => {
  it('walks back over the current word', () => {
    expect(prevWordBoundary('foo bar baz', 11)).toBe(8)
    expect(prevWordBoundary('foo bar baz', 8)).toBe(4)
    expect(prevWordBoundary('foo bar baz', 4)).toBe(0)
  })

  it('skips trailing whitespace before the word behind it', () => {
    expect(prevWordBoundary('foo bar   ', 10)).toBe(4)
  })

  it('stops at 0 and never goes negative', () => {
    expect(prevWordBoundary('foo', 0)).toBe(0)
    expect(prevWordBoundary('   ', 3)).toBe(0)
    expect(prevWordBoundary('', 0)).toBe(0)
  })

  it('lands mid-word when the cursor is mid-word', () => {
    expect(prevWordBoundary('foo bar', 6)).toBe(4)
  })

  it('treats a newline as whitespace: word motion crosses lines', () => {
    expect(prevWordBoundary('foo\nbar', 7)).toBe(4)
    expect(prevWordBoundary('foo\nbar', 4)).toBe(0)
  })
})

describe('nextWordBoundary', () => {
  it('walks forward to the end of the word ahead', () => {
    expect(nextWordBoundary('foo bar baz', 0)).toBe(3)
    expect(nextWordBoundary('foo bar baz', 3)).toBe(7)
    expect(nextWordBoundary('foo bar baz', 7)).toBe(11)
  })

  it('stops at the end of text and never runs past it', () => {
    expect(nextWordBoundary('foo', 3)).toBe(3)
    expect(nextWordBoundary('foo   ', 3)).toBe(6)
    expect(nextWordBoundary('', 0)).toBe(0)
  })

  it('is the mirror of prevWordBoundary across a newline', () => {
    expect(nextWordBoundary('foo\nbar', 3)).toBe(7)
  })
})

describe('lineStart / lineEnd', () => {
  const text = 'alpha\nbeta\ngamma'

  it('bound the CURRENT line, not the whole buffer', () => {
    expect(lineStart(text, 8)).toBe(6) // inside "beta"
    expect(lineEnd(text, 8)).toBe(10)
  })

  it('handle the first and last lines', () => {
    expect(lineStart(text, 0)).toBe(0)
    expect(lineEnd(text, 0)).toBe(5)
    expect(lineStart(text, 16)).toBe(11)
    expect(lineEnd(text, 16)).toBe(16)
  })

  it('a cursor sitting exactly ON a newline belongs to the line that newline ends', () => {
    expect(lineStart(text, 5)).toBe(0)
    expect(lineEnd(text, 5)).toBe(5)
  })

  it('degrade to 0/length for single-line text', () => {
    expect(lineStart('hello', 3)).toBe(0)
    expect(lineEnd('hello', 3)).toBe(5)
  })
})

describe('cursorRowCol', () => {
  it('maps a flat index onto the rendered row/column', () => {
    const text = 'alpha\nbeta\ngamma'
    expect(cursorRowCol(text, 0)).toEqual({ row: 0, col: 0 })
    expect(cursorRowCol(text, 5)).toEqual({ row: 0, col: 5 }) // end of row 0
    expect(cursorRowCol(text, 6)).toEqual({ row: 1, col: 0 }) // start of row 1
    expect(cursorRowCol(text, 16)).toEqual({ row: 2, col: 5 }) // end of the buffer
  })

  it('is row 0 for empty text', () => {
    expect(cursorRowCol('', 0)).toEqual({ row: 0, col: 0 })
  })

  it('agrees with value.split("\\n") on the row count', () => {
    const text = 'a\nb\nc'
    expect(cursorRowCol(text, text.length).row).toBe(text.split('\n').length - 1)
  })
})

describe('insertAt', () => {
  it('inserts in the middle and returns the cursor after the insertion', () => {
    expect(insertAt('helloworld', 5, ' ')).toEqual({ value: 'hello world', cursor: 6 })
  })

  it('appending at the end matches the old end-assuming behavior exactly', () => {
    expect(insertAt('hi', 2, ' there')).toEqual({ value: 'hi there', cursor: 8 })
  })

  it('inserts at the very start', () => {
    expect(insertAt('bc', 0, 'a')).toEqual({ value: 'abc', cursor: 1 })
  })
})

describe('deleteBackward / deleteForward', () => {
  it('deleteBackward removes the character before the cursor', () => {
    expect(deleteBackward('abc', 2)).toEqual({ value: 'ac', cursor: 1 })
    expect(deleteBackward('abc', 3)).toEqual({ value: 'ab', cursor: 2 })
  })

  it('deleteBackward is a no-op at index 0', () => {
    expect(deleteBackward('abc', 0)).toEqual({ value: 'abc', cursor: 0 })
  })

  it('deleteForward removes the character AT the cursor, leaving it put', () => {
    expect(deleteForward('abc', 1)).toEqual({ value: 'ac', cursor: 1 })
    expect(deleteForward('abc', 0)).toEqual({ value: 'bc', cursor: 0 })
  })

  it('deleteForward is a no-op at end of text', () => {
    expect(deleteForward('abc', 3)).toEqual({ value: 'abc', cursor: 3 })
  })
})

describe('deleteWordBackward', () => {
  it('kills the word behind the cursor', () => {
    expect(deleteWordBackward('foo bar baz', 11)).toEqual({ value: 'foo bar ', cursor: 8 })
  })

  it('kills trailing whitespace along with the word it follows', () => {
    expect(deleteWordBackward('foo bar   ', 10)).toEqual({ value: 'foo ', cursor: 4 })
  })

  it('keeps whatever follows the cursor intact', () => {
    expect(deleteWordBackward('foo bar baz', 7)).toEqual({ value: 'foo  baz', cursor: 4 })
  })

  it('is a no-op at index 0', () => {
    expect(deleteWordBackward('foo', 0)).toEqual({ value: 'foo', cursor: 0 })
  })
})

describe('isWordBackspaceKey', () => {
  it('is true only under Windows Terminal, and only for the BS (0x08) flavor', () => {
    const wt = { WT_SESSION: 'abc' } as NodeJS.ProcessEnv
    expect(isWordBackspaceKey({ backspace: true, delete: false }, wt)).toBe(true)
    // Plain Backspace on WT arrives as DEL, i.e. Ink's `delete` — must NOT word-delete.
    expect(isWordBackspaceKey({ backspace: false, delete: true }, wt)).toBe(false)
  })

  it('is false off Windows Terminal, where 0x08 can mean plain Backspace', () => {
    const other = {} as NodeJS.ProcessEnv
    expect(isWordBackspaceKey({ backspace: true, delete: false }, other)).toBe(false)
  })
})
