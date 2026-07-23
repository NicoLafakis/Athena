import { describe, it, expect, vi } from 'vitest'
import { createFullscreenController, ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from '../../src/tui/fullscreen.js'

function fakeStream(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY, write: vi.fn() } as unknown as NodeJS.WriteStream
}

describe('createFullscreenController', () => {
  it('is a non-fatal no-op off a non-TTY stream: supported=false, enter() never writes', () => {
    const stream = fakeStream(false)
    const c = createFullscreenController(stream)
    expect(c.supported).toBe(false)
    c.enter()
    expect(c.active).toBe(false)
    expect(stream.write).not.toHaveBeenCalled()
    c.dispose()
  })

  it('writes the alt-screen enter/exit sequences on a TTY stream', () => {
    const stream = fakeStream(true)
    const c = createFullscreenController(stream)
    expect(c.supported).toBe(true)
    c.enter()
    expect(c.active).toBe(true)
    expect(stream.write).toHaveBeenCalledWith(ALT_SCREEN_ENTER)
    c.exit()
    expect(c.active).toBe(false)
    expect(stream.write).toHaveBeenCalledWith(ALT_SCREEN_EXIT)
    c.dispose()
  })

  it('enter() is idempotent: calling it twice writes the enter sequence only once', () => {
    const stream = fakeStream(true)
    const c = createFullscreenController(stream)
    c.enter()
    c.enter()
    const enterCalls = (stream.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([arg]) => arg === ALT_SCREEN_ENTER,
    )
    expect(enterCalls).toHaveLength(1)
    c.dispose()
  })

  it('exit() when never entered is a safe no-op (no stray restore write)', () => {
    const stream = fakeStream(true)
    const c = createFullscreenController(stream)
    c.exit()
    expect(stream.write).not.toHaveBeenCalled()
    c.dispose()
  })

  it('dispose() unregisters this controller without throwing on a later process exit', () => {
    const stream = fakeStream(true)
    const c = createFullscreenController(stream)
    c.enter()
    expect(() => c.dispose()).not.toThrow()
  })
})
