import { describe, it, expect } from 'vitest'
import { EngineEventBus } from '../../src/engine/events.js'
import type { EngineEvent } from '../../src/engine/types.js'

describe('EngineEventBus', () => {
  it('delivers events to all listeners in subscription order', () => {
    const bus = new EngineEventBus()
    const seen: string[] = []
    bus.on((e) => seen.push(`a:${e.type}`))
    bus.on((e) => seen.push(`b:${e.type}`))
    const event: EngineEvent = { type: 'assistant-text', delta: 'hi' }
    bus.emit(event)
    expect(seen).toEqual(['a:assistant-text', 'b:assistant-text'])
  })

  it('unsubscribe stops delivery', () => {
    const bus = new EngineEventBus()
    const seen: EngineEvent[] = []
    const off = bus.on((e) => seen.push(e))
    off()
    bus.emit({ type: 'error', message: 'x', fatal: false })
    expect(seen).toHaveLength(0)
  })

  it('a listener added during emit does not receive the in-flight event', () => {
    const bus = new EngineEventBus()
    let lateCalls = 0
    bus.on(() => {
      bus.on(() => { lateCalls += 1 })
    })
    bus.emit({ type: 'assistant-text', delta: 'x' })
    expect(lateCalls).toBe(0)
  })
})
