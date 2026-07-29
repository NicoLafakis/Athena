import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EngineEventBus } from '../../src/engine/events.js'
import type { EngineEvent } from '../../src/engine/types.js'
import { InteractionEventAdapter } from '../../src/interaction/event-adapter.js'
import type { InteractionEventEnvelope } from '../../src/interaction/types.js'

const FixtureSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.string().min(1).max(512),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    detector: z.enum(['repeated-failure', 'verification-invalidation', 'budget', 'work-aggregation']),
    intent: z.enum(['helpful', 'quiet']),
    events: z.array(z.record(z.unknown())).min(1).max(20),
    expected: z.object({
      advisorySummaries: z.array(z.string().max(1_024)).max(4),
      aggregateLabels: z.array(z.string().max(256)).max(8),
    }).strict(),
  }).strict()).min(8).max(20),
}).strict()

describe('dogfood attention-quality replays', () => {
  it('proves a helpful and deliberate quiet case for every deterministic detector', () => {
    const file = join(process.cwd(), 'tests', 'fixtures', 'interaction', 'attention-quality.json')
    const fixture = FixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    const covered = new Set(fixture.cases.map((item) => `${item.detector}:${item.intent}`))
    expect([...covered].sort()).toEqual([
      'budget:helpful',
      'budget:quiet',
      'repeated-failure:helpful',
      'repeated-failure:quiet',
      'verification-invalidation:helpful',
      'verification-invalidation:quiet',
      'work-aggregation:helpful',
      'work-aggregation:quiet',
    ])

    for (const fixtureCase of fixture.cases) {
      const bus = new EngineEventBus()
      const seen: InteractionEventEnvelope[] = []
      const adapter = new InteractionEventAdapter({
        runId: `run-${fixtureCase.id}`,
        now: () => '2026-07-29T12:00:00.000Z',
        onEnvelope: (event) => seen.push(event),
      })
      adapter.attach(bus)
      for (const event of fixtureCase.events) bus.emit(event as EngineEvent)
      adapter.detach()

      const advisories = seen
        .filter((event): event is Extract<InteractionEventEnvelope, { kind: 'attention-added' }> =>
          event.kind === 'attention-added' && event.payload.attention.category === 'advisory',
        )
        .map((event) => event.payload.attention.summary)
      const aggregates = seen
        .filter((event): event is Extract<InteractionEventEnvelope, { kind: 'activity-changed' }> =>
          event.kind === 'activity-changed'
            && event.payload.activity?.target === 'work-aggregate',
        )
        .map((event) => event.payload.activity?.label)
      expect(advisories, fixtureCase.id).toEqual(fixtureCase.expected.advisorySummaries)
      expect(aggregates, fixtureCase.id).toEqual(fixtureCase.expected.aggregateLabels)
      expect(seen.length, fixtureCase.id).toBeLessThanOrEqual(fixtureCase.events.length * 4)
    }
  })
})
