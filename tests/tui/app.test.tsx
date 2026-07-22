import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { App, PermissionBridge, reduceEvent } from '../../src/tui/App.js'
import type { TranscriptEntry } from '../../src/tui/components/Transcript.js'
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

  it('/clear wipes the transcript display and notes that context is unchanged', async () => {
    const { bus, props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    bus.emit({ type: 'assistant-text', delta: 'old transcript content' })
    await delay(10)
    expect(lastFrame()).toContain('old transcript content')
    stdin.write('/clear')
    await delay(5)
    stdin.write('\r')
    await delay(10)
    expect(lastFrame()).not.toContain('old transcript content')
    expect(lastFrame()).toContain('context is unchanged')
  })

  it('todo-update event renders the checklist panel', async () => {
    const { bus, props } = makeHarness()
    const { lastFrame } = render(<App {...props} />)
    await delay(0) // let React flush useEffect so the bus subscription exists
    bus.emit({ type: 'todo-update', todos: [{ text: 'write tests', status: 'in_progress' }] })
    await delay(10)
    expect(lastFrame()).toContain('write tests')
  })

  it('status events update the status line live (mode changes without remount)', async () => {
    const { bus, props } = makeHarness()
    const { lastFrame } = render(<App {...props} />)
    await delay(0) // let React flush useEffect so the bus subscription exists
    expect(lastFrame()).toContain('normal')
    bus.emit({ type: 'status', patch: { mode: 'trusted' } })
    await delay(10)
    expect(lastFrame()).toContain('trusted')
    expect(lastFrame()).not.toContain('normal')
  })
})

describe('reduceEvent', () => {
  it('returns the transcript array unchanged for a status event (no transcript entry)', () => {
    const prev: TranscriptEntry[] = [{ kind: 'assistant', text: 'hi' }]
    const next = reduceEvent(prev, { type: 'status', patch: { mode: 'trusted', contextPct: 42 } })
    expect(next).toBe(prev) // same reference: status is purely a status-line concern
    expect(next).toEqual([{ kind: 'assistant', text: 'hi' }])
  })
})
