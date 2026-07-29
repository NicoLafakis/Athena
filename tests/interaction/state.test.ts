import { describe, expect, it } from 'vitest'
import {
  applyInteractionEnvelope,
  createInteractionSnapshot,
  InteractionStateStore,
} from '../../src/interaction/state.js'

const timestamp = '2026-07-29T12:00:00.000Z'

function envelope(
  sequence: number,
  source: 'runtime' | 'user' | 'agent',
  kind: string,
  payload: unknown,
  runId = 'run-1',
) {
  return {
    schemaVersion: 1,
    id: `${runId}:${sequence}`,
    runId,
    sequence,
    timestamp,
    source,
    kind,
    payload,
  }
}

describe('interaction state reducer', () => {
  it('reduces an objective, tool lifecycle, and verified completion deterministically', () => {
    let snapshot = createInteractionSnapshot('run-1', timestamp)
    const events = [
      envelope(1, 'user', 'objective-set', { objective: 'Ship the accessible interaction core.' }),
      envelope(2, 'runtime', 'phase-changed', { phase: 'thinking' }),
      envelope(3, 'runtime', 'activity-changed', {
        activity: { type: 'tool', label: 'Read', status: 'active', target: 'src/cli.ts' },
      }),
      envelope(4, 'runtime', 'phase-changed', { phase: 'acting' }),
      envelope(5, 'runtime', 'outcome-recorded', {
        outcome: {
          status: 'succeeded',
          summary: 'Read completed.',
          verified: true,
          operation: 'Read',
        },
      }),
      envelope(6, 'runtime', 'phase-changed', { phase: 'completed' }),
    ]

    for (const event of events) {
      const result = applyInteractionEnvelope(snapshot, event)
      expect(result.accepted).toBe(true)
      snapshot = result.snapshot
    }

    expect(snapshot.objective.value).toBe('Ship the accessible interaction core.')
    expect(snapshot.phase.value).toBe('completed')
    expect(snapshot.activity.value).toMatchObject({ label: 'Read', status: 'active' })
    expect(snapshot.lastVerifiedOutcome.value).toMatchObject({
      status: 'succeeded',
      verified: true,
    })
    expect(snapshot.lastSequence).toBe(6)

    let replay = createInteractionSnapshot('run-1', timestamp)
    for (const event of events) replay = applyInteractionEnvelope(replay, event).snapshot
    expect(replay).toEqual(snapshot)
  })

  it('keeps explicit user facts over later agent assertions', () => {
    let snapshot = createInteractionSnapshot('run-1', timestamp)
    snapshot = applyInteractionEnvelope(
      snapshot,
      envelope(1, 'user', 'objective-set', { objective: 'Preserve user control.' }),
    ).snapshot
    snapshot = applyInteractionEnvelope(
      snapshot,
      envelope(2, 'agent', 'objective-set', { objective: 'Act autonomously.' }),
    ).snapshot

    expect(snapshot.objective.value).toBe('Preserve user control.')
    expect(snapshot.objective.provenance?.source).toBe('user')
    expect(snapshot.lastSequence).toBe(2)
  })

  it('does not let an agent create verified outcomes or runtime phases', () => {
    const snapshot = createInteractionSnapshot('run-1', timestamp)
    const outcome = applyInteractionEnvelope(
      snapshot,
      envelope(1, 'agent', 'outcome-recorded', {
        outcome: { status: 'succeeded', summary: 'Everything passed.', verified: true },
      }),
    )
    expect(outcome.accepted).toBe(false)
    expect(outcome.diagnostic?.code).toBe('source-not-authorized')
    expect(outcome.snapshot).toEqual(snapshot)

    const phase = applyInteractionEnvelope(
      snapshot,
      envelope(1, 'agent', 'phase-changed', { phase: 'completed' }),
    )
    expect(phase.accepted).toBe(false)
    expect(phase.snapshot.phase.value).toBe('idle')
  })

  it('rejects malformed, cross-run, duplicate, and out-of-order envelopes without mutation', () => {
    const snapshot = createInteractionSnapshot('run-1', timestamp)
    const cases = [
      { invalid: { nonsense: true }, code: 'malformed-envelope' },
      { invalid: envelope(1, 'runtime', 'phase-changed', { phase: 'thinking' }, 'run-2'), code: 'run-mismatch' },
      { invalid: envelope(2, 'runtime', 'phase-changed', { phase: 'thinking' }), code: 'sequence-gap' },
    ]

    for (const testCase of cases) {
      const result = applyInteractionEnvelope(snapshot, testCase.invalid)
      expect(result.accepted).toBe(false)
      expect(result.diagnostic?.code).toBe(testCase.code)
      expect(result.snapshot).toEqual(snapshot)
      expect(result.diagnostic?.message.length).toBeLessThanOrEqual(240)
    }

    const accepted = applyInteractionEnvelope(
      snapshot,
      envelope(1, 'runtime', 'phase-changed', { phase: 'thinking' }),
    ).snapshot
    const duplicate = applyInteractionEnvelope(
      accepted,
      envelope(1, 'runtime', 'phase-changed', { phase: 'acting' }),
    )
    expect(duplicate.accepted).toBe(false)
    expect(duplicate.diagnostic?.code).toBe('sequence-rejected')
    expect(duplicate.snapshot).toEqual(accepted)
  })

  it('retains and resolves blocking attention by stable ID', () => {
    let snapshot = createInteractionSnapshot('run-1', timestamp)
    snapshot = applyInteractionEnvelope(
      snapshot,
      envelope(1, 'runtime', 'attention-added', {
        attention: {
          id: 'permission:req-1',
          category: 'permission',
          priority: 'blocking',
          summary: 'Write needs approval.',
          action: 'Choose allow once, always allow, or deny.',
        },
      }),
    ).snapshot
    expect(snapshot.attention).toHaveLength(1)

    snapshot = applyInteractionEnvelope(
      snapshot,
      envelope(2, 'runtime', 'attention-resolved', { attentionId: 'permission:req-1' }),
    ).snapshot
    expect(snapshot.attention).toEqual([])
  })

  it('stores parent and child snapshots independently', () => {
    const store = new InteractionStateStore()
    store.accept(envelope(1, 'runtime', 'phase-changed', { phase: 'thinking' }, 'run-1') as Parameters<typeof store.accept>[0])
    store.accept(envelope(1, 'runtime', 'phase-changed', { phase: 'acting' }, 'run-2') as Parameters<typeof store.accept>[0])

    expect(store.get('run-1')?.phase.value).toBe('thinking')
    expect(store.get('run-2')?.phase.value).toBe('acting')
  })
})
