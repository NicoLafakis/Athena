import { describe, expect, it } from 'vitest'
import type { RunResult } from '../../src/engine/types.js'
import { createInteractionSnapshot } from '../../src/interaction/state.js'
import type { Announcement } from '../../src/interaction/types.js'
import { ScreenReaderPresentation } from '../../src/presentation/screen-reader.js'
import { LineInputCancelledError, type LineInput } from '../../src/presentation/line-input.js'

class ControlledInput implements LineInput {
  readonly prompts: string[] = []
  private readonly pending: Array<(value: string) => void> = []

  readLine(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    return new Promise((resolve) => this.pending.push(resolve))
  }

  answer(value: string): void {
    this.pending.shift()?.(value)
  }

  close(): void {}
}

class CancellableInput extends ControlledInput {
  private rejectPending: ((error: Error) => void) | null = null

  override readLine(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    return new Promise((_resolve, reject) => {
      this.rejectPending = reject
    })
  }

  cancelRead(): boolean {
    const reject = this.rejectPending
    if (!reject) return false
    this.rejectPending = null
    reject(new LineInputCancelledError())
    return true
  }
}

function result(status: RunResult['status']): RunResult {
  return {
    status,
    reason: status,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      modelCalls: 0,
      toolCalls: 0,
      turns: 0,
      durationMs: 0,
    },
  }
}

function announcement(text: string): Announcement {
  return {
    schemaVersion: 1,
    id: 'announcement-1',
    runId: 'run-1',
    priority: 'assertive',
    category: 'error',
    text,
    dedupeKey: 'dedupe-1',
    requiresAcknowledgement: false,
    provenance: [{ source: 'runtime', runId: 'run-1', sequence: 1, sourceEventType: 'attention-added' }],
    createdAt: '2026-07-29T12:00:00.000Z',
  }
}

describe('ScreenReaderPresentation', () => {
  it('emits append-only plain lines with no terminal-control output', async () => {
    const chunks: string[] = []
    const input = new ControlledInput()
    const presentation = new ScreenReaderPresentation({ input, write: (chunk) => chunks.push(chunk) })
    await presentation.start(createInteractionSnapshot('run-1', '2026-07-29T12:00:00.000Z'))
    presentation.announce(announcement('Attention: \u001b[31mBuild failed.\u001b[0m'))
    presentation.acknowledgeCancellation(true)
    await presentation.close(result('completed'))
    await presentation.close(result('error'))

    const bytes = chunks.join('')
    expect(bytes).toBe(
      'Status: Athena screen-reader mode is ready.\n' +
      'Attention: Build failed.\n' +
      'Status: Cancellation accepted.\n' +
      'Completed: Work completed.\n',
    )
    expect(bytes).not.toMatch(/\u001b\[|\u001b\]|\u009b/)
    expect(chunks.every((chunk) => chunk.endsWith('\n'))).toBe(true)
  })

  it('queues announcements while input is active and flushes them before the next prompt', async () => {
    const chunks: string[] = []
    const input = new ControlledInput()
    const presentation = new ScreenReaderPresentation({ input, write: (chunk) => chunks.push(chunk) })
    const first = presentation.prompt({ id: 'prompt-1', label: 'You' })
    await Promise.resolve()
    presentation.announce(announcement('Attention: Background task failed.'))
    expect(chunks).toEqual([])
    input.answer('continue')
    await expect(first).resolves.toBe('continue')
    expect(chunks).toEqual(['Attention: Background task failed.\n'])

    const second = presentation.prompt({ id: 'prompt-2', label: 'You' })
    await Promise.resolve()
    expect(input.prompts).toEqual(['You: ', 'You: '])
    input.answer('done')
    await expect(second).resolves.toBe('done')
  })

  it('serializes concurrent permission requests and rejects invalid choices explicitly', async () => {
    const chunks: string[] = []
    const input = new ControlledInput()
    const presentation = new ScreenReaderPresentation({ input, write: (chunk) => chunks.push(chunk) })
    const request = {
      id: 'permission-1',
      toolName: 'Write',
      target: 'src/a.ts',
      consequence: 'Replace or create file content.',
      reason: 'Mutation requires approval.',
      summary: 'Write src/a.ts',
      detailsCommand: '/details permission permission-1',
    }
    const first = presentation.requestPermission(request)
    const second = presentation.requestPermission({ ...request, id: 'permission-2' })
    await Promise.resolve()
    expect(input.prompts).toHaveLength(1)
    input.answer('maybe')
    await Promise.resolve()
    expect(chunks.join('')).toContain('Permission: Enter y, a, or n.')
    input.answer('n')
    await expect(first).resolves.toBe('deny')
    await Promise.resolve()
    expect(input.prompts).toHaveLength(3)
    input.answer('y')
    await expect(second).resolves.toBe('allow-once')
  })

  it('writes assistant output as ordinary append-only text without a status prefix', () => {
    const chunks: string[] = []
    const presentation = new ScreenReaderPresentation({
      input: new ControlledInput(),
      write: (chunk) => chunks.push(chunk),
    })
    presentation.writeAssistantText('First line\nSecond \u001b[31mline\u001b[0m')
    expect(chunks.join('')).toBe('First line\nSecond line\n')
  })

  it('preserves an existing semantic prefix when showing local detail', () => {
    const chunks: string[] = []
    const presentation = new ScreenReaderPresentation({
      input: new ControlledInput(),
      write: (chunk) => chunks.push(chunk),
    })
    presentation.showDetails({ id: 'status', text: 'Status: idle.' })
    presentation.showDetails({ id: 'plain', text: 'No detail available.' })
    expect(chunks.join('')).toBe('Status: idle.\nStatus: No detail available.\n')
  })

  it('cancels a waiting permission fail-closed without leaving a dead prompt', async () => {
    const chunks: string[] = []
    const input = new CancellableInput()
    const presentation = new ScreenReaderPresentation({ input, write: (chunk) => chunks.push(chunk) })
    const pending = presentation.requestPermission({
      id: 'permission-cancel',
      toolName: 'Write',
      target: 'x.txt',
      consequence: 'Replace file content.',
      summary: 'Write x.txt',
      reason: 'Mutation requires approval.',
      detailsCommand: '/details permission permission-cancel',
    })
    await Promise.resolve()
    expect(presentation.cancelPendingInput()).toBe(true)
    await expect(pending).resolves.toBe('deny')
    expect(chunks.join('')).toContain('Permission: Denied because cancellation was requested.')
  })
})
