// src/tui/cursor.ts — pure cursor arithmetic for the InputBox's editable buffer.
// The buffer is a single flat string that MAY contain '\n' (backslash-continuation, see
// InputBox's Return handler), and the cursor is a single flat index into it — never a
// [row, col] pair. Multi-line behavior is expressed by respecting '\n' boundaries inside
// that flat index (lineStart/lineEnd/cursorRowCol below) rather than by carrying a second
// coordinate that could drift out of sync with the text it indexes into.
//
// Everything here is pure and index-only so it can be unit-tested directly, without
// mounting a component or simulating keypresses — row/cursor arithmetic is exactly the
// kind of logic where an off-by-one silently corrupts the UI instead of throwing.

/** Clamps an arbitrary index into the valid cursor range for `text` — [0, length], where
 *  `length` itself is valid and means "after the last character". */
export function clampCursor(text: string, index: number): number {
  if (!Number.isFinite(index)) return text.length
  return Math.min(Math.max(Math.trunc(index), 0), text.length)
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c)

/** Start of the whitespace-delimited word at or before `index` — skips any whitespace
 *  immediately behind the cursor first, then the word characters behind that. Mirrors
 *  readline's backward-word: repeated presses walk word by word and stop at 0. '\n'
 *  counts as whitespace here (word motion crosses lines; only lineStart/lineEnd below
 *  treat it as a hard boundary). */
export function prevWordBoundary(text: string, index: number): number {
  let i = clampCursor(text, index)
  while (i > 0 && isSpace(text[i - 1])) i -= 1
  while (i > 0 && !isSpace(text[i - 1])) i -= 1
  return i
}

/** End of the whitespace-delimited word at or after `index` — the forward mirror of
 *  prevWordBoundary: skips whitespace ahead of the cursor, then the word characters after
 *  it, landing just past the end of that word (readline's forward-word). */
export function nextWordBoundary(text: string, index: number): number {
  let i = clampCursor(text, index)
  while (i < text.length && isSpace(text[i])) i += 1
  while (i < text.length && !isSpace(text[i])) i += 1
  return i
}

/** Index just after the '\n' that precedes `index` (0 on the first line) — i.e. Ctrl+A
 *  goes to the start of the CURRENT LINE, not the start of the whole buffer. */
export function lineStart(text: string, index: number): number {
  const i = clampCursor(text, index)
  const nl = text.lastIndexOf('\n', i - 1)
  return nl === -1 ? 0 : nl + 1
}

/** Index of the '\n' that follows `index` (text.length on the last line) — Ctrl+E's
 *  counterpart to lineStart above. */
export function lineEnd(text: string, index: number): number {
  const i = clampCursor(text, index)
  const nl = text.indexOf('\n', i)
  return nl === -1 ? text.length : nl
}

/** Splits a flat cursor index into the visual row (index into `text.split('\n')`) and the
 *  column within that row — used ONLY for rendering the block cursor, which has to know
 *  which of InputBox's rendered lines carries it. Never stored as state. */
export function cursorRowCol(text: string, index: number): { row: number; col: number } {
  const i = clampCursor(text, index)
  const before = text.slice(0, i)
  const nl = before.lastIndexOf('\n')
  return { row: before.split('\n').length - 1, col: i - (nl + 1) }
}

/** Inserts `chars` at `cursor`, returning the new buffer and the cursor position after
 *  the insertion. The single seam every typed/pasted/selected run of text goes through so
 *  no edit path is left assuming the cursor is at the end. */
export function insertAt(text: string, cursor: number, chars: string): { value: string; cursor: number } {
  const i = clampCursor(text, cursor)
  return { value: text.slice(0, i) + chars + text.slice(i), cursor: i + chars.length }
}

/** Deletes the single character BEFORE the cursor (plain Backspace). A no-op at index 0. */
export function deleteBackward(text: string, cursor: number): { value: string; cursor: number } {
  const i = clampCursor(text, cursor)
  if (i === 0) return { value: text, cursor: 0 }
  return { value: text.slice(0, i - 1) + text.slice(i), cursor: i - 1 }
}

/** Deletes the single character AT the cursor (forward delete). A no-op at end of text. */
export function deleteForward(text: string, cursor: number): { value: string; cursor: number } {
  const i = clampCursor(text, cursor)
  if (i >= text.length) return { value: text, cursor: i }
  return { value: text.slice(0, i) + text.slice(i + 1), cursor: i }
}

/** Deletes from prevWordBoundary up to the cursor (Ctrl+W / Ctrl+Backspace). */
export function deleteWordBackward(text: string, cursor: number): { value: string; cursor: number } {
  const i = clampCursor(text, cursor)
  const start = prevWordBoundary(text, i)
  if (start === i) return { value: text, cursor: i }
  return { value: text.slice(0, start) + text.slice(i), cursor: start }
}

/** Windows Terminal delivers plain Backspace as DEL (0x7f, which Ink's vendored parser
 *  names 'delete') and Ctrl+Backspace as BS (0x08, which it names 'backspace'), so on WT
 *  the two ARE distinguishable and Ctrl+Backspace can be bound to delete-word-backward.
 *  Other hosts — notably legacy conhost — send 0x08 for PLAIN Backspace, where the exact
 *  same test would silently turn every single Backspace into a word delete. That failure
 *  is bad enough (and unverifiable from inside the app) that the binding is gated on
 *  WT_SESSION rather than assumed; everywhere else Ctrl+Backspace simply degrades to an
 *  ordinary Backspace and Ctrl+W remains the portable word-delete. */
export function isWordBackspaceKey(
  key: { backspace: boolean; delete: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.WT_SESSION !== undefined && key.backspace && !key.delete
}
