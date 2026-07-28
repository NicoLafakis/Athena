// tests/tui/input-box-cursor.test.tsx — component-level coverage for the InputBox's real
// cursor: every pre-existing mutation path (typing, backspace, submit, history recall,
// @-mention insertion, "/" completion) had assumed the cursor was at value.length, so the
// point of these tests is less "does Left move left" and more "does each of those paths
// still agree with the cursor after an edit made somewhere OTHER than the end". The
// escape sequences below are the xterm CSI encodings Ink's vendored parser expects, which
// is also what Windows Terminal emits.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { InputBox } from '../../src/tui/components/InputBox.js'

const LEFT = '[D'
const RIGHT = '[C'
const CTRL_LEFT = '[1;5D'
const CTRL_RIGHT = '[1;5C'
const ALT_LEFT = '[1;3D'
const ALT_RIGHT = '[1;3C'
const ESC_B = 'b'
const ESC_F = 'f'
const CTRL_A = ''
const CTRL_E = ''
const CTRL_W = ''
const CTRL_D = ''
const BACKSPACE = ''
const UP = '[A'
const DOWN = '[B'
const ENTER = '\r'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), 'athena-inputbox-cursor-'))
}

/** Mounts an InputBox, types `seed`, then replays `keys`, and returns whatever a final
 *  Enter submits — the only lossless way to read the buffer back out, since the rendered
 *  frame carries ANSI cursor markup. */
async function typeThenSubmit(seed: string, keys: string[]): Promise<string> {
  const onSubmit = vi.fn()
  const dir = makeCwd()
  try {
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    if (seed) stdin.write(seed)
    await delay(10)
    for (const k of keys) {
      stdin.write(k)
      await delay(5)
    }
    stdin.write(ENTER)
    await delay(10)
    return (onSubmit.mock.calls.at(-1)?.[0] as string) ?? ''
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('InputBox character motion', () => {
  it('Left moves the insertion point back, so typing lands mid-string', async () => {
    expect(await typeThenSubmit('hello', [LEFT, LEFT, 'X'])).toBe('helXlo')
  })

  it('Right moves it forward again', async () => {
    expect(await typeThenSubmit('hello', [LEFT, LEFT, RIGHT, 'X'])).toBe('hellXo')
  })

  it('Left clamps at the start and Right at the end', async () => {
    expect(await typeThenSubmit('ab', [LEFT, LEFT, LEFT, LEFT, 'X'])).toBe('Xab')
    expect(await typeThenSubmit('ab', [LEFT, RIGHT, RIGHT, RIGHT, 'X'])).toBe('abX')
  })

  it('Backspace deletes the character before the cursor, not the last one typed', async () => {
    expect(await typeThenSubmit('abcd', [LEFT, LEFT, BACKSPACE])).toBe('acd')
  })
})

describe('InputBox word motion', () => {
  it('Ctrl+Left jumps to the start of the previous word', async () => {
    expect(await typeThenSubmit('foo bar baz', [CTRL_LEFT, 'X'])).toBe('foo bar Xbaz')
  })

  it('repeated Ctrl+Left walks word by word', async () => {
    expect(await typeThenSubmit('foo bar baz', [CTRL_LEFT, CTRL_LEFT, 'X'])).toBe('foo Xbar baz')
  })

  it('Ctrl+Right jumps to the end of the next word', async () => {
    expect(await typeThenSubmit('foo bar baz', [CTRL_LEFT, CTRL_LEFT, CTRL_RIGHT, 'X'])).toBe('foo barX baz')
  })

  it('Alt+Left / Alt+Right are accepted as word-motion aliases', async () => {
    expect(await typeThenSubmit('foo bar baz', [ALT_LEFT, 'X'])).toBe('foo bar Xbaz')
    expect(await typeThenSubmit('foo bar baz', [ALT_LEFT, ALT_LEFT, ALT_RIGHT, 'X'])).toBe('foo barX baz')
  })

  it('the readline-style ESC-b / ESC-f encoding works too', async () => {
    expect(await typeThenSubmit('foo bar baz', [ESC_B, 'X'])).toBe('foo bar Xbaz')
    expect(await typeThenSubmit('foo bar baz', [ESC_B, ESC_B, ESC_F, 'X'])).toBe('foo barX baz')
  })

  it('Ctrl+W deletes the word behind the cursor', async () => {
    expect(await typeThenSubmit('foo bar baz', [CTRL_W])).toBe('foo bar ')
  })

  it('Ctrl+W mid-string keeps everything after the cursor', async () => {
    expect(await typeThenSubmit('foo bar baz', [CTRL_LEFT, CTRL_W])).toBe('foo baz')
  })
})

describe('InputBox line motion and forward delete', () => {
  it('Ctrl+A / Ctrl+E go to start and end of the input', async () => {
    expect(await typeThenSubmit('hello', [CTRL_A, 'X'])).toBe('Xhello')
    expect(await typeThenSubmit('hello', [CTRL_A, CTRL_E, 'X'])).toBe('helloX')
  })

  it('Ctrl+A / Ctrl+E respect \\n boundaries in a multi-line (backslash-continued) input', async () => {
    // "one\" + Enter continues onto a second line; the cursor then sits on line 2.
    expect(await typeThenSubmit('one\\', [ENTER, 'two', CTRL_A, 'X'])).toBe('one\nXtwo')
    expect(await typeThenSubmit('one\\', [ENTER, 'two', CTRL_A, CTRL_E, 'X'])).toBe('one\ntwoX')
  })

  it('Ctrl+D forward-deletes the character at the cursor', async () => {
    expect(await typeThenSubmit('abcd', [CTRL_A, CTRL_D])).toBe('bcd')
    expect(await typeThenSubmit('abcd', [LEFT, CTRL_D])).toBe('abc')
  })

  it('plain Backspace is never treated as a forward delete', async () => {
    expect(await typeThenSubmit('abcd', [BACKSPACE])).toBe('abc')
  })
})

describe('InputBox cursor across the other edit paths', () => {
  it('history recall places the cursor at the end of the recalled text', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('first')
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    stdin.write(UP) // recall "first"
    await delay(10)
    stdin.write('!') // must append, not insert at 0
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    expect(onSubmit).toHaveBeenLastCalledWith('first!')
    rmSync(dir, { recursive: true, force: true })
  })

  it('history recall resets a cursor left mid-string by the previous edit', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('alpha')
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    stdin.write('bb')
    await delay(10)
    stdin.write(LEFT) // cursor mid-draft
    await delay(5)
    stdin.write(UP) // recall "alpha"
    await delay(10)
    stdin.write(DOWN) // back to the draft
    await delay(10)
    stdin.write('Z')
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    expect(onSubmit).toHaveBeenLastCalledWith('bbZ')
    rmSync(dir, { recursive: true, force: true })
  })

  it('submitting resets the cursor, so the next message is not typed into a stale index', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('hello')
    await delay(10)
    stdin.write(LEFT)
    await delay(5)
    stdin.write(LEFT)
    await delay(5)
    stdin.write(ENTER)
    await delay(10)
    stdin.write('next')
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    expect(onSubmit).toHaveBeenNthCalledWith(1, 'hello')
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'next')
    rmSync(dir, { recursive: true, force: true })
  })

  it('a "/" completion leaves the cursor after the inserted token', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/clear')
    await delay(10)
    stdin.write('\t') // completes to "/clear " and closes the menu
    await delay(10)
    stdin.write('now')
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/clear now')
    rmSync(dir, { recursive: true, force: true })
  })

  it('cursor motion dismisses the live "/" menu, keeping the typed text literal', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/mo')
    await delay(10)
    expect(lastFrame()).toContain('select, Tab/Enter confirm')
    stdin.write(LEFT)
    await delay(10)
    expect(lastFrame()).not.toContain('select, Tab/Enter confirm')
    stdin.write('X')
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/mXo')
    rmSync(dir, { recursive: true, force: true })
  })

  it('a "@" typed mid-string does not arm the mention popup (it would swallow the rest of the line)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('hello world')
    await delay(10)
    stdin.write(CTRL_A)
    await delay(5)
    stdin.write('@')
    await delay(20)
    expect(lastFrame()).not.toContain('Esc cancel')
    stdin.write(ENTER)
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('@hello world')
    rmSync(dir, { recursive: true, force: true })
  })
})

// The block cursor is drawn with <Text inverse>, whose SGR codes ink-testing-library
// strips (chalk is at color level 0 under vitest), so the *styling* itself is not
// observable from a frame. What IS observable — and what actually breaks if the three-way
// before/at/after slice in the render is off by one — is the text: a mis-sliced line drops
// or duplicates the character under the cursor. That is what these assert.
describe('InputBox cursor rendering', () => {
  it('renders the line intact with the cursor at the end, in the middle, and at the start', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('abcd')
    await delay(10)
    expect(lastFrame()).toContain('❯ abcd')
    stdin.write(LEFT)
    await delay(10)
    expect(lastFrame()).toContain('❯ abcd')
    stdin.write(CTRL_A)
    await delay(10)
    expect(lastFrame()).toContain('❯ abcd')
    rmSync(dir, { recursive: true, force: true })
  })

  it('renders the cursor on the continuation line of a multi-line input', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('one\\')
    await delay(10)
    stdin.write(ENTER)
    await delay(10)
    stdin.write('two')
    await delay(10)
    const frame = lastFrame()!
    expect(frame).toContain('❯ one')
    expect(frame).toContain('… two')
    stdin.write(CTRL_A) // start of the SECOND line, not of the buffer
    await delay(10)
    expect(lastFrame()).toContain('… two')
    expect(lastFrame()).toContain('❯ one')
    rmSync(dir, { recursive: true, force: true })
  })
it('a disabled box still renders its text (no cursor is drawn)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame } = render(<InputBox onSubmit={onSubmit} disabled cwd={dir} />)
    await delay(10)
    expect(lastFrame()).toContain('❯')
    rmSync(dir, { recursive: true, force: true })
  })
})
