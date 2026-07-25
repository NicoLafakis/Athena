import { readFileSync } from 'node:fs'
import type { ContentBlock, Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient, StreamCallbacks, StreamResult } from './client.js'

interface FixtureStep {
  text?: string
  toolUses?: Array<{ id: string; name: string; input: unknown }>
  stopReason?: 'end_turn' | 'tool_use'
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}

/** Deterministic process-level provider used only when NODE_ENV=test. It lets
 * the real CLI binary, runtime assembly, session, trace, and output contracts be
 * tested without network calls or paid provider credentials. */
export class FixtureModelClient implements ModelClient {
  private readonly steps: FixtureStep[]
  private cursor = 0

  constructor(file: string) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(raw)) throw new Error('Fixture model script must be a JSON array')
    this.steps = raw as FixtureStep[]
  }

  async stream(
    params: { messages: MessageParam[]; signal: AbortSignal },
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    if (params.signal.aborted) throw new DOMException('aborted', 'AbortError')
    const step = this.steps[this.cursor++]
    if (!step) throw new Error(`Fixture model script exhausted at call ${this.cursor - 1}`)
    const content: ContentBlock[] = []
    if (step.text !== undefined) {
      callbacks.onTextDelta(step.text)
      content.push({ type: 'text', text: step.text, citations: null } as ContentBlock)
    }
    for (const tool of step.toolUses ?? []) {
      content.push({
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: tool.input,
      } as ContentBlock)
    }
    const usage = step.usage ?? {}
    const message: Message = {
      id: `fixture-${this.cursor}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content,
      stop_reason: step.stopReason ?? ((step.toolUses?.length ?? 0) > 0 ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: {
        input_tokens: usage.inputTokens ?? 10,
        output_tokens: usage.outputTokens ?? 5,
        cache_read_input_tokens: usage.cacheReadTokens ?? 0,
        cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
      } as Message['usage'],
    }
    return { message }
  }

  async complete(): Promise<string> {
    return 'fixture summary'
  }
}
