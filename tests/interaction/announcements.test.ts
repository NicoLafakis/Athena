import { describe, expect, it } from 'vitest'
import { announcementFor } from '../../src/interaction/announcements.js'
import { applyInteractionEnvelope, createInteractionSnapshot } from '../../src/interaction/state.js'
import type { InteractionEventEnvelope } from '../../src/interaction/types.js'

const timestamp = '2026-07-29T12:00:00.000Z'

function event<K extends InteractionEventEnvelope['kind']>(
  kind: K,
  payload: Extract<InteractionEventEnvelope, { kind: K }>['payload'],
  sequence = 1,
): Extract<InteractionEventEnvelope, { kind: K }> {
  return {
    schemaVersion: 1,
    id: `run-1:${sequence}`,
    runId: 'run-1',
    sequence,
    timestamp,
    source: 'runtime',
    kind,
    payload,
  } as Extract<InteractionEventEnvelope, { kind: K }>
}

function classify(input: InteractionEventEnvelope, verbosity: 'quiet' | 'balanced' | 'verbose' = 'balanced') {
  const before = createInteractionSnapshot('run-1', timestamp)
  const reduction = applyInteractionEnvelope(before, input)
  expect(reduction.accepted).toBe(true)
  return announcementFor(input, before, reduction.snapshot, { verbosity })
}

describe('announcement policy', () => {
  it('keeps routine thinking, acting, and successful tool activity silent in balanced mode', () => {
    expect(classify(event('phase-changed', { phase: 'thinking' }))).toBeNull()
    expect(classify(event('phase-changed', { phase: 'acting' }))).toBeNull()
    expect(classify(event('activity-changed', {
      activity: { type: 'tool', label: 'Read', status: 'succeeded' },
    }))).toBeNull()
  })

  it('announces verified terminal phases with deterministic priority and provenance', () => {
    expect(classify(event('phase-changed', { phase: 'completed' }))).toMatchObject({
      priority: 'polite',
      category: 'phase',
      text: 'Completed: Work completed.',
      requiresAcknowledgement: false,
      provenance: [{ source: 'runtime', sequence: 1 }],
    })
    expect(classify(event('phase-changed', { phase: 'limited' }))).toMatchObject({
      priority: 'assertive',
      text: 'Attention: Run limit reached.',
    })
  })

  it('makes permissions and blocked decisions durable blocking announcements', () => {
    const announcement = classify(event('attention-added', {
      attention: {
        id: 'permission:req-1',
        category: 'permission',
        priority: 'blocking',
        summary: 'Write needs approval.',
        action: 'Choose allow once, always allow, or deny.',
      },
    }))
    expect(announcement).toMatchObject({
      priority: 'blocking',
      category: 'permission',
      text: 'Permission: Write needs approval.',
      detail: 'Choose allow once, always allow, or deny.',
      requiresAcknowledgement: true,
    })
  })

  it('only narrates routine phase changes in verbose mode', () => {
    expect(classify(event('phase-changed', { phase: 'thinking' }), 'verbose')).toMatchObject({
      priority: 'polite',
      text: 'Status: Thinking.',
    })
    expect(classify(event('phase-changed', { phase: 'completed' }), 'quiet')).toBeNull()
  })

  it('changes its dedupe key when severity or required action changes', () => {
    const base = classify(event('attention-added', {
      attention: {
        id: 'condition-1',
        category: 'error',
        priority: 'assertive',
        summary: 'Read failed.',
        action: 'Retry.',
      },
    }))!
    const changed = classify(event('attention-added', {
      attention: {
        id: 'condition-1',
        category: 'error',
        priority: 'blocking',
        summary: 'Read failed.',
        action: 'Stop and inspect.',
      },
    }))!
    expect(changed.dedupeKey).not.toBe(base.dedupeKey)
  })
})
