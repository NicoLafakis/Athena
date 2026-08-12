import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessSessionController } from '../../src/harness/controller.js'
import type {
  RealtimeToolCall,
  RealtimeTurnResult,
} from '../../src/voice/realtime.js'
import {
  WindowsPersistentWakeInput,
  WindowsWakeCommandInput,
  athenaDelegateArgs,
  runVoiceSession,
  waitForWakeProbe,
  type VoiceCommandInput,
  type VoiceRealtimeClient,
  type WakeListenerProcess,
} from '../../src/voice/daemon.js'

function pcmWave(sampleRate = 16_000, samples = [0, 1, -1, 2]): Buffer {
  const pcm = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2))
  const wave = Buffer.alloc(44 + pcm.length)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(36 + pcm.length, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(sampleRate, 24)
  wave.writeUInt32LE(sampleRate * 2, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(pcm.length, 40)
  pcm.copy(wave, 44)
  return wave
}

function phraseLine(text: string, confidence: number): string {
  return JSON.stringify({ text, confidence, wave: pcmWave().toString('base64') })
}

class FakeWakeProcess implements WakeListenerProcess {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly written: string[] = []
  ended = false
  killed = false
  private readonly exitEmitter = new EventEmitter()
  readonly stdin = {
    write: (chunk: string) => {
      this.written.push(chunk)
      return true
    },
    end: () => {
      this.ended = true
    },
  }
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    this.exitEmitter.once(event, listener)
    return this
  }
  kill(): boolean {
    this.killed = true
    this.emitExit(null, 'SIGTERM')
    return true
  }
  emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitEmitter.emit('exit', code, signal)
  }
  emitStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text))
  }
}

function fakeSpawner(processes: FakeWakeProcess[]): () => FakeWakeProcess {
  return () => {
    const process = new FakeWakeProcess()
    processes.push(process)
    return process
  }
}

class ScriptedInput implements VoiceCommandInput {
  closed = false
  constructor(private readonly commands: string[]) {}
  async next() {
    return { kind: 'text' as const, text: this.commands.shift() ?? 'exit' }
  }
  close(): void { this.closed = true }
}

class ScriptedAudioInput implements VoiceCommandInput {
  closed = false
  constructor(private remaining = 2) {}
  async next() {
    if (this.remaining-- > 0) {
      return { kind: 'audio' as const, pcm: Buffer.alloc(4_800), wakeTranscript: 'Athena' }
    }
    return { kind: 'text' as const, text: 'exit' }
  }
  close(): void { this.closed = true }
}

describe('voice conductor composition', () => {
  it('ignores low-confidence or non-wake local recognition before accepting Athena', async () => {
    const phrases = [
      { text: 'Athena wrong', confidence: 0.2, audio: Buffer.from([1]) },
      { text: 'ordinary speech', confidence: 0.99, audio: Buffer.from([2]) },
      { text: 'Athena status', confidence: 0.95, audio: Buffer.from([3]) },
    ]
    const input = new WindowsWakeCommandInput(0.6, async () => phrases.shift() ?? null)
    await expect(input.next()).resolves.toEqual({
      kind: 'audio', pcm: Buffer.from([3]), wakeTranscript: 'Athena status',
    })
  })

  it('gives the wake probe bounded retries instead of failing on the first bad transcript', async () => {
    const phrases = [
      { text: 'The things that was', confidence: 0.92, audio: Buffer.from([1]) },
      { text: 'Athena probe', confidence: 0.2, audio: Buffer.from([2]) },
      { text: 'Athena probe', confidence: 0.95, audio: Buffer.from([3]) },
    ]
    const retry = vi.fn(async () => {})
    await expect(waitForWakeProbe(
      async () => phrases.shift() ?? null,
      retry,
      3,
    )).resolves.toEqual({
      passed: true,
      heard: ['The things that was', 'Athena probe', 'Athena probe'],
      command: 'probe',
      audio: Buffer.from([3]),
    })
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('separates a working Athena wake word from an imperfect command transcript', async () => {
    await expect(waitForWakeProbe(
      async () => ({ text: 'Athena status', confidence: 0.92, audio: Buffer.from([4]) }),
      async () => {},
    )).resolves.toEqual({
      passed: true, heard: ['Athena status'], command: 'status', audio: Buffer.from([4]),
    })
  })

  it('starts one durable Athena session, then resumes it without relaxing shell permissions', () => {
    expect(athenaDelegateArgs('run tests')).toEqual([
      'exec', 'Voice delegation: run tests', '--output', 'json', '--session',
      '--permission-mode', 'acceptEdits',
    ])
    expect(athenaDelegateArgs('continue', 'session-1')).toContain('session-1')
    expect(athenaDelegateArgs('continue', 'session-1')).not.toContain('trusted')
  })

  it('requires a separate confirm turn before delegating and supports cancel', async () => {
    const input = new ScriptedInput(['build it', 'confirm', 'another task', 'cancel', 'exit'])
    const delegate = vi.fn(async () => ({ status: 'completed' as const, summary: 'Tests passed.' }))
    let askCount = 0
    const client: VoiceRealtimeClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      ask: vi.fn(async (_text, handler): Promise<RealtimeTurnResult> => {
        askCount++
        if (askCount === 1 || askCount === 3) {
          await handler({
            name: 'delegate', callId: `call-${askCount}`, arguments: { prompt: `task-${askCount}` },
          } satisfies RealtimeToolCall)
        }
        return { transcript: 'ok', audio: Buffer.alloc(0), usage: [{ total_tokens: 1 }] }
      }),
      askAudio: vi.fn(async () => ({
        transcript: 'ok', audio: Buffer.alloc(0), usage: [{ total_tokens: 1 }],
      })),
    }
    const statuses: string[] = []
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      delegate,
      speakFallback: async () => {},
      play: async () => {},
      onStatus: (message) => statuses.push(message),
    })
    expect(delegate).toHaveBeenCalledOnce()
    expect(delegate).toHaveBeenCalledWith('task-1')
    expect(statuses.join('\n')).toContain('Pending delegation canceled')
    expect(input.closed).toBe(true)
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('lets Realtime understand raw speech while preserving separate-turn confirmation', async () => {
    const input = new ScriptedAudioInput()
    const delegate = vi.fn(async () => ({ status: 'completed' as const, summary: 'Done.' }))
    let turn = 0
    const client: VoiceRealtimeClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      ask: vi.fn(async () => ({ transcript: '', audio: Buffer.alloc(0), usage: [] })),
      askAudio: vi.fn(async (_pcm, handler) => {
        turn++
        const result = turn === 1
          ? await handler({ name: 'delegate', callId: 'proposal', arguments: { prompt: 'run tests' } })
          : await handler({ name: 'confirm', callId: 'confirmation', arguments: {} })
        return {
          transcript: JSON.stringify(result), audio: Buffer.alloc(0), usage: [],
        }
      }),
    }
    await runVoiceSession({
      apiKey: 'test', model: 'gpt-realtime-2.1-mini', input, client, delegate,
      speakFallback: async () => {}, play: async () => {}, onStatus: () => {},
    })
    expect(client.askAudio).toHaveBeenCalledTimes(2)
    expect(delegate).toHaveBeenCalledOnce()
    expect(delegate).toHaveBeenCalledWith('run tests')
  })

  it('handles direct-harness submit_turn and local_control tools when a controller is present', async () => {
    const input = new ScriptedInput(['run tests', 'exit'])
    const controller = {
      submitTurn: vi.fn(async (text: string) => ({
        status: 'completed' as const,
        summary: `Harness finished: ${text}`,
        sessionId: 'session-xyz',
      })),
      getSnapshot: vi.fn(() => ({
        schemaVersion: 1 as const,
        reducerVersion: 1 as const,
        runId: 'run-1',
        lastSequence: 1,
        objective: { value: 'All tests green.', source: 'user' as const, sequence: 1, timestamp: '' },
        phase: { value: 'completed' as const, source: 'user' as const, sequence: 1, timestamp: '' },
        activity: { value: null, source: 'user' as const, sequence: 1, timestamp: '' },
        attention: [],
        lastVerifiedOutcome: { value: null, source: 'user' as const, sequence: 1, timestamp: '' },
        nextExpected: { value: null, source: 'user' as const, sequence: 1, timestamp: '' },
        updatedAt: '',
      })),
    } as unknown as HarnessSessionController

    const asks: string[] = []
    const client: VoiceRealtimeClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      ask: vi.fn(async (text, handler) => {
        asks.push(text)
        if (asks.length === 1) {
          const turnRes = (await handler({ name: 'submit_turn', callId: '1', arguments: { text: 'run tests' } })) as { status: string }
          const statusRes = (await handler({ name: 'local_control', callId: '2', arguments: { action: 'status' } })) as { summary: string }
          // submit_turn returns at START, not at completion — the harness turn outlives
          // the Realtime response by design.
          expect(turnRes.status).toBe('started')
          expect(statusRes.summary).toBe('All tests green.')
        }
        return { transcript: 'ok', audio: Buffer.alloc(0), usage: [] }
      }),
      askAudio: vi.fn(async () => ({ transcript: '', audio: Buffer.alloc(0), usage: [] })),
    }

    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      controller,
      speakFallback: async () => {},
      play: async () => {},
      onStatus: () => {},
    })

    expect(controller.submitTurn).toHaveBeenCalledWith('run tests')
    expect(controller.getSnapshot).toHaveBeenCalled()
    // The harness completion is delivered as a second, spoken turn before shutdown.
    expect(asks).toHaveLength(2)
    expect(asks[1]).toContain('Harness finished: run tests')
    expect(asks[1]).toContain('status completed')
  })

  it('answers "still working" instead of double-running while a harness turn is in flight', async () => {
    const input = new ScriptedInput(['do work', 'exit'])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller = {
      submitTurn: vi.fn(() =>
        gate.then(() => ({ status: 'completed' as const, summary: 'done', sessionId: 's-1' }))),
      getSnapshot: vi.fn(() => undefined),
    } as unknown as HarnessSessionController

    const outcomes: unknown[] = []
    const client: VoiceRealtimeClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      ask: vi.fn(async (_text, handler) => {
        if (outcomes.length === 0) {
          outcomes.push(await handler({ name: 'submit_turn', callId: '1', arguments: { text: 'first' } }))
          outcomes.push(await handler({ name: 'submit_turn', callId: '2', arguments: { text: 'second' } }))
          release()
        }
        return { transcript: 'ok', audio: Buffer.alloc(0), usage: [] }
      }),
      askAudio: vi.fn(async () => ({ transcript: '', audio: Buffer.alloc(0), usage: [] })),
    }

    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input,
      client,
      controller,
      speakFallback: async () => {},
      play: async () => {},
      onStatus: () => {},
    })

    expect(outcomes[0]).toMatchObject({ status: 'started' })
    expect(outcomes[1]).toMatchObject({ error: expect.stringContaining('still working') })
    expect(controller.submitTurn).toHaveBeenCalledTimes(1)
  })
})

describe('WindowsPersistentWakeInput', () => {
  it('streams wake phrases from one persistent supervised process', async () => {
    const processes: FakeWakeProcess[] = []
    const input = new WindowsPersistentWakeInput({
      spawn: fakeSpawner(processes),
      sleep: async () => {},
    })
    const first = input.next()
    const process = processes[0]!
    // Garbage, split framing, and pre-ready chatter never produce commands.
    process.emitStdout('not json\n')
    process.emitStdout('{"ready":tr')
    process.emitStdout('ue}\n')
    process.emitStdout(phraseLine('Athena status', 0.2) + '\n')
    process.emitStdout(phraseLine('ordinary speech', 0.99) + '\n')
    process.emitStdout(phraseLine('Athena status', 0.95) + '\n')
    await expect(first).resolves.toMatchObject({ kind: 'audio', wakeTranscript: 'Athena status' })
    // Events without a waiter queue up instead of spawning a new process.
    process.emitStdout(phraseLine('Athena repeat', 0.9) + '\n')
    await expect(input.next()).resolves.toMatchObject({ wakeTranscript: 'Athena repeat' })
    expect(processes).toHaveLength(1)
    input.close()
  })

  it('restarts a crashed listener within a bounded budget and keeps waiting', async () => {
    const processes: FakeWakeProcess[] = []
    const warnings: string[] = []
    const input = new WindowsPersistentWakeInput({
      spawn: fakeSpawner(processes),
      restartDelayMs: 0,
      sleep: async () => {},
      onWarn: (message) => warnings.push(message),
    })
    const pending = input.next()
    processes[0]!.emitStdout('{"ready":true}\n')
    processes[0]!.emitExit(1)
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    expect(warnings.some((message) => message.includes('restarting (1/3)'))).toBe(true)
    expect(warnings.some((message) => message.includes('athena voice probe'))).toBe(true)
    processes[1]!.emitStdout('{"ready":true}\n')
    processes[1]!.emitStdout(phraseLine('Athena status', 0.95) + '\n')
    await expect(pending).resolves.toMatchObject({ kind: 'audio', wakeTranscript: 'Athena status' })
    input.close()
  })

  it('fails loudly with one actionable error after the restart budget is exhausted', async () => {
    const processes: FakeWakeProcess[] = []
    const input = new WindowsPersistentWakeInput({
      spawn: fakeSpawner(processes),
      maxRestarts: 2,
      restartDelayMs: 0,
      sleep: async () => {},
    })
    const pending = input.next()
    processes[0]!.emitExit(1)
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    processes[1]!.emitExit(1)
    await vi.waitFor(() => expect(processes).toHaveLength(3))
    processes[2]!.emitExit(1)
    await expect(pending).rejects.toThrow(/wake listener stopped repeatedly.*athena voice probe/)
    await expect(input.next()).rejects.toThrow(/wake listener stopped repeatedly/)
    input.close()
  })

  it('kills and replaces a listener that never proves microphone readiness', async () => {
    const processes: FakeWakeProcess[] = []
    const warnings: string[] = []
    let attempt = 0
    const input = new WindowsPersistentWakeInput({
      spawn: () => {
        attempt += 1
        const process = new FakeWakeProcess()
        // Later attempts report ready immediately (microtask: after handlers attach);
        // only the first attempt stalls and must hit the readiness timeout.
        if (attempt >= 2) queueMicrotask(() => process.emitStdout('{"ready":true}\n'))
        processes.push(process)
        return process
      },
      readyTimeoutMs: 5,
      restartDelayMs: 0,
      sleep: async () => {},
      onWarn: (message) => warnings.push(message),
    })
    const pending = input.next()
    pending.catch(() => {})
    await vi.waitFor(() => expect(processes.length).toBeGreaterThanOrEqual(2))
    expect(processes[0]!.killed).toBe(true)
    expect(warnings.some((message) => message.includes('readiness'))).toBe(true)
    const latest = processes[processes.length - 1]!
    latest.emitStdout(phraseLine('Athena', 0.9) + '\n')
    // Bare wake opens the capture window; the next phrase is the command.
    latest.emitStdout(phraseLine('status', 0.9) + '\n')
    await expect(pending).resolves.toMatchObject({ kind: 'audio', wakeTranscript: 'status' })
    input.close()
  })

  it('close asks the listener to exit and escalates to a kill', async () => {
    const processes: FakeWakeProcess[] = []
    const input = new WindowsPersistentWakeInput({
      spawn: fakeSpawner(processes),
      closeGraceMs: 5,
      sleep: async () => {},
    })
    const pending = input.next()
    pending.catch(() => {})
    const process = processes[0]!
    input.close()
    expect(process.written).toContain('exit\n')
    expect(process.ended).toBe(true)
    await vi.waitFor(() => expect(process.killed).toBe(true))
    await expect(pending).rejects.toThrow(/closed/)
    input.close()
  })

  it('answers a bare wake word locally and captures the next phrase as the command', async () => {
    const processes: FakeWakeProcess[] = []
    const listening: string[] = []
    let clock = 1_000
    const input = new WindowsPersistentWakeInput({
      spawn: fakeSpawner(processes),
      sleep: async () => {},
      now: () => clock,
      onListening: () => listening.push('listening'),
    })
    const pending = input.next()
    const process = processes[0]!
    process.emitStdout('{"ready":true}\n')
    // The bare wake word must NOT be uploaded: it opens the capture window locally.
    process.emitStdout(phraseLine('Athena', 0.97) + '\n')
    expect(listening).toEqual(['listening'])
    await Promise.resolve()
    // Ambient dictation before the wake would have been dropped; after it, it is the command.
    clock = 2_000
    process.emitStdout(phraseLine('what is the status', 0.9) + '\n')
    await expect(pending).resolves.toMatchObject({
      kind: 'audio',
      wakeTranscript: 'what is the status',
    })
    input.close()
  })

  it('drops non-wake phrases outside the capture window (ambient speech stays local)', async () => {
    const processes: FakeWakeProcess[] = []
    let clock = 0
    const input = new WindowsPersistentWakeInput({
      spawn: fakeSpawner(processes),
      sleep: async () => {},
      now: () => clock,
    })
    const pending = input.next()
    pending.catch(() => {})
    const process = processes[0]!
    process.emitStdout('{"ready":true}\n')
    process.emitStdout(phraseLine('someone else talking', 0.95) + '\n')
    // Still pending: nothing was delivered. A wake now, then expiry, then a phrase: dropped too.
    process.emitStdout(phraseLine('Athena', 0.95) + '\n')
    clock = 10_000 // past the 6s default window
    process.emitStdout(phraseLine('stale command', 0.95) + '\n')
    clock = 11_000
    process.emitStdout(phraseLine('Athena', 0.95) + '\n')
    clock = 11_500
    process.emitStdout(phraseLine('fresh command', 0.95) + '\n')
    await expect(pending).resolves.toMatchObject({ wakeTranscript: 'fresh command' })
    input.close()
  })
})
