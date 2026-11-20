import WebSocket from 'ws'
import { z } from 'zod'
import { plainBounded } from '../interaction/format.js'
import {
  buildVoiceInstructions,
  REALTIME_SESSION_MAX_MS,
  RealtimeTransportError,
  sanitizeVoiceUsage,
  VOICE_TOOLS,
  type RealtimeToolCall,
  type RealtimeToolHandler,
  type RealtimeTurnResult,
  type RealtimeVoiceClientOptions,
} from './realtime.js'

const ServerEventSchema = z.object({ type: z.string() }).passthrough()

/**
 * OpenAI GPT-Live (`gpt-live-1.1` / `gpt-live-1`) WebSocket client over
 * `wss://api.openai.com/v1/live/sessions` using `session.start` and `delegation: { type: 'client' }`.
 * Implements the exact same `VoiceRealtimeClient` seam as `RealtimeVoiceClient` so
 * `daemon.ts`, `HarnessSessionController`, permissions, and `VoiceHud` stay model-agnostic.
 */
export class LiveVoiceClient {
  private readonly model: string
  private readonly socket: WebSocket
  private readonly connectTimeoutMs: number
  private readonly responseTimeoutMs: number
  private readonly connected: Promise<void>
  private resolveConnected!: () => void
  private rejectConnected!: (error: Error) => void
  private openedAtMs: number | null = null
  private expiresAtMs: number | null = null
  private pending: {
    handler: RealtimeToolHandler
    transcript: string[]
    userTranscript: string[]
    audio: Buffer[]
    usage: unknown[]
    resolve: (result: RealtimeTurnResult) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null = null

  constructor(options: RealtimeVoiceClientOptions) {
    this.model = options.model ?? 'gpt-live-1.1'
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
    this.responseTimeoutMs = options.responseTimeoutMs ?? 120_000
    const url = options.url ?? 'wss://api.openai.com/v1/live/sessions'
    this.connected = new Promise((resolve, reject) => {
      this.resolveConnected = resolve
      this.rejectConnected = reject
    })
    const factory = options.webSocketFactory ?? ((target, socketOptions) => new WebSocket(target, socketOptions))
    this.socket = factory(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    })
    const connectTimer = setTimeout(() => {
      this.rejectConnected(new RealtimeTransportError('Live voice connection timed out.', 'connection_timeout'))
      this.socket.terminate()
    }, this.connectTimeoutMs)
    this.socket.on('open', () => {
      this.openedAtMs = Date.now()
      this.send({
        type: 'session.start',
        event_id: `evt_start_${this.openedAtMs}`,
        session: {
          model: this.model,
          instructions: options.instructions ?? buildVoiceInstructions(),
          audio: {
            format: { type: 'audio/pcm', rate: 24_000 },
            output: { voice: 'marin' },
          },
          delegation: { type: 'client' },
          tools: VOICE_TOOLS,
        },
      })
    })
    this.socket.on('message', (data) => {
      void this.onMessage(data.toString()).catch((error) => {
        this.rejectConnected(error as Error)
        this.fail(error as Error)
      })
    })
    this.socket.on('error', (error) => {
      clearTimeout(connectTimer)
      const failure = new RealtimeTransportError(
        `Live voice connection failed: ${error.message}`,
        'connection_error',
      )
      this.rejectConnected(failure)
      this.fail(failure)
    })
    this.socket.on('close', () => {
      clearTimeout(connectTimer)
      const error = new RealtimeTransportError('Live voice connection closed.', 'connection_closed')
      this.rejectConnected(error)
      this.fail(error)
    })
    this.connected.then(() => clearTimeout(connectTimer), () => clearTimeout(connectTimer))
  }

  async connect(): Promise<void> {
    await this.connected
  }

  expiresAt(): number | null {
    if (this.expiresAtMs !== null) return this.expiresAtMs
    return this.openedAtMs === null ? null : this.openedAtMs + REALTIME_SESSION_MAX_MS
  }

  async ask(text: string, handler: RealtimeToolHandler): Promise<RealtimeTurnResult> {
    const bounded = text.trim().slice(0, 8_192)
    return this.runTurn(handler, () => {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: bounded }],
        },
      })
      this.send({ type: 'response.create' })
    })
  }

  async askAudio(pcm: Buffer, handler: RealtimeToolHandler): Promise<RealtimeTurnResult> {
    return this.runTurn(handler, () => {
      const chunkSize = 24_000
      for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        this.send({
          type: 'input_audio_buffer.append',
          audio: pcm.subarray(offset, offset + chunkSize).toString('base64'),
        })
      }
      this.send({ type: 'input_audio_buffer.commit' })
      this.send({ type: 'response.create' })
    })
  }

  injectSystemNote(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: plainBounded(text, 1_024) }],
      },
    })
  }

  close(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
    this.socket.close()
  }

  private runTurn(handler: RealtimeToolHandler, sendRequest: () => void): Promise<RealtimeTurnResult> {
    if (this.pending) return Promise.reject(new Error('Another live voice turn is already in progress.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new RealtimeTransportError('Live voice response timed out.', 'response_timeout'))
      }, this.responseTimeoutMs)
      this.pending = { handler, transcript: [], userTranscript: [], audio: [], usage: [], resolve, reject, timer }
      try {
        sendRequest()
      } catch (error) {
        this.fail(error as Error)
      }
    })
  }

  private async onMessage(raw: string): Promise<void> {
    const event = ServerEventSchema.parse(JSON.parse(raw))
    if (event.type === 'session.started' || event.type === 'session.updated' || event.type === 'session.created') {
      const session = event.session as { expires_at?: unknown } | undefined
      if (typeof session?.expires_at === 'number' && Number.isFinite(session.expires_at)) {
        this.expiresAtMs = session.expires_at * 1_000
      }
      if (event.type === 'session.started' || event.type === 'session.updated') {
        this.resolveConnected()
      }
      return
    }
    if (event.type === 'error') {
      const errObj = event.error as { message?: unknown; code?: unknown } | undefined
      const code = typeof errObj?.code === 'string' && errObj.code ? errObj.code : 'server_error'
      const message = typeof errObj?.message === 'string' ? errObj.message : 'Live voice server error.'
      const failure = new RealtimeTransportError(message, code)
      this.rejectConnected(failure)
      this.fail(failure)
      return
    }
    if (!this.pending) return
    if (
      event.type === 'conversation.item.input_audio_transcription.completed' &&
      typeof event.transcript === 'string' &&
      event.transcript.trim()
    ) {
      this.pending.userTranscript.push(event.transcript.trim())
      return
    }
    if (
      (event.type === 'response.output_audio_transcript.delta' ||
        event.type === 'response.output_text.delta' ||
        event.type === 'response.audio_transcript.delta') &&
      typeof event.delta === 'string'
    ) {
      this.pending.transcript.push(event.delta)
      return
    }
    if (
      (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') &&
      typeof event.delta === 'string'
    ) {
      this.pending.audio.push(Buffer.from(event.delta, 'base64'))
      return
    }
    if (event.type !== 'response.done') return
    const response = (event.response ?? {}) as {
      status?: unknown
      usage?: unknown
      output?: Array<{ type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown }>
    }
    const usage = sanitizeVoiceUsage(response.usage)
    if (usage !== undefined) this.pending.usage.push(usage)
    const calls = (response.output ?? []).filter(
      (item): item is { type: 'function_call'; name: string; call_id: string; arguments: string } =>
        item.type === 'function_call' &&
        typeof item.name === 'string' &&
        typeof item.call_id === 'string' &&
        typeof item.arguments === 'string',
    )
    if (calls.length > 0) {
      const pending = this.pending
      for (const call of calls) {
        let parsedArgs: unknown = {}
        try {
          parsedArgs = JSON.parse(call.arguments)
        } catch {
          parsedArgs = {}
        }
        const toolCall: RealtimeToolCall = { name: call.name, callId: call.call_id, arguments: parsedArgs }
        const output = await pending.handler(toolCall)
        if (this.pending !== pending) return
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(output),
          },
        })
      }
      this.send({ type: 'response.create' })
      return
    }
    const done = this.pending
    this.pending = null
    clearTimeout(done.timer)
    const userText = done.userTranscript.join(' ').trim()
    done.resolve({
      transcript: done.transcript.join('').trim(),
      ...(userText ? { userTranscript: userText } : {}),
      audio: Buffer.concat(done.audio),
      usage: done.usage,
    })
  }

  private send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload))
  }

  private fail(error: Error): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}
