import { createInterface } from 'node:readline/promises'
import { plainBounded } from '../interaction/format.js'
import type { HarnessSessionController } from '../harness/controller.js'
import {
  parseVoicePermissionCommand,
  type VoiceAttentionBridge,
  type VoicePermissionNotice,
} from './attention.js'
import {
  VoicePermissionAnswerSchema,
  VoiceTurnSubmissionSchema,
  type VoiceTurnSource,
} from './schemas.js'
import { VoiceTurnLedger } from './turns.js'
import {
  ReconnectingRealtimeClient,
  RealtimeVoiceClient,
  buildVoiceInstructions,
  isRealtimeTransportFailure,
  type ReconnectingRealtimeOptions,
  type RealtimeToolCall,
  type RealtimeTurnResult,
  type RealtimeVoiceModel,
} from './realtime.js'
import {
  NULL_VOICE_TELEMETRY,
  type VoiceEventLabel,
  type VoiceTelemetryRecorder,
} from './telemetry.js'
import {
  playWindowsPcm,
  probeWindowsSpeech,
  realtimePcmFromWave,
  spawnWindowsWakeListener,
  speakWindowsText,
  stripWakePhrase,
  type RecognizedPhrase,
} from './windows-speech.js'

const WINDOWS_WAKE_MINIMUM_CONFIDENCE = 0.5

export interface VoiceCommandInput {
  next(): Promise<VoiceCommand | null>
  close(): void
}

export type VoiceCommand =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; pcm: Buffer; wakeTranscript: string }

/** The streaming subset of ChildProcess the wake listener needs (injectable for tests). */
export interface WakeListenerProcess {
  readonly stdout: NodeJS.EventEmitter | null
  readonly stderr: NodeJS.EventEmitter | null
  readonly stdin: { write(chunk: string): unknown; end(): unknown } | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type WakeListenerSpawner = () => WakeListenerProcess

export interface WindowsPersistentWakeOptions {
  minimumConfidence?: number
  spawn?: WakeListenerSpawner
  /** Unexpected exits tolerated before the input fails loudly. */
  maxRestarts?: number
  restartDelayMs?: number
  /** Per-attempt budget for the listener's real microphone readiness round trip. */
  readyTimeoutMs?: number
  /** Grace between the `exit` line and a forced kill on close. */
  closeGraceMs?: number
  /** Queued wake events accepted while Athena is busy answering an earlier turn. */
  maxQueue?: number
  /** How long a bare wake word holds the command-capture window open. */
  listeningWindowMs?: number
  now?: () => number
  /** Fired when a bare wake word opens the capture window (cue hook). */
  onListening?: () => void
  /**
   * Fired once per attempt when the listener proves microphone readiness, carrying the
   * recognizer it opened. Without it a caller cannot tell "ready but silent" apart from
   * "never came up" — the exact distinction `athena voice probe` has to report.
   */
  onReady?: (recognizer: string | null) => void
  onWarn?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  /** Lifecycle counters. Wake events are counted locally and never carry what was said. */
  telemetry?: VoiceTelemetryRecorder
}

interface WakeAttempt {
  child: WakeListenerProcess
  settled: boolean
  timer: NodeJS.Timeout | null
  stderrTail: string
}

const PERSISTENT_WAKE_FAILURE =
  'The Windows wake listener stopped repeatedly. ' +
  'Run `athena voice probe` to check the microphone and local speech backend.'

/**
 * One supervised, long-lived Windows recognition process: the microphone opens once and
 * wake phrases arrive as JSONL. Replaces the old one-process-per-listen churn. Ambient
 * audio still never leaves the machine; only post-wake utterances are emitted.
 */
export class WindowsPersistentWakeInput implements VoiceCommandInput {
  private readonly minimumConfidence: number
  private readonly spawn: WakeListenerSpawner
  private readonly maxRestarts: number
  private readonly restartDelayMs: number
  private readonly readyTimeoutMs: number
  private readonly closeGraceMs: number
  private readonly maxQueue: number
  private readonly listeningWindowMs: number
  private readonly now: () => number
  private readonly onListening: () => void
  private readonly onReady: (recognizer: string | null) => void
  private readonly onWarn: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>
  private readonly meter: VoiceTelemetryRecorder

  private attempt: WakeAttempt | null = null
  private lineBuffer = ''
  private queue: VoiceCommand[] = []
  private waiters: Array<{ resolve: (command: VoiceCommand) => void; reject: (error: Error) => void }> = []
  private closed = false
  private failed: Error | null = null
  private restarts = 0
  private restarting = false
  private listeningUntil = 0

  constructor(options: WindowsPersistentWakeOptions = {}) {
    this.minimumConfidence = options.minimumConfidence ?? WINDOWS_WAKE_MINIMUM_CONFIDENCE
    this.spawn = options.spawn ?? (() => spawnWindowsWakeListener())
    this.maxRestarts = options.maxRestarts ?? 3
    this.restartDelayMs = options.restartDelayMs ?? 500
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000
    this.closeGraceMs = options.closeGraceMs ?? 1_000
    this.maxQueue = options.maxQueue ?? 8
    this.listeningWindowMs = options.listeningWindowMs ?? 6_000
    this.now = options.now ?? (() => Date.now())
    this.onListening = options.onListening ?? (() => {})
    this.onReady = options.onReady ?? (() => {})
    this.onWarn = options.onWarn ?? (() => {})
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.meter = options.telemetry ?? NULL_VOICE_TELEMETRY
  }

  async next(): Promise<VoiceCommand | null> {
    const queued = this.queue.shift()
    if (queued) return queued
    if (this.failed) throw this.failed
    if (this.closed) throw new Error('Athena voice wake listener is closed.')
    this.ensureAttempt()
    return new Promise<VoiceCommand>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectWaiters(new Error('Athena voice wake listener is closed.'))
    const attempt = this.attempt
    if (!attempt) return
    if (attempt.timer) clearTimeout(attempt.timer)
    const child = attempt.child
    try {
      child.stdin?.write('exit\n')
      child.stdin?.end()
    } catch {
      // The process may already be gone; the grace timer below still applies.
    }
    const killTimer = setTimeout(() => {
      try { child.kill() } catch { /* already exited */ }
    }, this.closeGraceMs)
    killTimer.unref?.()
    child.once('exit', () => clearTimeout(killTimer))
  }

  private ensureAttempt(): void {
    if (this.attempt || this.restarting || this.closed || this.failed) return
    try {
      this.spawnAttempt()
    } catch (error) {
      void this.restart((error as Error).message, 'not-ready')
    }
  }

  private spawnAttempt(): void {
    const child = this.spawn()
    const attempt: WakeAttempt = { child, settled: false, timer: null, stderrTail: '' }
    this.attempt = attempt
    this.lineBuffer = ''
    child.stdout?.on('data', (chunk: Buffer | string) => this.onChunk(attempt, chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => {
      attempt.stderrTail = (attempt.stderrTail + chunk.toString('utf8')).slice(-512)
    })
    child.once('exit', (code, signal) => this.onExit(child, code, signal))
    attempt.timer = setTimeout(() => {
      attempt.timer = null
      if (this.attempt !== attempt || attempt.settled || this.closed) return
      this.onWarn(
        'Athena voice wake listener did not prove microphone readiness in time; restarting it. ' +
        'If this repeats, run `athena voice probe`.',
      )
      try { child.kill() } catch { /* the exit handler drives the restart */ }
    }, this.readyTimeoutMs)
    attempt.timer.unref?.()
  }

  private onChunk(attempt: WakeAttempt, chunk: Buffer | string): void {
    this.lineBuffer += chunk.toString('utf8')
    const lines = this.lineBuffer.split(/\r?\n/)
    this.lineBuffer = lines.pop() ?? ''
    for (const line of lines) this.onLine(attempt, line)
  }

  private onLine(attempt: WakeAttempt, line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: {
      ready?: unknown
      recognizer?: unknown
      text?: unknown
      confidence?: unknown
      wave?: unknown
    }
    try {
      parsed = JSON.parse(trimmed) as typeof parsed
    } catch {
      return
    }
    if (this.attempt !== attempt) return
    if (!attempt.settled) {
      // The first structured line must be the listener's real readiness round trip.
      if (parsed.ready === true) {
        attempt.settled = true
        if (attempt.timer) clearTimeout(attempt.timer)
        attempt.timer = null
        const recognizer = typeof parsed.recognizer === 'string' ? parsed.recognizer.trim() : ''
        this.onReady(recognizer || null)
      }
      return
    }
    if (typeof parsed.text !== 'string') return
    const text = parsed.text.trim()
    const wave = typeof parsed.wave === 'string' ? Buffer.from(parsed.wave, 'base64') : Buffer.alloc(0)
    if (!text || wave.length === 0) return
    let audio: Buffer
    try {
      audio = realtimePcmFromWave(wave)
    } catch (error) {
      this.meter.record({ event: 'wake.rejected', label: 'malformed-audio' })
      this.onWarn(`Athena voice skipped malformed wake audio: ${(error as Error).message}`)
      return
    }
    this.handlePhrase({ text, confidence: Number(parsed.confidence ?? 0), audio })
  }

  /**
   * The wake/listen state machine. A fluid "Athena, <command>" phrase ships its whole
   * audio (Realtime's instructions discount the wake word). A bare "Athena" is answered
   * LOCALLY — listening cue plus a capture window — and is never uploaded; the next
   * phrase inside the window is the command. Anything else is ambient speech and is
   * dropped on-device.
   */
  private handlePhrase(phrase: RecognizedPhrase): void {
    // Counted, never quoted: a rejected wake must leave a number behind and nothing else,
    // or the counter becomes a transcript of everything said near the microphone.
    if (phrase.confidence < this.minimumConfidence) {
      this.meter.record({ event: 'wake.rejected', label: 'low-confidence' })
      return
    }
    const text = phrase.text.trim()
    if (stripWakePhrase(text)) {
      this.listeningUntil = 0
      this.meter.record({ event: 'wake.accepted', label: 'wake-phrase' })
      this.deliver({ kind: 'audio', pcm: phrase.audio, wakeTranscript: text })
      return
    }
    if (/^athena[,.!?;:]?$/i.test(text)) {
      this.listeningUntil = this.now() + this.listeningWindowMs
      this.meter.record({ event: 'wake.accepted', label: 'wake-word' })
      this.onListening()
      return
    }
    if (this.now() < this.listeningUntil) {
      this.listeningUntil = 0
      this.meter.record({ event: 'wake.accepted', label: 'capture-window' })
      this.deliver({ kind: 'audio', pcm: phrase.audio, wakeTranscript: text })
      return
    }
    this.meter.record({ event: 'wake.rejected', label: 'ambient' })
  }

  private deliver(command: VoiceCommand): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(command)
    else {
      this.queue.push(command)
      while (this.queue.length > this.maxQueue) this.queue.shift()
    }
  }

  private onExit(child: WakeListenerProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const attempt = this.attempt
    if (!attempt || attempt.child !== child) return
    if (attempt.timer) clearTimeout(attempt.timer)
    const reason = attempt.settled
      ? `process exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code ?? 'unknown'}`}`
      : (attempt.stderrTail.trim().split(/\r?\n/).pop()?.trim() ||
        'the listener exited before proving microphone readiness')
    const settled = attempt.settled
    this.attempt = null
    if (this.closed || this.failed) return
    void this.restart(reason, settled ? 'crash' : 'not-ready')
  }

  private async restart(reason: string, label: 'crash' | 'not-ready'): Promise<void> {
    if (this.restarting || this.closed || this.failed) return
    this.restarting = true
    try {
      let detail = reason
      while (!this.closed && !this.failed) {
        if (this.restarts >= this.maxRestarts) {
          this.failed = new Error(PERSISTENT_WAKE_FAILURE)
          this.meter.record({ event: 'wake.failed', label })
          this.rejectWaiters(this.failed)
          return
        }
        this.restarts += 1
        this.meter.record({ event: 'wake.restart', label })
        this.onWarn(
          `Athena voice wake listener stopped (${detail}); ` +
          `restarting (${this.restarts}/${this.maxRestarts}). If this repeats, run \`athena voice probe\`.`,
        )
        await this.sleep(this.restartDelayMs)
        if (this.closed || this.failed) return
        try {
          this.spawnAttempt()
          return
        } catch (error) {
          detail = (error as Error).message
        }
      }
    } finally {
      this.restarting = false
    }
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }
}

export interface KeyboardVoiceCommandInputOptions {
  /**
   * Ctrl+C while the prompt is open. A terminal readline holds the TTY in raw mode, so the
   * keystroke arrives as an interface event and never reaches a process SIGINT listener;
   * without forwarding it, keyboard mode would have no immediate stop at all (FR-011).
   */
  onInterrupt?: () => void
  /** Terminal seams; production reads the real terminal. */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export class KeyboardVoiceCommandInput implements VoiceCommandInput {
  private readonly reader: ReturnType<typeof createInterface>
  private readonly aborter = new AbortController()

  constructor(options: KeyboardVoiceCommandInputOptions = {}) {
    this.reader = createInterface({
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    })
    if (options.onInterrupt) this.reader.on('SIGINT', options.onInterrupt)
  }

  async next(): Promise<VoiceCommand | null> {
    // The signal is load-bearing: a pending question never settles once the interface is
    // closed, so a shutdown would hang on the very prompt it is trying to leave.
    const answer = (await this.reader.question(
      'Athena voice command: ',
      { signal: this.aborter.signal },
    )).trim()
    return answer ? { kind: 'text', text: answer } : null
  }

  close(): void {
    this.aborter.abort()
    this.reader.close()
  }
}

export interface WakeProbeResult {
  passed: boolean
  heard: string[]
  command: string | null
  audio: Buffer | null
  /** What the persistent listener itself reported, bounded to one report line. */
  detail: string | null
}

export interface WakeProbeOptions {
  /** Builds the listener under test; defaults to the production persistent listener. */
  createInput?: (options: WindowsPersistentWakeOptions) => VoiceCommandInput
  onRetry?: () => Promise<void>
  maxAttempts?: number
  /** Budget for one spoken attempt, spawn and readiness included. */
  attemptTimeoutMs?: number
  /** Listener seams (`spawn`, `now`, `sleep`, timings). Production defaults otherwise. */
  listener?: WindowsPersistentWakeOptions
}

/**
 * Longer than the listener's own 15 s readiness budget on purpose: when readiness stalls
 * the listener must be the one to time out and say so, otherwise the probe reports a
 * generic "heard nothing" for what is actually a microphone that never opened.
 */
const WAKE_PROBE_ATTEMPT_MS = 20_000

interface WakeAttemptObservation {
  ready: boolean
  bareWake: boolean
  recognizer: string | null
  warnings: string[]
  fatal: Error | null
}

/** One bounded, actionable sentence naming what the listener reported, not just "failed". */
function describeWakeAttempt(seen: WakeAttemptObservation): string {
  if (seen.fatal) return plainBounded(seen.fatal.message, 240)
  const base = !seen.ready
    ? 'the listener never proved microphone readiness'
    : seen.bareWake
      ? 'heard the wake word Athena, but no command followed inside the capture window'
      : `listener ready (${seen.recognizer ?? 'recognizer unreported'}), but no Athena wake phrase arrived`
  const reported = seen.warnings.at(-1)
  return plainBounded(reported ? `${base}; listener reported: ${reported}` : base, 240)
}

/**
 * `next()` waits forever by design, so this timeout is what keeps the diagnostic from
 * becoming the same hang it exists to explain. Resolves null when the budget expires.
 */
async function awaitWakeCommand(
  input: VoiceCommandInput,
  timeoutMs: number,
): Promise<VoiceCommand | null> {
  let expire: (value: 'timeout') => void = () => {}
  const expiry = new Promise<'timeout'>((resolve) => {
    expire = resolve
  })
  const timer = setTimeout(() => expire('timeout'), timeoutMs)
  timer.unref?.()
  try {
    for (;;) {
      // A null from the input is "nothing usable yet"; only the deadline ends the attempt.
      const settled = await Promise.race([input.next(), expiry])
      if (settled === 'timeout') return null
      if (settled) return settled
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Drive the PRODUCTION wake path end to end — process spawn, readiness round trip, JSONL
 * framing, `realtimePcmFromWave`, and the wake state machine — and report on it. Every
 * voice failure message sends the user here, so probing a different recognizer than the
 * one that failed made this command worthless as a diagnostic: it could pass while the
 * real listener was broken, or fail while it was fine.
 *
 * One listener per attempt, closed before the retry cue is spoken: a listener left open
 * across the cue would hear Athena say "Athena voice probe" and pass itself.
 */
export async function waitForWakeProbe(options: WakeProbeOptions = {}): Promise<WakeProbeResult> {
  const createInput = options.createInput
    ?? ((listener: WindowsPersistentWakeOptions) => new WindowsPersistentWakeInput(listener))
  const onRetry = options.onRetry ?? (() => speakWindowsText(
    'I did not hear Athena. Please say Athena voice probe now.',
  ))
  const attempts = Math.max(1, Math.round(options.maxAttempts ?? 3))
  const attemptTimeoutMs = Math.max(1, Math.round(options.attemptTimeoutMs ?? WAKE_PROBE_ATTEMPT_MS))
  const heard: string[] = []
  let detail = 'the wake listener was never started'
  for (let attempt = 0; attempt < attempts; attempt++) {
    const seen: WakeAttemptObservation = {
      ready: false, bareWake: false, recognizer: null, warnings: [], fatal: null,
    }
    const input = createInput({
      ...options.listener,
      onReady: (recognizer) => {
        seen.ready = true
        seen.recognizer = recognizer
      },
      onListening: () => {
        // A pause after "Athena" is a legitimate way to reach the command; recording it
        // turns a silent retry into "I heard the wake word, the command never came".
        seen.bareWake = true
        heard.push('Athena')
      },
      onWarn: (message) => {
        seen.warnings.push(message)
        if (seen.warnings.length > 4) seen.warnings.shift()
      },
    })
    let command: VoiceCommand | null = null
    try {
      command = await awaitWakeCommand(input, attemptTimeoutMs)
    } catch (error) {
      seen.fatal = error as Error
    } finally {
      // Unconditional: a probe that leaks a listener holds the microphone the session the
      // user is about to start needs. `close()` asks for `exit` and escalates to a kill.
      input.close()
    }
    if (command?.kind === 'audio') {
      heard.push(command.wakeTranscript)
      return {
        passed: true,
        heard,
        // A fluid "Athena, <command>" carries the wake word; a command spoken after a
        // bare wake word does not, and is already the command itself.
        command: stripWakePhrase(command.wakeTranscript) ?? command.wakeTranscript,
        audio: command.pcm,
        detail: `persistent wake listener, recognizer: ${seen.recognizer ?? 'unreported'}`,
      }
    }
    detail = describeWakeAttempt(seen)
    // Asking the user to speak again cannot fix a listener that will not stay running.
    if (seen.fatal) break
    if (attempt + 1 < attempts) await onRetry()
  }
  return { passed: false, heard, command: null, audio: null, detail }
}

export interface VoiceSessionOptions {
  apiKey: string
  model: RealtimeVoiceModel
  input: VoiceCommandInput
  controller?: HarnessSessionController
  /**
   * Permission approver and announcement sink shared with the controller. Without it the
   * harness keeps its headless auto-deny and voice can only do read-only work.
   */
  attention?: VoiceAttentionBridge
  /**
   * One fixed session with no renewal or reconnect. This is the single-shot seam; normal
   * use goes through `clientFactory` so a dropped or expiring session can be replaced.
   */
  client?: VoiceRealtimeClient
  /** Builds session `generation`; called again for every renewal and reconnect. */
  clientFactory?: (generation: number) => VoiceRealtimeClient
  /** Reconnect bounds and clock seams; production defaults otherwise. */
  reconnect?: Omit<ReconnectingRealtimeOptions, 'open' | 'onWarn' | 'onSession'>
  play?: (audio: Buffer) => Promise<void>
  speakFallback?: (text: string) => Promise<void>
  onStatus?: (message: string) => void
  /**
   * Lifecycle counters, provider usage, and latency. Optional and non-fatal by
   * construction: a ledger that cannot be written must never cost a turn.
   */
  telemetry?: VoiceTelemetryRecorder
  maxCommands?: number
  /** Athena's constitution text, woven into the Realtime session instructions. */
  persona?: string
  /** Fired after each spoken reply finishes — the back-at-wake-standby cue hook. */
  onStandby?: () => void
}

export interface VoiceRealtimeClient {
  connect(): Promise<void>
  ask(text: string, handler: (call: RealtimeToolCall) => Promise<unknown>): Promise<RealtimeTurnResult>
  askAudio(pcm: Buffer, handler: (call: RealtimeToolCall) => Promise<unknown>): Promise<RealtimeTurnResult>
  close(): void
  /** Absolute provider deadline, when this session reports one. */
  expiresAt?(): number | null
  /**
   * Seeds one conversation item without asking for a reply. Optional: a session with no
   * such channel still speaks every permission locally and still answers it, so this is
   * context the model gains, never a step the permission path depends on.
   */
  note?(text: string): Promise<void>
}

/** Which closed counter label each notice kind writes; the summary never becomes one. */
const PERMISSION_NOTICE_LABELS: Record<VoicePermissionNotice['kind'], VoiceEventLabel> = {
  pending: 'permission-pending',
  resolved: 'permission-resolved',
  refused: 'permission-refused',
  shutdown: 'permission-shutdown',
}

/**
 * What the live model session is told about a permission — and the exact limit of it.
 *
 * Athena has already spoken the canonical request herself, straight from the accessible
 * record, so this text must not invite a repeat of it and must not read as a cue to reply.
 * It is added to the conversation with no `response.create` behind it; its whole job is to
 * put the identity and the fact of an outstanding decision where the model can reach them
 * on the turn the user actually answers. It confers nothing: only a validated
 * `local_control` call arriving at `VoiceAttentionBridge.resolve` decides anything.
 */
export function permissionNoticeText(notice: VoicePermissionNotice): string {
  switch (notice.kind) {
    case 'pending':
      return 'Athena runtime notice, not something the user said: permission ' +
        `${notice.id} is now waiting for the user's decision — ${notice.summary}. ` +
        'I have already asked for it out loud in my own voice, so do not repeat the request ' +
        'and do not reply to this notice. When the user answers on a later turn, call ' +
        `local_control with action allow or deny and request_id ${notice.id}. Your own words ` +
        'authorize nothing; only that tool result does.'
    case 'resolved':
      return `Athena runtime notice: permission ${notice.id} is now ` +
        `${notice.action === 'allow' ? 'allowed once' : 'denied'} and is no longer waiting. ` +
        'Do not reply to this notice.'
    case 'refused':
      return 'Athena runtime notice: the last permission answer was refused ' +
        `(${notice.reason}); nothing was authorized and nothing changed. ` +
        'Do not reply to this notice.'
    case 'shutdown':
      return `Athena runtime notice: permission ${notice.id} was denied automatically ` +
        'because the voice session is shutting down, and is no longer waiting. ' +
        'Do not reply to this notice.'
  }
}

/** Per-utterance state the tool handler needs and the recovery path reads back. */
interface VoiceTurnContext {
  /** Monotonic utterance number; the utterance half of the voice turn ID. */
  utterance: number
  source: VoiceTurnSource
  /** Realtime turn in flight, so a permission announced on it cannot answer itself. */
  answeringTurn: number
  /** Set when this utterance reached the harness, so a drop can say whether it was lost. */
  submitted: boolean
  /** End of user speech, in recorder time; the start of the first-feedback budget. */
  receivedAt: number
  /** Cleared once the first spoken feedback is measured, so one utterance meters once. */
  feedbackPending: boolean
}

export async function runVoiceSession(options: VoiceSessionOptions): Promise<void> {
  const play = options.play ?? playWindowsPcm
  const speakFallback = options.speakFallback ?? speakWindowsText
  const status = options.onStatus ?? ((message) => console.log(message))
  const meter = options.telemetry ?? NULL_VOICE_TELEMETRY
  const turns = new VoiceTurnLedger()
  let commands = 0
  let stopRequested = false
  // What Athena last actually said out loud, so `repeat` replays speech rather than the
  // objective. The announcement plane is the fallback when nothing has been spoken yet.
  let lastSpoken: string | null = null
  // Monotonic Realtime turn counter. A permission announced on the same turn as the
  // utterance answering it was never heard by the user, so the two must be tellable apart.
  let turnSeq = 0
  // The Realtime session allows one active response at a time, and a harness turn can
  // finish at the same moment the user wakes Athena. Serialize every response turn
  // (user-driven or completion-driven) through this chain.
  let turnChain: Promise<unknown> = Promise.resolve()
  const enqueueTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = turnChain.then(fn, fn)
    turnChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * A replacement Realtime session starts with an EMPTY conversation, so continuity has to
   * be re-seeded deliberately. It goes into the session instructions rather than a replayed
   * transcript for two reasons: `session.update` is the one channel already proven on this
   * wire, and the harness — not Realtime — is the authority on what happened, so the only
   * thing worth carrying across is the objective the user is still in the middle of.
   */
  const sessionInstructions = (generation: number): string => {
    const base = buildVoiceInstructions(options.persona)
    if (generation <= 1) return base
    const objective = options.controller?.getSnapshot()?.objective.value
    const continuity = objective
      ? 'Your voice connection was just reopened, so you remember nothing said before now. ' +
        `The work already under way is: ${plainBounded(objective, 512)}. ` +
        'Do not mention the reconnection unless the user asks about it.'
      : 'Your voice connection was just reopened, so you remember nothing said before now. ' +
        'Do not mention the reconnection unless the user asks about it.'
    // A replacement conversation is EMPTY, so any decision still outstanding would be
    // invisible to the new session — which is exactly the blind spot the mid-session notes
    // exist to close, reopened by a reconnect. Bounded like every other seeded value.
    const waiting = (options.attention?.pendingPermissions() ?? []).slice(0, 4)
    if (waiting.length === 0) return `${base} ${continuity}`
    const described = waiting
      .map((item) => `${item.id} (${plainBounded(item.summary, 256)})`)
      .join('; ')
    return `${base} ${continuity} Decisions already waiting on the user, which I asked for ` +
      `out loud before the reconnection: ${described}. When the user answers one, call ` +
      'local_control with allow or deny and that request_id. You cannot grant one yourself.'
  }

  const client: VoiceRealtimeClient = options.client ?? new ReconnectingRealtimeClient({
    ...options.reconnect,
    open: (generation) => options.clientFactory?.(generation) ?? new RealtimeVoiceClient({
      apiKey: options.apiKey,
      model: options.model,
      instructions: sessionInstructions(generation),
    }),
    onWarn: (message) => status(message),
    onSession: ({ generation, reason }) => {
      // A planned renewal and an unplanned reconnect cost the same but mean different
      // things, so they stay separate counters rather than one "session opened" total.
      if (reason === 'renewal') meter.record({ event: 'realtime.renewal' })
      else meter.record({ event: 'realtime.connect', label: reason })
      if (reason === 'initial') return
      status(`Athena voice opened Realtime session ${generation} (${reason}).`)
    },
  })

  /**
   * Playback is the last step of a turn and the least essential one: the transcript is
   * printed FIRST so a dead audio device still leaves stable text for Braille and review,
   * and a rejection from the audio backend degrades to local speech instead of ending the
   * session (which is what an unguarded `await play(...)` did).
   */
  const present = async (turn: RealtimeTurnResult, context?: VoiceTurnContext): Promise<void> => {
    meter.record({ event: 'provider.usage', meters: turn.usage })
    if (turn.transcript) {
      lastSpoken = turn.transcript
      status(`Athena: ${turn.transcript}`)
    }
    // The budget is end of speech to the first thing the user actually hears, and it is
    // metered here rather than at submit_turn: a status line is not feedback to a blind
    // user. Harness work carries on afterwards and is metered separately.
    if (context?.feedbackPending) {
      context.feedbackPending = false
      meter.record({
        event: 'turn.feedback',
        source: context.source,
        ms: meter.now() - context.receivedAt,
      })
    }
    const startedAt = meter.now()
    const path = turn.audio.length > 0 ? 'realtime-audio' : 'local-speech'
    try {
      if (turn.audio.length > 0) await play(turn.audio)
      else if (turn.transcript) await speakFallback(turn.transcript)
      else return
      meter.record({ event: 'playback.spoken', label: path, ms: meter.now() - startedAt })
      return
    } catch (error) {
      meter.record({ event: 'playback.failed', label: path })
      status(
        'Athena voice could not play audio through the Windows audio backend: ' +
        `${plainBounded((error as Error).message, 240)}. ` +
        'The reply text above is the full response. Run `athena voice probe` to test playback.',
      )
    }
    if (turn.audio.length === 0 || !turn.transcript) return
    const recoveryAt = meter.now()
    try {
      await speakFallback(turn.transcript)
      meter.record({
        event: 'playback.spoken',
        label: 'local-speech',
        ms: meter.now() - recoveryAt,
      })
    } catch {
      // Local speech was the recovery path; with both gone the stable text above is all
      // there is, and saying so twice would add nothing.
      meter.record({ event: 'playback.failed', label: 'local-speech' })
    }
  }

  /** Stable text plus local speech, with no model in the path and no way to throw. */
  const announceLocally = async (text: string): Promise<void> => {
    status(`Athena: ${text}`)
    lastSpoken = text
    try {
      await speakFallback(text)
    } catch (error) {
      status(`Athena: could not speak that aloud: ${plainBounded((error as Error).message, 200)}`)
    }
  }

  /**
   * Semantic-plane text goes out as stable text always and as local speech when the
   * ownership policy says Athena owns saying it. It rides the same turn chain as Marin so
   * a permission landing mid-turn cannot talk over her, and it never calls the model:
   * asking Realtime to voice a blocker would both delay it and license a paraphrase.
   */
  options.attention?.attach({
    currentTurn: () => turnSeq,
    present: ({ text, spoken }) => {
      status(`Athena: ${text}`)
      if (!spoken) return
      void enqueueTurn(async () => {
        lastSpoken = text
        await speakFallback(text)
      }).catch((error: unknown) => {
        status(`Athena: could not speak an announcement: ${(error as Error).message}`)
      })
    },
    /**
     * Context for the model, and nothing else. The item carries no `response.create`, so
     * Marin says nothing about it and the canonical blocker spoken above stays the only
     * thing the user hears. It deliberately does NOT ride `enqueueTurn` and does not touch
     * `turnSeq`: a note is not a turn, and inflating the counter would make a legitimate
     * later answer read as same-turn — or, worse, the reverse.
     */
    notify: (notice) => {
      const identity = 'id' in notice ? { permissionId: notice.id } : {}
      // Counted as DISPATCHED, not acknowledged: a WebSocket send has no receipt, and no
      // permission may wait on one. Between sessions there is no live conversation to seed,
      // and a replacement is re-seeded through its instructions instead.
      const delivery = client.note?.(permissionNoticeText(notice))
      if (!delivery) {
        meter.record({ event: 'realtime.context', label: 'not-delivered', ...identity })
        return
      }
      void delivery.then(
        () => meter.record({
          event: 'realtime.context',
          label: PERMISSION_NOTICE_LABELS[notice.kind],
          ...identity,
        }),
        (error: unknown) => {
          meter.record({ event: 'realtime.context', label: 'not-delivered', ...identity })
          status(
            'Athena: the voice session did not take that permission context ' +
            `(${plainBounded((error as Error).message, 200)}). ` +
            'The spoken request above still stands, and you can still answer it by voice or ' +
            'by typing allow or deny.',
          )
        },
      )
    },
  })

  const lastSpokenText = (): string =>
    lastSpoken
    ?? options.controller?.lastAnnouncement()?.text
    ?? 'I have not said anything yet in this session.'

  /** Deterministic runtime state, never a model-authored guess. */
  const semanticStatus = (): Record<string, unknown> => {
    const snapshot = options.controller?.getSnapshot()
    const awaiting = options.attention?.pendingPermissions() ?? []
    return {
      // A canonical permission record outranks the reduced phase: while a decision is
      // outstanding the harness is blocked on the user, whatever else has been reduced.
      status: awaiting.length > 0
        ? 'waiting-permission'
        : snapshot?.phase.value ?? 'idle',
      summary: snapshot?.objective.value ?? 'Athena voice is ready.',
      activity: snapshot?.activity.value?.label ?? null,
      attention: (snapshot?.attention ?? [])
        .slice(0, 8)
        .map((item) => plainBounded(item.summary, 256)),
      awaiting_permission: awaiting,
    }
  }

  /** Spoken completion for a harness turn that outlived its submit_turn response. */
  const deliverHarnessResult = (result: { status: string; summary: string }): void => {
    const summary = plainBounded(result.summary, 8_192)
    const prompt =
      `The work you started has finished with status ${result.status}. ` +
      'Report it to the user now: concise, faithful, first person, as your own completed work. ' +
      `Result: ${summary}`
    const nested = async (): Promise<unknown> =>
      ({ error: 'Nested delegation is not allowed while summarizing a result.' })
    void enqueueTurn(async () => {
      turnSeq += 1
      let turn: RealtimeTurnResult
      try {
        turn = await client.ask(prompt, nested)
      } catch (error) {
        // The result IS the turn: a transport drop here would swallow the only account of
        // work that actually ran. The client reopens on the next call, so one retry is it.
        if (!isRealtimeTransportFailure(error)) throw error
        turnSeq += 1
        turn = await client.ask(prompt, nested)
      }
      await present(turn)
      options.onStandby?.()
    }).catch((error: unknown) => {
      status(`Athena: could not speak the harness result: ${(error as Error).message}`)
      // Stable text is the floor: an unspeakable result must still be readable.
      status(`Athena result (${result.status}): ${summary}`)
    })
  }

  const handleTool = async (
    call: RealtimeToolCall,
    context: VoiceTurnContext,
  ): Promise<unknown> => {
    const { answeringTurn } = context
    if (call.name === 'submit_turn') {
      // Model output is untrusted input, and the tool is advertised with exactly one
      // string field: anything else is a malformed call and runs nothing.
      const parsed = VoiceTurnSubmissionSchema.safeParse(call.arguments)
      const text = parsed.success ? plainBounded(parsed.data.text, 4_096) : ''
      if (!text) {
        meter.record({ event: 'turn.refused', label: 'malformed', source: context.source })
        return {
          error: 'That submit_turn call is not well formed, so nothing was run.',
          instruction: 'Call submit_turn again with a single text field holding the user request.',
        }
      }
      const controller = options.controller
      if (!controller) {
        meter.record({ event: 'turn.refused', label: 'no-controller', source: context.source })
        // The harness IS the executor: with no controller there is nowhere to run work,
        // and inventing an answer would be worse than saying so.
        return {
          error: 'This voice session has no Athena harness attached, so nothing was run.',
          instruction: 'Tell the user you cannot run that right now, and do not try again.',
        }
      }
      const admission = turns.admit({
        utterance: context.utterance,
        source: context.source,
        text,
      })
      if (!admission.ok) {
        context.submitted = true
        meter.record({
          event: 'turn.refused',
          label: admission.reason,
          source: context.source,
          voiceTurnId: admission.record.id,
        })
        status(`Athena: submit_turn refused (${admission.reason}) for ${admission.record.id}.`)
        return admission.reason === 'duplicate'
          ? {
            error: 'I already have that exact request; it was not started a second time.',
            voice_turn_id: admission.record.id,
            state: admission.record.state,
            instruction: 'Tell the user you already have that request. Do not submit it again.',
          }
          : {
            error: 'Athena is still working on the previous request.',
            voice_turn_id: admission.record.id,
            instruction: 'Tell the user you are still working on the previous request.',
          }
      }
      // Non-blocking by design: the harness turn can run for minutes, and the Realtime
      // response holding this tool call times out long before that. Return at start; the
      // finished result is spoken via deliverHarnessResult.
      context.submitted = true
      const record = admission.record
      status(`Athena harness: ${text} (${record.id})`)
      meter.record({ event: 'turn.submitted', voiceTurnId: record.id, source: context.source })
      const submittedAt = meter.now()
      void controller.submitTurn(text)
        .then((turnResult) => {
          turns.settle(
            record.id,
            turnResult.status === 'completed' ? 'completed' : 'failed',
            turnResult.sessionId,
          )
          // The voice turn ID is the key that ties this meter to the Athena session and run
          // the trace already holds the real evidence for.
          meter.record({
            event: turnResult.status === 'completed' ? 'turn.completed' : 'turn.failed',
            voiceTurnId: record.id,
            harnessSessionId: turnResult.sessionId,
            ...(turnResult.snapshot ? { runId: turnResult.snapshot.runId } : {}),
            ms: meter.now() - submittedAt,
          })
          deliverHarnessResult(turnResult)
        })
        .catch((error: unknown) => {
          turns.settle(record.id, 'failed')
          meter.record({
            event: 'turn.failed',
            voiceTurnId: record.id,
            ms: meter.now() - submittedAt,
          })
          deliverHarnessResult({
            status: 'failed',
            summary: `Harness turn failed: ${(error as Error).message}`,
          })
        })
      return {
        status: 'started',
        voice_turn_id: record.id,
        instruction: 'The work has started. Tell the user, briefly and in first person, that you are on it.',
      }
    }
    if (call.name === 'local_control') {
      const args = call.arguments as { action?: unknown; request_id?: unknown } | null
      const action = typeof args?.action === 'string' ? args.action : ''
      if (action === 'status') return semanticStatus()
      if (action === 'stop_listening') {
        stopRequested = true
        return { status: 'stopping', summary: 'Athena voice is stopping.' }
      }
      if (action === 'repeat') {
        return {
          summary: lastSpokenText(),
          instruction: 'Say this back to the user unchanged; it is what you last said.',
        }
      }
      if (action === 'allow' || action === 'deny') {
        const attention = options.attention
        if (!attention) {
          return { error: 'No permission approver is wired into this voice session.' }
        }
        // Model output is untrusted input: the identity is bounded and validated here
        // before anything can be matched against a real pending harness request.
        const parsed = VoicePermissionAnswerSchema.safeParse({
          action,
          ...(typeof args?.request_id === 'string' && args.request_id.trim()
            ? { permissionId: args.request_id.trim() }
            : {}),
        })
        if (!parsed.success) {
          return {
            error: 'That permission identity is not well formed, so nothing was changed.',
            pending_ids: attention.pendingIds(),
            instruction: 'Ask the user which pending permission they mean. Nothing was authorized.',
          }
        }
        const outcome = attention.resolve(parsed.data.action, parsed.data.permissionId, answeringTurn)
        if (!outcome.ok) {
          status(`Athena: permission answer refused (${outcome.reason}).`)
          return {
            error: outcome.clarification,
            reason: outcome.reason,
            pending_ids: outcome.pendingIds,
            instruction: 'Tell the user exactly this and ask for clarification. Nothing was authorized.',
          }
        }
        // The running turn owns the decision that gated it; recording it keeps the turn
        // record and the spoken account of the turn describing the same thing.
        turns.recordPermission(outcome.id)
        status(`Athena: permission ${outcome.id} ${outcome.action === 'allow' ? 'allowed once' : 'denied'}.`)
        return {
          status: outcome.action === 'allow' ? 'allowed-once' : 'denied',
          permission_id: outcome.id,
          instruction: outcome.action === 'allow'
            ? 'Tell the user you allowed that one action and are carrying on.'
            : 'Tell the user you denied it and are carrying on.',
        }
      }
      return { error: `Unhandled local control action: ${action}` }
    }
    return { error: `Unsupported voice function: ${call.name}` }
  }

  /**
   * A Realtime drop is not the end of the session. The harness session, its trace, and any
   * turn already running are untouched by it, so recovery is: reopen the audio adapter,
   * then say plainly whether the utterance survived. Swallowing a lost request silently is
   * what makes a voice interface untrustworthy, and claiming one was received when it was
   * not is worse. Returns false when voice can no longer be served at all.
   */
  const recoverTransport = async (error: unknown, context: VoiceTurnContext): Promise<boolean> => {
    if (!isRealtimeTransportFailure(error)) {
      // The session is still usable; only this request failed.
      await enqueueTurn(() => announceLocally(
        `I could not complete that: ${plainBounded((error as Error).message, 240)}.`,
      ))
      return true
    }
    try {
      await client.connect()
    } catch (reconnectError) {
      meter.record({ event: 'realtime.lost', label: 'unrecoverable' })
      await enqueueTurn(() => announceLocally(plainBounded((reconnectError as Error).message, 512)))
      return false
    }
    meter.record({ event: 'realtime.lost', label: 'recovered' })
    await enqueueTurn(() => announceLocally(context.submitted
      ? 'I lost the voice connection and reopened it. The work you asked for is still running, ' +
        'so you do not need to repeat that.'
      : 'I lost the voice connection and reopened it. I did not get that request, ' +
        'so please say it again.'))
    return true
  }

  try {
    await client.connect()
    status(`Athena voice connected with ${options.model}. Say “Athena” followed by a command.`)
    // The ready cue is the end of the launch budget, measured from process start rather
    // than from here — everything before this line (boot, key resolution, controller
    // creation) is time the user spent waiting too.
    meter.record({ event: 'session.ready', ms: meter.sinceLaunch() })
    while (options.maxCommands === undefined || commands < options.maxCommands) {
      const command = await options.input.next()
      if (command === null) continue
      const receivedAt = meter.now()
      commands++
      const text = command.kind === 'text' ? command.text : null
      const normalized = text?.trim().toLowerCase() ?? ''
      if (text && (normalized === 'quit' || normalized === 'exit')) break
      // Keyboard parity (FR-006): a typed answer resolves the same canonical request
      // through the same matcher, with no model between the user and the decision.
      const typedAnswer = text && options.attention
        ? parseVoicePermissionCommand(normalized, options.attention.pendingIds())
        : null
      if (typedAnswer && options.attention) {
        turnSeq += 1
        const outcome = options.attention.resolve(
          typedAnswer.action,
          typedAnswer.permissionId,
          turnSeq,
        )
        const spoken = outcome.ok
          ? `Permission ${outcome.action === 'allow' ? 'allowed once' : 'denied'}.`
          : outcome.clarification
        lastSpoken = spoken
        await speakFallback(spoken)
        status(`Athena: ${spoken}`)
        // A typed decision is still an utterance that got an answer, so it counts against
        // the same feedback budget as a spoken one.
        meter.record({ event: 'turn.feedback', source: 'keyboard', ms: meter.now() - receivedAt })
        continue
      }
      const context: VoiceTurnContext = {
        utterance: commands,
        source: command.kind === 'audio' ? 'audio' : 'keyboard',
        answeringTurn: 0,
        submitted: false,
        receivedAt,
        feedbackPending: true,
      }
      let turn: RealtimeTurnResult
      try {
        turn = await enqueueTurn(() => {
          context.answeringTurn = ++turnSeq
          const handler = (call: RealtimeToolCall) => handleTool(call, context)
          return command.kind === 'audio'
            ? client.askAudio(command.pcm, handler)
            : client.ask(command.text, handler)
        })
      } catch (error) {
        if (!(await recoverTransport(error, context))) break
        continue
      }
      await present(turn, context)
      options.onStandby?.()
      if (stopRequested) break
    }
  } finally {
    // Deny anything still outstanding first: a harness turn parked on a decision nobody
    // is left to give would keep the chain below from ever draining.
    options.attention?.close()
    // Let an already-spoken-queue harness completion reach the speaker before closing.
    await turnChain.catch(() => {})
    options.input.close()
    client.close()
  }
}

export async function runVoiceProbe(apiKey: string, model: RealtimeVoiceModel): Promise<string[]> {
  const report: string[] = []
  const local = await probeWindowsSpeech()
  report.push(`Local speech backend: ${local.available ? 'available' : 'unavailable'} (${local.detail})`)
  if (!local.available) {
    report.push('Recovery: install a Windows speech language and voice, then run `athena voice probe`.')
    return report
  }
  await speakWindowsText('Athena voice probe. Please say Athena voice probe now.')
  const wake = await waitForWakeProbe()
  const backend = wake.detail ? `; ${plainBounded(wake.detail, 240)}` : ''
  if (!wake.passed) {
    const heard = wake.heard.length > 0
      ? ` (heard: ${plainBounded(wake.heard.join(' | '), 128)})`
      : ''
    report.push(`Microphone wake probe: failed${backend}${heard}`)
    report.push('Recovery: check the default microphone and Windows speech language, then rerun `athena voice probe`.')
    return report
  }
  if (wake.command?.toLowerCase() === 'voice probe') {
    report.push(`Microphone wake probe: passed (Athena voice probe${backend}).`)
  } else {
    report.push(
      `Microphone wake probe: passed (wake word Athena; heard command: ` +
      `${plainBounded(wake.command ?? 'unknown', 128)}${backend}).`,
    )
    report.push('Wake diagnostic note: Windows only gates on Athena; OpenAI receives the raw audio.')
  }
  const client = new RealtimeVoiceClient({ apiKey, model })
  try {
    await client.connect()
    report.push(`OpenAI Realtime connection: passed (${model}).`)
    if (!wake.audio) throw new Error('Wake detector returned no microphone audio.')
    const turn = await client.askAudio(wake.audio, async () => ({
      error: 'Tools are disabled during the voice probe.',
    }))
    if (turn.audio.length > 0) await playWindowsPcm(turn.audio)
    else if (turn.transcript) await speakWindowsText(turn.transcript)
    if (!turn.audio.length && !turn.transcript) {
      throw new Error('OpenAI Realtime returned no spoken probe response.')
    }
    report.push('OpenAI speech understanding and playback: passed (raw microphone audio).')
  } finally {
    client.close()
  }
  return report
}
