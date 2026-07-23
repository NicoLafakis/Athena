import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Message, Tool } from '@anthropic-ai/sdk/resources/messages'
import type { ThinkingParam, Effort } from '../brain/models.js'

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void
  onThinkingDelta: (delta: string) => void
}

export interface StreamResult {
  message: Message
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
  complete(params: { model: string; prompt: string; maxTokens: number }): Promise<string>
}

const MAX_RETRIES = 3

export class AnthropicClient implements ModelClient {
  private readonly sdk: Anthropic

  constructor(apiKey?: string, baseURL?: string) {
    this.sdk = new Anthropic({ apiKey, baseURL })
  }

  async stream(
    params: Parameters<ModelClient['stream']>[0],
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    let lastError: unknown
    // Only clean-slate failures are retried: once any delta reached the caller,
    // a retry would re-stream the same text into the transcript (double render).
    let deltaEmitted = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Forward-compat pass-through: the installed SDK (0.57) does not yet type
        // output_config or thinking:{type:'adaptive'}, but it forwards unknown body
        // fields verbatim to the wire, and both are GA (no beta header). Build the body
        // untyped and cast at the call. Never send legacy thinking (budget_tokens) here —
        // it 400s on sonnet-5/opus-4-8/fable-5; resolveModelRequest guarantees we don't.
        const body: Record<string, unknown> = {
          model: params.model,
          system: params.system,
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
        return { message: await stream.finalMessage() }
      } catch (err) {
        lastError = err
        if (params.signal.aborted) throw err
        const status = (err as { status?: number }).status
        const retryable = status === 429 || status === 529 || (status !== undefined && status >= 500)
        if (!retryable || deltaEmitted || attempt === MAX_RETRIES - 1) throw err
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
    throw lastError
  }

  async complete(params: { model: string; prompt: string; maxTokens: number }): Promise<string> {
    const res = await this.sdk.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: [{ role: 'user', content: params.prompt }],
    })
    return res.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }
}
