import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { App, PermissionBridge } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'

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
        model: 'mock',
        mode: 'normal' as const,
        contextPct: 0,
      },
      // Never resolves: the turn stays busy for the whole test.
      onSubmit: vi.fn(() => new Promise<void>(() => {})),
      onSlash: vi.fn(),
      onAbort: vi.fn(),
      permissionBridge: new PermissionBridge(),
    },
  }
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  stdin.write(text)
  await delay(5)
  stdin.write('\r') // return key must arrive as its own input event
  await delay(10)
}

describe('busy-turn slash guard', () => {
  it('rejects /compact and /model while a turn is running, without calling onSlash', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, 'do work')
    await type(stdin, '/compact')
    expect(props.onSlash).not.toHaveBeenCalled()
    expect(lastFrame()!.toLowerCase()).toContain('esc')
    await type(stdin, '/model claude-opus-4-6')
    expect(props.onSlash).not.toHaveBeenCalled()
  })

  it('typing a second prompt while a turn is busy is a no-op (no second runTurn)', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, 'first prompt')
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
    await type(stdin, 'second prompt')
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('still forwards /compact when idle', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/compact')
    expect(props.onSlash).toHaveBeenCalledWith({ kind: 'compact' })
  })
})
