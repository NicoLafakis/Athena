// tests/tui/busy-indicator.test.tsx — coverage for the "the model is working" indicator
// (see src/tui/components/BusyIndicator.tsx): it must show only while a turn is actually
// running with nothing blocking it (busy && pending === null, mirroring InputBox's own
// disabled condition), animate its spinner, count elapsed time without drifting or
// resetting across a permission-dialog interruption, and never leak its interval.
import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { App, PermissionBridge } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { BusyIndicator, busyIndicatorText, formatElapsed } from '../../src/tui/components/BusyIndicator.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeHarness(onSubmit = vi.fn(() => new Promise<void>(() => {}))) {
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
      onSubmit,
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

describe('formatElapsed', () => {
  it('renders compact seconds under a minute, M:SS at or beyond it', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(999)).toBe('0s')
    expect(formatElapsed(1000)).toBe('1s')
    expect(formatElapsed(59_000)).toBe('59s')
    expect(formatElapsed(60_000)).toBe('1:00')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(600_000)).toBe('10:00')
  })
})

describe('busyIndicatorText', () => {
  it('is the same single source of truth the component renders (used by App.tsx row budgeting)', () => {
    expect(busyIndicatorText(0)).toContain('Thinking…')
    expect(busyIndicatorText(0)).toContain('(esc to interrupt)')
    expect(busyIndicatorText(65_000)).toContain('1:05')
  })
})

describe('BusyIndicator (standalone)', () => {
  it('renders the spinner, phrase, elapsed time, and interrupt hint', () => {
    const { lastFrame } = render(<BusyIndicator startedAt={Date.now()} />)
    const frame = lastFrame()
    expect(frame).toContain('Thinking')
    expect(frame).toContain('(esc to interrupt)')
    expect(frame).toMatch(/\b0s\b/)
  })

  it('the spinner frame advances over time', async () => {
    const { lastFrame } = render(<BusyIndicator startedAt={Date.now()} />)
    const first = lastFrame()
    await delay(300) // comfortably >= 2 ticks at the 120ms interval
    const second = lastFrame()
    // Elapsed text is still "0s" at this point (well under a second), so any change
    // between the two frames can only be the spinner glyph advancing.
    expect(second).not.toBe(first)
  })

  it('the elapsed counter increments as real time passes', async () => {
    const { lastFrame } = render(<BusyIndicator startedAt={Date.now()} />)
    await delay(1150) // comfortably past a full-second boundary given the 120ms tick
    const match = lastFrame()!.match(/Thinking… (\d+)s/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(1)
  })

  it('elapsed time is derived from the stable startedAt prop, not this mount — no reset on remount', () => {
    // Simulates App.tsx's real integration: startedAt reflects a turn that began before
    // this particular mount (e.g. remounted after a permission-dialog interruption).
    const startedAt = Date.now() - 5000
    const match = render(<BusyIndicator startedAt={startedAt} />)
      .lastFrame()!
      .match(/Thinking… (\d+)s/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(5)
  })

  it('clears its interval on unmount (no leaked timer)', async () => {
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const { unmount } = render(<BusyIndicator startedAt={Date.now()} />)
    await delay(0) // let React/Ink flush the mount effect that calls setInterval
    unmount()
    await delay(0) // let the effect's cleanup (clearInterval) actually run
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('a fresh mount after unmount starts exactly one new interval, never stacking on the old one', async () => {
    const setSpy = vi.spyOn(global, 'setInterval')
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const first = render(<BusyIndicator startedAt={Date.now()} />)
    await delay(0)
    expect(setSpy).toHaveBeenCalledTimes(1)
    first.unmount()
    await delay(0)
    expect(clearSpy).toHaveBeenCalledTimes(1)
    const second = render(<BusyIndicator startedAt={Date.now()} />)
    await delay(0)
    expect(setSpy).toHaveBeenCalledTimes(2) // one new interval, not a second one stacked
    second.unmount()
    await delay(0)
    expect(clearSpy).toHaveBeenCalledTimes(2)
    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})

describe('BusyIndicator wired into App', () => {
  it('does not appear while idle', async () => {
    const { props } = makeHarness()
    const { lastFrame } = render(<App {...props} />)
    await delay(0)
    expect(lastFrame()).not.toContain('Thinking')
  })

  it('appears once a turn is submitted, and the interrupt hint is not duplicated', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, 'do work')
    const frame = lastFrame()!
    expect(frame).toContain('Thinking')
    // Moved out of StatusLine's own right segment (see StatusLine.tsx) — must render
    // exactly once, never in both places at once.
    const hintOccurrences = frame.split('(esc to interrupt)').length - 1
    expect(hintOccurrences).toBe(1)
  })

  it('hides while a permission dialog is pending mid-turn (the model is waiting, not working)', async () => {
    const { props } = makeHarness()
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, 'do work')
    expect(lastFrame()).toContain('Thinking')

    const answer = props.permissionBridge.ask({
      toolName: 'Bash',
      input: { command: 'echo hi' },
      summary: 'Bash(echo hi)',
      reason: 'mutating',
    })
    await delay(10)
    const frame = lastFrame()!
    expect(frame).toContain('Permission required')
    expect(frame).not.toContain('Thinking')

    stdin.write('y')
    await answer
  })

  it('disappears once the turn finishes (turn-done event)', async () => {
    const { bus, props } = makeHarness(vi.fn(async () => {}))
    const { lastFrame, stdin } = render(<App {...props} />)
    await delay(0)
    await type(stdin, 'do work')
    expect(lastFrame()).toContain('Thinking') // sanity: showing before turn-done
    bus.emit({ type: 'turn-done', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } })
    await delay(20)
    expect(lastFrame()).not.toContain('Thinking')
  })
})
