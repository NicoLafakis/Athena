import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ReactNode } from 'react'
import { render as inkRender } from 'ink'
import { App, PermissionBridge } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'
import type { AgentMentionSource } from '../../src/tui/agentMention.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Enough agents that the '@' picker fills its whole window (and then some, so the
 *  "… N more" notice row is in play too) without depending on a real project file walk —
 *  agent rows resolve synchronously, file rows would not (see agentMention.ts). */
const AGENTS: AgentMentionSource[] = Array.from({ length: 14 }, (_, i) => ({
  name: `agent-${String(i + 1).padStart(2, '0')}`,
  description: `does thing number ${i + 1}`,
}))

function makeProps(cwd = 'C:/proj') {
  const bus = new EngineEventBus()
  return {
    bus,
    status: {
      cwd,
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
    agents: AGENTS,
  }
}

// Same hand-built TTY stream doubles as app-scroll.test.tsx / fullscreen-overflow.test.tsx:
// ink-testing-library's own doubles never set `.isTTY`, so they can't reach fullscreen mode.
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

function renderOnTty(node: ReactNode, rows: number, columns = 80): { stdout: TtyStdout; stdin: TtyStdin; unmount: () => void } {
  const stdout = new TtyStdout(columns, rows)
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
  return { stdout, stdin, unmount: instance.unmount }
}

function lastFrame(stdout: TtyStdout): string {
  return stdout.frames.at(-1) ?? ''
}


function sound(frames: string[], rows: number) {
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    expect(frame).toContain('Permission required')
    expect(frame).toContain('deny')
    expect(frame).toContain('details')
    expect(frame).not.toMatch(/Permission required.*[???]/)
  }
}

describe('permission minimum chrome', () => {
  it.each([[40, 12], [80, 24], [120, 40]])('keeps all frames readable at %sx%s', async (columns, rows) => {
    const props = makeProps('C:/project/' + 'long-directory/'.repeat(15))
    const { stdout, stdin, unmount } = renderOnTty(<App {...props} />, rows!, columns!)
    await delay(30)
    const from = stdout.frames.length
    const answer = props.permissionBridge.ask({ toolName: 'Bash', input: { command: 'echo end' }, summary: 'Summary '.repeat(60), reason: 'Reason '.repeat(60) })
    await delay(35)
    sound(stdout.frames.slice(from), rows!)
    stdin.write('n')
    await expect(answer).resolves.toBe('deny')
    unmount()
  })
  it('replaces overflowing chrome on resize and denies tiny pending prompts with Escape', async () => {
    const props = makeProps()
    const { stdout, stdin, unmount } = renderOnTty(<App {...props} />, 24, 40)
    await delay(30)
    const answer = props.permissionBridge.ask({ toolName: 'Bash', input: { command: 'echo end' }, summary: 'Summary '.repeat(60), reason: 'Reason '.repeat(60) })
    await delay(30)
    const old = lastFrame(stdout)
    const from = stdout.frames.length
    stdout.rows = 12
    stdout.emit('resize')
    await delay(40)
    sound(stdout.frames.slice(from).filter(frame => frame !== old), 12)
    stdout.rows = 3
    stdout.emit('resize')
    await delay(30)
    expect(lastFrame(stdout)).toContain('Esc deny')
    stdin.write('y')
    await delay(20)
    expect(lastFrame(stdout)).toContain('Esc deny')
    stdin.write('\u001b')
    await expect(answer).resolves.toBe('deny')
    unmount()
  })
})
