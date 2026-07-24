import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { InputBox } from '../../src/tui/components/InputBox.js'

const UP = '[A'
const DOWN = '[B'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), 'athena-inputbox-argpicker-'))
}

describe('InputBox: pickable slash commands hand off to the arg picker', () => {
  it.each(['model', 'provider', 'effort', 'tui'])(
    'Tab-selecting bare "/%s" from the menu submits immediately, with no trailing space',
    async (name) => {
      const onSubmit = vi.fn()
      const dir = makeCwd()
      const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
      await delay(0)
      stdin.write(`/${name}`)
      await delay(10)
      stdin.write('\t') // Tab, with only one exact match highlighted
      await delay(10)
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(onSubmit).toHaveBeenCalledWith(`/${name}`)
      rmSync(dir, { recursive: true, force: true })
    },
  )

  it('Tab-selecting "/mode" (whose prefix "mode" also matches "model", so it is not the top match) still auto-submits once reached', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/mode')
    await delay(10)
    // Catalog order for query "mode": 'model' also prefix-matches ("model".startsWith
    // ("mode")), and sorts first — pre-existing property of filterSlashCommands, not
    // something this feature changes. One Down reaches the actual 'mode' entry.
    stdin.write(DOWN)
    await delay(10)
    stdin.write('\t')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('/mode')
    rmSync(dir, { recursive: true, force: true })
  })

  it('clears the input and closes the menu on pickable auto-submit (does not leave "/model" sitting in the box)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/model')
    await delay(10)
    stdin.write('\t')
    await delay(10)
    expect(lastFrame()).not.toContain('select, Tab/Enter confirm')
    // The box itself should be back to just the prompt caret, no leftover "/model".
    expect(lastFrame()!.replace(/\s/g, '')).toBe('❯')
    rmSync(dir, { recursive: true, force: true })
  })

  it('Enter on an already-exact, unambiguous pickable command also hands off immediately (single Enter, no double)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/effort')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('/effort')
    rmSync(dir, { recursive: true, force: true })
  })

  it('a pickable command typed with an explicit argument bypasses the picker hand-off entirely', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/model opus')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('/model opus')
    rmSync(dir, { recursive: true, force: true })
  })

  it('recalling a pickable command from history and pressing Enter hands off the same way', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/effort')
    await delay(10)
    stdin.write('\r') // first submission, exact unambiguous match, hands off directly
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    stdin.write(UP) // Up-arrow: recall "/effort" from history
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit).toHaveBeenNthCalledWith(2, '/effort')
    rmSync(dir, { recursive: true, force: true })
  })

  it('regression: a non-pickable command (e.g. /compact) still fills text on Tab rather than auto-submitting', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/compact')
    await delay(10)
    stdin.write('\t')
    await delay(10)
    expect(onSubmit).not.toHaveBeenCalled()
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/compact ')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('InputBox: an exact-typed name beats the cursor-highlighted entry (mode/model prefix collision)', () => {
  it('typing "/mode" fully with no arrow-key navigation and pressing Enter hands off /mode, not /model', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    // "model".startsWith('mode') is true, so 'model' (catalog index 0) also prefix-matches
    // the query 'mode' and would sit under the cursor (slashMenu.index === 0, never moved)
    // if exact-name matching didn't take precedence.
    stdin.write('/mode')
    await delay(10)
    stdin.write('\r') // Enter, cursor never touched
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('/mode')
    rmSync(dir, { recursive: true, force: true })
  })

  it('typing "/model" fully with no arrow-key navigation and pressing Enter hands off /model (regression check: unambiguous exact match is unaffected)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    // No collision in this direction: "mode" does not start with "model" (it's shorter),
    // so 'model' is the sole prefix match even before considering exactness.
    stdin.write('/model')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('/model')
    rmSync(dir, { recursive: true, force: true })
  })

  it('Tab on a fully-typed "/mode" with the cursor still at index 0 also resolves to /mode, not /model', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/mode')
    await delay(10)
    // No arrow keys pressed — slashMenu.index is still 0, which without exact-name
    // precedence would resolve to 'model' (catalog index 0) instead of 'mode'.
    stdin.write('\t')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('/mode')
    rmSync(dir, { recursive: true, force: true })
  })
})
