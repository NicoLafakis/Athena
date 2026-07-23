import { describe, it, expect, beforeEach } from 'vitest'
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
    expect(log).toEqual(['a:stream', 'a:complete', 'b:complete', 'b:stream'])
  })

  it('is itself a ModelClient, so engine/orchestrator/compactor can hold it directly', () => {
    const holder: ModelClient = new ClientHolder(new MockAnthropicClient([]))
    expect(typeof holder.stream).toBe('function')
    expect(typeof holder.complete).toBe('function')
  })
})

describe('AnthropicClient baseURL', () => {
  beforeEach(() => {
    delete process.env['ANTHROPIC_BASE_URL']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_AUTH_TOKEN']
  })

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

describe('AnthropicClient authMode', () => {
  beforeEach(() => {
    delete process.env['ANTHROPIC_BASE_URL']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_AUTH_TOKEN']
  })

  type SdkAuth = { sdk: { apiKey: string | null; authToken: string | null | undefined } }

  it("bearer mode sends the key as authToken (Authorization: Bearer) with apiKey null'd out", () => {
    // apiKey must be explicitly null so the SDK never auto-picks ANTHROPIC_API_KEY
    // from the env and sends BOTH headers (Moonshot 401s on x-api-key).
    const c = new AnthropicClient('sk-x', 'https://api.moonshot.ai/anthropic', 'bearer')
    const { sdk } = c as unknown as SdkAuth
    expect(sdk.authToken).toBe('sk-x')
    expect(sdk.apiKey).toBeNull()
  })

  it('x-api-key mode (the default) keeps the key on apiKey with no authToken', () => {
    const c = new AnthropicClient('sk-x')
    const { sdk } = c as unknown as SdkAuth
    expect(sdk.apiKey).toBe('sk-x')
    expect(sdk.authToken == null).toBe(true)
  })
})
