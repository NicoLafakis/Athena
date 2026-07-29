import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { plainBounded } from '../interaction/format.js'
import {
  RealtimeVoiceClient,
  type RealtimeToolCall,
  type RealtimeTurnResult,
  type RealtimeVoiceModel,
} from './realtime.js'
import {
  playWindowsPcm,
  probeWindowsSpeech,
  recognizeWindowsPhrase,
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

export class WindowsWakeCommandInput implements VoiceCommandInput {
  constructor(
    private readonly minimumConfidence = WINDOWS_WAKE_MINIMUM_CONFIDENCE,
    private readonly recognize: typeof recognizeWindowsPhrase = recognizeWindowsPhrase,
  ) {}
  async next(): Promise<VoiceCommand | null> {
    for (;;) {
      const phrase = await this.recognize()
      if (!phrase) return null
      if (phrase.confidence < this.minimumConfidence) continue
      if (stripWakePhrase(phrase.text) || /^athena[,.!?;:]?$/i.test(phrase.text.trim())) {
        return { kind: 'audio', pcm: phrase.audio, wakeTranscript: phrase.text }
      }
    }
  }
  close(): void {}
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
  delegate?: DelegateRunner
  client?: VoiceRealtimeClient
  play?: (audio: Buffer) => Promise<void>
  speakFallback?: (text: string) => Promise<void>
  onStatus?: (message: string) => void
  onUsage?: (usage: unknown) => void
  maxCommands?: number
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
  })
  const play = options.play ?? playWindowsPcm
  const speakFallback = options.speakFallback ?? speakWindowsText
  const status = options.onStatus ?? ((message) => console.log(message))
  let pendingDelegate: string | null = null
  let lastDelegate: DelegateResult | null = null
  let commands = 0
  let stopRequested = false
  const delegate = options.delegate
    ?? ((prompt: string) => runAthenaDelegate(prompt, process.cwd(), process.argv[1], lastDelegate?.sessionId))

  const present = async (turn: RealtimeTurnResult): Promise<void> => {
    options.onUsage?.(turn.usage)
    if (turn.audio.length > 0) await play(turn.audio)
    else if (turn.transcript) await speakFallback(turn.transcript)
    if (turn.transcript) status(`Athena: ${turn.transcript}`)
  }

  const handleTool = async (
    call: RealtimeToolCall,
    pendingAtTurnStart: boolean,
  ): Promise<unknown> => {
    if (call.name === 'status') {
      return lastDelegate ?? { status: 'idle', summary: 'No voice delegation has run yet.' }
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
        const summary = plainBounded(lastDelegate.summary, 8_192)
        await present(await client.ask(
          `A separately confirmed Athena coding delegation finished with status ` +
          `${lastDelegate.status}. Give a concise spoken summary of this redacted result: ${summary}`,
          async () => ({ error: 'Nested delegation is not allowed while summarizing a result.' }),
        ))
        continue
      }
      if (text && pendingDelegate) {
        await speakFallback('A delegation is waiting. Say Athena confirm or Athena cancel.')
        status('Athena: A delegation is waiting for confirm or cancel.')
        continue
      }
      const handler = (call: RealtimeToolCall) => handleTool(call, pendingAtTurnStart)
      const turn = command.kind === 'audio'
        ? await client.askAudio(command.pcm, handler)
        : await client.ask(command.text, handler)
      await present(turn)
      if (stopRequested) break
    }
  } finally {
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
