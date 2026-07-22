import { describe, it, expect } from 'vitest'
import { AnthropicClient } from '../../src/engine/client.js'

interface FakeStream {
  on(event: string, cb: (delta: string) => void): void
  finalMessage(): Promise<unknown>
}

/** Replace the private SDK with a scripted messages.stream implementation. */
function scriptStream(client: AnthropicClient, attempts: Array<(textCb: (d: string) => void) => Promise<unknown>>): { calls: () => number } {
  let call = 0
  const sdk = {
    messages: {
      stream: (): FakeStream => {
        const behavior = attempts[call]
        call += 1
        let textCb: (d: string) => void = () => {}
        return {
          on(event, cb) {
            if (event === 'text') textCb = cb
          },
          finalMessage() {
            if (!behavior) throw new Error('script exhausted')
            return behavior((d) => textCb(d))
          },
        }
      },
    },
  }
  ;(client as unknown as { sdk: typeof sdk }).sdk = sdk
  return { calls: () => call }
}

function params() {
  return {
    model: 'mock',
    system: 'sys',
    messages: [],
    tools: [],
    maxTokens: 16,
    signal: new AbortController().signal,
  }
}

function callbacks(deltas: string[]) {
  return {
    onTextDelta: (d: string) => deltas.push(d),
    onThinkingDelta: () => {},
  }
}

function retryableError(): Error {
  return Object.assign(new Error('overloaded'), { status: 529 })
}

describe('AnthropicClient retry', () => {
  it('does NOT retry once a delta has been emitted (no double-render), even on a retryable status', async () => {
    const client = new AnthropicClient('test-key')
    const script = scriptStream(client, [
      async (emit) => {
        emit('partial text already shown')
        throw retryableError()
      },
      async () => ({ ok: true }), // must never be reached
    ])
    const deltas: string[] = []
    await expect(client.stream(params(), callbacks(deltas))).rejects.toThrow('overloaded')
    expect(script.calls()).toBe(1)
    expect(deltas).toEqual(['partial text already shown'])
  })

  it('still retries a clean-slate failure (no deltas emitted) and succeeds', async () => {
    const client = new AnthropicClient('test-key')
    const message = { id: 'msg_ok' }
    const script = scriptStream(client, [
      async () => {
        throw retryableError()
      },
      async () => message,
    ])
    const deltas: string[] = []
    const res = await client.stream(params(), callbacks(deltas))
    expect(script.calls()).toBe(2)
    expect(res.message).toBe(message)
    expect(deltas).toEqual([])
  }, 10_000) // includes one real 1s backoff

  it('does not retry non-retryable statuses', async () => {
    const client = new AnthropicClient('test-key')
    const script = scriptStream(client, [
      async () => {
        throw Object.assign(new Error('bad request'), { status: 400 })
      },
      async () => ({ ok: true }),
    ])
    await expect(client.stream(params(), callbacks([]))).rejects.toThrow('bad request')
    expect(script.calls()).toBe(1)
  })
})
