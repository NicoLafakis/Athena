import { describe, it, expect } from 'vitest'
import { ClientHolder } from '../../src/engine/client-holder.js'
import { AnthropicClient } from '../../src/engine/client.js'
import type { ModelClient, StreamResult } from '../../src/engine/client.js'
import { MockAnthropicClient, textBlock } from '../helpers/mock-client.js'

function namedClient(name: string, log: string[]): ModelClient {
  const inner = new MockAnthropicClient([{ blocks: [textBlock(name)], stopReason: 'end_turn' }])
  return {
    stream(params, callbacks): Promise<StreamResult> {
      log.push(`${name}:stream`)
      return inner.stream(params, callbacks)
    },
    complete(params): Promise<string> {
      log.push(`${name}:complete`)
      return inner.complete(params)
    },
  }
}

describe('ClientHolder', () => {
  it('routes stream and complete through the CURRENT client, and swap re-routes both', async () => {
    const log: string[] = []
    const holder = new ClientHolder(namedClient('a', log))
    await holder.stream(
      {
        model: 'm',
        system: 's',
        messages: [],
        tools: [],
        maxTokens: 10,
        signal: new AbortController().signal,
      },
      { onTextDelta: () => {}, onThinkingDelta: () => {} },
    )
    await holder.complete({ model: 'm', prompt: 'p', maxTokens: 10 })
    holder.swap(namedClient('b', log))
    await holder.complete({ model: 'm', prompt: 'p', maxTokens: 10 })
    expect(log).toEqual(['a:stream', 'a:complete', 'b:complete'])
  })

  it('is itself a ModelClient, so engine/orchestrator/compactor can hold it directly', () => {
    const holder: ModelClient = new ClientHolder(new MockAnthropicClient([]))
    expect(typeof holder.stream).toBe('function')
    expect(typeof holder.complete).toBe('function')
  })
})

describe('AnthropicClient baseURL', () => {
  it('passes baseURL through to the SDK when given', () => {
    const c = new AnthropicClient('sk-x', 'https://api.moonshot.ai/anthropic')
    const sdk = (c as unknown as { sdk: { baseURL: string } }).sdk
    expect(sdk.baseURL).toBe('https://api.moonshot.ai/anthropic')
  })

  it('keeps the SDK default when omitted', () => {
    const c = new AnthropicClient('sk-x')
    const sdk = (c as unknown as { sdk: { baseURL: string } }).sdk
    expect(sdk.baseURL).toBe('https://api.anthropic.com')
  })
})
