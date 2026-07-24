import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { InputBox } from '../../src/tui/components/InputBox.js'
import type { CustomCommandDef } from '../../src/tui/slash.js'

const UP = '[A'
const DOWN = '[B'
const ESC = ''

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), 'athena-inputbox-slashmenu-'))
}

describe('InputBox live "/" command menu', () => {
  it('typing bare "/" as the first character opens the menu, listing built-ins with descriptions', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0) // let React flush useEffect so the useInput listener is mounted
    stdin.write('/')
    await delay(10)
    const frame = lastFrame()!
    expect(frame).toContain('/help')
    expect(frame).toContain('Show available commands')
    expect(frame).toContain('/clear')
    rmSync(dir, { recursive: true, force: true })
  })

  it('typing more characters filters the menu live', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/')
    await delay(10)
    stdin.write('mo')
    await delay(10)
    const frame = lastFrame()!
    // 'mo' prefix-matches both 'model' and 'mode' (not 'mode' swallowing 'model' or
    // vice versa) — asserted via each entry's description, which is unambiguous.
    expect(frame).toContain('Switch the active model')
    expect(frame).toContain('Set permission mode')
    expect(frame).not.toContain('Show available commands') // 'help' filtered out
    expect(frame).not.toContain('Clear the transcript') // 'clear' filtered out
    rmSync(dir, { recursive: true, force: true })
  })

  it('a "/" that is not the first character of the input never opens the menu', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('hi /not-a-menu')
    await delay(10)
    const frame = lastFrame()!
    expect(frame).not.toContain('select, Tab/Enter confirm')
    expect(frame).toContain('hi /not-a-menu')
    rmSync(dir, { recursive: true, force: true })
  })

  it('arrow keys move the highlight, and Tab fills the input with a trailing space without submitting (non-pickable command)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/c')
    await delay(10)
    // Catalog order for prefix 'c': clear, compact — both non-pickable, so Tab still
    // fills text and waits rather than auto-submitting (see the dedicated arg-picker
    // test file for the pickable-command Tab behavior).
    stdin.write(DOWN)
    await delay(10)
    stdin.write('\t') // Tab confirms the highlighted entry
    await delay(10)
    expect(onSubmit).not.toHaveBeenCalled()
    stdin.write('\r') // submit now, to inspect what Tab actually left in the box
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/compact ')
    rmSync(dir, { recursive: true, force: true })
  })

  it('Up then Down cancel out, leaving the top match selected (non-pickable command)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/m')
    await delay(10)
    // Catalog order for prefix 'm': memory, model, mode. 'memory' (top match) is not
    // pickable, so this still exercises the "Tab fills, doesn't submit" path.
    stdin.write(UP) // already at index 0, clamps
    await delay(5)
    stdin.write(DOWN)
    await delay(5)
    stdin.write(UP) // back to index 0 ('memory')
    await delay(5)
    stdin.write('\t')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/memory ')
    rmSync(dir, { recursive: true, force: true })
  })

  it('Escape cancels the menu, keeping the typed text as literal input', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/mo')
    await delay(10)
    expect(lastFrame()).toContain('select, Tab/Enter confirm')
    stdin.write(ESC)
    await delay(10)
    expect(lastFrame()).not.toContain('select, Tab/Enter confirm')
    expect(lastFrame()).toContain('/mo')
    stdin.write(' extra')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/mo extra')
    rmSync(dir, { recursive: true, force: true })
  })

  it('after Escape, continuing to type more of the same word does not reopen the menu', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/mo')
    await delay(10)
    stdin.write(ESC)
    await delay(10)
    stdin.write('del') // continues the same word: "/model", no fresh leading '/'
    await delay(10)
    expect(lastFrame()).not.toContain('select, Tab/Enter confirm')
    expect(lastFrame()).toContain('/model')
    rmSync(dir, { recursive: true, force: true })
  })

  it('typing a space while filtering ends the menu without selecting anything', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/mo')
    await delay(10)
    stdin.write(' ')
    await delay(10)
    expect(lastFrame()).not.toContain('select, Tab/Enter confirm')
    stdin.write('x')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/mo x')
    rmSync(dir, { recursive: true, force: true })
  })

  it('a fully-typed, unambiguous command submits directly on Enter (no double-Enter needed)', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/clear')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/clear')
    rmSync(dir, { recursive: true, force: true })
  })

  it('Tab on that same unambiguous command still completes (adds a trailing space) rather than submitting', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(0)
    stdin.write('/clear')
    await delay(10)
    stdin.write('\t')
    await delay(10)
    expect(onSubmit).not.toHaveBeenCalled()
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('/clear ')
    rmSync(dir, { recursive: true, force: true })
  })

  it('unions in a custom command, filtered into view by its own prefix', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const commands = new Map<string, CustomCommandDef>([
      ['standup', { description: 'Write a standup update.', template: '...' }],
      ['myplugin:deploy', { description: 'Deploy the thing.', template: '...' }],
    ])
    const { lastFrame, stdin } = render(
      <InputBox onSubmit={onSubmit} disabled={false} cwd={dir} commands={commands} />,
    )
    await delay(0)
    stdin.write('/stand')
    await delay(10)
    const frame = lastFrame()!
    expect(frame).toContain('/standup')
    expect(frame).toContain('Write a standup update.')
    expect(frame).not.toContain('[plugin]') // a plain custom command, not plugin-namespaced
    rmSync(dir, { recursive: true, force: true })
  })

  it('visually tags a plugin-namespaced entry, filtered into view by its own prefix', async () => {
    const onSubmit = vi.fn()
    const dir = makeCwd()
    const commands = new Map<string, CustomCommandDef>([
      ['standup', { description: 'Write a standup update.', template: '...' }],
      ['myplugin:deploy', { description: 'Deploy the thing.', template: '...' }],
    ])
    const { lastFrame, stdin } = render(
      <InputBox onSubmit={onSubmit} disabled={false} cwd={dir} commands={commands} />,
    )
    await delay(0)
    stdin.write('/myplugin')
    await delay(10)
    const frame = lastFrame()!
    expect(frame).toContain('/myplugin:deploy')
    expect(frame).toContain('[plugin]')
    rmSync(dir, { recursive: true, force: true })
  })
})
