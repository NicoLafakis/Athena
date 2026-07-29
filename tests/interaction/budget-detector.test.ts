import { describe, expect, it } from 'vitest'
import { BudgetThresholdDetector } from '../../src/interaction/detectors/budget.js'
import type { RunLimits, RunUsage } from '../../src/engine/types.js'

function usage(overrides: Partial<RunUsage> = {}): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    toolCalls: 0,
    turns: 0,
    durationMs: 0,
    ...overrides,
  }
}

describe('BudgetThresholdDetector', () => {
  const limits: RunLimits = { maxTokens: 1_000, maxCostUsd: 10, maxToolCalls: 100 }

  it('emits each threshold once and omits exact usage from unsolicited text', () => {
    const detector = new BudgetThresholdDetector()
    expect(detector.accept(usage({ inputTokens: 749 }), limits)).toEqual([])
    expect(detector.accept(usage({ inputTokens: 750 }), limits)).toMatchObject([
      { threshold: 75, priority: 'polite', summary: 'Run budget reached 75%.' },
    ])
    expect(detector.accept(usage({ inputTokens: 899, costUsd: 8.5 }), limits)).toEqual([])
    expect(detector.accept(usage({ inputTokens: 900, costUsd: 9.5 }), limits)).toMatchObject([
      { threshold: 90, priority: 'assertive', summary: 'Run budget reached 90%.' },
    ])
    expect(detector.accept(usage({ inputTokens: 999, costUsd: 9.9 }), limits)).toEqual([])
    expect(JSON.stringify(detector)).not.toContain('9.9')
  })

  it('uses the highest defined utilization and ignores missing or invalid limits', () => {
    const detector = new BudgetThresholdDetector()
    expect(detector.accept(usage({ toolCalls: 75 }), { maxToolCalls: 100 })).toHaveLength(1)
    expect(new BudgetThresholdDetector().accept(usage({ inputTokens: 1_000 }), {})).toEqual([])
    expect(new BudgetThresholdDetector().accept(usage({ inputTokens: 1_000 }), { maxTokens: 0 })).toEqual([])
  })

  it('emits both thresholds if one sparse snapshot jumps past both', () => {
    expect(new BudgetThresholdDetector().accept(
      usage({ costUsd: 9.5 }),
      { maxCostUsd: 10 },
    ).map((signal) => signal.threshold)).toEqual([75, 90])
  })
})
