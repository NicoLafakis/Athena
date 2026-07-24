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
        modelKey: 'sonnet',
        provider: 'anthropic' as const,
        effort: 'high',
        mode: 'normal' as const,
        contextPct: 0,
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
  stdin.write('\r') // return key must arrive as its own input event
  await delay(10)
}

describe('/tui fullscreen | classic', () => {
  it('/tui fullscreen is a non-fatal no-op off a non-TTY stream (ink-testing-library stdout has no isTTY)', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/tui fullscreen')
    expect(lastFrame()).toContain('interactive terminal')
    expect(props.onSlash).not.toHaveBeenCalled()
  })

  it('/tui classic is always accepted (never forwarded to onSlash, no engine involvement)', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/tui classic')
    expect(lastFrame()).toContain('Classic mode restored')
    expect(props.onSlash).not.toHaveBeenCalled()
  })

  it('an invalid /tui argument surfaces through the existing parse-error path', async () => {
    const { props } = makeHarness()
    const { stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, '/tui bogus')
    expect(props.onSlash).toHaveBeenCalledWith({ kind: 'error', value: 'Usage: /tui <fullscreen|classic>' })
  })
})
