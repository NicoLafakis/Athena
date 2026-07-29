import { describe, expect, it } from 'vitest'
import { announcementFor } from '../../src/interaction/announcements.js'
import { applyInteractionEnvelope, createInteractionSnapshot } from '../../src/interaction/state.js'
import type { InteractionEventEnvelope } from '../../src/interaction/types.js'
import { RepeatedFailureDetector } from '../../src/interaction/detectors/repeated-failure.js'
import { VerificationInvalidationDetector } from '../../src/interaction/detectors/verification.js'
import { BudgetThresholdDetector } from '../../src/interaction/detectors/budget.js'
import { WorkAggregationDetector } from '../../src/interaction/detectors/work-aggregation.js'

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

  it('keeps bounded proactive detector p95 below 5 ms over 20k lifecycle pairs', () => {
    const repeated = new RepeatedFailureDetector()
    const verification = new VerificationInvalidationDetector()
    const budget = new BudgetThresholdDetector()
    const work = new WorkAggregationDetector()
    const durations: number[] = []

    for (let index = 0; index < 20_000; index++) {
      const request = {
        type: 'tool-request' as const,
        id: `tool-${index}`,
        name: index % 5 === 0 ? 'Write' : 'Read',
        input: { file_path: `file-${index % 4}.ts` },
      }
      const result = {
        type: 'tool-result' as const,
        id: request.id,
        name: request.name,
        output: 'bounded fixture output',
        isError: index % 3 === 0,
      }
      const started = performance.now()
      repeated.accept(request)
      verification.accept(request)
      repeated.accept(result)
      verification.accept(result)
      budget.accept({
        inputTokens: index,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        modelCalls: index,
        toolCalls: index,
        turns: 1,
        durationMs: index,
      }, { maxTokens: 40_000, maxToolCalls: 40_000 })
      work.accept({
        type: 'background-status',
        taskId: `bg-${index % 4}`,
        status: index % 2 === 0 ? 'running' : 'completed',
        awaited: false,
      })
      durations.push(performance.now() - started)
    }

    durations.sort((left, right) => left - right)
    expect(durations[Math.floor(durations.length * 0.95)]!).toBeLessThan(5)
  })
})
