import { describe, expect, it, vi } from 'vitest'
import type {
  RealtimeToolCall,
  RealtimeTurnResult,
} from '../../src/voice/realtime.js'
import {
  WindowsWakeCommandInput,
  athenaDelegateArgs,
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
})
