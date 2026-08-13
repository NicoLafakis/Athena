import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

/** One response the fake provider serves for one `response.create`. */
export interface ScriptedRealtimeResponse {
  /** Served as `function_call` output items; the client answers them and asks again. */
  toolCalls?: Array<{ name: string; callId?: string; arguments: unknown }>
  transcript?: string
  audio?: Buffer
  usage?: unknown
}

export interface FakeRealtimeSocketOptions {
  script?: ScriptedRealtimeResponse[]
  /** Provider session deadline in epoch seconds, as `session.created` reports it. */
  expiresAtSeconds?: number
}

/** What an unscripted `response.create` gets, so a short script fails an assertion not a timeout. */
export const UNSCRIPTED_TRANSCRIPT = 'unscripted-response'

/**
 * A fake OpenAI Realtime socket that speaks the real wire protocol, so a test can drive
 * the production {@link RealtimeVoiceClient} rather than a stub of it: `session.update` is
 * answered with `session.created`/`session.updated`, and every `response.create` is served
 * the next scripted response — including the function-call round trip, which the client
 * closes by sending `function_call_output` and asking again.
 *
 * Replies are queued on a microtask rather than sent inside `send`, because the real socket
 * never answers re-entrantly and the client's pending-turn bookkeeping assumes it does not.
 */
export class FakeRealtimeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  /** Every event the client sent, parsed. */
  readonly sent: Array<Record<string, unknown>> = []
  /** Responses served, including unscripted fallbacks. */
  served = 0

  private readonly script: ScriptedRealtimeResponse[]
  private readonly expiresAtSeconds: number | undefined

  constructor(options: FakeRealtimeSocketOptions = {}) {
    super()
    this.script = [...(options.script ?? [])]
    this.expiresAtSeconds = options.expiresAtSeconds
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  send(raw: string): void {
    const event = JSON.parse(raw) as Record<string, unknown>
    this.sent.push(event)
    if (event['type'] === 'session.update') {
      queueMicrotask(() => {
        this.deliver({
          type: 'session.created',
          session: {
            id: 'sess_fake',
            ...(this.expiresAtSeconds === undefined ? {} : { expires_at: this.expiresAtSeconds }),
          },
        })
        this.deliver({ type: 'session.updated' })
      })
      return
    }
    if (event['type'] === 'response.create') queueMicrotask(() => this.serve())
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED
  }

  /** Push one arbitrary server event, for protocol errors and drops. */
  deliver(event: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(event)))
  }

  /** The user text the client put on the wire (`ask`), in order. */
  userInputs(): string[] {
    return this.sent.flatMap((event) => {
      if (event['type'] !== 'conversation.item.create') return []
      const item = event['item'] as { role?: string; content?: Array<{ type?: string; text?: string }> }
      if (item?.role !== 'user') return []
      return (item.content ?? [])
        .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
        .map((part) => part.text as string)
    })
  }

  /**
   * The out-of-band `system` items the client seeded (`note`), in order. Separate from
   * {@link userInputs} on purpose: a note must never reach the wire dressed as the user.
   */
  systemNotes(): string[] {
    return this.sent.flatMap((event) => {
      if (event['type'] !== 'conversation.item.create') return []
      const item = event['item'] as {
        type?: string
        role?: string
        content?: Array<{ type?: string; text?: string }>
      }
      if (item?.type !== 'message' || item.role !== 'system') return []
      return (item.content ?? [])
        .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
        .map((part) => part.text as string)
    })
  }

  /** The tool results the client returned, in order, as raw JSON strings. */
  functionOutputs(): string[] {
    return this.sent.flatMap((event) => {
      if (event['type'] !== 'conversation.item.create') return []
      const item = event['item'] as { type?: string; output?: unknown }
      return item?.type === 'function_call_output' && typeof item.output === 'string'
        ? [item.output]
        : []
    })
  }

  private serve(): void {
    const next = this.script.shift() ?? { transcript: UNSCRIPTED_TRANSCRIPT }
    this.served += 1
    if (next.toolCalls && next.toolCalls.length > 0) {
      this.deliver({
        type: 'response.done',
        response: {
          output: next.toolCalls.map((call, index) => ({
            type: 'function_call',
            name: call.name,
            call_id: call.callId ?? `call-${this.served}-${index}`,
            arguments: JSON.stringify(call.arguments),
          })),
          ...(next.usage === undefined ? {} : { usage: next.usage }),
        },
      })
      return
    }
    if (next.transcript) {
      this.deliver({ type: 'response.output_audio_transcript.delta', delta: next.transcript })
    }
    if (next.audio && next.audio.length > 0) {
      this.deliver({ type: 'response.output_audio.delta', delta: next.audio.toString('base64') })
    }
    this.deliver({
      type: 'response.done',
      response: {
        status: 'completed',
        output: [],
        ...(next.usage === undefined ? {} : { usage: next.usage }),
      },
    })
  }
}
