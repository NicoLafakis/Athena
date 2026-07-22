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
        contextPct: 12,
      },
      onSubmit: vi.fn(async () => {}),
      onSlash: vi.fn(),
      onAbort: vi.fn(),
      permissionBridge: new PermissionBridge(),
    },
  }
}

describe('App', () => {
  it('renders the status line and input box', () => {
    const { props } = makeHarness()
    const { lastFrame } = render(<App {...props} />)
    expect(lastFrame()).toContain('C:/proj')
    expect(lastFrame()).toContain('main')
    expect(lastFrame()).toContain('normal')
  })

  it('streams assistant text from engine events into the transcript', async () => {
    const { bus, props } = makeHarness()
    const { lastFrame } = render(<App {...props} />)
    await delay(0) // let React flush useEffect so the bus subscription exists
    bus.emit({ type: 'assistant-text', delta: 'Hello from Athena' })
    await delay(10)
    expect(lastFrame()).toContain('Hello from Athena')
  })

  it('permission dialog renders on request and answers flow back', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0) // let React flush useEffect so the bridge is bound
    const answer = props.permissionBridge.ask({
      toolName: 'Bash',
      input: { command: 'git push' },
      summary: 'Bash(git push)',
      reason: 'mutating',
    })
    await delay(10)
    expect(lastFrame()).toContain('git push')
    expect(lastFrame()).toMatch(/allow once/i)
    stdin.write('y') // 'y' = allow once
    await expect(answer).resolves.toBe('allow-once')
  })

  it('todo-update event renders the checklist panel', async () => {
    const { bus, props } = makeHarness()
    const { lastFrame } = render(<App {...props} />)
    await delay(0) // let React flush useEffect so the bus subscription exists
    bus.emit({ type: 'todo-update', todos: [{ text: 'write tests', status: 'in_progress' }] })
    await delay(10)
    expect(lastFrame()).toContain('write tests')
  })
})
