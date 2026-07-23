// tests/tui/fullscreen-default.test.tsx — the new TTY-gated default for `fullscreen`
// (see App.tsx): a real interactive terminal now starts in fullscreen; anything else
// (piped output, CI, ink-testing-library's stdout test double) still starts classic,
// exactly as before.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ReactNode } from 'react'
import { render as inkRender } from 'ink'
import { render as testRender } from 'ink-testing-library'
import { App, PermissionBridge } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from '../../src/tui/fullscreen.js'
import { getVersion } from '../../src/version.js'

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

// Faithful copies of ink-testing-library's internal Stdout/Stdin/Stderr doubles (see
// node_modules/ink-testing-library/build/index.js) — that library's own `render()`
// always builds its own non-TTY Stdout (no `.isTTY` at all) with no option to override
// it, so exercising the "real interactive terminal" branch of the new default requires
// driving Ink's own `render` directly with a hand-built stream trio instead.
class TtyStdout extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  frames: string[] = []
  write = (frame: string): boolean => {
    this.frames.push(frame)
    return true
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

function renderOnTty(node: ReactNode) {
  const stdout = new TtyStdout()
  const stdin = new TtyStdin()
  const stderr = new TtyStderr()
  const instance = inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return { instance, stdout, stdin }
}

async function type(stdin: TtyStdin, text: string): Promise<void> {
  stdin.write(text)
  await delay(5)
  stdin.write('\r')
  await delay(10)
}

describe('default TUI mode is TTY-gated', () => {
  it('defaults to fullscreen on a real TTY: auto-enters the alternate screen and renders the banner', async () => {
    const props = makeProps()
    const { stdout } = renderOnTty(<App {...props} />)
    await delay(10)
    const all = stdout.frames.join('\n')
    // Actually entered (not just state=true): the raw alt-screen escape was written.
    expect(stdout.frames).toContain(ALT_SCREEN_ENTER)
    expect(all).toContain('ATHENA')
    expect(all).toContain(getVersion())
    expect(all).toContain('kimi-k2.7-code')
    expect(all).toContain('C:/proj')
  })

  it('/tui classic still drops back out of the new TTY default, exactly as the toggle always has', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />)
    await delay(10)
    expect(stdout.frames).toContain(ALT_SCREEN_ENTER)
    await type(stdin, '/tui classic')
    const all = stdout.frames.join('\n')
    expect(all).toContain('Classic mode restored')
    expect(stdout.frames).toContain(ALT_SCREEN_EXIT)
  })

  it('defaults to classic on a non-TTY stream (ink-testing-library double): no banner, no alt-screen write', async () => {
    const props = makeProps()
    const { lastFrame } = testRender(<App {...props} />)
    await delay(10)
    expect(lastFrame()).not.toContain('ATHENA')
    expect(lastFrame()).toContain('C:/proj') // classic layout still renders the status line
  })
})
