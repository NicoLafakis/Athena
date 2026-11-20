import WebSocket from 'ws'
import { z } from 'zod'
import { plainBounded } from '../interaction/format.js'
import { RealtimeTransportError, type RealtimeVoiceModel } from './realtime.js'

const ServerEventSchema = z.object({ type: z.string() }).passthrough()

const SPEECH_PEAK_THRESHOLD = 50
const SILENCE_FLUSH_FRAMES = 5 // ~500ms silent output frames -> commit Athena's transcript line

export interface DuplexAudioTransport {
  start(handlers: {
    onReady: (backend: string) => void
    onFrame: (pcm: Buffer, level: number) => void
    onWarn: (message: string) => void
  }): void
  playChunk(pcm: Buffer): void
  flushPlayback(): void
  close(): void
}

export interface LiveVoiceSessionOptions {
  apiKey: string
  model: RealtimeVoiceModel
  duplex: DuplexAudioTransport
  persona?: string
  voice?: string
  signal?: AbortSignal
  connectTimeoutMs?: number
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket
  onReady?: (backend: string) => void
  onMicLevel?: (level: number) => void
  onAthenaLevel?: (level: number) => void
  onUserHypothesis?: (text: string) => void
  onUserTranscript?: (text: string) => void
  onAthenaTranscript?: (text: string) => void
  onAthenaSpeaking?: (speaking: boolean) => void
  onStatus?: (text: string) => void
  onWarn?: (message: string) => void
  /** Optional asynchronous harness delegation callback when GPT-Live emits session.delegation.created. */
  onDelegate?: (prompt: string, delegationId: string) => Promise<string>
  onDelegateStart?: (info: { id: string; prompt: string }) => void
  onDelegateEnd?: (info: { id: string; status: 'completed' | 'failed'; detail?: string }) => void
}

function buildLiveVoiceInstructions(persona?: string): string {
  const rules = [
    'You are Athena, the terminal coding agent in this session, speaking directly with the user by voice in first person ("I", "me", "my").',
    'Never describe Athena, the harness, or the engine as a separate person or assistant standing between you and the user.',
    'Whenever the user asks you to inspect files, check git status, run commands, edit code, search the repository, or perform any project task, trigger client delegation immediately rather than guessing or promising to check without delegating.',
    'When a delegated task starts, tell the user briefly that you are on it. When the result arrives via commentary, report it concisely and faithfully in first person as your own completed work.',
    'Keep spoken replies concise, natural, and direct — a colleague, not a narrator.',
  ]
  const trimmed = persona?.trim().slice(0, 2_048)
  if (!trimmed) return rules.join(' ')
  return [...rules, `Athena's constitution:\n${trimmed}`].join(' ')
}

function measurePcmLevel(pcm: Buffer): { hasSpeech: boolean; level: number } {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) return { hasSpeech: false, level: 0 }
  let sumSq = 0
  let peak = 0
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2)
    const abs = Math.abs(s)
    if (abs > peak) peak = abs
    const norm = s / 32_768
    sumSq += norm * norm
  }
  const rms = Math.sqrt(sumSq / samples)
  const dbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -96
  const level = Math.max(0, Math.min(100, Math.round(((dbfs + 58) / 44) * 100)))
  return { hasSpeech: peak > SPEECH_PEAK_THRESHOLD, level }
}

/**
 * True full-duplex streaming session for OpenAI GPT-Live (`gpt-live-1.1` / `gpt-live-1`).
 *
 * Unlike half-duplex turn-by-turn Realtime sessions, GPT-Live streams microphone audio
 * continuously via `session.input_audio.append` and streams Athena's audio directly to
 * `waveOutWrite` on every `session.output_audio.delta` chunk — eliminating local VAD wait,
 * artificial silence tails, reply buffering, and per-turn PowerShell playback spawns.
 */
export async function runLiveVoiceSession(options: LiveVoiceSessionOptions): Promise<void> {
  const url = 'wss://api.openai.com/v1/live/sessions'
  const wsOptions: WebSocket.ClientOptions = {
    headers: { Authorization: `Bearer ${options.apiKey}` },
    family: 4,
  }
  const socket = options.webSocketFactory
    ? options.webSocketFactory(url, wsOptions)
    : new WebSocket(url, wsOptions)

  let eventSeq = 0
  const nextEventId = (prefix: string): string => {
    eventSeq += 1
    return `evt_${prefix}_${eventSeq}`
  }

  let closed = false
  let sessionStarted = false
  let userTranscriptBuf = ''
  let lastUserUtterance = ''
  let athenaTranscriptBuf = ''
  let athenaSpeaking = false
  let silentOutputFrames = 0
  const seenDelegationIds = new Set<string>()

  const flushUserTranscript = (): void => {
    const text = userTranscriptBuf.trim()
    userTranscriptBuf = ''
    if (text) {
      lastUserUtterance = text
      options.onUserTranscript?.(text)
    }
  }

  const flushAthenaTranscript = (): void => {
    const text = athenaTranscriptBuf.trim()
    athenaTranscriptBuf = ''
    if (text) options.onAthenaTranscript?.(text)
  }

  const sendJson = (payload: unknown): void => {
    if (closed || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(payload))
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      closed = true
      clearTimeout(connectTimer)
      options.signal?.removeEventListener('abort', onAbort)
      flushUserTranscript()
      flushAthenaTranscript()
      options.duplex.close()
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'session.close', event_id: nextEventId('close') }))
        } catch {
          // ignore
        }
        socket.close(1000)
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate()
      }
      if (error) reject(error)
      else resolve()
    }

    const onAbort = (): void => finish()
    if (options.signal?.aborted) {
      finish()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const connectTimer = setTimeout(() => {
      if (!sessionStarted) {
        finish(new RealtimeTransportError('Timed out starting OpenAI Live voice session.', 'connect_timeout'))
      }
    }, options.connectTimeoutMs ?? 15_000)

    socket.on('open', () => {
      sendJson({
        type: 'session.start',
        event_id: nextEventId('start'),
        session: {
          model: options.model,
          instructions: buildLiveVoiceInstructions(options.persona),
          audio: {
            format: { type: 'audio/pcm', rate: 24_000 },
            output: { voice: options.voice ?? 'marin' },
          },
          delegation: { type: 'client' },
        },
      })
    })

    socket.on('message', (raw) => {
      let value: unknown
      try {
        value = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      const parsed = ServerEventSchema.safeParse(value)
      if (!parsed.success) return
      const event = parsed.data as Record<string, unknown> & { type: string }

      if (event.type === 'session.started') {
        sessionStarted = true
        clearTimeout(connectTimer)
        options.onStatus?.(`Live full-duplex connected (${options.model})`)
        options.duplex.start({
          onReady: (backend) => options.onReady?.(backend),
          onWarn: (msg) => options.onWarn?.(msg),
          onFrame: (pcm, level) => {
            options.onMicLevel?.(level)
            sendJson({
              type: 'session.input_audio.append',
              audio: pcm.toString('base64'),
            })
          },
        })
        return
      }

      if (event.type === 'error') {
        const detail = event.error as { message?: unknown; code?: unknown } | undefined
        const msg = `Live voice API error: ${String(detail?.message ?? 'unknown error')}`
        if (!sessionStarted) {
          finish(new RealtimeTransportError(msg, typeof detail?.code === 'string' ? detail.code : 'api_error'))
        } else {
          options.onWarn?.(msg)
        }
        return
      }

      if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
        userTranscriptBuf += event.delta
        options.onUserHypothesis?.(userTranscriptBuf.trim())
        return
      }

      if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
        if (userTranscriptBuf.trim()) flushUserTranscript()
        athenaTranscriptBuf += event.delta
        return
      }

      if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
        const chunk = Buffer.from(event.delta, 'base64')
        const { hasSpeech, level } = measurePcmLevel(chunk)
        if (hasSpeech) {
          if (userTranscriptBuf.trim()) flushUserTranscript()
          if (!athenaSpeaking) {
            athenaSpeaking = true
            options.onAthenaSpeaking?.(true)
          }
          silentOutputFrames = 0
          options.onAthenaLevel?.(level)
          options.duplex.playChunk(chunk)
        } else if (athenaSpeaking) {
          silentOutputFrames += 1
          options.onAthenaLevel?.(0)
          if (silentOutputFrames >= SILENCE_FLUSH_FRAMES) {
            athenaSpeaking = false
            silentOutputFrames = 0
            options.onAthenaSpeaking?.(false)
            flushAthenaTranscript()
          }
        }
        return
      }

      // Handle OpenAI GPT-Live client delegation (`session.delegation.created`)
      // Per OpenAI docs, `session.delegation.created` carries `delegation.id` and the client
      // reads the user's request from recent `session.input_transcript.delta` text.
      if (
        options.onDelegate &&
        event.type === 'session.delegation.created'
      ) {
        const delegationObj = event['delegation'] as { id?: unknown; target?: unknown } | undefined
        const delegationId =
          typeof delegationObj?.id === 'string'
            ? delegationObj.id
            : typeof event['delegation_id'] === 'string'
              ? event['delegation_id']
              : null
        if (!delegationId || seenDelegationIds.has(delegationId)) return
        seenDelegationIds.add(delegationId)
        if (userTranscriptBuf.trim()) flushUserTranscript()
        const rawPrompt =
          typeof event['prompt'] === 'string' && event['prompt'].trim()
            ? event['prompt']
            : typeof event['content'] === 'string' && event['content'].trim()
              ? event['content']
              : lastUserUtterance
        const prompt = plainBounded(rawPrompt || 'Inspect the current request from the user.', 4_096)
        options.onDelegateStart?.({ id: delegationId, prompt })
        void options.onDelegate(prompt, delegationId).then(
          (summary) => {
            const bounded = plainBounded(summary, 1_500)
            options.onDelegateEnd?.({ id: delegationId, status: 'completed', detail: bounded })
            sendJson({
              type: 'session.commentary.append',
              event_id: nextEventId('commentary'),
              delegation_id: delegationId,
              content: bounded || 'Task completed.',
            })
          },
          (err: unknown) => {
            const msg = plainBounded((err as Error).message, 400)
            options.onDelegateEnd?.({ id: delegationId, status: 'failed', detail: msg })
            sendJson({
              type: 'session.commentary.append',
              event_id: nextEventId('commentary'),
              delegation_id: delegationId,
              content: `That task failed: ${msg}`,
            })
          },
        )
      }
    })

    socket.on('error', (err) => {
      finish(new RealtimeTransportError(`Live voice connection failed: ${err.message}`, 'socket_error'))
    })

    socket.on('close', () => {
      finish()
    })
  })
}
