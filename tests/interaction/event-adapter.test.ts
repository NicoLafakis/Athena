import { describe, expect, it } from 'vitest'
import { EngineEventBus } from '../../src/engine/events.js'
import { InteractionEventAdapter } from '../../src/interaction/event-adapter.js'
import type { InteractionEventEnvelope } from '../../src/interaction/types.js'

describe('InteractionEventAdapter', () => {
  it('maps runtime evidence with stable per-run sequencing and ignores streamed prose', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    adapter.recordUserObjective('Fix the failing gate.', 'prompt:1')
    bus.emit({ type: 'assistant-text', delta: 'I think everything is done.' })
    bus.emit({ type: 'turn-start', turn: 1 })
    bus.emit({ type: 'tool-request', id: 'tool-1', name: 'Read', input: { file_path: 'secret' } })
    bus.emit({ type: 'tool-result', id: 'tool-1', name: 'Read', output: 'raw private output', isError: false })
    bus.emit({
      type: 'turn-done',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      result: {
        status: 'completed',
        reason: 'completed',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          modelCalls: 1,
          toolCalls: 1,
          turns: 1,
          durationMs: 1,
        },
      },
    })

    expect(seen.map((event) => [event.sequence, event.kind])).toEqual([
      [1, 'objective-set'],
      [2, 'phase-changed'],
      [3, 'activity-changed'],
      [4, 'phase-changed'],
      [5, 'activity-changed'],
      [6, 'outcome-recorded'],
      [7, 'phase-changed'],
      [8, 'phase-changed'],
      [9, 'outcome-recorded'],
    ])
    expect(JSON.stringify(seen)).not.toContain('raw private output')
    expect(JSON.stringify(seen)).not.toContain('secret')
    expect(seen.every((event) => event.id === `${event.runId}:${event.sequence}`)).toBe(true)
  })

  it('keeps child run sequencing isolated from the parent', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    bus.emit({ type: 'turn-start', turn: 1 })
    bus.emit({ type: 'child-status', runId: 'child-run', agent: 'reviewer', status: 'running' })
    bus.emit({ type: 'child-status', runId: 'child-run', agent: 'reviewer', status: 'failed' })
    bus.emit({ type: 'tool-request', id: 'tool-1', name: 'Read', input: {} })

    expect(seen.filter((event) => event.runId === 'root-run').map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(seen.filter((event) => event.runId === 'child-run').map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(seen.filter((event) => event.runId === 'child-run').at(-1)).toMatchObject({
      kind: 'attention-added',
      payload: { attention: { category: 'error', priority: 'assertive' } },
    })
  })

  it('can detach without affecting the engine bus', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({ runId: 'root-run', onEnvelope: (event) => seen.push(event) })
    adapter.attach(bus)
    adapter.detach()
    bus.emit({ type: 'turn-start', turn: 1 })
    expect(seen).toEqual([])
  })

  it('turns a permission request into blocking attention and resolves the exact item', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    bus.emit({
      type: 'permission-requested',
      requestId: 'permission:tool-1',
      toolCallId: 'tool-1',
      toolName: 'Write',
      summary: 'Write requires permission.',
      reason: 'workspace write requires approval',
    })
    bus.emit({
      type: 'permission-resolved',
      requestId: 'permission:tool-1',
      toolCallId: 'tool-1',
      toolName: 'Write',
      answer: 'allow-once',
      resolution: 'user',
    })

    expect(seen).toMatchObject([
      { kind: 'phase-changed', payload: { phase: 'waiting-permission' } },
      {
        kind: 'attention-added',
        payload: {
          attention: {
            id: 'permission:tool-1',
            category: 'permission',
            priority: 'blocking',
            summary: 'Write requires permission.',
          },
        },
      },
      { kind: 'attention-resolved', payload: { attentionId: 'permission:tool-1' } },
      { kind: 'phase-changed', payload: { phase: 'acting' } },
    ])
    expect(JSON.stringify(seen)).not.toContain('workspace write requires approval')
  })

  it('bounds user objectives before they reach the validated state plane', () => {
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.recordUserObjective(`line one\nsk-ant-api03-supersecretvalue1234 ${'x'.repeat(5_000)}`)

    const objective = seen[0]
    expect(objective).toMatchObject({ kind: 'objective-set' })
    if (objective?.kind !== 'objective-set') throw new Error('expected objective-set')
    expect(objective.payload.objective.length).toBe(4_096)
    expect(objective.payload.objective).not.toContain('\n')
    expect(objective.payload.objective).not.toContain('supersecretvalue1234')
    expect(objective.payload.objective).toContain('[REDACTED]')
  })
})
