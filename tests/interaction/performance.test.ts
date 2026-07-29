import { describe, expect, it } from 'vitest'
import { announcementFor } from '../../src/interaction/announcements.js'
import { applyInteractionEnvelope, createInteractionSnapshot } from '../../src/interaction/state.js'
import type { InteractionEventEnvelope } from '../../src/interaction/types.js'

describe('interaction performance budgets', () => {
  it('keeps the p95 reducer plus announcement policy cost below 5 ms over 20k events', () => {
    let snapshot = createInteractionSnapshot('run-1', '2026-07-29T12:00:00.000Z')
    const durations: number[] = []

    for (let sequence = 1; sequence <= 20_000; sequence++) {
      const event: InteractionEventEnvelope = {
        schemaVersion: 1,
        id: `run-1:${sequence}`,
        runId: 'run-1',
        sequence,
        timestamp: '2026-07-29T12:00:00.000Z',
        source: 'runtime',
        kind: 'phase-changed',
        payload: { phase: sequence % 2 === 0 ? 'acting' : 'thinking' },
      }
      const started = performance.now()
      const result = applyInteractionEnvelope(snapshot, event)
      if (!result.accepted) throw new Error(`reducer rejected sequence ${sequence}`)
      announcementFor(event, snapshot, result.snapshot)
      snapshot = result.snapshot
      durations.push(performance.now() - started)
    }

    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95)]!
    expect(p95).toBeLessThan(5)
  })
})
