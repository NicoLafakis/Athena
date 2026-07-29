import type { RunLimits, RunUsage } from '../../engine/types.js'

export interface BudgetThresholdSignal {
  threshold: 75 | 90
  priority: 'polite' | 'assertive'
  summary: string
  action: string
}

const THRESHOLDS = [75, 90] as const

function ratio(value: number, limit: number | undefined): number {
  return limit !== undefined && Number.isFinite(limit) && limit > 0 ? value / limit : 0
}

function utilization(usage: RunUsage, limits: RunLimits): number {
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return Math.max(
    ratio(tokens, limits.maxTokens),
    ratio(usage.costUsd, limits.maxCostUsd),
    ratio(usage.modelCalls, limits.maxModelCalls),
    ratio(usage.toolCalls, limits.maxToolCalls),
    ratio(usage.turns, limits.maxTurns),
    ratio(usage.durationMs, limits.maxDurationMs),
  )
}

/** Run-local threshold detector. Exact usage stays in the source event for on-demand detail. */
export class BudgetThresholdDetector {
  private readonly emitted = new Set<number>()

  accept(usage: RunUsage, limits: RunLimits): BudgetThresholdSignal[] {
    const percent = utilization(usage, limits) * 100
    const signals: BudgetThresholdSignal[] = []
    for (const threshold of THRESHOLDS) {
      if (percent < threshold || this.emitted.has(threshold)) continue
      this.emitted.add(threshold)
      signals.push({
        threshold,
        priority: threshold === 75 ? 'polite' : 'assertive',
        summary: `Run budget reached ${threshold}%.`,
        action: 'Review current usage and limits before continuing.',
      })
    }
    return signals
  }
}
