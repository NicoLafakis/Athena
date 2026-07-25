import type { RunLimits, RunResult, RunUsage, TokenUsage } from './types.js'

const UNLIMITED = Number.POSITIVE_INFINITY

export class RunBudget {
  private readonly startedAt = Date.now()
  private readonly usage: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    toolCalls: 0,
    turns: 0,
    durationMs: 0,
  }
  private result: RunResult = { status: 'completed', reason: 'completed', usage: this.usage }

  constructor(private readonly limits: RunLimits = {}) {}

  getLimits(): Readonly<RunLimits> {
    return this.limits
  }

  snapshot(): RunUsage {
    return { ...this.usage, durationMs: Date.now() - this.startedAt }
  }

  getResult(): RunResult {
    return { ...this.result, usage: this.snapshot() }
  }

  remainingDurationMs(): number {
    return Math.max(
      0,
      (this.limits.maxDurationMs ?? UNLIMITED) - (Date.now() - this.startedAt),
    )
  }

  beginTurn(): string | null {
    const reason = this.checkTime() ?? this.checkLimit('maxTurns', this.usage.turns, 1)
    if (reason) return reason
    this.usage.turns++
    return null
  }

  beforeModelCall(estimatedInputTokens = 0): string | null {
    const reason =
      this.checkTime() ??
      this.checkLimit('maxModelCalls', this.usage.modelCalls, 1) ??
      this.checkLimit(
        'maxTokens',
        this.usage.inputTokens +
          this.usage.outputTokens +
          this.usage.cacheReadTokens +
          this.usage.cacheWriteTokens,
        Math.max(0, estimatedInputTokens),
      )
    if (reason) return reason
    this.usage.modelCalls++
    return null
  }

  beforeToolCalls(count = 1): string | null {
    const reason =
      this.checkTime() ?? this.checkLimit('maxToolCalls', this.usage.toolCalls, count)
    if (reason) return reason
    this.usage.toolCalls += count
    return null
  }

  addUsage(usage: TokenUsage, costUsd: number): string | null {
    this.usage.inputTokens += usage.inputTokens
    this.usage.outputTokens += usage.outputTokens
    this.usage.cacheReadTokens += usage.cacheReadTokens
    this.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    this.usage.costUsd += costUsd
    const totalTokens =
      this.usage.inputTokens +
      this.usage.outputTokens +
      this.usage.cacheReadTokens +
      this.usage.cacheWriteTokens
    if (totalTokens > (this.limits.maxTokens ?? UNLIMITED)) return 'maxTokens'
    if (this.usage.costUsd > (this.limits.maxCostUsd ?? UNLIMITED)) return 'maxCostUsd'
    return this.checkTime()
  }

  limited(reason: string): RunResult {
    this.result = { status: 'limit', reason, usage: this.usage }
    return this.getResult()
  }

  aborted(reason = 'aborted'): RunResult {
    this.result = { status: 'aborted', reason, usage: this.usage }
    return this.getResult()
  }

  failed(reason: string): RunResult {
    this.result = { status: 'error', reason, usage: this.usage }
    return this.getResult()
  }

  completed(): RunResult {
    this.result = { status: 'completed', reason: 'completed', usage: this.usage }
    return this.getResult()
  }

  private checkTime(): string | null {
    return Date.now() - this.startedAt >= (this.limits.maxDurationMs ?? UNLIMITED)
      ? 'maxDurationMs'
      : null
  }

  private checkLimit(
    key: 'maxTurns' | 'maxModelCalls' | 'maxToolCalls' | 'maxTokens',
    current: number,
    addition: number,
  ): string | null {
    return current + addition > (this.limits[key] ?? UNLIMITED) ? key : null
  }
}
