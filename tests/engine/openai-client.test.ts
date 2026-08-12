import { describe, expect, it, vi } from 'vitest'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import {
  OpenAIClient,
  parseSseFrames,
  toAnthropicMessage,
  toResponsesInput,
  toResponsesTools,
} from '../../src/engine/openai-client.js'

function sse(events: Array<string>): string {
  return events.map((data) => `data: ${data}\n\n`).join('')
}

function textDone(text: string, usage: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-5.6-luna',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 10, output_tokens: 2, ...usage },
    },
  })
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

describe('OpenAI provider translation', () => {
  it('translates Anthropic history into Responses input items, preserving order', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'read x' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'thinking', thinking: 'hidden', signature: 'sig' } as never,
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
          { type: 'text', text: 'now summarize' },
        ],
      },
    ]
    expect(toResponsesInput(messages)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'read x' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'reading' }],
      },
      { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"path":"x"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'file body' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'now summarize' }],
      },
    ])
  })

  it('flattens rich tool_result content and never drops a block silently', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_9',
            content: [
              { type: 'text', text: 'partial' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } } as never,
            ],
          },
        ],
      },
    ]
    const items = toResponsesInput(messages) as Array<{ output?: string }>
    expect(items[0]!.output).toContain('partial')
    expect(items[0]!.output).toContain('[unsupported image content omitted by the OpenAI provider]')
  })

  it('maps Anthropic tool definitions to Responses function tools', () => {
    const tools = [
      { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } },
    ] as unknown as Tool[]
    expect(toResponsesTools(tools)).toEqual([
      {
        type: 'function',
        name: 'Read',
        description: 'read a file',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
    ])
  })

  it('converts Responses output into an Anthropic-shaped tool_use message with normalized usage', () => {
    const message = toAnthropicMessage(
      {
        id: 'resp_2',
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'opening x' }] },
          { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"x"}' },
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens: 12,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
      'gpt-5.6-sol',
    )
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'opening x' })
    expect(message.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'Read',
      input: { path: 'x' },
    })
    // Anthropic semantics: input_tokens excludes the cached subset (no double-count).
    expect(message.usage.input_tokens).toBe(70)
    expect(message.usage.cache_read_input_tokens).toBe(30)
    expect(message.usage.output_tokens).toBe(12)
  })

  it('maps incomplete-at-max-output to max_tokens and malformed tool arguments to a schema-visible {}', () => {
    const message = toAnthropicMessage(
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'function_call', call_id: 'call_2', name: 'Read', arguments: '{nope' }],
      },
      'gpt-5.6-luna',
    )
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content[0]).toMatchObject({ type: 'tool_use', input: {} })
    const plain = toAnthropicMessage(
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      'gpt-5.6-luna',
    )
    expect(plain.stop_reason).toBe('max_tokens')
  })

  it('parses SSE frames across chunk boundaries', () => {
    const first = parseSseFrames('data: {"a":1}\n\nda')
    expect(first.frames).toEqual([{ event: '', data: '{"a":1}' }])
    expect(first.rest).toBe('da')
    const second = parseSseFrames(`${first.rest}ta: {"b":2}\r\n\r\n`)
    expect(second.frames).toEqual([{ event: '', data: '{"b":2}' }])
    expect(second.rest).toBe('')
  })
})

describe('OpenAIClient', () => {
  it('streams text deltas and resolves the translated final message', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse(sse([
        JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' }),
        JSON.stringify({ type: 'response.output_text.delta', delta: ' world' }),
        textDone('Hello world', { input_tokens_details: { cached_tokens: 4 } }),
      ])),
    )
    const client = new OpenAIClient('sk-test', undefined, 'openai', undefined, fetchMock)
    const deltas: string[] = []
    const result = await client.stream(
      {
        model: 'gpt-5.6-luna',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 64,
        signal: new AbortController().signal,
        effort: 'high',
      },
      { onTextDelta: (d) => deltas.push(d), onThinkingDelta: () => {} },
    )
    expect(deltas).toEqual(['Hello', ' world'])
    expect(result.message.content[0]).toMatchObject({ type: 'text', text: 'Hello world' })
    expect(result.message.usage.input_tokens).toBe(6)
    expect(result.message.usage.cache_read_input_tokens).toBe(4)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.model).toBe('gpt-5.6-luna')
    expect(body.instructions).toBe('sys')
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  it('streams reasoning summary deltas into the thinking channel', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse(sse([
        JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'thinking…' }),
        textDone('done'),
      ])),
    )
    const client = new OpenAIClient('sk-test', undefined, 'openai', undefined, fetchMock)
    const thinking: string[] = []
    await client.stream(
      {
        model: 'gpt-5.6-luna',
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 64,
        signal: new AbortController().signal,
      },
      { onTextDelta: () => {}, onThinkingDelta: (d) => thinking.push(d) },
    )
    expect(thinking).toEqual(['thinking…'])
  })

  it('retries a 500 once and succeeds; a 401 never retries', async () => {
    let calls = 0
    const retryFetch = vi.fn(async () => {
      calls++
      if (calls === 1) return new Response('boom', { status: 500, statusText: 'Server Error' })
      return okResponse(sse([textDone('recovered')]))
    })
    const client = new OpenAIClient('sk-test', undefined, 'openai', undefined, retryFetch)
    const result = await client.stream(
      {
        model: 'gpt-5.6-luna',
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 64,
        signal: new AbortController().signal,
      },
      { onTextDelta: () => {}, onThinkingDelta: () => {} },
    )
    expect(result.message.content[0]).toMatchObject({ text: 'recovered' })
    expect(retryFetch).toHaveBeenCalledTimes(2)

    const authFetch = vi.fn(async () => new Response('bad key', { status: 401 }))
    const denied = new OpenAIClient('sk-bad', undefined, 'openai', undefined, authFetch)
    await expect(
      denied.stream(
        {
          model: 'gpt-5.6-luna',
          system: '',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          maxTokens: 64,
          signal: new AbortController().signal,
        },
        { onTextDelta: () => {}, onThinkingDelta: () => {} },
      ),
    ).rejects.toThrow(/OpenAI 401/)
    expect(authFetch).toHaveBeenCalledTimes(1)
  })

  it('never retries after a delta was emitted (no double render)', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse(sse([
        JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }),
        JSON.stringify({ type: 'error', error: { message: 'stream died' } }),
      ])),
    )
    const client = new OpenAIClient('sk-test', undefined, 'openai', undefined, fetchMock)
    await expect(
      client.stream(
        {
          model: 'gpt-5.6-luna',
          system: '',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          maxTokens: 64,
          signal: new AbortController().signal,
        },
        { onTextDelta: () => {}, onThinkingDelta: () => {} },
      ),
    ).rejects.toThrow(/stream died/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('completes one-shot prompts and records normalized telemetry meters', async () => {
    const telemetry = vi.fn()
    const fetchMock = vi.fn(async () =>
      okResponse(JSON.stringify({
        id: 'resp_3',
        model: 'gpt-5.6-luna',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'summary' }] }],
        usage: {
          input_tokens: 50,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 3 },
        },
      })),
    )
    const client = new OpenAIClient('sk-test', undefined, 'openai', telemetry, fetchMock)
    const result = await client.completeDetailed({ model: 'gpt-5.6-luna', prompt: 'p', maxTokens: 32 })
    expect(result.text).toBe('summary')
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 8, cacheReadTokens: 20 })
    expect(telemetry).toHaveBeenCalledTimes(1)
    const attempt = telemetry.mock.calls[0]![0] as { provider: string; meters: Array<{ canonical: string; value: number }> }
    expect(attempt.provider).toBe('openai')
    expect(attempt.meters).toEqual([
      { name: 'prompt_total', value: 50, unit: 'token', canonical: 'prompt_total' },
      { name: 'cache_read', value: 20, unit: 'token', canonical: 'cache_read' },
      { name: 'completion_total', value: 8, unit: 'token', canonical: 'completion_total' },
      { name: 'reasoning', value: 3, unit: 'token', canonical: 'reasoning' },
    ])
  })
})
