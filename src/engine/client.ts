import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Message, Tool } from '@anthropic-ai/sdk/resources/messages'
import type { ThinkingParam, Effort } from '../brain/models.js'
import type { Provider } from '../../api-calculator/src/types.js'
import type { TokenUsage } from './types.js'
import type { TelemetryRecorder } from './telemetry.js'
import { anthropicUsageMeters, newLogicalRequestId } from './telemetry.js'

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void
  onThinkingDelta: (delta: string) => void
}

export interface StreamResult {
  message: Message
}

export interface CompletionResult {
  text: string
  usage?: TokenUsage
}

/** The seam the engine depends on. Production impl wraps @anthropic-ai/sdk; tests script it. */
export interface ModelClient {
  stream(
    params: {
      model: string
      system: string
      messages: MessageParam[]
      tools: Tool[]
      maxTokens: number
      signal: AbortSignal
      thinking?: ThinkingParam
      effort?: Effort
    },
    callbacks: StreamCallbacks,
  ): Promise<StreamResult>
  /** One-shot non-streaming call used by the compactor. */
  complete(params: {
    model: string
    prompt: string
    maxTokens: number
    signal?: AbortSignal
  }): Promise<string>
  completeDetailed?(params: {
    model: string
    prompt: string
    maxTokens: number
    signal?: AbortSignal
  }): Promise<CompletionResult>
}

const MAX_RETRIES = 3

function attemptOutcomeFromError(err: unknown): 'ok' | 'error' | 'cancelled' {
  const status = (err as { status?: number }).status
  if (status === 401 || status === 403) return 'error'
  return 'error'
}

export class AnthropicClient implements ModelClient {
  private readonly sdk: Anthropic
  private readonly promptCaching: boolean

  constructor(
    apiKey?: string,
    baseURL?: string,
    authMode: 'x-api-key' | 'bearer' = 'x-api-key',
    private readonly provider: Provider = 'anthropic',
    private readonly telemetry?: TelemetryRecorder,
  ) {
    // Bearer (Moonshot's Anthropic-compatible endpoint): the key goes out as
    // Authorization: Bearer via authToken. apiKey: null is REQUIRED — otherwise the
    // SDK auto-picks ANTHROPIC_API_KEY from the env and sends BOTH auth headers,
    // which Moonshot rejects with invalid_authentication_error.
    this.sdk =
      authMode === 'bearer'
        ? new Anthropic({ apiKey: null, authToken: apiKey, baseURL })
        : new Anthropic({ apiKey, baseURL })
    this.promptCaching = baseURL === undefined
  }

  async stream(
    params: Parameters<ModelClient['stream']>[0],
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    let lastError: unknown
    // Only clean-slate failures are retried: once any delta reached the caller,
    // a retry would re-stream the same text into the transcript (double render).
    let deltaEmitted = false
    const logicalRequestId = newLogicalRequestId()
    const startedAt = new Date().toISOString()
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Forward-compat pass-through: the installed SDK (0.57) does not yet type
        // output_config or thinking:{type:'adaptive'}, but it forwards unknown body
        // fields verbatim to the wire, and both are GA (no beta header). Build the body
        // untyped and cast at the call. Never send legacy thinking (budget_tokens) here —
        // it 400s on sonnet-5/opus-4-8/fable-5; resolveModelRequest guarantees we don't.
        const body: Record<string, unknown> = {
          model: params.model,
          system: this.promptCaching
            ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
            : params.system,
          messages: params.messages,
          tools: params.tools,
          max_tokens: params.maxTokens,
        }
        if (params.thinking) body.thinking = params.thinking
        if (params.effort) body.output_config = { effort: params.effort }
        const stream = this.sdk.messages.stream(
          body as unknown as Parameters<typeof this.sdk.messages.stream>[0],
          { signal: params.signal },
        )
        stream.on('text', (delta) => {
          deltaEmitted = true
          callbacks.onTextDelta(delta)
        })
        stream.on('thinking', (delta) => {
          deltaEmitted = true
          callbacks.onThinkingDelta(delta)
        })
        // The SDK triggers a standalone unhandled Promise.reject on stream 'error' if no
        // error listener is attached (MessageStream.js). We already surface errors via the
        // finalMessage() rejection caught below; this no-op listener just disarms that footgun.
        stream.on('error', () => {})
        const message = await stream.finalMessage()
        this.recordStreamAttempt(logicalRequestId, attempt, startedAt, params.model, message, 'ok')
        return { message }
      } catch (err) {
        lastError = err
        const aborted = params.signal.aborted
        const status = (err as { status?: number }).status
        const retryable =
          status === undefined || status === 429 || status === 529 || status >= 500
        const outcome = aborted ? 'cancelled' : attemptOutcomeFromError(err)
        // Record the failed attempt before deciding whether to retry.
        this.recordStreamAttempt(logicalRequestId, attempt, startedAt, params.model, undefined, outcome)
        if (aborted) throw err
        if (!retryable || deltaEmitted || attempt === MAX_RETRIES - 1) throw err
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
    throw lastError
  }

  private recordStreamAttempt(
    logicalRequestId: string,
    attemptIndex: number,
    startedAt: string,
    model: string,
    message: Message | undefined,
    outcome: 'ok' | 'error' | 'cancelled',
  ): void {
    if (!this.telemetry) return
    this.telemetry({
      external_id: `${logicalRequestId}-${attemptIndex}`,
      logical_request_id: logicalRequestId,
      provider: this.provider,
      model,
      operation: 'stream',
      started_at: startedAt,
      outcome,
      meters: message ? anthropicUsageMeters(message.usage) : [],
    })
  }

  async complete(params: {
    model: string
    prompt: string
    maxTokens: number
    signal?: AbortSignal
  }): Promise<string> {
    return (await this.completeDetailed(params)).text
  }

  async completeDetailed(params: {
    model: string
    prompt: string
    maxTokens: number
    signal?: AbortSignal
  }): Promise<CompletionResult> {
    let lastError: unknown
    const logicalRequestId = newLogicalRequestId()
    const startedAt = new Date().toISOString()
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await this.sdk.messages.create(
          {
            model: params.model,
            max_tokens: params.maxTokens,
            messages: [{ role: 'user', content: params.prompt }],
          },
          { signal: params.signal },
        )
        const text = res.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
        this.recordCompleteAttempt(logicalRequestId, attempt, startedAt, params.model, res, 'ok')
        return {
          text,
          usage: {
            inputTokens: res.usage.input_tokens,
            outputTokens: res.usage.output_tokens,
            cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
          },
        }
      } catch (err) {
        lastError = err
        const aborted = params.signal?.aborted ?? false
        const status = (err as { status?: number }).status
        const retryable =
          status === undefined || status === 429 || status === 529 || status >= 500
        const outcome = aborted ? 'cancelled' : attemptOutcomeFromError(err)
        this.recordCompleteAttempt(logicalRequestId, attempt, startedAt, params.model, undefined, outcome)
        if (aborted) throw err
        if (!retryable || attempt === MAX_RETRIES - 1) throw err
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      }
    }
    throw lastError
  }

  private recordCompleteAttempt(
    logicalRequestId: string,
    attemptIndex: number,
    startedAt: string,
    model: string,
    message: Message | undefined,
    outcome: 'ok' | 'error' | 'cancelled',
  ): void {
    if (!this.telemetry) return
    this.telemetry({
      external_id: `${logicalRequestId}-${attemptIndex}`,
      logical_request_id: logicalRequestId,
      provider: this.provider,
      model,
      operation: 'complete',
      started_at: startedAt,
      outcome,
      meters: message ? anthropicUsageMeters(message.usage) : [],
    })
  }
}
