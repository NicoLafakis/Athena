import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { RealtimeVoiceClient, buildVoiceInstructions } from '../../src/voice/realtime.js'

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
