import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  REALTIME_SESSION_MAX_MS,
  ReconnectingRealtimeClient,
  RealtimeTransportError,
  RealtimeVoiceClient,
  buildVoiceInstructions,
  isRealtimeTransportFailure,
  type RealtimeTurnResult,
} from '../../src/voice/realtime.js'

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  readonly sent: unknown[] = []
  send(raw: string): void { this.sent.push(JSON.parse(raw)) }
  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }
  server(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event))) }
  close(): void {
    this.readyState = WebSocket.CLOSED
  }
  terminate(): void { this.readyState = WebSocket.CLOSED }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('OpenAI Realtime voice transport', () => {
  it('builds first-person voice instructions, weaving in the persona when present', () => {
    const bare = buildVoiceInstructions()
    expect(bare).toContain('You are Athena')
    expect(bare).toContain('first person')
    expect(bare).toContain('When asked who you are, answer that you are Athena')
    expect(bare).toContain('not a claim of human personhood or independent origins')
    expect(bare).not.toContain('constitution')
    const withPersona = buildVoiceInstructions('I am Athena. I am concise.')
    expect(withPersona).toContain('constitution')
    expect(withPersona).toContain('I am Athena. I am concise.')
    expect(withPersona).toContain('submit_turn')
  })

  it('configures the current audio/tool session and completes function-call continuation', async () => {
    const socket = new FakeSocket()
    let authorization = ''
    const client = new RealtimeVoiceClient({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      webSocketFactory: (_url, options) => {
        authorization = String(options.headers?.Authorization)
        return socket as unknown as WebSocket
      },
    })
    socket.open()
    expect(socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        model: 'gpt-realtime-2.1-mini',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            noise_reduction: { type: 'far_field' },
            turn_detection: null,
          },
          output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: 'marin' },
        },
      },
    })
    expect(authorization).toBe('Bearer test-key')
    socket.server({ type: 'session.updated' })
    await client.connect()

    const handler = vi.fn(async () => ({ status: 'confirmation_required' }))
    const turn = client.ask('run tests', handler)
    await tick()
    socket.server({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call', name: 'delegate', call_id: 'call-1',
          arguments: '{"prompt":"run tests"}',
        }],
      },
    })
    await tick()
    expect(handler).toHaveBeenCalledWith({
      name: 'delegate', callId: 'call-1', arguments: { prompt: 'run tests' },
    })
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'conversation.item.create',
      item: expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' }),
    }))
    socket.server({ type: 'response.output_audio_transcript.delta', delta: 'Please confirm.' })
    socket.server({ type: 'response.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') })
    socket.server({
      type: 'response.done',
      response: { output: [], usage: { total_tokens: 3, unexpected: 'sk-do-not-persist' } },
    })
    await expect(turn).resolves.toEqual({
      transcript: 'Please confirm.', audio: Buffer.from([1, 2]),
      usage: [{ total_tokens: 3 }],
    })
    client.close()
  })

  it('sends raw microphone PCM through the documented audio buffer events', async () => {
    const socket = new FakeSocket()
    const client = new RealtimeVoiceClient({
      apiKey: 'test',
      webSocketFactory: () => socket as unknown as WebSocket,
    })
    socket.open()
    socket.server({ type: 'session.updated' })
    const pcm = Buffer.alloc(4_800, 1)
    const turn = client.askAudio(pcm, async () => ({}))
    await tick()
    expect(socket.sent.slice(-3)).toEqual([
      { type: 'input_audio_buffer.append', audio: pcm.toString('base64') },
      { type: 'input_audio_buffer.commit' },
      { type: 'response.create' },
    ])
    socket.server({ type: 'response.output_audio_transcript.delta', delta: 'I heard you.' })
    socket.server({ type: 'response.done', response: { status: 'completed', output: [] } })
    await expect(turn).resolves.toMatchObject({ transcript: 'I heard you.' })
  })

  it('fails loudly on a protocol error without echoing the API key', async () => {
    const socket = new FakeSocket()
    const client = new RealtimeVoiceClient({
      apiKey: 'super-secret-key',
      webSocketFactory: () => socket as unknown as WebSocket,
    })
    socket.open()
    socket.server({ type: 'error', error: { message: 'invalid authentication' } })
    await tick()
    await expect(client.connect()).rejects.toThrow(/invalid authentication/)
    await expect(client.connect()).rejects.not.toThrow(/super-secret-key/)
  })

  it('takes the session deadline from session.created and falls back to the documented maximum', async () => {
    const reported = new FakeSocket()
    const withExpiry = new RealtimeVoiceClient({
      apiKey: 'test',
      webSocketFactory: () => reported as unknown as WebSocket,
    })
    expect(withExpiry.expiresAt()).toBeNull()
    reported.open()
    reported.server({ type: 'session.created', session: { id: 'sess_1', expires_at: 1_800_000 } })
    reported.server({ type: 'session.updated' })
    await withExpiry.connect()
    expect(withExpiry.expiresAt()).toBe(1_800_000_000)

    const silent = new FakeSocket()
    const withoutExpiry = new RealtimeVoiceClient({
      apiKey: 'test',
      webSocketFactory: () => silent as unknown as WebSocket,
    })
    const before = Date.now()
    silent.open()
    silent.server({ type: 'session.updated' })
    await withoutExpiry.connect()
    // No expires_at on the wire still yields a deadline, so renewal never depends on the
    // provider volunteering one.
    expect(withoutExpiry.expiresAt()).toBeGreaterThanOrEqual(before + REALTIME_SESSION_MAX_MS)
  })

  it('classifies a session_expired error as a dead transport, not a failed request', async () => {
    const expired = new FakeSocket()
    const client = new RealtimeVoiceClient({
      apiKey: 'test',
      webSocketFactory: () => expired as unknown as WebSocket,
    })
    expired.open()
    expired.server({ type: 'session.updated' })
    await client.connect()
    const turn = client.ask('hello', async () => ({}))
    await tick()
    expired.server({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'session_expired',
        message: 'Your session hit the maximum duration of 60 minutes.',
      },
    })
    const error = await turn.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(RealtimeTransportError)
    expect((error as RealtimeTransportError).code).toBe('session_expired')
    expect(isRealtimeTransportFailure(error)).toBe(true)
    // A request-level complaint leaves the socket usable and must not trigger a reconnect.
    expect(isRealtimeTransportFailure(new RealtimeTransportError('bad tool argument', 'invalid_value')))
      .toBe(false)
  })

  it('does not silently accept a failed response as empty speech', async () => {
    const socket = new FakeSocket()
    const client = new RealtimeVoiceClient({
      apiKey: 'test',
      webSocketFactory: () => socket as unknown as WebSocket,
    })
    socket.open()
    socket.server({ type: 'session.updated' })
    await client.connect()
    const turn = client.ask('hello', async () => ({}))
    await tick()
    socket.server({
      type: 'response.done',
      response: { status: 'failed', status_details: { error: { message: 'model unavailable' } } },
    })
    await expect(turn).rejects.toThrow(/model unavailable/)
  })
})

describe('Realtime session renewal and reconnection', () => {
  const reply = (text: string): RealtimeTurnResult =>
    ({ transcript: text, audio: Buffer.alloc(0), usage: [] })

  interface FakeSessionOptions {
    connect?: () => Promise<void>
    ask?: (text: string) => Promise<RealtimeTurnResult>
    expiresAt?: () => number | null
  }

  function fakeSession(generation: number, options: FakeSessionOptions = {}) {
    return {
      generation,
      closed: false,
      connect: options.connect ?? (async () => {}),
      ask: options.ask ?? (async (text: string) => reply(`${generation}:${text}`)),
      askAudio: async () => reply(`${generation}:audio`),
      close(): void {
        this.closed = true
      },
      expiresAt: options.expiresAt ?? (() => null),
    }
  }

  it('replaces an expiring session before the deadline, transparently to the caller', async () => {
    let clock = 0
    const opened: ReturnType<typeof fakeSession>[] = []
    const client = new ReconnectingRealtimeClient({
      open: (generation) => {
        const session = fakeSession(generation, {
          // Only the first session is near its deadline; the replacement is fresh.
          expiresAt: () => (generation === 1 ? 5_000 : 1_000_000),
        })
        opened.push(session)
        return session
      },
      renewMarginMs: 1_000,
      now: () => clock,
      sleep: async () => {},
    })
    await client.connect()
    await expect(client.ask('first', async () => ({}))).resolves.toMatchObject({ transcript: '1:first' })
    expect(client.generation()).toBe(1)

    clock = 4_500
    await expect(client.ask('second', async () => ({}))).resolves.toMatchObject({ transcript: '2:second' })
    expect(client.generation()).toBe(2)
    // The expiring session is retired, not left holding a socket that is about to die.
    expect(opened[0]!.closed).toBe(true)
    expect(opened[1]!.closed).toBe(false)
    client.close()
  })

  it('discards a dead session and opens another one on the next call', async () => {
    const reasons: string[] = []
    const client = new ReconnectingRealtimeClient({
      open: (generation) => fakeSession(generation, {
        ask: async (text) => {
          if (generation === 1) throw new RealtimeTransportError('Realtime connection closed.', 'connection_closed')
          return reply(`${generation}:${text}`)
        },
      }),
      backoffMs: 0,
      sleep: async () => {},
      onSession: ({ reason }) => reasons.push(reason),
    })
    await client.connect()
    await expect(client.ask('dropped', async () => ({}))).rejects.toThrow(/connection closed/)
    await expect(client.ask('after', async () => ({}))).resolves.toMatchObject({ transcript: '2:after' })
    expect(reasons).toEqual(['initial', 'recovery'])
    client.close()
  })

  it('keeps a usable session after a request-level failure that did not kill the transport', async () => {
    const client = new ReconnectingRealtimeClient({
      open: (generation) => fakeSession(generation, {
        ask: async (text) => {
          if (text === 'bad') throw new RealtimeTransportError('Realtime API error: bad tool argument', 'invalid_value')
          return reply(`${generation}:${text}`)
        },
      }),
      sleep: async () => {},
    })
    await client.connect()
    await expect(client.ask('bad', async () => ({}))).rejects.toThrow(/bad tool argument/)
    await expect(client.ask('next', async () => ({}))).resolves.toMatchObject({ transcript: '1:next' })
    expect(client.generation()).toBe(1)
    client.close()
  })

  it('bounds reconnect attempts, backs off, and warns once per episode', async () => {
    const warnings: string[] = []
    const waits: number[] = []
    let attempts = 0
    const client = new ReconnectingRealtimeClient({
      open: (generation) => fakeSession(generation, {
        connect: async () => {
          attempts += 1
          if (attempts > 1) throw new Error('getaddrinfo ENOTFOUND api.openai.com')
        },
        ask: async () => {
          throw new RealtimeTransportError('Realtime connection closed.', 'connection_closed')
        },
      }),
      maxAttempts: 3,
      backoffMs: 10,
      sleep: async (ms) => {
        waits.push(ms)
      },
      onWarn: (message) => warnings.push(message),
    })
    await client.connect()
    await expect(client.ask('lost', async () => ({}))).rejects.toThrow(/connection closed/)
    await expect(client.connect()).rejects.toThrow(/could not reopen the OpenAI Realtime connection/)
    await expect(client.connect()).rejects.toThrow(/athena voice probe/)
    // Three attempts per episode, two backoffs between them, and never a busy-loop.
    expect(attempts).toBe(7)
    expect(waits).toEqual([10, 20, 10, 20])
    // One line per episode, not one per attempt.
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('reconnecting')
    client.close()
  })

  it('refuses to reopen anything once closed', async () => {
    const client = new ReconnectingRealtimeClient({
      open: (generation) => fakeSession(generation),
      sleep: async () => {},
    })
    await client.connect()
    client.close()
    await expect(client.connect()).rejects.toThrow(/closed/)
  })
})
