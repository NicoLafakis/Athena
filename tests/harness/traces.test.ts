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

  it('records bounded semantic metadata through the redacted hash chain', async () => {
    const writer = await RunTraceWriter.create(root, {
      cwd: root,
      provider: 'anthropic',
      model: 'sonnet',
      mode: 'normal',
      sandbox: 'workspace-write',
    })
    writer.recordInteraction({
      schemaVersion: 1,
      id: `${writer.runId}:1`,
      runId: writer.runId,
      sequence: 1,
      timestamp: '2026-07-29T12:00:00.000Z',
      source: 'runtime',
      kind: 'attention-added',
      payload: {
        attention: {
          id: 'error:1',
          category: 'error',
          priority: 'assertive',
          summary: 'Provider rejected sk-ant-api03-supersecretvalue1234.',
          action: 'Run athena auth.',
        },
      },
      sourceRef: 'runtime-error',
    })
    await writer.close({
      status: 'error',
      reason: 'provider error',
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

    const events = await readRunTrace(writer.file)
    const semantic = events.find((event) => event.type === 'interaction-event')
    expect(semantic?.payload).toMatchObject({
      reducerVersion: 1,
      kind: 'attention-added',
      sourceSequence: 1,
      payloadDigest: expect.any(String),
    })
    expect(JSON.stringify(semantic)).not.toContain('supersecretvalue1234')
    expect(JSON.stringify(semantic)).not.toContain('Provider rejected')
    expect(await verifyRunTrace(writer.file)).toMatchObject({ valid: true })
  })

  it('records announcement decisions without duplicating announcement text', async () => {
    const writer = await RunTraceWriter.create(root, {
      cwd: root,
      provider: 'anthropic',
      model: 'sonnet',
      mode: 'normal',
      sandbox: 'workspace-write',
    })
    writer.recordAnnouncement({
      schemaVersion: 1,
      id: 'announcement-1',
      runId: writer.runId,
      priority: 'blocking',
      category: 'permission',
      text: 'Permission: secret prose that must not be duplicated.',
      detail: 'A detailed consequence summary.',
      dedupeKey: 'permission:req-1',
      requiresAcknowledgement: true,
      provenance: [{
        source: 'runtime',
        runId: writer.runId,
        sequence: 3,
        sourceEventType: 'attention-added',
        sourceEventId: 'req-1',
      }],
      createdAt: '2026-07-29T12:00:00.000Z',
    }, { coalesced: false, occurrences: 1 })
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

    const record = (await readRunTrace(writer.file)).find((event) => event.type === 'interaction-announcement')
    expect(record?.payload).toMatchObject({
      priority: 'blocking',
      disposition: 'emitted',
      category: 'permission',
      sourceSequences: [3],
      chars: expect.any(Number),
    })
    expect(JSON.stringify(record)).not.toContain('secret prose')
    expect(JSON.stringify(record)).not.toContain('detailed consequence')
    expect(await verifyRunTrace(writer.file)).toMatchObject({ valid: true })
  })
})
