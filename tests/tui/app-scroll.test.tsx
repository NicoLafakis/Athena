// tests/tui/app-scroll.test.tsx — fullscreen transcript scrolling. Fullscreen swaps to the
// alternate screen buffer (see fullscreen.ts), which throws away the terminal's native
// scrollback, so without these bindings there is no way at all to see earlier turns. The
// invariant this file protects is the one App.tsx's whole row-budget system exists for:
// scrolling may only ever move which entries the (overflow="hidden") Transcript renders —
// it must never let the pinned Banner/InputBox/StatusLine chrome move, and it must never
// widen the frame past the terminal's real row count, since Ink/Yoga corrupts an
// over-tall frame rather than clipping it.
//
// Driving Ink's own render() with hand-built TTY stream doubles (rather than
// ink-testing-library's, which never set .isTTY and so can't reach fullscreen) mirrors
// tests/tui/fullscreen-overflow.test.tsx.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ReactNode } from 'react'
import { render as inkRender } from 'ink'
import { App, PermissionBridge } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'

const PAGE_UP = '\u001B[5~'
const PAGE_DOWN = '\u001B[6~'
const CTRL_PAGE_UP = '\u001B[5;5~'
const CTRL_PAGE_DOWN = '\u001B[6;5~'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeProps() {
  const bus = new EngineEventBus()
  return {
    bus,
    status: {
      cwd: 'C:/proj',
      gitBranch: 'main',
      model: 'kimi-k2.7-code',
      modelKey: 'kimi-k2.7-code',
      provider: 'kimi' as const,
      effort: 'high',
      mode: 'normal' as const,
      contextPct: 0,
    },
    onSubmit: vi.fn(async () => {}),
    onSlash: vi.fn(),
    onAbort: vi.fn(),
    permissionBridge: new PermissionBridge(),
  }
}

class TtyStdout extends EventEmitter {
  isTTY = true
  frames: string[] = []
  write = (frame: string): boolean => {
    this.frames.push(frame)
    return true
  }
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
}

class TtyStderr extends EventEmitter {
  write = (): boolean => true
}

class TtyStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
  write = (data: string): void => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
}

function renderOnTty(
  node: ReactNode,
  rows: number,
  columns = 80,
): { stdout: TtyStdout; stdin: TtyStdin } {
  const stdout = new TtyStdout(columns, rows)
  const stdin = new TtyStdin()
  const stderr = new TtyStderr()
  inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return { stdout, stdin }
}

/** The most recently written frame — the settled render, not the union of every frame. */
function lastFrame(stdout: TtyStdout): string {
  return stdout.frames.at(-1) ?? ''
}

/** Emits `count` single-line assistant messages, each its own transcript entry (an 'info'
 *  event appends a fresh system entry every time, whereas 'assistant-text' would extend
 *  one growing entry — see App.tsx's reduceEvent). */
async function seedEntries(bus: EngineEventBus, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    bus.emit({ type: 'info', message: `msg-${i}` })
    // Yield between emits: dozens of synchronous setState calls in one tick trip React's
    // nested-update guard, which is a property of the test's firehose, not of the app.
    await delay(0)
  }
  await delay(20)
}

describe('fullscreen transcript scrolling', () => {
  it('by default the view is pinned to the tail and shows no scroll notice', async () => {
    const props = makeProps()
    const { stdout } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 40)

    const frame = lastFrame(stdout)
    expect(frame).toContain('msg-40')
    expect(frame).not.toContain('msg-1\n')
    expect(frame).not.toContain('scrolled')
  })

  it('PageUp reveals earlier entries and marks the view as scrolled', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 40)
    expect(lastFrame(stdout)).toContain('msg-40')

    stdin.write(PAGE_UP)
    await delay(20)

    const frame = lastFrame(stdout)
    expect(frame).not.toContain('msg-40')
    expect(frame).toContain('scrolled')
    expect(frame).toContain('more below')
  })

  it('PageDown walks back toward the tail and drops the notice once it arrives', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 40)

    stdin.write(PAGE_UP)
    await delay(20)
    expect(lastFrame(stdout)).toContain('scrolled')

    stdin.write(PAGE_DOWN)
    await delay(20)
    stdin.write(PAGE_DOWN)
    await delay(20)

    const frame = lastFrame(stdout)
    expect(frame).toContain('msg-40')
    expect(frame).not.toContain('scrolled')
  })

  it('Ctrl+PageUp jumps to the very top, Ctrl+PageDown back to the live tail', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 40)

    stdin.write(CTRL_PAGE_UP)
    await delay(20)
    expect(lastFrame(stdout)).toContain('msg-1')
    expect(lastFrame(stdout)).not.toContain('msg-40')

    stdin.write(CTRL_PAGE_DOWN)
    await delay(20)
    expect(lastFrame(stdout)).toContain('msg-40')
    expect(lastFrame(stdout)).not.toContain('scrolled')
  })

  it('auto-follow: while pinned, new messages keep the view at the tail', async () => {
    const props = makeProps()
    const { stdout } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 20)

    props.bus.emit({ type: 'info', message: 'fresh-arrival' })
    await delay(20)
    expect(lastFrame(stdout)).toContain('fresh-arrival')
  })

  it('while scrolled up, a new message does NOT yank the view down to it', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 40)

    stdin.write(CTRL_PAGE_UP)
    await delay(20)
    const beforeArrival = lastFrame(stdout)
    expect(beforeArrival).toContain('msg-1')

    props.bus.emit({ type: 'info', message: 'fresh-arrival' })
    await delay(20)

    const frame = lastFrame(stdout)
    expect(frame).toContain('msg-1') // still parked where the user left it
    expect(frame).not.toContain('fresh-arrival')
    expect(frame).toContain('scrolled')
  })

  it('the pinned chrome never scrolls and the frame never outgrows the terminal', async () => {
    const rows = 20
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
    await delay(10)
    await seedEntries(props.bus, 60)

    for (const key of [PAGE_UP, PAGE_UP, CTRL_PAGE_UP, PAGE_DOWN]) {
      stdin.write(key)
      await delay(20)
      const frame = lastFrame(stdout)
      expect(frame).toContain('ATHENA') // Banner (header) stays put
      expect(frame).toContain('C:/proj') // StatusLine (footer) stays put
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    }
  })

  it('reaches the middle of an entry taller than the screen', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    // One 30-line assistant entry (a single emit stays a single entry), then singles.
    props.bus.emit({
      type: 'assistant-text',
      delta: Array.from({ length: 30 }, (_, i) => `tall-line-${i + 1}`).join('\n'),
    })
    await delay(20)
    await seedEntries(props.bus, 10)

    const tail = lastFrame(stdout)
    expect(tail).toContain('msg-10')
    expect(tail).not.toContain('tall-line-15')

    stdin.write(PAGE_UP)
    await delay(20)

    const frame = lastFrame(stdout)
    // The middle of the tall entry — structurally unreachable with entry-granular windows.
    expect(frame).toContain('tall-line-15')
    expect(frame).toContain('C:/proj') // pinned chrome stays put
    expect(frame.split('\n').length).toBeLessThanOrEqual(20)
  })

  it('keeps the first visible row fixed while the visible streaming entry grows below it', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    props.bus.emit({
      type: 'assistant-text',
      delta: Array.from({ length: 40 }, (_, i) => `stream-line-${i + 1}`).join('\n'),
    })
    await delay(20)

    stdin.write(PAGE_UP)
    await delay(20)
    const before = lastFrame(stdout)
    const visible = before.match(/stream-line-\d+/g) ?? []
    expect(visible.length).toBeGreaterThan(0)
    expect(before).toContain('scrolled')

    props.bus.emit({ type: 'assistant-text', delta: '\nstream-line-41\nstream-line-42' })
    await delay(20)

    const after = lastFrame(stdout)
    expect(after.match(/stream-line-\d+/g)?.[0]).toBe(visible[0])
    expect(after).not.toContain('stream-line-41')
    expect(after).toContain('C:/proj')
  })

  it('/clear resets a stale scroll anchor instead of leaving it pointing at gone entries', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 40)

    stdin.write(CTRL_PAGE_UP)
    await delay(20)
    expect(lastFrame(stdout)).toContain('scrolled')

    stdin.write('/clear')
    await delay(20)
    stdin.write('\r')
    await delay(30)

    const frame = lastFrame(stdout)
    expect(frame).not.toContain('msg-1')
    expect(frame).not.toContain('scrolled')
    expect(frame).toContain('Screen cleared')
  })

  it('a resize re-clamps rather than leaving the window pinned to a now-impossible budget', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 20, 80)
    await delay(10)
    await seedEntries(props.bus, 40)

    stdin.write(PAGE_UP)
    await delay(20)
    expect(lastFrame(stdout)).toContain('scrolled')

    stdout.rows = 10
    stdout.emit('resize')
    await delay(20)

    const frame = lastFrame(stdout)
    expect(frame.split('\n').length).toBeLessThanOrEqual(10)
    expect(frame).toContain('C:/proj')
  })
})
