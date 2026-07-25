import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineEventBus } from '../../src/engine/events.js'
import { RunTraceWriter, readRunTrace, verifyRunTrace } from '../../src/harness/traces.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-trace-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('RunTraceWriter', () => {
  it('records a complete, ordered, hash-chained run', async () => {
    const bus = new EngineEventBus()
    const writer = await RunTraceWriter.create(root, {
      cwd: root,
      provider: 'anthropic',
      model: 'sonnet',
      mode: 'normal',
      sandbox: 'workspace-write',
    })
    writer.attach(bus)
    writer.recordPrompt('do work')
    bus.emit({ type: 'assistant-text', delta: 'done' })
    await writer.close({
      status: 'completed',
      reason: 'completed',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        modelCalls: 1,
        toolCalls: 0,
        turns: 1,
        durationMs: 1,
      },
    })
    const events = await readRunTrace(writer.file)
    expect(events.map((event) => event.type)).toEqual([
      'run-start',
      'user-prompt',
      'engine-event',
      'run-finish',
    ])
    expect(await verifyRunTrace(writer.file)).toEqual({ valid: true, events: 4 })
  })

  it('detects trace tampering', async () => {
    const writer = await RunTraceWriter.create(root, {
      cwd: root,
      provider: 'anthropic',
      model: 'sonnet',
      mode: 'normal',
      sandbox: 'workspace-write',
    })
    await writer.close({
      status: 'completed',
      reason: 'completed',
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
    })
    const original = await readRunTrace(writer.file)
    original[0]!.payload = { cwd: 'tampered' }
    writeFileSync(writer.file, original.map((event) => JSON.stringify(event)).join('\n') + '\n')
    expect(await verifyRunTrace(writer.file)).toMatchObject({ valid: false })
  })

  it('redacts common secret shapes before writing immutable evidence', async () => {
    const writer = await RunTraceWriter.create(root, {
      cwd: root,
      provider: 'anthropic',
      model: 'sonnet',
      mode: 'normal',
      sandbox: 'workspace-write',
    })
    writer.recordPrompt('use sk-ant-api03-supersecretvalue1234')
    await writer.close({
      status: 'completed',
      reason: 'completed',
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
    })
    const serialized = JSON.stringify(await readRunTrace(writer.file))
    expect(serialized).not.toContain('supersecretvalue1234')
    expect(serialized).toContain('[REDACTED]')
    expect(await verifyRunTrace(writer.file)).toMatchObject({ valid: true })
  })
})
