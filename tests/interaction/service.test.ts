import { describe, expect, it } from 'vitest'
import { InteractionService } from '../../src/interaction/service.js'
import type { Announcement, InteractionEventEnvelope } from '../../src/interaction/types.js'

const timestamp = '2026-07-29T12:00:00.000Z'

function event<K extends InteractionEventEnvelope['kind']>(
  sequence: number,
  kind: K,
  payload: Extract<InteractionEventEnvelope, { kind: K }>['payload'],
): Extract<InteractionEventEnvelope, { kind: K }> {
  return {
    schemaVersion: 1,
    id: `run-1:${sequence}`,
    runId: 'run-1',
    sequence,
    timestamp: new Date(Date.parse(timestamp) + sequence * 1_000).toISOString(),
    source: kind === 'objective-set' ? 'user' : 'runtime',
    kind,
    payload,
  } as Extract<InteractionEventEnvelope, { kind: K }>
}

describe('InteractionService', () => {
  it('keeps status, repeat, and details local and evidence-backed', () => {
    const emitted: Announcement[] = []
    const service = new InteractionService({
      tracePath: () => 'runs/run-1.jsonl',
      onAnnouncement: (announcement) => emitted.push(announcement),
    })
    service.accept(event(1, 'objective-set', { objective: 'Ship safely.' }))
    service.accept(event(2, 'phase-changed', { phase: 'thinking' }))
    service.accept(event(3, 'phase-changed', { phase: 'completed' }))

    expect(service.status('run-1')).toContain('Objective (user): Ship safely.')
    expect(service.status('run-1')).toContain('Status: completed.')
    expect(service.repeat('run-1')).toBe('Completed: Work completed.')
    expect(service.details('run-1')).toContain('Full trace: runs/run-1.jsonl')
    expect(emitted).toHaveLength(1)
  })

  it('returns explicit recovery text when state or material history is absent', () => {
    const service = new InteractionService()
    expect(service.status('missing')).toBe('Status: no semantic state is available for this run.')
    expect(service.repeat('missing')).toBe('No material announcement is available. Use /status.')
    expect(service.details('missing')).toBe('No material detail is available. Use /status.')
  })

  it('reports coalescing metadata without re-emitting an equivalent announcement', () => {
    const emitted: Announcement[] = []
    const service = new InteractionService({ onAnnouncement: (announcement) => emitted.push(announcement) })
    service.accept(event(1, 'attention-added', {
      attention: {
        id: 'failure:read',
        category: 'error',
        priority: 'polite',
        summary: 'Read failed.',
      },
    }))
    const outcome = service.accept(event(2, 'attention-added', {
      attention: {
        id: 'failure:read',
        category: 'error',
        priority: 'polite',
        summary: 'Read failed.',
      },
    }))

    expect(outcome.coalesced).toBe(true)
    expect(outcome.occurrences).toBe(2)
    expect(emitted).toHaveLength(1)
  })

  it('can change verbosity without changing state or calling a model', () => {
    const service = new InteractionService({ verbosity: 'quiet' })
    expect(service.accept(event(1, 'phase-changed', { phase: 'completed' })).announcement).toBeUndefined()
    service.setVerbosity('verbose')
    expect(service.accept(event(2, 'phase-changed', { phase: 'thinking' })).announcement).toMatchObject({
      text: 'Status: Thinking.',
    })
  })

  it('releases a blocking announcement only when its matching attention ID resolves', () => {
    const service = new InteractionService()
    service.accept(event(1, 'attention-added', {
      attention: {
        id: 'permission:req-1',
        category: 'permission',
        priority: 'blocking',
        summary: 'Write needs approval.',
      },
    }))
    expect(service.unresolvedBlocking('run-1')).toHaveLength(1)

    service.accept(event(2, 'attention-resolved', { attentionId: 'permission:other' }))
    expect(service.unresolvedBlocking('run-1')).toHaveLength(1)

    service.accept(event(3, 'attention-resolved', { attentionId: 'permission:req-1' }))
    expect(service.unresolvedBlocking('run-1')).toHaveLength(0)
  })
})
