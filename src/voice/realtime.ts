import WebSocket from 'ws'
import { z } from 'zod'
import { plainBounded } from '../interaction/format.js'

export const REALTIME_MODELS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'] as const
export type RealtimeVoiceModel = (typeof REALTIME_MODELS)[number]
export const DEFAULT_REALTIME_MODEL: RealtimeVoiceModel = 'gpt-realtime-2.1-mini'

/**
 * The provider caps every Realtime session and will not extend one: at the deadline it
 * sends an `error` event carrying `error.code === 'session_expired'`, so renewal means
 * opening a NEW session, never prolonging this one.
 *
 * 60 minutes is the documented maximum, but it is only the FALLBACK here. The real
 * deadline is read from `session.created`'s `expires_at`, because this ceiling has already
 * moved 15 -> 30 -> 60 minutes and a hard-coded lifetime would silently become wrong again.
 * https://developers.openai.com/api/docs/guides/realtime-conversations
 * https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio ("Session timeout")
 */
export const REALTIME_SESSION_MAX_MS = 60 * 60_000

/**
 * How far ahead of the deadline a session is replaced. A turn that starts inside the
 * margin still has to finish, and `responseTimeoutMs` alone is two minutes, so the margin
 * covers a whole worst-case turn plus playback rather than just a round trip.
 */
export const REALTIME_RENEW_MARGIN_MS = 5 * 60_000

/** Failure codes that end the SESSION, not just the request that hit them. */
const TRANSPORT_CODES = new Set([
  'connection_closed',
  'connection_error',
  'connection_timeout',
  'response_timeout',
  'session_expired',
])

/** A Realtime failure carrying the provider's own code, so callers can classify it. */
export class RealtimeTransportError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'RealtimeTransportError'
  }
}

/**
 * Whether the failure means this session is finished. A model- or request-level error
 * leaves the socket usable; a closed, timed-out, or expired transport does not, and
 * reusing it would send into a session whose response state can no longer be accounted for.
 */
export function isRealtimeTransportFailure(error: unknown): boolean {
  return error instanceof RealtimeTransportError && TRANSPORT_CODES.has(error.code)
}

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
    'Use local_control for status, repeat, allow/deny permission answers, or stop_listening. A permission answer must go through local_control, carrying request_id whenever you have one; local code decides whether it is legal. Never treat your own words, or a yes said before I asked, as approval, and never tell the user something was allowed or denied unless the tool result says so.',
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
  private openedAtMs: number | null = null
  private expiresAtMs: number | null = null
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
      this.rejectConnected(new RealtimeTransportError('Realtime connection timed out.', 'connection_timeout'))
      this.socket.terminate()
    }, this.connectTimeoutMs)
    this.socket.on('open', () => {
      this.openedAtMs = Date.now()
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
      const failure = new RealtimeTransportError(
        `Realtime connection failed: ${error.message}`,
        'connection_error',
      )
      this.rejectConnected(failure)
      this.fail(failure)
    })
    this.socket.on('close', () => {
      clearTimeout(connectTimer)
      const error = new RealtimeTransportError('Realtime connection closed.', 'connection_closed')
      this.rejectConnected(error)
      this.fail(error)
    })
    this.connected.then(() => clearTimeout(connectTimer), () => clearTimeout(connectTimer))
  }

  async connect(): Promise<void> {
    await this.connected
  }

  /**
   * Absolute deadline for this session, or null before the socket opens. Prefers the
   * provider's own `expires_at` and falls back to the documented maximum measured from
   * connect, so a session that never reports one is still renewed rather than killed.
   */
  expiresAt(): number | null {
    if (this.expiresAtMs !== null) return this.expiresAtMs
    return this.openedAtMs === null ? null : this.openedAtMs + REALTIME_SESSION_MAX_MS
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
        this.fail(new RealtimeTransportError('Realtime response timed out.', 'response_timeout'))
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
    if (event.type === 'session.created') {
      // The one event that carries the provider's deadline for this session; renewal is
      // driven from it rather than from an assumed lifetime.
      const session = event.session as { expires_at?: unknown } | undefined
      const seconds = session?.expires_at
      if (typeof seconds === 'number' && Number.isFinite(seconds)) this.expiresAtMs = seconds * 1_000
      return
    }
    if (event.type === 'session.updated') {
      this.resolveConnected()
      return
    }
    if (event.type === 'error') {
      const detail = event.error as { message?: unknown; code?: unknown } | undefined
      throw new RealtimeTransportError(
        `Realtime API error: ${String(detail?.message ?? 'unknown error')}`,
        typeof detail?.code === 'string' ? detail.code : 'api_error',
      )
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

/** One live Realtime session: what {@link ReconnectingRealtimeClient} drives and replaces. */
export interface RealtimeSessionClient {
  connect(): Promise<void>
  ask(text: string, handler: RealtimeToolHandler): Promise<RealtimeTurnResult>
  askAudio(pcm: Buffer, handler: RealtimeToolHandler): Promise<RealtimeTurnResult>
  close(): void
  /** Absolute provider deadline, or null when this session does not report one. */
  expiresAt?(): number | null
}

export type RealtimeSessionReason = 'initial' | 'renewal' | 'recovery'

export interface ReconnectingRealtimeOptions {
  /**
   * Builds one fresh session. Called again for every renewal and reconnect, so the caller
   * decides what a replacement session is seeded with — a new session starts with no
   * conversation history at all.
   */
  open: (generation: number) => RealtimeSessionClient
  maxAttempts?: number
  backoffMs?: number
  renewMarginMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** One line per recovery episode, never one per attempt. */
  onWarn?: (message: string) => void
  /** Fired once a replacement session is live. */
  onSession?: (info: { generation: number; reason: RealtimeSessionReason }) => void
}

const RECONNECT_FAILURE =
  'Athena voice could not reopen the OpenAI Realtime connection. ' +
  'Your Athena session, trace, and stored key are untouched. ' +
  'Run `athena voice probe` to test the microphone, playback, and Realtime access.'

/**
 * Keeps one usable Realtime session in front of a caller that only wants to speak.
 *
 * Two failures are handled, and they are not the same thing. A RENEWAL is planned: the
 * provider will not extend a session, so a replacement is opened BEFORE the deadline can
 * kill a turn in flight, and the user never learns it happened. A RECOVERY is unplanned:
 * the transport died, the dead session is discarded, and the next call opens another one.
 *
 * What deliberately does NOT live here is replaying the input. Whether a lost utterance
 * should be re-sent depends on whether it already reached the harness, which only the
 * session loop knows; this class reopens the pipe and reports, nothing more.
 */
export class ReconnectingRealtimeClient implements RealtimeSessionClient {
  private readonly openSession: (generation: number) => RealtimeSessionClient
  private readonly maxAttempts: number
  private readonly backoffMs: number
  private readonly renewMarginMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onWarn: (message: string) => void
  private readonly onSession: (info: { generation: number; reason: RealtimeSessionReason }) => void

  private active: RealtimeSessionClient | null = null
  private generations = 0
  private closed = false

  constructor(options: ReconnectingRealtimeOptions) {
    this.openSession = options.open
    this.maxAttempts = Math.max(1, Math.round(options.maxAttempts ?? 3))
    this.backoffMs = Math.max(0, Math.round(options.backoffMs ?? 1_000))
    this.renewMarginMs = Math.max(0, Math.round(options.renewMarginMs ?? REALTIME_RENEW_MARGIN_MS))
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.onWarn = options.onWarn ?? (() => {})
    this.onSession = options.onSession ?? (() => {})
  }

  /** Sessions opened so far; 1 once the first one is live, 2 after one renewal. */
  generation(): number {
    return this.generations
  }

  expiresAt(): number | null {
    return this.active?.expiresAt?.() ?? null
  }

  async connect(): Promise<void> {
    await this.ensure()
  }

  async ask(text: string, handler: RealtimeToolHandler): Promise<RealtimeTurnResult> {
    return this.run((session) => session.ask(text, handler))
  }

  async askAudio(pcm: Buffer, handler: RealtimeToolHandler): Promise<RealtimeTurnResult> {
    return this.run((session) => session.askAudio(pcm, handler))
  }

  close(): void {
    this.closed = true
    this.retire()
  }

  private retire(): void {
    const active = this.active
    this.active = null
    try {
      active?.close()
    } catch {
      // Closing a socket that is already gone is not a failure worth reporting.
    }
  }

  private async run(
    call: (session: RealtimeSessionClient) => Promise<RealtimeTurnResult>,
  ): Promise<RealtimeTurnResult> {
    const session = await this.ensure()
    try {
      return await call(session)
    } catch (error) {
      if (this.active === session && isRealtimeTransportFailure(error)) this.retire()
      throw error
    }
  }

  private async ensure(): Promise<RealtimeSessionClient> {
    if (this.closed) throw new Error('Athena voice Realtime client is closed.')
    const active = this.active
    if (active && !this.expiring(active)) return active
    const reason: RealtimeSessionReason = active
      ? 'renewal'
      : this.generations === 0 ? 'initial' : 'recovery'
    if (active) this.retire()
    return this.reopen(reason)
  }

  private expiring(session: RealtimeSessionClient): boolean {
    const deadline = session.expiresAt?.() ?? null
    return deadline !== null && deadline - this.now() <= this.renewMarginMs
  }

  private async reopen(reason: RealtimeSessionReason): Promise<RealtimeSessionClient> {
    let announced = false
    let last: Error | null = null
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const generation = this.generations + 1
      let session: RealtimeSessionClient | null = null
      try {
        session = this.openSession(generation)
        await session.connect()
        this.generations = generation
        this.active = session
        this.onSession({ generation, reason })
        return session
      } catch (error) {
        last = error as Error
        try {
          session?.close()
        } catch {
          // The half-open socket is already unusable; the retry below is the recovery.
        }
        if (!announced && reason !== 'initial') {
          // Once per episode. A line per attempt turns a three-attempt recovery into
          // three interruptions of a user who only needs to know it is being handled.
          announced = true
          this.onWarn(
            'Athena voice lost the OpenAI Realtime connection ' +
            `(${plainBounded(last.message, 160)}); reconnecting.`,
          )
        }
        if (this.closed) break
        // Exponential backoff: a provider refusing connections must not be hammered, and
        // a busy-loop here would burn the machine while saying nothing useful.
        if (attempt < this.maxAttempts) await this.sleep(this.backoffMs * 2 ** (attempt - 1))
        if (this.closed) break
      }
    }
    throw new Error(`${RECONNECT_FAILURE} Last error: ${plainBounded(last?.message ?? 'unknown', 200)}`)
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
