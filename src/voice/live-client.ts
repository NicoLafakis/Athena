import WebSocket from 'ws'
import { z } from 'zod'
import { plainBounded } from '../interaction/format.js'
import {
  buildVoiceInstructions,
  REALTIME_SESSION_MAX_MS,
  RealtimeTransportError,
  type RealtimeToolHandler,
  type RealtimeTurnResult,
  type RealtimeVoiceClientOptions,
} from './realtime.js'

const ServerEventSchema = z.object({ type: z.string() }).passthrough()

const PCM_CHUNK_BYTES = 4_800 // 100ms at 24 kHz 16-bit mono
const INPUT_SILENCE_TAIL_CHUNKS = 12 // 1.2s trailing silence to trigger end-of-turn
const OUTPUT_SILENCE_TAIL_FRAMES = 8 // ~800ms silent output frames after speech ends
const SPEECH_PEAK_THRESHOLD = 50

function hasSpeechEnergy(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (Math.abs(pcm.readInt16LE(i)) > SPEECH_PEAK_THRESHOLD) return true
  }
  return false
}

/**
 * OpenAI GPT-Live (`gpt-live-1.1` / `gpt-live-1`) WebSocket client over
 * `wss://api.openai.com/v1/live/sessions`.
 *
 * Wire protocol (verified live against OpenAI):
 * - Startup: `session.start` with `delegation: { type: 'client' }` (no `session.tools` field)
 *   and wait for `session.started`.
 * - Audio in: 100ms `session.input_audio.append` PCM16LE 24kHz chunks + silence tail.
 * - Audio/transcript out: continuous `session.output_audio.delta` (100ms PCM frames),
 *   `session.input_transcript.delta` (user), and `session.output_transcript.delta` (Athena).
 * - Turn completion: once non-zero output audio or output transcript has been received,
 *   resolves after `OUTPUT_SILENCE_TAIL_FRAMES` consecutive silent output audio frames.
 */
export class LiveVoiceClient {
  private readonly model: string
  private readonly socket: WebSocket
  private readonly connectTimeoutMs: number
  private readonly responseTimeoutMs: number
  private readonly silenceTailFrames: number
  private readonly connected: Promise<void>
  private resolveConnected!: () => void
  private rejectConnected!: (error: Error) => void
  private openedAtMs: number | null = null
  private expiresAtMs: number | null = null
  private eventSeq = 0
  private pending: {
    handler: RealtimeToolHandler
    transcript: string[]
    userTranscript: string[]
    audio: Buffer[]
    hasSpeechOutput: boolean
    silentOutputFrames: number
    resolve: (result: RealtimeTurnResult) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null = null

  constructor(options: RealtimeVoiceClientOptions & { voice?: string; silenceTailFrames?: number }) {
    this.model = options.model ?? 'gpt-live-1.1'
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    this.responseTimeoutMs = options.responseTimeoutMs ?? 45_000
    this.silenceTailFrames = options.silenceTailFrames ?? OUTPUT_SILENCE_TAIL_FRAMES
    const url = 'wss://api.openai.com/v1/live/sessions'
    const wsOptions: WebSocket.ClientOptions = {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      family: 4,
    }
    this.socket = options.webSocketFactory
      ? options.webSocketFactory(url, wsOptions)
      : new WebSocket(url, wsOptions)

    this.connected = new Promise((resolve, reject) => {
      this.resolveConnected = resolve
      this.rejectConnected = reject
    })
    this.connected.catch(() => {})

    const connectTimer = setTimeout(() => {
      const error = new RealtimeTransportError(
        'Timed out connecting to OpenAI Live voice session.',
        'connect_timeout',
      )
      this.rejectConnected(error)
      this.fail(error)
      this.close()
    }, this.connectTimeoutMs)

    this.socket.on('open', () => {
      this.openedAtMs = Date.now()
      this.send({
        type: 'session.start',
        event_id: this.nextEventId('start'),
        session: {
          model: this.model,
          instructions: options.instructions ?? buildVoiceInstructions(),
          audio: {
            format: { type: 'audio/pcm', rate: 24_000 },
            output: { voice: options.voice ?? 'marin' },
          },
          delegation: { type: 'client' },
        },
      })
    })
    this.socket.on('message', (data) => {
      this.onMessage(data.toString('utf8')).catch((err) => this.fail(err as Error))
    })
    this.socket.on('error', (err) => {
      const error = new RealtimeTransportError(`Live voice connection failed: ${err.message}`, 'socket_error')
      this.rejectConnected(error)
      this.fail(error)
    })
    this.socket.on('close', () => {
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
    if (!bounded) throw new Error('Voice command is empty.')
    return this.startTurn(handler, () => {
      this.send({
        type: 'session.commentary.append',
        event_id: this.nextEventId('commentary'),
        delegation_id: null,
        content: bounded,
      })
      this.send({
        type: 'session.input_audio.append',
        audio: Buffer.alloc(PCM_CHUNK_BYTES).toString('base64'),
      })
    })
  }

  async askAudio(pcm: Buffer, handler: RealtimeToolHandler): Promise<RealtimeTurnResult> {
    if (pcm.length < 4_800) throw new Error('Voice command audio is too short.')
    return this.startTurn(handler, () => {
      const withTail = Buffer.concat([pcm, Buffer.alloc(PCM_CHUNK_BYTES * INPUT_SILENCE_TAIL_CHUNKS)])
      for (let offset = 0; offset < withTail.length; offset += PCM_CHUNK_BYTES) {
        this.send({
          type: 'session.input_audio.append',
          audio: withTail.subarray(offset, offset + PCM_CHUNK_BYTES).toString('base64'),
        })
      }
    })
  }

  async note(text: string): Promise<void> {
    const bounded = plainBounded(text, 2_048)
    if (!bounded) return
    await this.connect()
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.send({
      type: 'session.instructions.append',
      event_id: this.nextEventId('note'),
      instructions: bounded,
    })
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.send({ type: 'session.close', event_id: this.nextEventId('close') })
      } catch {
        // ignore
      }
      this.socket.close(1000)
    } else if (this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.terminate()
    }
  }

  private nextEventId(prefix: string): string {
    this.eventSeq += 1
    return `evt_${prefix}_${this.eventSeq}`
  }

  private send(event: unknown): void {
    this.socket.send(JSON.stringify(event))
  }

  private async startTurn(
    handler: RealtimeToolHandler,
    sendInput: () => void,
  ): Promise<RealtimeTurnResult> {
    await this.connect()
    if (this.pending) throw new Error('A Live voice response is already active.')
    const result = new Promise<RealtimeTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new RealtimeTransportError('Live voice response timed out.', 'response_timeout'))
      }, this.responseTimeoutMs)
      this.pending = {
        handler,
        transcript: [],
        userTranscript: [],
        audio: [],
        hasSpeechOutput: false,
        silentOutputFrames: 0,
        resolve,
        reject,
        timer,
      }
    })
    try {
      sendInput()
    } catch (error) {
      this.fail(error as Error)
      throw error
    }
    return result
  }

  private async onMessage(raw: string): Promise<void> {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('Live voice server returned malformed JSON.')
    }
    const parsed = ServerEventSchema.parse(value)
    const event = parsed as Record<string, unknown> & { type: string }

    if (event.type === 'session.started' || event.type === 'session.created' || event.type === 'session.updated') {
      const session = event.session as { expires_at?: unknown } | undefined
      if (typeof session?.expires_at === 'number' && Number.isFinite(session.expires_at)) {
        this.expiresAtMs = session.expires_at * 1_000
      }
      this.resolveConnected()
      return
    }

    if (event.type === 'error') {
      const detail = event.error as { message?: unknown; code?: unknown } | undefined
      const err = new RealtimeTransportError(
        `Live voice API error: ${String(detail?.message ?? 'unknown error')}`,
        typeof detail?.code === 'string' ? detail.code : 'api_error',
      )
      this.rejectConnected(err)
      throw err
    }

    const pending = this.pending
    if (!pending) return

    if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
      pending.userTranscript.push(event.delta)
      return
    }

    if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
      pending.transcript.push(event.delta)
      pending.hasSpeechOutput = true
      pending.silentOutputFrames = 0
      return
    }

    if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
      const chunk = Buffer.from(event.delta, 'base64')
      if (hasSpeechEnergy(chunk)) {
        pending.hasSpeechOutput = true
        pending.silentOutputFrames = 0
        pending.audio.push(chunk)
      } else if (pending.hasSpeechOutput) {
        pending.audio.push(chunk)
        pending.silentOutputFrames += 1
        if (pending.silentOutputFrames >= this.silenceTailFrames) {
          this.completePending()
        }
      }
    }
  }

  private completePending(): void {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending = null
    const userText = pending.userTranscript.join('').trim()
    pending.resolve({
      transcript: pending.transcript.join('').trim(),
      ...(userText ? { userTranscript: userText } : {}),
      audio: Buffer.concat(pending.audio),
      usage: [],
    })
  }

  private fail(error: Error): void {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending = null
    pending.reject(error)
  }
}
