import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { BrainPaths } from '../../src/brain/paths.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import type { Settings } from '../../src/brain/settings.js'
import type { ModelClient, StreamCallbacks, StreamResult } from '../../src/engine/client.js'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { HarnessSessionController } from '../../src/harness/controller.js'
import { VoiceAttentionBridge } from '../../src/voice/attention.js'
import {
  WindowsPersistentWakeInput,
  runVoiceSession,
  type VoiceCommand,
  type VoiceCommandInput,
} from '../../src/voice/daemon.js'
import { RealtimeVoiceClient, RealtimeTransportError } from '../../src/voice/realtime.js'
import {
  VoiceTelemetry,
  VoiceTelemetryRecordSchema,
  type VoiceTelemetryRecord,
} from '../../src/voice/telemetry.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'
import {
  FakeRealtimeSocket,
  type ScriptedRealtimeResponse,
} from '../helpers/fake-realtime-socket.js'
import { FakeWakeProcess, fakeSpawner, phraseLine } from '../helpers/fake-wake-process.js'

/**
 * Values that are deliberately easy to spot and must never reach the usage ledger: a
 * credential, an absolute path, and a phrase distinctive enough that a substring search
 * for it is meaningful.
 */
const SECRET = 'sk-ant-api03-DEADBEEFdeadbeefDEADBEEFdeadbeef'
const PHRASE = 'xylophone marmalade seventeen'

let root: string
let paths: BrainPaths

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-voice-integration-'))
  paths = resolveBrainPaths({ cwd: root, homeOverride: root })
  mkdirSync(paths.brainDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const defaultSettings: Settings = {
  permissionMode: 'normal',
  sandboxMode: 'workspace-write',
  model: 'sonnet',
  effort: 'high',
  allow: [],
  deny: [],
  accessibility: {
    presentation: 'standard',
    verbosity: 'balanced',
    progressAnnouncements: 'milestones',
    progressIntervalMs: 15_000,
    directSpeech: 'off',
  },
  hooks: [],
  mcpServers: {},
  vmp: { enabled: false },
}

function makeController(
  client: ModelClient,
  askUser?: VoiceAttentionBridge['askUser'],
): Promise<HarnessSessionController> {
  return HarnessSessionController.create({
    paths,
    effectivePaths: paths,
    cwd: root,
    provider: 'anthropic',
    client,
    settings: defaultSettings,
    projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
    persistSession: true,
    ...(askUser ? { askUser } : {}),
  })
}

/** A real ledger file, so redaction is asserted against the artifact and not a spy. */
function makeTelemetry() {
  const file = join(paths.brainDir, 'voice-usage.jsonl')
  const warnings: string[] = []
  const telemetry = new VoiceTelemetry({
    model: 'gpt-realtime-2.1-mini',
    write: (line) => appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 }),
    onWarn: (message) => warnings.push(message),
  })
  const raw = (): string => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  const records = (): VoiceTelemetryRecord[] =>
    raw().split('\n').filter(Boolean).map((line) => JSON.parse(line) as VoiceTelemetryRecord)
  return { telemetry, warnings, file, raw, records }
}

function realtime(script: ScriptedRealtimeResponse[]) {
  const socket = new FakeRealtimeSocket({ script })
  const client = new RealtimeVoiceClient({
    apiKey: 'test-key',
    webSocketFactory: () => socket as unknown as WebSocket,
  })
  socket.open()
  return { socket, client }
}

/**
 * A command source the test drives directly, because a real harness turn finishes on its
 * own schedule: a scripted list would race the completion it exists to observe.
 */
class DrivenInput implements VoiceCommandInput {
  closed = false
  private readonly queue: VoiceCommand[] = []
  private waiter: ((command: VoiceCommand) => void) | null = null
  private stopped = false

  push(command: VoiceCommand): void {
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter(command)
      return
    }
    this.queue.push(command)
  }

  say(text: string): void {
    this.push({ kind: 'text', text })
  }

  /** Post-wake audio; the length is the client's real minimum utterance. */
  speak(wakeTranscript: string): void {
    this.push({ kind: 'audio', pcm: Buffer.alloc(9_600, 7), wakeTranscript })
  }

  stop(): void {
    this.stopped = true
    this.push({ kind: 'text', text: 'exit' })
  }

  async next(): Promise<VoiceCommand | null> {
    const queued = this.queue.shift()
    if (queued) return queued
    if (this.stopped) return { kind: 'text', text: 'exit' }
    return new Promise<VoiceCommand>((resolve) => {
      this.waiter = resolve
    })
  }

  close(): void {
    this.closed = true
  }
}

describe('voice through the real harness controller', () => {
  it('runs a spoken request in the real session and speaks its authoritative result', async () => {
    const model = new MockAnthropicClient([
      { blocks: [textBlock('Two tests fail in the parser suite.')], stopReason: 'end_turn' },
    ])
    const controller = await makeController(model)
    const { telemetry, records } = makeTelemetry()
    const { socket, client } = realtime([
      { toolCalls: [{ name: 'submit_turn', arguments: { text: 'inspect the failing tests' } }] },
      { transcript: 'I am on it.', usage: { total_tokens: 41, input_token_details: { audio_tokens: 30 } } },
      { transcript: 'Two tests fail in the parser suite.', usage: { total_tokens: 58 } },
    ])
    const input = new DrivenInput()
    const spoken: string[] = []

    const session = runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      controller,
      telemetry,
      play: async () => {},
      speakFallback: async (text) => {
        spoken.push(text)
      },
      onStatus: () => {},
    })
    input.speak('Athena, inspect the failing tests')
    await vi.waitFor(() =>
      expect(records().some((record) => record.event === 'turn.completed')).toBe(true))
    await vi.waitFor(() => expect(spoken).toContain('Two tests fail in the parser suite.'))
    input.stop()
    await session
    await controller.close()

    // The model answered inside the real engine, and the harness result — not a Realtime
    // invention — is what went back over the wire to be spoken.
    const delivered = socket.userInputs().find((text) => text.includes('The work you started'))
    expect(delivered).toContain('Two tests fail in the parser suite.')
    expect(delivered).toContain('status completed')
    // submit_turn returned at START; the result arrived as its own later turn.
    expect(socket.functionOutputs()[0]).toContain('"status":"started"')

    // The hash-chained trace stays the evidence for the work itself.
    const trace = readFileSync(controller.trace.file, 'utf8')
    expect(trace).toContain('inspect the failing tests')

    const submitted = records().find((record) => record.event === 'turn.submitted')
    const completed = records().find((record) => record.event === 'turn.completed')
    expect(submitted).toMatchObject({ source: 'audio' })
    // The correlation the budgets need: one voice turn ID, tied to the Athena session and
    // run whose trace holds the real account of what happened.
    expect(completed).toMatchObject({
      voiceTurnId: submitted?.voiceTurnId,
      harnessSessionId: controller.session.id,
      runId: controller.trace.runId,
    })
    expect(completed?.ms).toBeGreaterThanOrEqual(0)

    // Both budgets are measurable, and separately: feedback latency stops when Athena
    // first speaks, harness latency runs on past it.
    const feedback = records().find((record) => record.event === 'turn.feedback')
    expect(feedback).toMatchObject({ source: 'audio' })
    expect(feedback?.ms).toBeGreaterThanOrEqual(0)
    expect(records().some((record) => record.event === 'session.ready')).toBe(true)
    // Provider usage survives as numbers, which is the whole point of keeping the ledger.
    const usage = records().filter((record) => record.event === 'provider.usage')
    expect(JSON.stringify(usage)).toContain('"total_tokens":41')
  })

  it('records a permission wait and its resolution without persisting what was asked', async () => {
    const target = join(root, 'quarterly-forecast.txt')
    const model = new MockAnthropicClient([
      {
        blocks: [toolUseBlock('write-1', 'Write', { file_path: target, content: `${PHRASE} ${SECRET}` })],
        stopReason: 'tool_use',
      },
      { blocks: [textBlock(`Wrote ${PHRASE} to the forecast.`)], stopReason: 'end_turn' },
    ])
    const { telemetry, raw, records } = makeTelemetry()
    // The bridge is the only place that sees a wait begin, so the real one has to be the
    // instrumented one — the controller is built around it, not patched afterwards.
    const attention = new VoiceAttentionBridge({ cwd: root, telemetry })
    const controller = await makeController(model, attention.askUser)
    const { client } = realtime([
      { toolCalls: [{ name: 'submit_turn', arguments: { text: `write ${PHRASE} using ${SECRET} to ${target}` } }] },
      { transcript: 'I am on it.' },
    ])
    const input = new DrivenInput()

    const session = runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      controller,
      attention,
      telemetry,
      play: async () => {},
      speakFallback: async () => {},
      onStatus: () => {},
    })
    input.speak(`Athena, write ${PHRASE} to ${target}`)
    await vi.waitFor(() => expect(attention.pendingIds()).toHaveLength(1))
    // Keyboard parity: no model in the path between the user and the decision.
    input.say('allow')
    await vi.waitFor(() =>
      expect(records().some((record) => record.event === 'permission.resolved')).toBe(true))
    input.stop()
    await session
    await controller.close()

    const wait = records().find((record) => record.event === 'permission.wait')
    const resolved = records().find((record) => record.event === 'permission.resolved')
    expect(wait).toMatchObject({ permissionId: 'permission:write-1' })
    expect(resolved).toMatchObject({ label: 'allow', permissionId: 'permission:write-1' })
    expect(resolved?.ms).toBeGreaterThanOrEqual(0)
    // The identity is a counter key; the tool, the target, and the content are not.
    expect(raw()).not.toContain('Write')
    expect(raw()).not.toContain('quarterly-forecast')
    // The allow really did run the tool, so this drove the whole gate, not a mock of it.
    expect(existsSync(target)).toBe(true)
    expect(attention.pendingIds()).toEqual([])
  })

  it('keeps transcripts, submitted text, secrets, and absolute paths out of the ledger', async () => {
    const target = join(root, 'sensitive-report.txt')
    const model = new MockAnthropicClient([
      { blocks: [textBlock(`I read ${target} and found ${PHRASE}, key ${SECRET}.`)], stopReason: 'end_turn' },
    ])
    const controller = await makeController(model)
    const { telemetry, raw, records } = makeTelemetry()
    const { client } = realtime([
      {
        toolCalls: [{
          name: 'submit_turn',
          arguments: { text: `open ${target} and tell me about ${PHRASE} with key ${SECRET}` },
        }],
      },
      { transcript: 'I am on it.', usage: { total_tokens: 12, request_id: SECRET, transcript: PHRASE } },
      { transcript: `I found ${PHRASE}.`, audio: Buffer.from([1, 2, 3]) },
    ])
    const input = new DrivenInput()
    const statuses: string[] = []

    const session = runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      controller,
      telemetry,
      play: async () => {},
      speakFallback: async () => {},
      onStatus: (message) => statuses.push(message),
    })
    // A wake transcript carrying the same values, so the audio path is covered too.
    input.speak(`Athena, open ${target} and read ${PHRASE} key ${SECRET}`)
    await vi.waitFor(() =>
      expect(records().some((record) => record.event === 'turn.completed')).toBe(true))
    input.stop()
    await session
    await controller.close()

    const ledger = raw()
    expect(ledger.length).toBeGreaterThan(0)
    for (const value of [PHRASE, SECRET, target, 'sensitive-report', 'xylophone', 'marmalade']) {
      expect(ledger).not.toContain(value)
    }
    // Nothing else crept in either: every persisted line is a legal scalar record, and the
    // schema is what makes that a structural property rather than a habit.
    for (const record of records()) {
      expect(() => VoiceTelemetryRecordSchema.parse(record)).not.toThrow()
    }
    // Proof the values were really driven through: the trace and the terminal saw them.
    expect(readFileSync(controller.trace.file, 'utf8')).toContain(PHRASE)
    expect(statuses.join('\n')).toContain(PHRASE)
  })

  it('records an abort during work as a failed turn and leaves the session usable', async () => {
    let started: () => void = () => {}
    const startedTurn = new Promise<void>((resolve) => {
      started = resolve
    })
    /** Blocks until the run is aborted, which is the only way to catch a turn in flight. */
    const blocking: ModelClient = {
      async stream(
        params: { messages: MessageParam[]; signal: AbortSignal },
        _callbacks: StreamCallbacks,
      ): Promise<StreamResult> {
        started()
        return new Promise<StreamResult>((_resolve, reject) => {
          params.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      },
      async complete(): Promise<string> {
        return ''
      },
    }
    const controller = await makeController(blocking)
    const { telemetry, records } = makeTelemetry()
    const { client } = realtime([
      { toolCalls: [{ name: 'submit_turn', arguments: { text: 'run the long job' } }] },
      { transcript: 'I am on it.' },
    ])
    const input = new DrivenInput()

    const session = runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      controller,
      telemetry,
      play: async () => {},
      speakFallback: async () => {},
      onStatus: () => {},
    })
    input.say('run the long job')
    await startedTurn
    controller.abort()
    await vi.waitFor(() =>
      expect(records().some((record) => record.event === 'turn.failed')).toBe(true))
    input.stop()
    await session
    await controller.close()

    const failed = records().find((record) => record.event === 'turn.failed')
    expect(failed?.voiceTurnId).toMatch(/^voice-turn:\d+:[0-9a-f]{16}$/)
    expect(failed?.ms).toBeGreaterThanOrEqual(0)
    expect(records().some((record) => record.event === 'turn.completed')).toBe(false)
    // The trace still closes cleanly: an abort is an outcome, not a lost session.
    expect(existsSync(controller.trace.file)).toBe(true)
  })

  it('never lets a broken ledger cost a turn', async () => {
    const model = new MockAnthropicClient([
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ])
    const controller = await makeController(model)
    const warnings: string[] = []
    const telemetry = new VoiceTelemetry({
      model: 'gpt-realtime-2.1-mini',
      write: () => {
        throw new Error('EBUSY: resource busy or locked, open voice-usage.jsonl')
      },
      onWarn: (message) => warnings.push(message),
    })
    const { client } = realtime([
      { toolCalls: [{ name: 'submit_turn', arguments: { text: 'do the work' } }] },
      { transcript: 'I am on it.' },
      { transcript: 'It is done.' },
    ])
    const input = new DrivenInput()
    const spoken: string[] = []

    const session = runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      controller,
      telemetry,
      play: async () => {},
      speakFallback: async (text) => {
        spoken.push(text)
      },
      onStatus: () => {},
    })
    input.say('do the work')
    await vi.waitFor(() => expect(spoken).toContain('It is done.'))
    input.stop()
    await session
    await controller.close()

    // A locked ledger is a degraded optional backend, not a failed turn.
    expect(telemetry.counters()).toMatchObject({ 'turn.submitted': 1, 'turn.completed': 1 })
    expect(telemetry.isDegraded()).toBe(true)
    expect(warnings[0]).toContain('Voice is unaffected')
  })
})

describe('voice lifecycle counters', () => {
  const reply = (transcript: string) => ({ transcript, audio: Buffer.alloc(0), usage: [] })

  it('counts an initial connect, a planned renewal, and an unplanned recovery apart', async () => {
    const { telemetry, records } = makeTelemetry()
    let clock = 0
    const input = new DrivenInput()
    const session = runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      input,
      telemetry,
      clientFactory: (generation) => ({
        connect: async () => {},
        close: () => {},
        expiresAt: () => (generation === 1 ? 5_000 : 1_000_000),
        ask: async (text) => {
          if (generation === 2 && text === 'second') {
            throw new RealtimeTransportError('Realtime connection closed.', 'connection_closed')
          }
          clock = 4_500
          return reply(`heard ${text}`)
        },
        askAudio: async () => reply(''),
      }),
      reconnect: { renewMarginMs: 1_000, backoffMs: 0, now: () => clock, sleep: async () => {} },
      play: async () => {},
      speakFallback: async () => {},
      onStatus: () => {},
    })
    input.say('first')
    input.say('second')
    input.say('third')
    input.stop()
    await session

    const counts = telemetry.counters()
    expect(counts['realtime.connect/initial']).toBe(1)
    expect(counts['realtime.renewal']).toBe(1)
    expect(counts['realtime.connect/recovery']).toBe(1)
    expect(counts['realtime.lost/recovered']).toBe(1)
    // Session counters carry no identity of what was said on the session.
    expect(records().every((record) => record.event.startsWith('realtime')
      ? record.voiceTurnId === undefined
      : true)).toBe(true)
  })

  it('counts a wake backend restart and its exhausted budget without recording speech', async () => {
    const { telemetry, raw } = makeTelemetry()
    const processes: FakeWakeProcess[] = []
    const wake = new WindowsPersistentWakeInput({
      spawn: fakeSpawner(processes),
      maxRestarts: 2,
      restartDelayMs: 0,
      sleep: async () => {},
      telemetry,
    })
    const pending = wake.next()
    pending.catch(() => {})
    processes[0]!.emitStdout('{"ready":true}\n')
    // Ambient speech and a low-confidence match are both dropped on-device, and counted.
    processes[0]!.emitStdout(`${phraseLine(PHRASE, 0.95)}\n`)
    processes[0]!.emitStdout(`${phraseLine(`Athena ${PHRASE}`, 0.2)}\n`)
    processes[0]!.emitStdout(`${phraseLine('Athena run the tests', 0.95)}\n`)
    await expect(pending).resolves.toMatchObject({ wakeTranscript: 'Athena run the tests' })

    const next = wake.next()
    processes[0]!.emitExit(1)
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    processes[1]!.emitExit(1)
    await vi.waitFor(() => expect(processes).toHaveLength(3))
    processes[2]!.emitExit(1)
    await expect(next).rejects.toThrow(/stopped repeatedly/)
    wake.close()

    expect(telemetry.counters()).toMatchObject({
      'wake.accepted/wake-phrase': 1,
      'wake.rejected/ambient': 1,
      'wake.rejected/low-confidence': 1,
      // A backend that died after proving the microphone is a different fault from one
      // that never proved it, and the labels keep those two apart in the total.
      'wake.restart': 2,
      'wake.restart/crash': 1,
      'wake.restart/not-ready': 1,
      'wake.failed/not-ready': 1,
    })
    // A rejected wake must leave a number behind and nothing else.
    expect(raw()).not.toContain(PHRASE)
    expect(raw()).not.toContain('xylophone')
  })

  it('counts a playback failure and the local speech that recovered it', async () => {
    const { telemetry } = makeTelemetry()
    const input = new DrivenInput()
    const spoken: string[] = []
    const session = runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      input,
      telemetry,
      clientFactory: () => ({
        connect: async () => {},
        close: () => {},
        ask: async (text) => ({
          transcript: `answer to ${text}`,
          audio: Buffer.from([1, 2, 3]),
          usage: [],
        }),
        askAudio: async () => reply(''),
      }),
      reconnect: { sleep: async () => {} },
      play: async () => {
        throw new Error('MMSYSERR_NODRIVER')
      },
      speakFallback: async (text) => {
        spoken.push(text)
      },
      onStatus: () => {},
    })
    input.say('say something')
    input.stop()
    await session

    expect(spoken).toContain('answer to say something')
    expect(telemetry.counters()).toMatchObject({
      'playback.failed/realtime-audio': 1,
      'playback.spoken/local-speech': 1,
    })
  })
})
