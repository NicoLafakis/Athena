import { describe, expect, it } from 'vitest'
import { createInteractionSnapshot } from '../../src/interaction/state.js'
import type { Announcement, InteractionSnapshot } from '../../src/interaction/types.js'
import { buildVoiceContext } from '../../src/voice/context.js'

describe('voice semantic context', () => {
  it('derives bounded redacted context only from semantic state and announcements', () => {
    const secret = 'sk-ant-api03-supersecretvalue1234'
    const base = createInteractionSnapshot('run-1', '2026-07-29T12:00:00.000Z')
    const snapshot: InteractionSnapshot = {
      ...base,
      objective: { value: `Release ${secret}`, provenance: null },
      attention: [{
        id: 'attention-1',
        category: 'error',
        priority: 'assertive',
        summary: `Provider rejected ${secret}`,
        action: 'Inspect the trace.',
        provenance: { source: 'runtime', runId: 'run-1', sequence: 1, sourceEventType: 'error' },
      }],
    }
    const announcement: Announcement = {
      schemaVersion: 1,
      id: 'announcement-1',
      runId: 'run-1',
      priority: 'assertive',
      category: 'error',
      text: `Attention: ${secret}`,
      dedupeKey: 'one',
      requiresAcknowledgement: false,
      provenance: [{ source: 'runtime', runId: 'run-1', sequence: 1, sourceEventType: 'error' }],
      createdAt: '2026-07-29T12:00:00.000Z',
    }
    const context = buildVoiceContext(snapshot, announcement)
    expect(context).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      phase: 'idle',
      objective: 'Release [REDACTED]',
      pendingAttention: [{ id: 'attention-1', priority: 'assertive' }],
    })
    expect(JSON.stringify(context)).not.toContain('supersecretvalue1234')
    expect(JSON.stringify(context).length).toBeLessThan(8_192)
  })
})
