import WebSocket from 'ws'
import { z } from 'zod'

export const REALTIME_MODELS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'] as const
export type RealtimeVoiceModel = (typeof REALTIME_MODELS)[number]
export const DEFAULT_REALTIME_MODEL: RealtimeVoiceModel = 'gpt-realtime-2.1-mini'

export interface RealtimeToolCall {
  name: string
  callId: string
  arguments: unknown
}

export type RealtimeToolHandler = (call: RealtimeToolCall) => Promise<unknown>

export interface RealtimeTurnResult {
  transcript: string
  audio: Buffer
  usage: unknown
}

export interface RealtimeVoiceClientOptions {
  apiKey: string
  model?: RealtimeVoiceModel
  url?: string
  connectTimeoutMs?: number
  responseTimeoutMs?: number
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket
  /** Session instructions; defaults to buildVoiceInstructions() with no persona. */
  instructions?: string
}

const ServerEventSchema = z.object({ type: z.string() }).passthrough()

/** Usage persistence accepts counters only; unexpected provider strings never become a log. */
export function sanitizeVoiceUsage(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    return value.map(sanitizeVoiceUsage).filter((item) => item !== undefined)
  }
  if (!value || typeof value !== 'object') return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => /^[A-Za-z0-9_]{1,64}$/.test(key))
      .map(([key, item]) => [key, sanitizeVoiceUsage(item)] as const)
      .filter((entry) => entry[1] !== undefined),
  )
}

const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'submit_turn',
    description: 'Submit an understood user coding or repository request directly to the Athena harness.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 4096 } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'local_control',
    description: 'Perform a deterministic local control action (status, repeat, allow, deny, stop_listening).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'repeat', 'allow', 'deny', 'stop_listening'],
        },
        request_id: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
] as const

/**
 * The voice session IS Athena talking — not an assistant sitting in front of her.
 * First person is a hard rule: third-person narration about "Athena" or "the harness"
 * is precisely the failure this wording exists to prevent.
 */
export function buildVoiceInstructions(persona?: string): string {
  const rules = [
    'You are Athena, the terminal coding agent in this session, speaking directly with the user by voice. Your spoken words ARE Athena: always use first person ("I", "me", "my"). When asked who you are, answer that you are Athena. Never describe "Athena", "the harness", or "the engine" as a separate assistant, agent, product, or individual standing between you and the user. You may name a source-code component only when discussing its implementation; retain first-person ownership of your actions and responses. This is an operating identity, not a claim of human personhood or independent origins.',
    'The word "Athena" at the start of user audio is the wake word, never part of the request.',
    'For every coding, repository, inspection, or action request, call submit_turn in the SAME response with the understood request text. Never promise to do something without the tool call, and never answer repository or coding questions from your own knowledge — that is exactly what submit_turn is for.',
    'submit_turn returns as soon as the work STARTS, not when it finishes. When it returns, tell the user briefly that you are on it. The finished result then arrives as a separate user message; report that result concisely and faithfully, first person, as your own completed work.',
    'Use local_control for status, repeat, allow/deny permission answers, or stop_listening.',
    'Keep spoken replies short and natural — a colleague, not a narrator.',
  ]
  const trimmed = persona?.trim().slice(0, 2_048)
  if (!trimmed) return rules.join(' ')
  return [
    ...rules,
    `Athena's own constitution follows; let it shape how you speak and what you claim:\n${trimmed}`,
  ].join(' ')
}

export class RealtimeVoiceClient {
  private readonly model: RealtimeVoiceModel
  private readonly connectTimeoutMs: number
  private readonly responseTimeoutMs: number
  private readonly socket: WebSocket
  private connected: Promise<void>
  private resolveConnected!: () => void
  private rejectConnected!: (error: Error) => void
  private pending: {
    handler: RealtimeToolHandler
    transcript: string[]
    audio: Buffer[]
    usage: unknown[]
    resolve: (result: RealtimeTurnResult) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null = null

  constructor(options: RealtimeVoiceClientOptions) {
    this.model = options.model ?? DEFAULT_REALTIME_MODEL
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
    this.responseTimeoutMs = options.responseTimeoutMs ?? 120_000
    const url = options.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`
    this.connected = new Promise((resolve, reject) => {
      this.resolveConnected = resolve
      this.rejectConnected = reject
    })
    const factory = options.webSocketFactory ?? ((target, socketOptions) => new WebSocket(target, socketOptions))
    this.socket = factory(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    })
    const connectTimer = setTimeout(() => {
      this.rejectConnected(new Error('Realtime connection timed out.'))
      this.socket.terminate()
    }, this.connectTimeoutMs)
    this.socket.on('open', () => {
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: this.model,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24_000 },
              noise_reduction: { type: 'far_field' },
              turn_detection: null,
            },
            output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: 'marin' },
          },
          instructions: options.instructions ?? buildVoiceInstructions(),
          tools: VOICE_TOOLS,
          tool_choice: 'auto',
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
      this.rejectConnected(error)
      this.fail(error)
    })
    this.socket.on('close', () => {
      clearTimeout(connectTimer)
      const error = new Error('Realtime connection closed.')
      this.rejectConnected(error)
      this.fail(error)
    })
    this.connected.then(() => clearTimeout(connectTimer), () => clearTimeout(connectTimer))
  }

  async connect(): Promise<void> {
    await this.connected
  }

  async ask(text: string, handler: RealtimeToolHandler): Promise<RealtimeTurnResult> {
    const bounded = text.trim().slice(0, 8_192)
    if (!bounded) throw new Error('Voice command is empty.')
    return this.startTurn(handler, () => {
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
    if (pcm.length < 4_800) throw new Error('Voice command audio is too short.')
    return this.startTurn(handler, () => {
      this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
      this.send({ type: 'input_audio_buffer.commit' })
      this.send({ type: 'response.create' })
    })
  }

  private async startTurn(
    handler: RealtimeToolHandler,
    sendInput: () => void,
  ): Promise<RealtimeTurnResult> {
    await this.connect()
    if (this.pending) throw new Error('A Realtime response is already active.')
    const result = new Promise<RealtimeTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Realtime response timed out.'))
      }, this.responseTimeoutMs)
      this.pending = { handler, transcript: [], audio: [], usage: [], resolve, reject, timer }
    })
    try {
      sendInput()
    } catch (error) {
      this.fail(error as Error)
      throw error
    }
    return result
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000)
    else if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
  }

  private send(event: unknown): void {
    this.socket.send(JSON.stringify(event))
  }

  private async onMessage(raw: string): Promise<void> {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('Realtime server returned malformed JSON.')
    }
    const parsed = ServerEventSchema.parse(value)
    const event = parsed as Record<string, unknown> & { type: string }
    if (event.type === 'session.updated') {
      this.resolveConnected()
      return
    }
    if (event.type === 'error') {
      const detail = event.error as { message?: unknown } | undefined
      throw new Error(`Realtime API error: ${String(detail?.message ?? 'unknown error')}`)
    }
    const pending = this.pending
    if (!pending) return
    if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
      pending.audio.push(Buffer.from(event.delta, 'base64'))
      return
    }
    if (
      event.type === 'response.output_audio_transcript.delta' &&
      typeof event.delta === 'string'
    ) {
      pending.transcript.push(event.delta)
      return
    }
    if (event.type !== 'response.done') return
    const response = event.response as {
      output?: unknown
      usage?: unknown
      status?: unknown
      status_details?: { error?: { message?: unknown } }
    } | undefined
    if (response?.usage !== undefined) pending.usage.push(sanitizeVoiceUsage(response.usage))
    const output = Array.isArray(response?.output) ? response.output : []
    const calls = output.flatMap((item): RealtimeToolCall[] => {
      if (!item || typeof item !== 'object') return []
      const call = item as Record<string, unknown>
      if (call.type !== 'function_call' || typeof call.name !== 'string' || typeof call.call_id !== 'string') {
        return []
      }
      let args: unknown = {}
      if (typeof call.arguments === 'string') {
        try {
          args = JSON.parse(call.arguments)
        } catch {
          args = null
        }
      }
      return [{ name: call.name, callId: call.call_id, arguments: args }]
    })
    if (calls.length > 0) {
      for (const call of calls) {
        let result: unknown
        try {
          result = await pending.handler(call)
        } catch (error) {
          result = { error: (error as Error).message }
        }
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.callId,
            output: JSON.stringify(result).slice(0, 16_384),
          },
        })
      }
      this.send({ type: 'response.create' })
      return
    }
    if (response?.status && response.status !== 'completed') {
      throw new Error(
        `Realtime response ${String(response.status)}: ` +
        `${String(response.status_details?.error?.message ?? 'no detail')}`,
      )
    }
    clearTimeout(pending.timer)
    this.pending = null
    pending.resolve({
      transcript: pending.transcript.join('').trim(),
      audio: Buffer.concat(pending.audio),
      usage: pending.usage,
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

export async function validateRealtimeKey(
  apiKey: string,
  options: Omit<RealtimeVoiceClientOptions, 'apiKey'> = {},
): Promise<void> {
  const client = new RealtimeVoiceClient({ ...options, apiKey })
  try {
    await client.connect()
  } finally {
    client.close()
  }
}
