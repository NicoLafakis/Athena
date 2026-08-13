import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessSessionController } from '../../src/harness/controller.js'
import type { PermissionAnswer } from '../../src/engine/types.js'
import {
  FakeWakeProcess,
  fakeSpawner,
  phraseLine,
  readyLine,
} from '../helpers/fake-wake-process.js'
import { VoiceAttentionBridge } from '../../src/voice/attention.js'
import {
  RealtimeTransportError,
  type RealtimeToolCall,
  type RealtimeTurnResult,
} from '../../src/voice/realtime.js'
import { VoiceTelemetry } from '../../src/voice/telemetry.js'
import {
  probeWindowsSpeech,
  runPowerShell,
  spawnWindowsWakeListener,
} from '../../src/voice/windows-speech.js'
import {
  KeyboardVoiceCommandInput,
  WindowsPersistentWakeInput,
  runVoiceSession,
  waitForWakeProbe,
  type VoiceCommandInput,
  type VoiceRealtimeClient,
} from '../../src/voice/daemon.js'

class ScriptedInput implements VoiceCommandInput {
  closed = false
  constructor(private readonly commands: string[]) {}
  async next() {
    return { kind: 'text' as const, text: this.commands.shift() ?? 'exit' }
  }
  close(): void { this.closed = true }
}

describe('direct harness voice composition', () => {
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

describe('voice session renewal, idempotency, and playback recovery', () => {
  const reply = (text: string): RealtimeTurnResult =>
    ({ transcript: text, audio: Buffer.alloc(0), usage: [] })

  const dropped = (): RealtimeTransportError =>
    new RealtimeTransportError('Realtime connection closed.', 'connection_closed')

  /** A controller whose harness turn never finishes, so it stays in flight for the test. */
  function stallingController(): HarnessSessionController {
    return {
      submitTurn: vi.fn(() => new Promise(() => {})),
      getSnapshot: vi.fn(() => undefined),
      lastAnnouncement: vi.fn(() => undefined),
    } as unknown as HarnessSessionController
  }

  function finishingController(sessionId = 's-1'): HarnessSessionController {
    return {
      submitTurn: vi.fn(async (text: string) => ({
        status: 'completed' as const,
        summary: `Finished ${text} in session ${sessionId}`,
        sessionId,
      })),
      getSnapshot: vi.fn(() => undefined),
      lastAnnouncement: vi.fn(() => undefined),
    } as unknown as HarnessSessionController
  }

  it('reopens a dropped Realtime session and keeps serving later turns', async () => {
    const opened: number[] = []
    const statuses: string[] = []
    const spoken: string[] = []
    const heard: string[] = []
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['first', 'second', 'third', 'exit']),
      clientFactory: (generation) => {
        opened.push(generation)
        return {
          connect: async () => {},
          close: () => {},
          ask: async (text) => {
            if (generation === 1 && text === 'second') throw dropped()
            heard.push(`${generation}:${text}`)
            return reply(`heard ${text}`)
          },
          askAudio: async () => reply(''),
        }
      },
      reconnect: { backoffMs: 0, sleep: async () => {} },
      speakFallback: async (text) => {
        spoken.push(text)
      },
      play: async () => {},
      onStatus: (message) => statuses.push(message),
    })
    expect(opened).toEqual([1, 2])
    // The utterance that died is reported as lost rather than silently swallowed, and the
    // session keeps working afterwards.
    expect(spoken.join('\n')).toContain('please say it again')
    expect(heard).toEqual(['1:first', '2:third'])
    expect(statuses.join('\n')).toContain('Realtime session 2 (recovery)')
  })

  it('renews an expiring session transparently, and the harness session is unchanged', async () => {
    let clock = 0
    const controller = finishingController('session-abc')
    const asks: string[] = []
    const spoken: string[] = []
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['do the first thing', 'do the second thing', 'exit']),
      controller,
      clientFactory: (generation) => ({
        connect: async () => {},
        close: () => {},
        // Only the first session is close to the provider deadline.
        expiresAt: () => (generation === 1 ? 5_000 : 1_000_000),
        ask: async (text, handler) => {
          asks.push(`${generation}:${text}`)
          if (!text.startsWith('The work you started')) {
            await handler({ name: 'submit_turn', callId: `c-${asks.length}`, arguments: { text } })
          }
          // The renewal boundary sits between the two utterances.
          clock = 4_500
          return reply('ok')
        },
        askAudio: async () => reply(''),
      }),
      reconnect: { renewMarginMs: 1_000, now: () => clock, sleep: async () => {} },
      speakFallback: async (text) => {
        spoken.push(text)
      },
      play: async () => {},
      onStatus: () => {},
    })
    expect(controller.submitTurn).toHaveBeenCalledTimes(2)
    // Both turns ran, and the second — spoken by a session opened after the renewal —
    // still reports the same durable Athena session.
    const delivered = asks.filter((ask) => ask.includes('The work you started'))
    expect(delivered).toHaveLength(2)
    expect(delivered.every((ask) => ask.includes('session-abc'))).toBe(true)
    expect(asks.some((ask) => ask.startsWith('2:'))).toBe(true)
    // Planned renewal is not an incident: the user is never asked to repeat anything.
    expect(spoken.join('\n')).not.toContain('lost the voice connection')
  })

  it('runs a duplicated submit_turn once, and answers with the same voice turn ID', async () => {
    const controller = stallingController()
    const results: unknown[] = []
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['inspect the failing tests', 'exit']),
      controller,
      clientFactory: () => ({
        connect: async () => {},
        close: () => {},
        ask: async (_text, handler) => {
          if (results.length === 0) {
            const call = { name: 'submit_turn', arguments: { text: 'inspect the failing tests' } }
            results.push(await handler({ ...call, callId: 'a' } as RealtimeToolCall))
            // The exact same request again — a repeated tool call, or a model retrying
            // after the function-call round trip.
            results.push(await handler({ ...call, callId: 'b' } as RealtimeToolCall))
            // Same words, different punctuation and casing: still the same request.
            results.push(await handler({
              name: 'submit_turn',
              callId: 'c',
              arguments: { text: 'Inspect the failing tests.' },
            }))
          }
          return reply('ok')
        },
        askAudio: async () => reply(''),
      }),
      reconnect: { sleep: async () => {} },
      speakFallback: async () => {},
      play: async () => {},
      onStatus: () => {},
    })
    expect(controller.submitTurn).toHaveBeenCalledTimes(1)
    const started = results[0] as { status: string; voice_turn_id: string }
    expect(started.status).toBe('started')
    for (const repeat of results.slice(1)) {
      expect(repeat).toMatchObject({
        error: expect.stringContaining('already have that exact request'),
        voice_turn_id: started.voice_turn_id,
        state: 'running',
      })
    }
  })

  it('does not resubmit an in-flight harness turn across a reconnect', async () => {
    const controller = stallingController()
    const refusals: unknown[] = []
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['fix the build', 'anything', 'fix the build', 'exit']),
      controller,
      clientFactory: (generation) => ({
        connect: async () => {},
        close: () => {},
        ask: async (text, handler) => {
          if (generation === 1 && text === 'anything') throw dropped()
          if (text === 'fix the build') {
            refusals.push(await handler({
              name: 'submit_turn',
              callId: `${generation}`,
              arguments: { text },
            }))
          }
          return reply('ok')
        },
        askAudio: async () => reply(''),
      }),
      reconnect: { backoffMs: 0, sleep: async () => {} },
      speakFallback: async () => {},
      play: async () => {},
      onStatus: () => {},
    })
    // One harness run, despite the same request arriving again on the reopened session.
    expect(controller.submitTurn).toHaveBeenCalledTimes(1)
    expect(refusals[0]).toMatchObject({ status: 'started' })
    expect(refusals[1]).toMatchObject({ error: expect.stringContaining('still working') })
  })

  it('tells the user the work survived when the drop happened after the turn started', async () => {
    const controller = stallingController()
    const spoken: string[] = []
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['run the tests', 'exit']),
      controller,
      clientFactory: (generation) => ({
        connect: async () => {},
        close: () => {},
        ask: async (text, handler) => {
          if (generation === 1) {
            await handler({ name: 'submit_turn', callId: '1', arguments: { text } })
            throw dropped()
          }
          return reply('ok')
        },
        askAudio: async () => reply(''),
      }),
      reconnect: { backoffMs: 0, sleep: async () => {} },
      speakFallback: async (text) => {
        spoken.push(text)
      },
      play: async () => {},
      onStatus: () => {},
    })
    expect(controller.submitTurn).toHaveBeenCalledTimes(1)
    expect(spoken.join('\n')).toContain('you do not need to repeat that')
    expect(spoken.join('\n')).not.toContain('please say it again')
  })

  it('rejects a malformed submit_turn without running anything', async () => {
    const controller = stallingController()
    const results: unknown[] = []
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['do something', 'exit']),
      controller,
      clientFactory: () => ({
        connect: async () => {},
        close: () => {},
        ask: async (_text, handler) => {
          if (results.length === 0) {
            for (const args of [
              null,
              {},
              { text: '' },
              { text: 42 },
              { prompt: 'run the tests' },
              { text: 'run the tests', permission_mode: 'bypass' },
            ]) {
              results.push(await handler({ name: 'submit_turn', callId: 'x', arguments: args }))
            }
          }
          return reply('ok')
        },
        askAudio: async () => reply(''),
      }),
      reconnect: { sleep: async () => {} },
      speakFallback: async () => {},
      play: async () => {},
      onStatus: () => {},
    })
    expect(controller.submitTurn).not.toHaveBeenCalled()
    expect(results).toHaveLength(6)
    for (const result of results) {
      expect(result).toMatchObject({ error: expect.stringContaining('not well formed') })
    }
  })

  it('survives a playback failure with stable text and local recovery speech', async () => {
    const statuses: string[] = []
    const spoken: string[] = []
    let serve = 0
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['say something', 'say more', 'exit']),
      clientFactory: () => ({
        connect: async () => {},
        close: () => {},
        ask: async (text) => {
          serve += 1
          return { transcript: `answer to ${text}`, audio: Buffer.from([1, 2, 3]), usage: [] }
        },
        askAudio: async () => reply(''),
      }),
      reconnect: { sleep: async () => {} },
      play: async () => {
        throw new Error('MMSYSERR_NODRIVER')
      },
      speakFallback: async (text) => {
        spoken.push(text)
      },
      onStatus: (message) => statuses.push(message),
    })
    // A dead audio device does not end the session.
    expect(serve).toBe(2)
    const printed = statuses.join('\n')
    expect(printed).toContain('Athena: answer to say something')
    expect(printed).toContain('could not play audio through the Windows audio backend')
    expect(printed).toContain('athena voice probe')
    // Local speech is the recovery path, and it carries the same words.
    expect(spoken).toContain('answer to say something')
    expect(spoken).toContain('answer to say more')
  })

  it('routes Ctrl+C to the interrupt hook and settles a prompt left open by shutdown', async () => {
    const input = new PassThrough()
    // readline only takes over Ctrl+C when it owns a terminal — exactly the case where a
    // process SIGINT listener never fires. It decides that from the OUTPUT stream.
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 })
    const interrupts: string[] = []
    const keyboard = new KeyboardVoiceCommandInput({
      input,
      output,
      onInterrupt: () => interrupts.push('sigint'),
    })
    const answered = keyboard.next()
    input.write('run the tests\n')
    await expect(answered).resolves.toEqual({ kind: 'text', text: 'run the tests' })

    const pending = keyboard.next()
    input.write('')
    await new Promise((resolve) => setImmediate(resolve))
    expect(interrupts).toEqual(['sigint'])
    // The prompt outstanding at shutdown must settle, or teardown deadlocks on it.
    keyboard.close()
    await expect(pending).rejects.toThrow()
  })

  it('stops cleanly with one actionable report when the connection cannot be reopened', async () => {
    const statuses: string[] = []
    const spoken: string[] = []
    let opens = 0
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['first', 'second', 'third', 'exit']),
      clientFactory: () => {
        opens += 1
        const generation = opens
        return {
          connect: async () => {
            if (generation > 1) throw new Error('getaddrinfo ENOTFOUND api.openai.com')
          },
          close: () => {},
          ask: async (text) => {
            if (text === 'second') throw dropped()
            return reply(`heard ${text}`)
          },
          askAudio: async () => reply(''),
        }
      },
      reconnect: { maxAttempts: 3, backoffMs: 0, sleep: async () => {} },
      speakFallback: async (text) => {
        spoken.push(text)
      },
      play: async () => {},
      onStatus: (message) => statuses.push(message),
    })
    // One initial session plus a bounded three attempts, then it stops trying.
    expect(opens).toBe(4)
    const reconnecting = statuses.filter((message) => message.includes('reconnecting'))
    expect(reconnecting).toHaveLength(1)
    const report = spoken.join('\n')
    expect(report).toContain('could not reopen the OpenAI Realtime connection')
    expect(report).toContain('Athena session, trace, and stored key are untouched')
    expect(report).toContain('athena voice probe')
  })
})

describe('voice permissions and local controls', () => {
  interface PermissionHarness {
    bridge: VoiceAttentionBridge
    controller: HarnessSessionController
    /** Resolves with whatever the harness permission callback was finally answered. */
    answerFor(id: string): Promise<PermissionAnswer>
    raise(): string
  }

  interface PermissionHarnessOptions {
    snapshotPhase?: string
    /** Permission requests the harness turn raises, mirroring parallel tool dispatch. */
    raiseOnSubmit?: number
  }

  function permissionHarness(options: PermissionHarnessOptions = {}): PermissionHarness {
    const bridge = new VoiceAttentionBridge({ cwd: process.cwd() })
    const answers = new Map<string, Promise<PermissionAnswer>>()
    let issued = 0
    const raise = (): string => {
      issued += 1
      const id = `permission:write-${issued}`
      const file = issued === 1 ? 'x.txt' : `x${issued}.txt`
      answers.set(id, bridge.askUser({
        id,
        toolName: 'Write',
        input: { file_path: file, content: 'y' },
        summary: `Write ${file}`,
        reason: 'Write is mutating; no rule matched in normal mode',
      }))
      return id
    }
    const controller = {
      // The harness turn stays in flight for as long as the decisions are outstanding.
      submitTurn: vi.fn(() => {
        for (let index = 0; index < (options.raiseOnSubmit ?? 1); index++) raise()
        return new Promise(() => {})
      }),
      getSnapshot: vi.fn(() => options.snapshotPhase
        ? {
          phase: { value: options.snapshotPhase },
          objective: { value: 'Write the file.' },
          activity: { value: null },
          attention: [],
        }
        : undefined),
      lastAnnouncement: vi.fn(() => undefined),
    } as unknown as HarnessSessionController
    return {
      bridge,
      controller,
      raise,
      answerFor: (id) => answers.get(id)!,
    }
  }

  /** Fake Realtime that issues one scripted tool call per turn and records the results. */
  function scriptedClient(
    script: Array<RealtimeToolCall | null>,
    results: unknown[],
  ): VoiceRealtimeClient {
    let turn = 0
    return {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      ask: vi.fn(async (_text, handler): Promise<RealtimeTurnResult> => {
        const call = script[turn++]
        if (call) results.push(await handler(call))
        return { transcript: 'ok', audio: Buffer.alloc(0), usage: [] }
      }),
      askAudio: vi.fn(async () => ({ transcript: '', audio: Buffer.alloc(0), usage: [] })),
    }
  }

  function control(callId: string, args: Record<string, unknown>): RealtimeToolCall {
    return { name: 'local_control', callId, arguments: args }
  }

  async function drive(
    harness: PermissionHarness,
    commands: string[],
    script: Array<RealtimeToolCall | null>,
  ): Promise<{ results: unknown[]; spoken: string[]; client: VoiceRealtimeClient }> {
    const results: unknown[] = []
    const spoken: string[] = []
    const client = scriptedClient(script, results)
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(commands),
      client,
      controller: harness.controller,
      attention: harness.bridge,
      speakFallback: async (text) => {
        spoken.push(text)
      },
      play: async () => {},
      onStatus: () => {},
    })
    return { results, spoken, client }
  }

  /**
   * A fake Realtime that records seeded context items and can put SEVERAL tool calls on one
   * turn — which is the only way to reach the same-turn case deterministically, because a
   * permission and the answer to it then share one `answeringTurn`.
   */
  function notingClient(
    script: Array<RealtimeToolCall[]>,
    results: unknown[],
    notes: string[],
  ): VoiceRealtimeClient {
    let turn = 0
    return {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      note: vi.fn(async (text: string) => {
        notes.push(text)
      }),
      ask: vi.fn(async (_text, handler): Promise<RealtimeTurnResult> => {
        for (const call of script[turn++] ?? []) results.push(await handler(call))
        return { transcript: 'ok', audio: Buffer.alloc(0), usage: [] }
      }),
      askAudio: vi.fn(async () => ({ transcript: '', audio: Buffer.alloc(0), usage: [] })),
    }
  }

  it('seeds the pending permission into the session without spending a turn on it', async () => {
    const harness = permissionHarness()
    const results: unknown[] = []
    const notes: string[] = []
    const telemetry = new VoiceTelemetry({ model: 'gpt-realtime-2.1-mini', write: () => {} })
    const client = notingClient(
      [[{ name: 'submit_turn', callId: '1', arguments: { text: 'write x' } }]],
      results,
      notes,
    )
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['write x', 'exit']),
      client,
      controller: harness.controller,
      attention: harness.bridge,
      telemetry,
      speakFallback: async () => {},
      play: async () => {},
      onStatus: () => {},
    })

    // The identity the model needs, the tool it must reach for, and an explicit denial that
    // its own words count for anything.
    expect(notes[0]).toContain('permission:write-1')
    expect(notes[0]).toContain('Write x.txt')
    expect(notes[0]).toContain('local_control')
    expect(notes[0]).toContain('Your own words authorize nothing')
    // Athena already said the blocker herself, so the model must not say it again.
    expect(notes[0]).toContain('do not repeat the request')
    // Context is not a turn: the only Realtime turn was the utterance the user actually spoke.
    expect(client.ask).toHaveBeenCalledOnce()
    // Shutdown retires it, so the seeded view cannot outlive the thing it described.
    expect(notes.at(-1)).toContain('no longer waiting')
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('deny')

    // Counted by closed label and bounded identity only; the summary rode the wire, not the
    // ledger, and there is no field on the record it could have arrived in.
    await vi.waitFor(() => expect(telemetry.counters()).toMatchObject({
      'realtime.context/permission-pending': 1,
      'realtime.context/permission-shutdown': 1,
    }))
  })

  it('never lets a failed context injection cost the permission or the turn', async () => {
    const harness = permissionHarness()
    const results: unknown[] = []
    const spoken: string[] = []
    const statuses: string[] = []
    const telemetry = new VoiceTelemetry({ model: 'gpt-realtime-2.1-mini', write: () => {} })
    const script: RealtimeToolCall[][] = [
      [{ name: 'submit_turn', callId: '1', arguments: { text: 'write x' } }],
      [control('2', { action: 'allow', request_id: 'permission:write-1' })],
    ]
    let turn = 0
    const client: VoiceRealtimeClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      note: vi.fn(async () => {
        throw new Error('socket is not open')
      }),
      ask: vi.fn(async (_text, handler): Promise<RealtimeTurnResult> => {
        for (const call of script[turn++] ?? []) results.push(await handler(call))
        return { transcript: 'ok', audio: Buffer.alloc(0), usage: [] }
      }),
      askAudio: vi.fn(async () => ({ transcript: '', audio: Buffer.alloc(0), usage: [] })),
    }
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['write x', 'athena allow', 'exit']),
      client,
      controller: harness.controller,
      attention: harness.bridge,
      telemetry,
      speakFallback: async (text) => {
        spoken.push(text)
      },
      play: async () => {},
      onStatus: (message) => statuses.push(message),
    })

    // The blocker was still spoken from its canonical record, unchanged...
    expect(spoken.join('\n')).toContain('Permission needed: Write on x.txt.')
    // ...and still answerable through exactly the same validated path.
    expect(results[1]).toMatchObject({ status: 'allowed-once' })
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('allow-once')
    // Degraded loudly rather than silently: the user is told the request still stands.
    expect(statuses.join('\n')).toContain('did not take that permission context')
    expect(statuses.join('\n')).toContain('still stands')
    await vi.waitFor(() =>
      expect(telemetry.counters()['realtime.context/not-delivered']).toBeGreaterThanOrEqual(1))
  })

  it('still refuses a same-turn answer once the model has been told, and still takes the next one', async () => {
    const harness = permissionHarness()
    const results: unknown[] = []
    const notes: string[] = []
    const client = notingClient(
      [
        // Both on turn 1: the permission is raised inside submit_turn, so the answer that
        // follows it here cannot have been heard by the user.
        [
          { name: 'submit_turn', callId: '1', arguments: { text: 'write x' } },
          control('2', { action: 'allow', request_id: 'permission:write-1' }),
        ],
        [control('3', { action: 'allow', request_id: 'permission:write-1' })],
      ],
      results,
      notes,
    )
    await runVoiceSession({
      apiKey: 'test',
      model: 'gpt-realtime-2.1-mini',
      input: new ScriptedInput(['write x', 'athena allow', 'exit']),
      client,
      controller: harness.controller,
      attention: harness.bridge,
      speakFallback: async () => {},
      play: async () => {},
      onStatus: () => {},
    })

    // Direction one: seeding context did not make a same-turn answer start landing.
    expect(results[1]).toMatchObject({ reason: 'same-turn' })
    // Direction two: nor did it inflate the turn counter, so the legitimate later answer
    // still resolves the real request rather than being refused as same-turn in its turn.
    expect(results[2]).toMatchObject({
      status: 'allowed-once',
      permission_id: 'permission:write-1',
    })
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('allow-once')

    // Exactly one Realtime turn per spoken utterance; a note never became one.
    expect(client.ask).toHaveBeenCalledTimes(2)
    expect(notes).toHaveLength(3)
    expect(notes[1]).toContain('refused (same-turn)')
    expect(notes[1]).toContain('nothing was authorized')
    expect(notes[2]).toContain('allowed once')
  })

  it('speaks the canonical request and lets an allow with its exact identity through', async () => {
    const harness = permissionHarness()
    const { results, spoken } = await drive(
      harness,
      ['write x', 'athena allow', 'exit'],
      [
        { name: 'submit_turn', callId: '1', arguments: { text: 'write x' } },
        control('2', { action: 'allow', request_id: 'permission:write-1' }),
      ],
    )
    expect(results[0]).toMatchObject({ status: 'started' })
    expect(results[1]).toMatchObject({
      status: 'allowed-once',
      permission_id: 'permission:write-1',
    })
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('allow-once')
    // Spoken from the semantic plane, not paraphrased by the model.
    expect(spoken.join('\n')).toContain('Permission needed: Write on x.txt.')
    expect(spoken.join('\n')).toContain('Say Athena allow')
  })

  it('changes nothing when a stale identity is answered a second time', async () => {
    const harness = permissionHarness()
    const { results } = await drive(
      harness,
      ['write x', 'athena allow', 'athena allow again', 'exit'],
      [
        { name: 'submit_turn', callId: '1', arguments: { text: 'write x' } },
        control('2', { action: 'allow', request_id: 'permission:write-1' }),
        control('3', { action: 'deny', request_id: 'permission:write-1' }),
      ],
    )
    expect(results[1]).toMatchObject({ status: 'allowed-once' })
    expect(results[2]).toMatchObject({ reason: 'stale' })
    // The harness saw exactly one answer, and it was the first one.
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('allow-once')
  })

  it('asks for clarification instead of guessing when several requests are waiting', async () => {
    const harness = permissionHarness({ raiseOnSubmit: 2 })
    const { results } = await drive(
      harness,
      ['write both', 'athena allow', 'exit'],
      [
        { name: 'submit_turn', callId: '1', arguments: { text: 'write both' } },
        control('2', { action: 'allow' }),
      ],
    )
    const refusal = results[1] as { reason: string; error: string; pending_ids: string[] }
    expect(refusal.reason).toBe('ambiguous')
    expect(refusal.error).toContain('which one')
    expect(refusal.pending_ids).toHaveLength(2)
    // Neither request was authorized; shutdown denies both.
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('deny')
    await expect(harness.answerFor('permission:write-2')).resolves.toBe('deny')
  })

  it('authorizes nothing when a conversational yes arrives with no request pending', async () => {
    const harness = permissionHarness()
    const { results } = await drive(
      harness,
      ['yes go ahead', 'exit'],
      [control('1', { action: 'allow' })],
    )
    expect(results[0]).toMatchObject({ reason: 'none-pending' })
    expect(harness.controller.submitTurn).not.toHaveBeenCalled()
  })

  it('refuses an identity it never issued and names what is actually waiting', async () => {
    const harness = permissionHarness()
    const { results } = await drive(
      harness,
      ['write x', 'athena allow', 'exit'],
      [
        { name: 'submit_turn', callId: '1', arguments: { text: 'write x' } },
        control('2', { action: 'allow', request_id: 'permission:invented' }),
      ],
    )
    expect(results[1]).toMatchObject({
      reason: 'unknown',
      pending_ids: ['permission:write-1'],
    })
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('deny')
  })

  it('reports waiting-permission from the semantic plane while a decision is outstanding', async () => {
    const harness = permissionHarness({ snapshotPhase: 'acting' })
    const { results } = await drive(
      harness,
      ['write x', 'athena status', 'exit'],
      [
        { name: 'submit_turn', callId: '1', arguments: { text: 'write x' } },
        control('2', { action: 'status' }),
      ],
    )
    expect(results[1]).toMatchObject({
      status: 'waiting-permission',
      summary: 'Write the file.',
      awaiting_permission: [{ id: 'permission:write-1', summary: 'Write x.txt' }],
    })
  })

  it('repeats the last thing actually spoken, not the objective', async () => {
    const harness = permissionHarness({ snapshotPhase: 'acting' })
    harness.bridge.announce({
      schemaVersion: 1,
      id: 'announcement:1',
      runId: 'run-1',
      priority: 'assertive',
      category: 'error',
      text: 'Attention: Athena encountered a recoverable error.',
      dedupeKey: 'run-1:error:1',
      requiresAcknowledgement: false,
      provenance: [],
      createdAt: '2026-08-13T00:00:00.000Z',
    })
    const { results, spoken } = await drive(
      harness,
      ['athena repeat', 'exit'],
      [control('1', { action: 'repeat' })],
    )
    expect(spoken).toContain('Attention: Athena encountered a recoverable error.')
    expect(results[0]).toMatchObject({
      summary: 'Attention: Athena encountered a recoverable error.',
    })
  })

  it('answers a typed allow on the same controller path without consulting the model', async () => {
    const harness = permissionHarness()
    const { results, spoken, client } = await drive(
      harness,
      ['write x', 'allow', 'exit'],
      [{ name: 'submit_turn', callId: '1', arguments: { text: 'write x' } }],
    )
    expect(results).toHaveLength(1)
    // Keyboard parity: the second command never reached Realtime at all.
    expect(client.ask).toHaveBeenCalledOnce()
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('allow-once')
    expect(spoken).toContain('Permission allowed once.')
  })

  it('stops treating a bare typed answer as a decision once nothing is pending', async () => {
    const harness = permissionHarness()
    harness.raise()
    const { spoken, client } = await drive(harness, ['deny', 'deny', 'exit'], [])
    expect(spoken).toContain('Permission denied.')
    await expect(harness.answerFor('permission:write-1')).resolves.toBe('deny')
    // With an empty queue the same word is far more likely an ordinary request, so it
    // goes to the model — which cannot authorize anything either way.
    expect(client.ask).toHaveBeenCalledOnce()
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

describe('athena voice probe wake stage', () => {
  it('drives the production persistent listener and returns its captured microphone audio', async () => {
    const processes: FakeWakeProcess[] = []
    const probe = waitForWakeProbe({
      onRetry: async () => {},
      attemptTimeoutMs: 5_000,
      listener: { spawn: fakeSpawner(processes), sleep: async () => {}, closeGraceMs: 1 },
    })
    await vi.waitFor(() => expect(processes).toHaveLength(1))
    const listener = processes[0]!
    listener.emitStdout(readyLine())
    listener.emitStdout(phraseLine('Athena voice probe', 0.95) + '\n')
    const result = await probe
    expect(result).toMatchObject({
      passed: true,
      command: 'voice probe',
      heard: ['Athena voice probe'],
      detail: 'persistent wake listener, recognizer: Athena Test Recognizer',
    })
    // Real audio off the production path, not a stub: four 16 kHz frames resampled to 24 kHz.
    expect(result.audio?.length).toBe(12)
    // The probe reports only after the microphone is handed back.
    expect(listener.written).toContain('exit\n')
    expect(listener.ended).toBe(true)
    await vi.waitFor(() => expect(listener.killed).toBe(true))
  })

  it('still passes when the user pauses after the wake word instead of failing instantly', async () => {
    const processes: FakeWakeProcess[] = []
    let clock = 1_000
    const probe = waitForWakeProbe({
      onRetry: async () => {},
      attemptTimeoutMs: 5_000,
      listener: { spawn: fakeSpawner(processes), sleep: async () => {}, now: () => clock },
    })
    await vi.waitFor(() => expect(processes).toHaveLength(1))
    const listener = processes[0]!
    listener.emitStdout(readyLine())
    listener.emitStdout(phraseLine('Athena', 0.96) + '\n')
    clock = 3_000
    listener.emitStdout(phraseLine('voice probe', 0.94) + '\n')
    await expect(probe).resolves.toMatchObject({
      passed: true,
      command: 'voice probe',
      heard: ['Athena', 'voice probe'],
    })
  })

  it('bounds a listener that never proves readiness and names why, without hanging', async () => {
    const processes: FakeWakeProcess[] = []
    const retry = vi.fn(async () => {})
    const result = await waitForWakeProbe({
      onRetry: retry,
      maxAttempts: 3,
      attemptTimeoutMs: 5,
      listener: { spawn: fakeSpawner(processes), sleep: async () => {}, closeGraceMs: 1 },
    })
    expect(result).toMatchObject({
      passed: false,
      command: null,
      audio: null,
      detail: 'the listener never proved microphone readiness',
    })
    expect(processes).toHaveLength(3)
    expect(retry).toHaveBeenCalledTimes(2)
    // No orphan listener from any attempt, including the ones that failed.
    for (const listener of processes) {
      expect(listener.written).toContain('exit\n')
      expect(listener.ended).toBe(true)
    }
    await vi.waitFor(() => expect(processes.every((listener) => listener.killed)).toBe(true))
  })

  it('reports a ready listener that heard nothing differently from one that never came up', async () => {
    const processes: FakeWakeProcess[] = []
    const result = await waitForWakeProbe({
      onRetry: async () => {},
      maxAttempts: 1,
      attemptTimeoutMs: 20,
      listener: {
        spawn: () => {
          const listener = new FakeWakeProcess()
          processes.push(listener)
          queueMicrotask(() => listener.emitStdout(readyLine('Microsoft Speech Recognizer')))
          return listener
        },
        sleep: async () => {},
        closeGraceMs: 1,
      },
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toBe(
      'listener ready (Microsoft Speech Recognizer), but no Athena wake phrase arrived',
    )
  })

  it('surfaces an exhausted restart budget instead of coaxing a listener that cannot stay up', async () => {
    const processes: FakeWakeProcess[] = []
    const retry = vi.fn(async () => {})
    const result = await waitForWakeProbe({
      onRetry: retry,
      maxAttempts: 3,
      attemptTimeoutMs: 5_000,
      listener: {
        spawn: () => {
          const listener = new FakeWakeProcess()
          processes.push(listener)
          queueMicrotask(() => listener.emitExit(1))
          return listener
        },
        maxRestarts: 1,
        restartDelayMs: 0,
        sleep: async () => {},
      },
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toMatch(/stopped repeatedly.*athena voice probe/)
    // The listener already burned its own restart budget; a spoken retry cue cannot help.
    expect(retry).not.toHaveBeenCalled()
    expect(processes).toHaveLength(2)
  })

  it.runIf(process.platform === 'win32')(
    'proves the whole production wake chain through the real listener subprocess',
    async (ctx) => {
      const backend = await probeWindowsSpeech()
      if (!backend.available) ctx.skip()
      // Synthesize the wake phrase locally: the WAV sentinel drives the exact production
      // script, so the probe's own chain is proven end to end without a microphone.
      const directory = await mkdtemp(join(tmpdir(), 'athena-probe-test-'))
      const waveFile = join(directory, 'wake.wav')
      const children: ChildProcess[] = []
      try {
        await runPowerShell(String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SetOutputToWaveFile($args[0])
  $synth.Speak('Athena status')
} finally { $synth.Dispose() }
`, [waveFile], 30_000)

        const result = await waitForWakeProbe({
          onRetry: async () => {},
          maxAttempts: 1,
          attemptTimeoutMs: 45_000,
          listener: {
            spawn: () => {
              const child = spawnWindowsWakeListener(waveFile)
              children.push(child)
              return child
            },
          },
        })
        expect(result.passed, `probe reported: ${result.detail ?? 'nothing'}`).toBe(true)
        expect(result.heard.join(' | ')).toMatch(/athena|status/i)
        expect(result.command).toBeTruthy()
        expect(result.audio?.length ?? 0).toBeGreaterThan(0)
        expect(result.detail).toContain('persistent wake listener')
        expect(children).toHaveLength(1)
        // No orphan PowerShell: the probe's close() drove the real child to exit.
        await Promise.all(children.map((child) => new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }
          const timer = setTimeout(() => {
            child.kill()
            resolve()
          }, 15_000)
          timer.unref?.()
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })))
        expect(children[0]!.exitCode === 0 || children[0]!.signalCode !== null).toBe(true)
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
          .catch((error) => console.error(`test cleanup: ${(error as Error).message}`))
      }
    },
    120_000,
  )
})
