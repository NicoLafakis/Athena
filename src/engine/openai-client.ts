// src/engine/openai-client.ts — ModelClient for OpenAI's Responses API. The engine speaks
// Anthropic-shaped messages internally; this client is the ONLY translation boundary:
// Anthropic MessageParam/Tool in, Anthropic-shaped Message out, so loop.ts, the session
// store, and the compactor never learn which provider answered. Hand-rolled fetch + SSE
// (no SDK dependency), mirroring the retry/telemetry discipline of AnthropicClient.
import type { Message, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import type { Provider } from '../../api-calculator/src/types.js'
import type { TokenUsage } from './types.js'
import type { CompletionResult, ModelClient, StreamCallbacks, StreamResult } from './client.js'
import type { TelemetryRecorder } from './telemetry.js'
import { newLogicalRequestId, openaiUsageMeters } from './telemetry.js'

const DEFAULT_BASE_URL = 'https://api.openai.com'
const MAX_RETRIES = 3

/** Responses API usage envelope (subset semantics: cached/reasoning are included in the
 *  totals, never added on top — see api-calculator AGENTS.md overlap rule). */
export interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

interface ResponsesOutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: Array<{ type?: string; text?: string }>
}

interface ResponsesObject {
  id?: string
  model?: string
  status?: string
  incomplete_details?: { reason?: string } | null
  error?: { message?: string } | null
  output?: ResponsesOutputItem[]
  usage?: ResponsesUsage
}

/** Anthropic tool_result content -> the plain string OpenAI function_call_output wants. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Array<{ type: string; text?: string }>) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(`[unsupported ${block.type} content omitted by the OpenAI provider]`)
  }
  return parts.join('\n')
}

/** Anthropic message history -> Responses input items. Order is preserved: an assistant
 *  turn [text, tool_use] becomes a message item followed by a function_call item, and
 *  tool_result blocks become function_call_output items with matching call_ids.
 *  Thinking/redacted-thinking blocks are Anthropic-only state and are dropped. */
export function toResponsesInput(messages: MessageParam[]): unknown[] {
  const items: unknown[] = []
  for (const message of messages) {
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content
    const pendingText: string[] = []
    const flushText = (): void => {
      if (pendingText.length === 0) return
      items.push({
        type: 'message',
        role: message.role,
        content: [
          {
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: pendingText.join('\n'),
          },
        ],
      })
      pendingText.length = 0
    }
    for (const block of blocks) {
      if (block.type === 'text') {
        pendingText.push(block.text)
        continue
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') continue
      flushText()
      if (block.type === 'tool_use') {
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        })
        continue
      }
      if (block.type === 'tool_result') {
        items.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: toolResultText(block.content),
        })
        continue
      }
      pendingText.push(`[unsupported ${String((block as { type?: unknown }).type)} content omitted by the OpenAI provider]`)
    }
    flushText()
  }
  return items
}

/** Anthropic tool definitions -> Responses function tools. */
export function toResponsesTools(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.input_schema,
    strict: false,
  }))
}

function safeParseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    // Malformed arguments land as an empty object; the tool's own schema validation
    // surfaces the real, actionable error instead of a JSON stack.
    return {}
  }
}

/** Responses object -> the Anthropic-shaped Message the engine runs on. Usage is
 *  normalized to Anthropic semantics here (uncached input excludes the cached subset)
 *  so usageCostUsd and the token budget never double-count cache reads. */
export function toAnthropicMessage(response: ResponsesObject, fallbackModel: string): Message {
  const content: Array<Record<string, unknown>> = []
  let hasToolCall = false
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text })
        }
      }
      continue
    }
    if (item.type === 'function_call') {
      hasToolCall = true
      content.push({
        type: 'tool_use',
        id: item.call_id ?? item.id ?? '',
        name: item.name ?? '',
        input: safeParseToolArguments(item.arguments),
      })
    }
  }
  const usage = response.usage ?? {}
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  const totalInput = usage.input_tokens ?? 0
  const stopReason = hasToolCall
    ? 'tool_use'
    : response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
      ? 'max_tokens'
      : 'end_turn'
  return {
    id: response.id ?? 'msg_openai',
    type: 'message',
    role: 'assistant',
    model: response.model ?? fallbackModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, totalInput - cached),
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Message
}

function tokenUsageFromResponses(usage: ResponsesUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
}

interface SseEvent {
  event: string
  data: string
}

/** Minimal SSE frame parser: events are separated by blank lines; `data:` lines within
 *  one frame join with newlines. Unknown/comment lines are ignored. */
export function parseSseFrames(chunkBuffer: string): { frames: SseEvent[]; rest: string } {
  const frames: SseEvent[] = []
  const parts = chunkBuffer.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ''
  for (const part of parts) {
    let event = ''
    const dataLines: string[] = []
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (event || dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') })
  }
  return { frames, rest }
}

export class OpenAIClient implements ModelClient {
  private readonly baseURL: string

  constructor(
    private readonly apiKey: string,
    baseURL?: string,
    private readonly provider: Provider = 'openai',
    private readonly telemetry?: TelemetryRecorder,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseURL = (baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  }

  private buildBody(params: Parameters<ModelClient['stream']>[0], stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      instructions: params.system,
      input: toResponsesInput(params.messages),
      max_output_tokens: params.maxTokens,
      store: false,
      stream,
    }
    const tools = toResponsesTools(params.tools)
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    // OpenAI reasoning is effort-driven; Anthropic's `thinking` param has no counterpart
    // (resolveModelRequest keeps supportsThinking false for every OpenAI model, so
    // params.thinking never arrives here). Summaries feed the TUI's thinking channel.
    if (params.effort) body.reasoning = { effort: params.effort, summary: 'auto' }
    return body
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseURL}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 512)
      throw Object.assign(
        new Error(`OpenAI ${response.status}: ${detail || response.statusText}`),
        { status: response.status },
      )
    }
    return response
  }

  async stream(
    params: Parameters<ModelClient['stream']>[0],
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    let lastError: unknown
    // Same discipline as AnthropicClient: only clean-slate failures are retried — once
    // any delta reached the caller, a retry would double-render text.
    let deltaEmitted = false
    const logicalRequestId = newLogicalRequestId()
    const startedAt = new Date().toISOString()
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.post(this.buildBody(params, true), params.signal)
        if (!response.body) throw new Error('OpenAI returned no response body')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let completed: ResponsesObject | null = null
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const { frames, rest } = parseSseFrames(buffer)
          buffer = rest
          for (const frame of frames) {
            if (frame.data === '[DONE]') continue
            let payload: Record<string, unknown>
            try {
              payload = JSON.parse(frame.data) as Record<string, unknown>
            } catch {
              continue
            }
            const type = typeof payload.type === 'string' ? payload.type : frame.event
            if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
              deltaEmitted = true
              callbacks.onTextDelta(payload.delta)
            } else if (
              type === 'response.reasoning_summary_text.delta' &&
              typeof payload.delta === 'string'
            ) {
              deltaEmitted = true
              callbacks.onThinkingDelta(payload.delta)
            } else if (type === 'response.completed' || type === 'response.incomplete') {
              completed = (payload.response ?? payload) as ResponsesObject
            } else if (type === 'response.failed') {
              const failed = (payload.response ?? payload) as ResponsesObject
              throw new Error(failed.error?.message ?? 'OpenAI response failed')
            } else if (type === 'error') {
              const message = (payload.error as { message?: string } | undefined)?.message
                ?? (payload.message as string | undefined)
                ?? 'OpenAI stream error'
              throw new Error(message)
            }
          }
        }
        if (!completed) throw new Error('OpenAI stream ended without a completed response')
        const message = toAnthropicMessage(completed, params.model)
        this.recordAttempt(logicalRequestId, attempt, startedAt, params.model, completed.usage, 'stream', 'ok')
        return { message }
      } catch (err) {
        lastError = err
        const aborted = params.signal.aborted
        const status = (err as { status?: number }).status
        const retryable = status === undefined || status === 429 || status === 529 || status >= 500
        this.recordAttempt(logicalRequestId, attempt, startedAt, params.model, undefined, 'stream', aborted ? 'cancelled' : 'error')
        if (aborted) throw err
        if (!retryable || deltaEmitted || attempt === MAX_RETRIES - 1) throw err
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      }
    }
    throw lastError
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
    const signal = params.signal ?? new AbortController().signal
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.post(
          this.buildBody(
            {
              model: params.model,
              system: '',
              messages: [{ role: 'user', content: params.prompt }],
              tools: [],
              maxTokens: params.maxTokens,
              signal,
            },
            false,
          ),
          signal,
        )
        const parsed = (await response.json()) as ResponsesObject
        const message = toAnthropicMessage(parsed, params.model)
        const text = message.content
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('')
        this.recordAttempt(logicalRequestId, attempt, startedAt, params.model, parsed.usage, 'complete', 'ok')
        return { text, usage: tokenUsageFromResponses(parsed.usage) }
      } catch (err) {
        lastError = err
        const aborted = signal.aborted
        const status = (err as { status?: number }).status
        const retryable = status === undefined || status === 429 || status === 529 || status >= 500
        this.recordAttempt(logicalRequestId, attempt, startedAt, params.model, undefined, 'complete', aborted ? 'cancelled' : 'error')
        if (aborted) throw err
        if (!retryable || attempt === MAX_RETRIES - 1) throw err
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      }
    }
    throw lastError
  }

  private recordAttempt(
    logicalRequestId: string,
    attemptIndex: number,
    startedAt: string,
    model: string,
    usage: ResponsesUsage | undefined,
    operation: 'stream' | 'complete',
    outcome: 'ok' | 'error' | 'cancelled',
  ): void {
    if (!this.telemetry) return
    this.telemetry({
      external_id: `${logicalRequestId}-${attemptIndex}`,
      logical_request_id: logicalRequestId,
      provider: this.provider,
      model,
      operation,
      started_at: startedAt,
      outcome,
      meters: usage ? openaiUsageMeters(usage) : [],
    })
  }
}
