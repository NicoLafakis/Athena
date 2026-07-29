import { describe, expect, it } from 'vitest'
import {
  AnnouncementSchema,
  InteractionEventEnvelopeSchema,
  InteractionSnapshotSchema,
} from '../../src/interaction/schemas.js'
import { createInteractionSnapshot } from '../../src/interaction/state.js'

describe('interaction schemas', () => {
  it('accepts a bounded, versioned envelope', () => {
    const parsed = InteractionEventEnvelopeSchema.parse({
      schemaVersion: 1,
      id: 'run-1:1',
      runId: 'run-1',
      sequence: 1,
      timestamp: '2026-07-29T12:00:00.000Z',
      source: 'user',
      kind: 'objective-set',
      payload: { objective: 'Make Athena usable without sight.' },
      sourceRef: 'prompt:1',
    })

    expect(parsed.kind).toBe('objective-set')
  })

  it('rejects unknown versions, malformed timestamps, and oversized user text', () => {
    const base = {
      id: 'run-1:1',
      runId: 'run-1',
      sequence: 1,
      source: 'user',
      kind: 'objective-set',
      payload: { objective: 'valid' },
    }

    expect(InteractionEventEnvelopeSchema.safeParse({
      ...base,
      schemaVersion: 2,
      timestamp: '2026-07-29T12:00:00.000Z',
    }).success).toBe(false)
    expect(InteractionEventEnvelopeSchema.safeParse({
      ...base,
      schemaVersion: 1,
      timestamp: 'not-a-date',
    }).success).toBe(false)
    expect(InteractionEventEnvelopeSchema.safeParse({
      ...base,
      schemaVersion: 1,
      timestamp: '2026-07-29T12:00:00.000Z',
      payload: { objective: 'x'.repeat(4_097) },
    }).success).toBe(false)
  })

  it('validates snapshots and announcements at externalization boundaries', () => {
    expect(InteractionSnapshotSchema.parse(
      createInteractionSnapshot('run-1', '2026-07-29T12:00:00.000Z'),
    ).runId).toBe('run-1')

    const announcement = {
      schemaVersion: 1,
      id: 'announcement-1',
      runId: 'run-1',
      priority: 'blocking',
      category: 'permission',
      text: 'Permission required for Write.',
      detail: 'Review the bounded diff before deciding.',
      dedupeKey: 'run-1:permission:req-1',
      requiresAcknowledgement: true,
      provenance: [{
        source: 'runtime',
        runId: 'run-1',
        sequence: 2,
        sourceEventType: 'permission-requested',
        sourceEventId: 'req-1',
      }],
      createdAt: '2026-07-29T12:00:01.000Z',
    }
    expect(AnnouncementSchema.parse(announcement).priority).toBe('blocking')
    expect(AnnouncementSchema.safeParse({ ...announcement, text: 'x'.repeat(1_025) }).success).toBe(false)
  })
})
