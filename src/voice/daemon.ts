import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { plainBounded } from '../interaction/format.js'
import type { HarnessSessionController } from '../harness/controller.js'
import {
  RealtimeVoiceClient,
  buildVoiceInstructions,
  type RealtimeToolCall,
  type RealtimeTurnResult,
  type RealtimeVoiceModel,
} from './realtime.js'
import {
  playWindowsPcm,
  probeWindowsSpeech,
  recognizeWindowsPhrase,
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

/** Shared local wake gate: confidence threshold plus the constrained `Athena` prefix.
 *  The full post-wake audio is what Realtime receives; the transcript only gates. */
function acceptWakePhrase(phrase: RecognizedPhrase, minimumConfidence: number): VoiceCommand | null {
  if (phrase.confidence < minimumConfidence) return null
  if (stripWakePhrase(phrase.text) || /^athena[,.!?;:]?$/i.test(phrase.text.trim())) {
    return { kind: 'audio', pcm: phrase.audio, wakeTranscript: phrase.text }
  }
  return null
}

export class WindowsWakeCommandInput implements VoiceCommandInput {
  constructor(
    private readonly minimumConfidence = WINDOWS_WAKE_MINIMUM_CONFIDENCE,
    private readonly recognize: typeof recognizeWindowsPhrase = recognizeWindowsPhrase,
  ) {}
  async next(): Promise<VoiceCommand | null> {
    for (;;) {
      const phrase = await this.recognize()
      if (!phrase) return null
      const command = acceptWakePhrase(phrase, this.minimumConfidence)
      if (command) return command
    }
  }
  close(): void {}
}

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
  onWarn?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
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
  private readonly onWarn: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>

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
    this.onWarn = options.onWarn ?? (() => {})
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
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
      void this.restart((error as Error).message)
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
    let parsed: { ready?: unknown; text?: unknown; confidence?: unknown; wave?: unknown }
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
    if (phrase.confidence < this.minimumConfidence) return
    const text = phrase.text.trim()
    if (stripWakePhrase(text)) {
      this.listeningUntil = 0
      this.deliver({ kind: 'audio', pcm: phrase.audio, wakeTranscript: text })
      return
    }
    if (/^athena[,.!?;:]?$/i.test(text)) {
      this.listeningUntil = this.now() + this.listeningWindowMs
      this.onListening()
      return
    }
    if (this.now() < this.listeningUntil) {
      this.listeningUntil = 0
      this.deliver({ kind: 'audio', pcm: phrase.audio, wakeTranscript: text })
    }
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
    this.attempt = null
    if (this.closed || this.failed) return
    void this.restart(reason)
  }

  private async restart(reason: string): Promise<void> {
    if (this.restarting || this.closed || this.failed) return
    this.restarting = true
    try {
      let detail = reason
      while (!this.closed && !this.failed) {
        if (this.restarts >= this.maxRestarts) {
          this.failed = new Error(PERSISTENT_WAKE_FAILURE)
          this.rejectWaiters(this.failed)
          return
        }
        this.restarts += 1
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

export class KeyboardVoiceCommandInput implements VoiceCommandInput {
  private readonly reader = createInterface({ input: process.stdin, output: process.stdout })
  async next(): Promise<VoiceCommand | null> {
    const answer = (await this.reader.question('Athena voice command: ')).trim()
    return answer ? { kind: 'text', text: answer } : null
  }
  close(): void {
    this.reader.close()
  }
}

export interface WakeProbeResult {
  passed: boolean
  heard: string[]
  command: string | null
  audio: Buffer | null
}

export async function waitForWakeProbe(
  recognize: () => Promise<RecognizedPhrase | null> = () => recognizeWindowsPhrase(undefined, 10),
  onRetry: () => Promise<void> = () => speakWindowsText(
    'I did not hear Athena. Please say Athena voice probe now.',
  ),
  maxAttempts = 3,
): Promise<WakeProbeResult> {
  const heard: string[] = []
  const attempts = Math.max(1, Math.round(maxAttempts))
  for (let attempt = 0; attempt < attempts; attempt++) {
    const phrase = await recognize()
    if (phrase) heard.push(phrase.text)
    const command = phrase && phrase.confidence >= WINDOWS_WAKE_MINIMUM_CONFIDENCE
      ? stripWakePhrase(phrase.text)
      : null
    if (command) return { passed: true, heard, command, audio: phrase!.audio }
    if (attempt + 1 < attempts) await onRetry()
  }
  return { passed: false, heard, command: null, audio: null }
}

export interface DelegateResult {
  status: 'completed' | 'failed'
  summary: string
  sessionId?: string
}

export type DelegateRunner = (prompt: string) => Promise<DelegateResult>

export function athenaDelegateArgs(prompt: string, resumeId?: string): string[] {
  return [
    'exec',
    `Voice delegation: ${plainBounded(prompt, 4_096)}`,
    '--output',
    'json',
    ...(resumeId ? ['--resume', resumeId] : ['--session']),
    '--permission-mode',
    'acceptEdits',
  ]
}

export function runAthenaDelegate(
  prompt: string,
  cwd = process.cwd(),
  entrypoint = process.argv[1],
  resumeId?: string,
): Promise<DelegateResult> {
  return new Promise((resolve) => {
    if (!entrypoint) {
      resolve({ status: 'failed', summary: 'Athena CLI entrypoint is unavailable.' })
      return
    }
    const bounded = plainBounded(prompt, 4_096)
    execFile(
      process.execPath,
      [entrypoint, ...athenaDelegateArgs(bounded, resumeId)],
      {
        cwd,
        windowsHide: true,
        timeout: 30 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ATHENA_VOICE_CHILD: '1' },
      },
      (error, stdout, stderr) => {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
        let envelope: Record<string, unknown> | null = null
        try {
          const parsed = JSON.parse(lines.at(-1) ?? '') as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            envelope = parsed as Record<string, unknown>
          }
        } catch {
          // The bounded stderr fallback below is the actionable result.
        }
        const output = typeof envelope?.output === 'string'
          ? plainBounded(envelope.output, 8_192)
          : ''
        if (!error && envelope) {
          resolve({
            status: envelope.status === 'completed' ? 'completed' : 'failed',
            summary: output || `Athena finished with status ${String(envelope.status ?? 'unknown')}.`,
            ...(typeof envelope.sessionId === 'string' ? { sessionId: envelope.sessionId } : {}),
          })
          return
        }
        resolve({
          status: 'failed',
          summary: plainBounded(stderr || error?.message || 'Athena delegation failed.', 2_048),
        })
      },
    )
  })
}

export interface VoiceSessionOptions {
  apiKey: string
  model: RealtimeVoiceModel
  input: VoiceCommandInput
  controller?: HarnessSessionController
  delegate?: DelegateRunner
  client?: VoiceRealtimeClient
  play?: (audio: Buffer) => Promise<void>
  speakFallback?: (text: string) => Promise<void>
  onStatus?: (message: string) => void
  onUsage?: (usage: unknown) => void
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
}

export async function runVoiceSession(options: VoiceSessionOptions): Promise<void> {
  const client = options.client ?? new RealtimeVoiceClient({
    apiKey: options.apiKey,
    model: options.model,
    instructions: buildVoiceInstructions(options.persona),
  })
  const play = options.play ?? playWindowsPcm
  const speakFallback = options.speakFallback ?? speakWindowsText
  const status = options.onStatus ?? ((message) => console.log(message))
  let pendingDelegate: string | null = null
  let lastDelegate: DelegateResult | null = null
  let commands = 0
  let stopRequested = false
  let harnessBusy = false
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
  const delegate = options.delegate
    ?? ((prompt: string) => runAthenaDelegate(prompt, process.cwd(), process.argv[1], lastDelegate?.sessionId))

  const present = async (turn: RealtimeTurnResult): Promise<void> => {
    options.onUsage?.(turn.usage)
    if (turn.audio.length > 0) await play(turn.audio)
    else if (turn.transcript) await speakFallback(turn.transcript)
    if (turn.transcript) status(`Athena: ${turn.transcript}`)
  }

  /** Spoken completion for a harness turn that outlived its submit_turn response. */
  const deliverHarnessResult = (result: { status: string; summary: string }): void => {
    const summary = plainBounded(result.summary, 8_192)
    void enqueueTurn(async () => {
      const turn = await client.ask(
        `The work you started has finished with status ${result.status}. ` +
        'Report it to the user now: concise, faithful, first person, as your own completed work. ' +
        `Result: ${summary}`,
        async () => ({ error: 'Nested delegation is not allowed while summarizing a result.' }),
      )
      await present(turn)
      options.onStandby?.()
    }).catch((error: unknown) => {
      status(`Athena: could not speak the harness result: ${(error as Error).message}`)
    })
  }

  const handleTool = async (
    call: RealtimeToolCall,
    pendingAtTurnStart: boolean,
  ): Promise<unknown> => {
    if (call.name === 'submit_turn') {
      const args = call.arguments as { text?: unknown } | null
      const text = typeof args?.text === 'string' ? plainBounded(args.text, 4_096) : ''
      if (!text) return { error: 'Submit turn text is missing.' }
      if (options.controller) {
        // Non-blocking by design: the harness turn can run for minutes, and the
        // Realtime response holding this tool call times out long before that. Return
        // at start; the finished result is spoken via deliverHarnessResult.
        if (harnessBusy) {
          return {
            error: 'Athena is still working on the previous request.',
            instruction: 'Tell the user you are still working on the previous request.',
          }
        }
        harnessBusy = true
        status(`Athena harness: ${text}`)
        const controller = options.controller
        void controller.submitTurn(text)
          .then((turnResult) => deliverHarnessResult(turnResult))
          .catch((error: unknown) => deliverHarnessResult({
            status: 'failed',
            summary: `Harness turn failed: ${(error as Error).message}`,
          }))
          .finally(() => {
            harnessBusy = false
          })
        return {
          status: 'started',
          instruction: 'The work has started. Tell the user, briefly and in first person, that you are on it.',
        }
      }
      lastDelegate = await delegate(text)
      return {
        status: lastDelegate.status,
        summary: plainBounded(lastDelegate.summary, 8_192),
      }
    }
    if (call.name === 'local_control') {
      const args = call.arguments as { action?: unknown; request_id?: unknown } | null
      const action = typeof args?.action === 'string' ? args.action : ''
      if (action === 'status') {
        const snap = options.controller?.getSnapshot()
        return {
          status: snap?.phase.value ?? lastDelegate?.status ?? 'idle',
          summary: snap?.objective.value ?? lastDelegate?.summary ?? 'Athena voice is ready.',
        }
      }
      if (action === 'stop_listening') {
        stopRequested = true
        return { status: 'stopping', summary: 'Athena voice is stopping.' }
      }
      if (action === 'repeat') {
        const snap = options.controller?.getSnapshot()
        return {
          summary: snap?.objective.value ?? lastDelegate?.summary ?? 'Athena is ready.',
        }
      }
      return { error: `Unhandled local control action: ${action}` }
    }
    if (call.name === 'status') {
      const snap = options.controller?.getSnapshot()
      return {
        status: snap?.phase.value ?? lastDelegate?.status ?? 'idle',
        summary: snap?.objective.value ?? lastDelegate?.summary ?? 'No voice delegation has run yet.',
      }
    }
    if (call.name === 'stop_listening') {
      stopRequested = true
      return { status: 'stopping', summary: 'Athena voice is stopping.' }
    }
    if (call.name === 'cancel') {
      if (!pendingAtTurnStart || !pendingDelegate) {
        return { error: 'There is no proposal from an earlier turn to cancel.' }
      }
      pendingDelegate = null
      return { status: 'canceled', summary: 'The pending delegation was canceled.' }
    }
    if (call.name === 'confirm') {
      if (!pendingAtTurnStart || !pendingDelegate) {
        return { error: 'There is no proposal from an earlier turn to confirm.' }
      }
      const prompt = pendingDelegate
      pendingDelegate = null
      status('Athena: Confirmed. Delegating to the coding engine.')
      if (options.controller) {
        const turnResult = await options.controller.submitTurn(prompt)
        return {
          status: turnResult.status,
          summary: turnResult.summary,
          sessionId: turnResult.sessionId,
        }
      }
      lastDelegate = await delegate(prompt)
      return {
        status: lastDelegate.status,
        summary: plainBounded(lastDelegate.summary, 8_192),
      }
    }
    if (call.name !== 'delegate') return { error: `Unsupported voice function: ${call.name}` }
    if (pendingAtTurnStart) {
      return { error: 'A proposal is already waiting; the user must confirm or cancel it.' }
    }
    const args = call.arguments as { prompt?: unknown } | null
    const prompt = typeof args?.prompt === 'string' ? plainBounded(args.prompt, 4_096) : ''
    if (!prompt) return { error: 'Delegate prompt is missing.' }
    if (options.controller) {
      status(`Athena harness: ${prompt}`)
      const turnResult = await options.controller.submitTurn(prompt)
      return {
        status: turnResult.status,
        summary: turnResult.summary,
        sessionId: turnResult.sessionId,
      }
    }
    pendingDelegate = prompt
    return {
      status: 'confirmation_required',
      instruction: 'Say Athena confirm to run it, or Athena cancel to discard it.',
    }
  }

  try {
    await client.connect()
    status(`Athena voice connected with ${options.model}. Say “Athena” followed by a command.`)
    while (options.maxCommands === undefined || commands < options.maxCommands) {
      const command = await options.input.next()
      if (command === null) continue
      commands++
      const pendingAtTurnStart = pendingDelegate !== null
      const text = command.kind === 'text' ? command.text : null
      const normalized = text?.trim().toLowerCase() ?? ''
      if (text && (normalized === 'quit' || normalized === 'exit')) break
      if (text && pendingDelegate && normalized === 'cancel') {
        pendingDelegate = null
        await speakFallback('Pending delegation canceled.')
        status('Athena: Pending delegation canceled.')
        continue
      }
      if (text && pendingDelegate && normalized === 'confirm') {
        const prompt = pendingDelegate
        pendingDelegate = null
        status('Athena: Confirmed. Delegating to the coding engine.')
        lastDelegate = await delegate(prompt)
        const confirmed: DelegateResult = lastDelegate
        const summary = plainBounded(confirmed.summary, 8_192)
        await present(await enqueueTurn(() => client.ask(
          `A separately confirmed Athena coding delegation finished with status ` +
          `${confirmed.status}. Give a concise spoken summary of this redacted result: ${summary}`,
          async () => ({ error: 'Nested delegation is not allowed while summarizing a result.' }),
        )))
        continue
      }
      if (text && pendingDelegate) {
        await speakFallback('A delegation is waiting. Say Athena confirm or Athena cancel.')
        status('Athena: A delegation is waiting for confirm or cancel.')
        continue
      }
      const handler = (call: RealtimeToolCall) => handleTool(call, pendingAtTurnStart)
      const turn = await enqueueTurn(() => command.kind === 'audio'
        ? client.askAudio(command.pcm, handler)
        : client.ask(command.text, handler))
      await present(turn)
      options.onStandby?.()
      if (stopRequested) break
    }
  } finally {
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
  if (!wake.passed) {
    const heard = wake.heard.length > 0
      ? ` (heard: ${plainBounded(wake.heard.join(' | '), 128)})`
      : ''
    report.push(`Microphone wake probe: failed${heard}`)
    report.push('Recovery: check the default microphone and Windows speech language, then rerun `athena voice probe`.')
    return report
  }
  if (wake.command?.toLowerCase() === 'voice probe') {
    report.push('Microphone wake probe: passed (Athena voice probe).')
  } else {
    report.push(
      `Microphone wake probe: passed (wake word Athena; heard command: ` +
      `${plainBounded(wake.command ?? 'unknown', 128)}).`,
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
