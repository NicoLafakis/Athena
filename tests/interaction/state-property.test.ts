import { describe, expect, it } from 'vitest'
import { applyInteractionEnvelope, createInteractionSnapshot } from '../../src/interaction/state.js'

const timestamp = '2026-07-29T12:00:00.000Z'

function phase(sequence: number, value: 'thinking' | 'acting' | 'completed', runId = 'run-1') {
  return {
    schemaVersion: 1,
    id: `${runId}:${sequence}`,
    runId,
    sequence,
    timestamp,
    source: 'runtime',
    kind: 'phase-changed',
    payload: { phase: value },
  } as const
}

describe('interaction reducer invariants', () => {
  it('never changes state for duplicate, reordered, cross-run, or malformed events', () => {
    const first = applyInteractionEnvelope(createInteractionSnapshot('run-1', timestamp), phase(1, 'thinking'))
    expect(first.accepted).toBe(true)

    const hostileInputs: unknown[] = [
      phase(1, 'completed'),
      phase(0, 'completed'),
      phase(3, 'completed'),
      phase(2, 'completed', 'run-2'),
      { ...phase(2, 'completed'), schemaVersion: 999 },
      { ...phase(2, 'completed'), payload: { phase: 'invented' } },
      null,
      'fake status',
    ]

    for (const input of hostileInputs) {
      const result = applyInteractionEnvelope(first.snapshot, input)
      expect(result.accepted).toBe(false)
      expect(result.snapshot).toEqual(first.snapshot)
    }
  })

  it('produces the same snapshot for repeated replays of every valid prefix', () => {
    const events = [phase(1, 'thinking'), phase(2, 'acting'), phase(3, 'completed')]
    for (let prefix = 0; prefix <= events.length; prefix++) {
      const replay = () => events.slice(0, prefix).reduce(
        (snapshot, event) => applyInteractionEnvelope(snapshot, event).snapshot,
        createInteractionSnapshot('run-1', timestamp),
      )
      expect(replay()).toEqual(replay())
    }
  })
})
