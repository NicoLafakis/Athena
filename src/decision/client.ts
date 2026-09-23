import { performance } from 'node:perf_hooks'
import { z, type ZodType } from 'zod'

export type DecisionFallbackReason =
  | 'disabled'
  | 'unavailable'
  | 'invalid-response'
  | 'timeout'
  | 'rate-limited'
  | 'cancelled'
  | 'provider-error'
  | 'input-too-large'
  | 'invalid-input'

export type DecisionResult<Output> =
  | { status: 'decision'; value: Output; usage?: DecisionUsage }
  | { status: 'fallback'; reason: DecisionFallbackReason; usage?: DecisionUsage }

export interface DecisionUsage {
  inputTokens: number
  outputTokens: number
}

export interface DecisionRequest<Output> {
  /** Provider-specific input. Keep it to the explicitly approved decision payload. */
  payload: unknown
  /** The caller's contract for the structured answer. */
  responseSchema: ZodType<Output>
}

export interface DecisionTransport {
  evaluate(payload: unknown, options: { signal: AbortSignal }): Promise<DecisionTransportOutput>
}

export interface DecisionTransportOutput {
  value: unknown
  usage?: DecisionUsage
}

export type DecisionTelemetryOutcome =
  | 'decision'
  | DecisionFallbackReason

/** Content-free event: provider/model, outcome, and elapsed time only. */
export interface DecisionTelemetryEvent {
  provider: string
  model: string
  outcome: DecisionTelemetryOutcome
  elapsedMs: number
  inputTokens?: number
  outputTokens?: number
}

export type DecisionTelemetryRecorder = (event: DecisionTelemetryEvent) => void

export interface DecisionClient {
  evaluate<Output>(
    request: DecisionRequest<Output>,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionResult<Output>>
}

export class DecisionTransportError extends Error {
  constructor(message: string, readonly kind: 'rate-limited' | 'provider-error') {
    super(message)
    this.name = 'DecisionTransportError'
  }
}

export interface OptionalDecisionClientOptions {
  enabled: boolean
  provider: string
  model: string
  transport?: DecisionTransport
  timeoutMs?: number
  telemetry?: DecisionTelemetryRecorder
}

class DecisionTimeoutError extends Error {}
class DecisionCancelledError extends Error {}

function isRateLimit(error: unknown): boolean {
  if (error instanceof DecisionTransportError) return error.kind === 'rate-limited'
  if (typeof error !== 'object' || error === null) return false
  const details = error as { status?: unknown; code?: unknown }
  return details.status === 429 || details.code === 'rate_limit_exceeded'
}

/** Optional structured decision boundary, deliberately separate from ModelClient. */
export class OptionalDecisionClient implements DecisionClient {
  private readonly enabled: boolean
  private readonly provider: string
  private readonly model: string
  private readonly transport?: DecisionTransport
  private readonly timeoutMs: number
  private readonly telemetry?: DecisionTelemetryRecorder

  constructor(options: OptionalDecisionClientOptions) {
    this.enabled = options.enabled
    this.provider = options.provider
    this.model = options.model
    this.transport = options.transport
    this.timeoutMs = options.timeoutMs ?? 1_000
    this.telemetry = options.telemetry
  }

  async evaluate<Output>(
    request: DecisionRequest<Output>,
    options: { signal?: AbortSignal } = {},
  ): Promise<DecisionResult<Output>> {
    const startedAt = performance.now()
    if (!this.enabled) return this.finish({ status: 'fallback', reason: 'disabled' }, 'disabled', startedAt)
    if (!this.transport) return this.finish({ status: 'fallback', reason: 'unavailable' }, 'unavailable', startedAt)
    if (options.signal?.aborted) return this.finish({ status: 'fallback', reason: 'cancelled' }, 'cancelled', startedAt)

    const controller = new AbortController()
    let timeoutReached = false
    let callerCancelled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onCallerAbort: (() => void) | undefined

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timeoutReached = true
        const error = new DecisionTimeoutError('Decision request timed out')
        controller.abort(error)
        reject(error)
      }, this.timeoutMs)
    })

    const cancelPromise = new Promise<never>((_resolve, reject) => {
      const signal = options.signal
      if (!signal) return
      onCallerAbort = () => {
        callerCancelled = true
        const error = new DecisionCancelledError('Decision request cancelled')
        controller.abort(signal.reason ?? error)
        reject(error)
      }
      signal.addEventListener('abort', onCallerAbort, { once: true })
    })

    try {
      const response = await Promise.race([
        this.transport.evaluate(request.payload, { signal: controller.signal }),
        timeoutPromise,
        cancelPromise,
      ])
      const usage = parseUsage(response.usage)
      const parsed = request.responseSchema.safeParse(response.value)
      if (!parsed.success) {
        return this.finish({ status: 'fallback', reason: 'invalid-response' }, 'invalid-response', startedAt, usage)
      }
      return this.finish({ status: 'decision', value: parsed.data }, 'decision', startedAt, usage)
    } catch (error) {
      if (timeoutReached || error instanceof DecisionTimeoutError) {
        return this.finish({ status: 'fallback', reason: 'timeout' }, 'timeout', startedAt)
      }
      if (callerCancelled || error instanceof DecisionCancelledError) {
        return this.finish({ status: 'fallback', reason: 'cancelled' }, 'cancelled', startedAt)
      }
      if (isRateLimit(error)) {
        return this.finish({ status: 'fallback', reason: 'rate-limited' }, 'rate-limited', startedAt)
      }
      return this.finish({ status: 'fallback', reason: 'provider-error' }, 'provider-error', startedAt)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (options.signal && onCallerAbort) options.signal.removeEventListener('abort', onCallerAbort)
    }
  }

  private finish<Output>(
    result: DecisionResult<Output>,
    outcome: DecisionTelemetryOutcome,
    startedAt: number,
    usage?: { inputTokens: number; outputTokens: number },
  ): DecisionResult<Output> {
    try {
      this.telemetry?.({
        provider: this.provider,
        model: this.model,
        outcome,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
      })
    } catch {
      // An optional telemetry sink cannot block a decision or its fallback.
    }
    return usage ? { ...result, usage } : result
  }
}

function parseUsage(value: DecisionUsage | undefined): DecisionUsage | undefined {
  if (!value) return undefined
  const parsed = z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict().safeParse(value)
  return parsed.success ? parsed.data : undefined
}
