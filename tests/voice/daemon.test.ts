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
  async next(): Promise<string | null> { return this.commands.shift() ?? 'exit' }
  close(): void { this.closed = true }
}

describe('voice conductor composition', () => {
  it('ignores low-confidence or non-wake local recognition before accepting Athena', async () => {
    const phrases = [
      { text: 'Athena wrong', confidence: 0.2 },
      { text: 'ordinary speech', confidence: 0.99 },
      { text: 'Athena status', confidence: 0.95 },
    ]
    const input = new WindowsWakeCommandInput(0.6, async () => phrases.shift() ?? null)
    await expect(input.next()).resolves.toBe('status')
  })

  it('gives the wake probe bounded retries instead of failing on the first bad transcript', async () => {
    const phrases = [
      { text: 'The things that was', confidence: 0.92 },
      { text: 'Athena probe', confidence: 0.2 },
      { text: 'Athena probe', confidence: 0.95 },
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
    })
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('separates a working Athena wake word from an imperfect command transcript', async () => {
    await expect(waitForWakeProbe(
      async () => ({ text: 'Athena status', confidence: 0.92 }),
      async () => {},
    )).resolves.toEqual({ passed: true, heard: ['Athena status'], command: 'status' })
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
})
