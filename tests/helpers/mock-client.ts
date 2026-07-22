import type { Message, MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient, StreamCallbacks, StreamResult } from '../../src/engine/client.js'

export interface ScriptedResponse {
  blocks: ContentBlock[]
  stopReason: 'end_turn' | 'tool_use'
  inputTokens?: number
  outputTokens?: number
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text, citations: null } as ContentBlock
}

export function toolUseBlock(id: string, name: string, input: unknown): ContentBlock {
  return { type: 'tool_use', id, name, input } as ContentBlock
}

export class MockAnthropicClient implements ModelClient {
  readonly calls: MessageParam[][] = []
  readonly completePrompts: string[] = []
  private cursor = 0

  constructor(
    private readonly script: ScriptedResponse[],
    private readonly summary = 'mock summary',
  ) {}

  async stream(
    params: { messages: MessageParam[]; signal: AbortSignal },
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    if (params.signal.aborted) throw new DOMException('aborted', 'AbortError')
    this.calls.push(structuredClone(params.messages))
    const step = this.script[this.cursor]
    if (!step) throw new Error(`MockAnthropicClient script exhausted at call ${this.cursor}`)
    this.cursor += 1
    for (const block of step.blocks) {
      if (block.type === 'text') callbacks.onTextDelta(block.text)
    }
    const message: Message = {
      id: `msg_${this.cursor}`,
      type: 'message',
      role: 'assistant',
      model: 'mock',
      content: step.blocks,
      stop_reason: step.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: step.inputTokens ?? 100,
        output_tokens: step.outputTokens ?? 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as Message['usage'],
    }
    return { message }
  }

  async complete(params: { prompt: string }): Promise<string> {
    this.completePrompts.push(params.prompt)
    return this.summary
  }
}
