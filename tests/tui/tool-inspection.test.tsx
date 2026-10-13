import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { App, PermissionBridge, reduceEvent } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'

function props() {
  return {
    bus: new EngineEventBus(),
    status: { cwd: process.cwd(), gitBranch: 'main', model: 'test', modelKey: 'sonnet', provider: 'anthropic' as const, effort: 'high', mode: 'normal' as const, contextPct: 0 },
    onSubmit: vi.fn(async () => {}), onSlash: vi.fn(), onAbort: vi.fn(), permissionBridge: new PermissionBridge(),
  }
}

class Output extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  frames: string[] = []
  write = (frame: string) => { this.frames.push(frame); return true }
}
class Input extends EventEmitter {
  isTTY = true
  private data: string | null = null
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read = () => { const result = this.data; this.data = null; return result }
  write = (data: string) => { this.data = data; this.emit('readable'); this.emit('data', data) }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 25))
describe('tool readback', () => {
  it('allows inspection during work without admitting another model turn', async () => {
    const p = props()
    p.onSubmit = vi.fn(() => new Promise<void>(() => {}))
    const view = render(<App {...p} />)
    await tick()
    view.stdin.write('start')
    await tick()
    view.stdin.write('\r')
    await tick()
    expect(p.onSubmit).toHaveBeenCalledTimes(1)
    p.bus.emit({ type: 'tool-request', id: 'working', name: 'Bash', input: { command: 'work' } })
    p.bus.emit({ type: 'tool-progress', id: 'working', name: 'Bash', delta: 'LIVE-PROGRESS' })
    await tick()
    view.stdin.write('\u000f')
    await tick()
    expect(view.lastFrame()).toContain('State: running')
    expect(view.lastFrame()).toContain('LIVE-PROGRESS')
    view.stdin.write('another turn')
    view.stdin.write('\r')
    await tick()
    expect(p.onSubmit).toHaveBeenCalledTimes(1)
    view.stdin.write('\u001b')
    await tick()
    expect(p.onAbort).not.toHaveBeenCalled()
    expect(p.onSubmit).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('a pending permission preempts tool inspection and remains explicitly answerable', async () => {
    const p = props()
    const view = render(<App {...p} />)
    await tick()
    p.bus.emit({ type: 'tool-request', id: 't', name: 'Bash', input: { command: 'inspect' } })
    await tick()
    view.stdin.write('\u000f')
    await tick()
    expect(view.lastFrame()).toContain('Tool 1/1')
    const answer = p.permissionBridge.ask({ id: 'new-permission', toolName: 'Bash', input: { command: 'needs consent' }, summary: 'Needs consent', reason: 'approval required' })
    await tick()
    expect(view.lastFrame()).toContain('Permission required')
    expect(view.lastFrame()).not.toContain('Tool 1/1')
    view.stdin.write('n')
    await tick()
    await expect(answer).resolves.toBe('deny')
    expect(p.onSubmit).not.toHaveBeenCalled()
    view.unmount()
  })

  it('returns from inspection to the unchanged scrolled transcript', async () => {
    const p = props()
    const stdout = new Output()
    const stdin = new Input()
    const view = inkRender(<App {...p} />, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new Output() as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false })
    await tick()
    p.bus.emit({ type: 'tool-request', id: 't', name: 'Bash', input: { command: 'inspect' } })
    p.bus.emit({ type: 'tool-result', id: 't', name: 'Bash', output: 'retained result', isError: false })
    for (let i = 0; i < 30; i++) p.bus.emit({ type: 'info', message: `TRANSCRIPT-${i}` })
    await tick()
    stdin.write('\u001b[5~')
    await tick()
    const before = stdout.frames.at(-1)!
    expect(before).toContain('scrolled')
    stdin.write('\u000f')
    await tick()
    expect(stdout.frames.at(-1)).toContain('Tool 1/1')
    stdin.write('\u001b[6~')
    await tick()
    stdin.write('\u001b')
    await tick()
    expect(stdout.frames.at(-1)).toBe(before)
    expect(p.onSubmit).not.toHaveBeenCalled()
    view.unmount()
  })
  it('records effective hook arguments without creating a duplicate tool', () => {
    const proposed = reduceEvent([], { type: 'tool-request', id: 't', name: 'Bash', input: { command: 'before' } })
    const effective = reduceEvent(proposed, { type: 'tool-effective-input', id: 't', name: 'Bash', input: { command: 'after' } })
    expect(effective).toHaveLength(1)
    expect(effective[0]).toMatchObject({ input: { command: 'after' }, effective: true })
  })
  it('does not mark streaming output completed', () => {
    const started = reduceEvent([], { type: 'tool-request', id: 't', name: 'Bash', input: { command: 'test' } })
    const streaming = reduceEvent(started, { type: 'tool-progress', id: 't', name: 'Bash', delta: 'first line' })
    expect(streaming[0]).toMatchObject({ completed: false })
    const done = reduceEvent(streaming, { type: 'tool-result', id: 't', name: 'Bash', output: 'finished', isError: false })
    expect(done[0]).toMatchObject({ completed: true })
  })
  it('opens retained tool text using Ctrl+O and searches it without a model call', async () => {
    const bus = new EngineEventBus()
    const submit = vi.fn(async () => {})
    const { stdin, lastFrame, unmount } = render(<App bus={bus} status={{ cwd: process.cwd(), gitBranch: 'main', model: 'test', modelKey: 'sonnet', provider: 'anthropic', effort: 'high', mode: 'normal', contextPct: 0 }} onSubmit={submit} onSlash={vi.fn()} onAbort={vi.fn()} permissionBridge={new PermissionBridge()} />)
    await tick()
    bus.emit({ type: 'tool-request', id: 't', name: 'Bash', input: { command: 'test command' } })
    bus.emit({ type: 'tool-result', id: 't', name: 'Bash', output: Array.from({ length: 200 }, (_, i) => `error-${i}`).join('\n'), isError: true })
    await tick()
    stdin.write('\u000f')
    await tick()
    expect(lastFrame()).toContain('Tool')
    stdin.write('/')
    await tick()
    stdin.write('error-199')
    await tick()
    stdin.write('\r')
    await tick()
    expect(lastFrame()).toContain('error-199')
    expect(submit).not.toHaveBeenCalled()
    stdin.write('\u001b')
    await tick()
    unmount()
  })
})
