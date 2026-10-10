import { describe, expect, it, vi } from 'vitest'
import { AnthropicClient } from '../../src/engine/client.js'
import { OpenAIClient } from '../../src/engine/openai-client.js'

describe('journal physical provider attempt budget', () => {
  it('disables SDK retries and wrapper retries for a one-attempt Anthropic completion', async () => {
    const client = new AnthropicClient('fixture-key')
    const create = vi.fn(async () => { throw Object.assign(new Error('overloaded'), { status: 529 }) })
    ;(client as unknown as { sdk: { messages: { create: typeof create } } }).sdk = { messages: { create } }
    await expect(client.complete({ model: 'fixture', prompt: 'fixture', maxTokens: 1400, maxAttempts: 1 })).rejects.toThrow('overloaded')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]).toEqual([{ model: 'fixture', max_tokens: 1400, messages: [{ role: 'user', content: 'fixture' }] }, { signal: undefined, maxRetries: 0 }])
  })
  it('makes one actual injected fetch call for a one-attempt OpenAI completion', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 500 }))
    const client = new OpenAIClient('fixture-key', undefined, 'openai', undefined, fetcher)
    await expect(client.complete({ model: 'fixture', prompt: 'fixture', maxTokens: 1400, maxAttempts: 1 })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as { tools: unknown[]; max_output_tokens: number }
    expect(body.tools).toBeUndefined()
    expect(body.max_output_tokens).toBe(1400)
  })
})
