import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { App, PermissionBridge, detectBarePickableCommand } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'

const UP = '[A'
const DOWN = '[B'
const ESC = ''

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeHarness() {
  const bus = new EngineEventBus()
  return {
    bus,
    props: {
      bus,
      status: {
        cwd: 'C:/proj',
        gitBranch: 'main',
        model: 'Sonnet 5',
        modelKey: 'sonnet',
        provider: 'anthropic' as const,
        effort: 'high',
        mode: 'normal' as const,
        contextPct: 12,
      },
      onSubmit: vi.fn(async () => {}),
      onSlash: vi.fn(),
      onAbort: vi.fn(),
      permissionBridge: new PermissionBridge(),
    },
  }
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  stdin.write(text)
  await delay(5)
  stdin.write('\r')
  await delay(10)
}

describe('detectBarePickableCommand', () => {
  it('matches each of the 5 bare pickable command names', () => {
    expect(detectBarePickableCommand('/model')).toBe('model')
    expect(detectBarePickableCommand('/provider')).toBe('provider')
    expect(detectBarePickableCommand('/effort')).toBe('effort')
    expect(detectBarePickableCommand('/mode')).toBe('mode')
    expect(detectBarePickableCommand('/tui')).toBe('tui')
  })

  it('allows surrounding whitespace only', () => {
    expect(detectBarePickableCommand('  /model  ')).toBe('model')
    expect(detectBarePickableCommand('/model\n')).toBe('model')
  })

  it('returns null when an argument follows', () => {
    expect(detectBarePickableCommand('/model opus')).toBeNull()
    expect(detectBarePickableCommand('/mode plan')).toBeNull()
  })

  it('returns null for non-pickable bare commands', () => {
    expect(detectBarePickableCommand('/compact')).toBeNull()
    expect(detectBarePickableCommand('/help')).toBeNull()
    expect(detectBarePickableCommand('/clear')).toBeNull()
  })

  it('returns null for non-slash text', () => {
    expect(detectBarePickableCommand('model')).toBeNull()
    expect(detectBarePickableCommand('')).toBeNull()
  })

  it('is case-sensitive, mirroring parseSlash', () => {
    expect(detectBarePickableCommand('/Model')).toBeNull()
    expect(detectBarePickableCommand('/MODE')).toBeNull()
  })
})

describe('App: bare pickable-command picker', () => {
  it('typing "/model" and Enter opens the picker instead of dispatching onSlash', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/model')
    expect(props.onSlash).not.toHaveBeenCalled()
    const frame = lastFrame()!
    expect(frame).toContain('Select model')
    expect(frame).toContain('↑/↓ select, Enter confirm, Esc cancel')
  })

  it('marks the current model as pre-selected via the leading marker', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/model')
    const frame = lastFrame()!
    // status.modelKey is 'sonnet' -> modelLabel(anthropic, 'sonnet') = 'Sonnet 5'.
    expect(frame).toMatch(/●\s*Sonnet 5/)
  })

  it('Escape cancels the picker without dispatching onSlash', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/model')
    stdin.write(ESC)
    await delay(10)
    expect(lastFrame()).not.toContain('Select model')
    expect(props.onSlash).not.toHaveBeenCalled()
  })

  it('Down then Enter confirms the next option and dispatches onSlash({kind:"model", value})', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/model')
    stdin.write(DOWN)
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(props.onSlash).toHaveBeenCalledTimes(1)
    const call = (props.onSlash as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(call?.kind).toBe('model')
    expect(call?.value).not.toBe('sonnet') // moved off the pre-selected row
  })

  it('Up clamps at the first option rather than wrapping or going negative', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/model') // pre-selects 'sonnet' at index 1
    stdin.write(UP) // -> index 0 (haiku)
    await delay(10)
    stdin.write(UP) // already at 0: clamps
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(props.onSlash).toHaveBeenCalledWith({ kind: 'model', value: 'haiku' })
  })

  it('/provider bare opens the provider picker and Enter dispatches onSlash({kind:"provider", value})', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/provider')
    expect(lastFrame()).toContain('Select provider')
    stdin.write('\r') // Enter on the pre-selected (current) row: anthropic
    await delay(10)
    expect(props.onSlash).toHaveBeenCalledWith({ kind: 'provider', value: 'anthropic' })
  })

  it('/effort bare opens the effort picker and Enter dispatches onSlash({kind:"effort", value})', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/effort')
    stdin.write('\r')
    await delay(10)
    expect(props.onSlash).toHaveBeenCalledWith({ kind: 'effort', value: 'high' })
  })

  it('/mode bare opens the mode picker and Enter dispatches onSlash({kind:"mode", value})', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    stdin.write('/mode')
    await delay(10)
    // Catalog order for query "mode": 'model' also prefix-matches and sorts first (pre-
    // existing filterSlashCommands property, unrelated to this feature). With 2 matches
    // still live, Enter alone won't hand off (nothingLeftToComplete needs a single
    // match) — one Down reaches 'mode', then Tab hands off regardless of ambiguity
    // (mirrors the InputBox-level "/mode" test in input-box-arg-picker.test.tsx).
    stdin.write(DOWN)
    await delay(10)
    stdin.write('\t')
    await delay(10)
    expect(props.onSlash).not.toHaveBeenCalled() // that hand-off opened the picker, didn't dispatch yet
    stdin.write('\r') // confirm the pre-selected (current) row: normal
    await delay(10)
    expect(props.onSlash).toHaveBeenCalledWith({ kind: 'mode', value: 'normal' })
  })

  it('/tui bare opens the picker and Enter applies fullscreen mode locally (no onSlash dispatch)', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/tui')
    expect(lastFrame()).toContain('Select TUI mode')
    stdin.write(DOWN) // classic (current) -> fullscreen
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(props.onSlash).not.toHaveBeenCalled()
  })

  it('an explicit argument bypasses the picker entirely ("/model opus" still goes through parseSlash/onSlash)', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/model opus')
    expect(props.onSlash).toHaveBeenCalledWith({ kind: 'model', value: 'opus' })
  })

  it('a turn cannot be started while the picker is open (InputBox itself goes inert)', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/model') // opens the picker
    expect(lastFrame()).toContain('Select model')
    // Ordinary typed characters must not leak into InputBox's own value while the
    // picker owns Up/Down/Enter/Esc (disabled={... || argPicker !== null}) — otherwise
    // a stray keystroke here would submit a bogus turn the moment the picker closes.
    stdin.write('hello')
    await delay(10)
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(lastFrame()).toContain('Select model') // picker still owns the screen
  })

  it('never opens while a turn is busy (InputBox disables itself before handleSubmit can run)', async () => {
    const { props } = makeHarness()
    props.onSubmit = vi.fn(() => new Promise<void>(() => {})) // never resolves: stays busy
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, 'do work') // starts a turn, flips busy true
    // InputBox disables itself while busy, so no further keystrokes reach handleSubmit —
    // this is the same invariant relied on for the existing compact/model/provider guard
    // (see busy-slash-guard.test.tsx) and for why the picker can never open while busy.
    await type(stdin, '/model')
    expect(lastFrame()).not.toContain('Select model')
  })
})
