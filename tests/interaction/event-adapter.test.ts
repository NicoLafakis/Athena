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

    expect(seen.filter((event) => event.runId === 'root-run').map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
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

  it('keeps routine background success silent but preserves awaited completion and failure', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    bus.emit({ type: 'background-status', taskId: 'bg-1', status: 'running', awaited: false })
    bus.emit({ type: 'background-output', taskId: 'bg-1', delta: 'secret raw output' })
    bus.emit({ type: 'background-status', taskId: 'bg-1', status: 'completed', awaited: false })
    bus.emit({ type: 'background-status', taskId: 'bg-1', status: 'completed', awaited: true })
    bus.emit({ type: 'background-status', taskId: 'bg-2', status: 'failed', awaited: false })

    const lifecycleFacts = seen.filter(
      (event) => event.kind !== 'activity-changed' || event.payload.activity?.target !== 'work-aggregate',
    )
    expect(lifecycleFacts).toMatchObject([
      {
        kind: 'activity-changed',
        payload: { activity: { type: 'background', status: 'active', target: 'bg-1' } },
      },
      {
        kind: 'activity-changed',
        payload: { activity: { type: 'background', status: 'succeeded', target: 'bg-1' } },
      },
      {
        kind: 'activity-changed',
        payload: { activity: { type: 'background', status: 'succeeded', target: 'bg-1' } },
      },
      {
        kind: 'outcome-recorded',
        payload: {
          outcome: {
            status: 'succeeded',
            summary: 'Background task completed.',
            operation: 'background:bg-1:awaited',
            verified: true,
          },
        },
      },
      {
        kind: 'activity-changed',
        payload: { activity: { type: 'background', status: 'failed', target: 'bg-2' } },
      },
      {
        kind: 'attention-added',
        payload: {
          attention: {
            id: 'background:bg-2',
            category: 'error',
            priority: 'assertive',
            summary: 'Background task failed.',
          },
        },
      },
    ])
    expect(JSON.stringify(seen)).not.toContain('secret raw output')
  })

  it('turns the unchanged second tool failure into one advisory attention item', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    for (const id of ['tool-1', 'tool-2', 'tool-3']) {
      bus.emit({ type: 'tool-request', id, name: 'Write', input: { file_path: 'same.txt' } })
      bus.emit({ type: 'tool-result', id, name: 'Write', output: 'raw failure', isError: true })
    }

    const advisories = seen.filter(
      (event) => event.kind === 'attention-added' && event.payload.attention.category === 'advisory',
    )
    expect(advisories).toHaveLength(1)
    expect(advisories[0]).toMatchObject({
      kind: 'attention-added',
      payload: {
        attention: {
          priority: 'assertive',
          summary: 'Write failed twice with unchanged input.',
        },
      },
    })
    expect(JSON.stringify(advisories)).not.toContain('same.txt')
    expect(JSON.stringify(advisories)).not.toContain('raw failure')
  })

  it('advises when a successful gate is invalidated by a later mutation', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    bus.emit({ type: 'tool-request', id: 'gate', name: 'Bash', input: { command: 'pnpm test' } })
    bus.emit({ type: 'tool-result', id: 'gate', name: 'Bash', output: 'passed', isError: false })
    bus.emit({ type: 'tool-request', id: 'edit', name: 'Edit', input: { old_string: 'secret' } })
    bus.emit({ type: 'tool-result', id: 'edit', name: 'Edit', output: 'edited', isError: false })

    const advisory = seen.find(
      (event) => event.kind === 'attention-added'
        && event.payload.attention.id === 'verification-invalidated:gate:edit',
    )
    expect(advisory).toMatchObject({
      kind: 'attention-added',
      payload: {
        attention: {
          category: 'advisory',
          priority: 'assertive',
          summary: 'Test verification is stale after Edit changed the workspace.',
        },
      },
    })
    expect(JSON.stringify(advisory)).not.toContain('secret')
    expect(JSON.stringify(advisory)).not.toContain('passed')
  })

  it('maps budget crossings to one-time advisories without unsolicited exact usage', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)
    const baseUsage = {
      inputTokens: 750,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 7.5,
      modelCalls: 1,
      toolCalls: 1,
      turns: 1,
      durationMs: 10,
    }
    const limits = { maxTokens: 1_000, maxCostUsd: 10 }

    bus.emit({ type: 'budget-status', usage: baseUsage, limits })
    bus.emit({ type: 'budget-status', usage: { ...baseUsage, inputTokens: 800 }, limits })
    bus.emit({ type: 'budget-status', usage: { ...baseUsage, inputTokens: 900 }, limits })

    const advisories = seen.filter(
      (event) => event.kind === 'attention-added'
        && event.payload.attention.id.startsWith('budget:'),
    )
    expect(advisories).toMatchObject([
      { payload: { attention: { id: 'budget:75', priority: 'polite', summary: 'Run budget reached 75%.' } } },
      { payload: { attention: { id: 'budget:90', priority: 'assertive', summary: 'Run budget reached 90%.' } } },
    ])
    expect(JSON.stringify(advisories)).not.toContain('750')
    expect(JSON.stringify(advisories)).not.toContain('900')
    expect(JSON.stringify(advisories)).not.toContain('7.5')
  })

  it('maps bounded agent status assertions without granting runtime authority', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    bus.emit({
      type: 'agent-status-update',
      objective: 'Prepare the release.',
      nextExpected: 'Run verification.',
      sourceRef: 'status-1',
      runId: 'child-run',
    })

    expect(seen).toMatchObject([
      {
        runId: 'child-run',
        source: 'agent',
        sourceRef: 'status-1',
        kind: 'objective-set',
        payload: { objective: 'Prepare the release.' },
      },
      {
        runId: 'child-run',
        source: 'agent',
        sourceRef: 'status-1',
        kind: 'next-expected-set',
        payload: { nextExpected: 'Run verification.' },
      },
    ])
    expect(seen.some((event) => event.kind === 'outcome-recorded')).toBe(false)
  })

  it('maintains a coalesced root aggregate for child and background work', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    bus.emit({ type: 'child-status', runId: 'child-1', agent: 'reviewer', status: 'running' })
    bus.emit({ type: 'background-status', taskId: 'bg-1', status: 'running', awaited: false })
    bus.emit({ type: 'child-status', runId: 'child-1', agent: 'reviewer', status: 'completed' })

    const aggregate = seen.filter(
      (event) => event.runId === 'root-run'
        && event.kind === 'activity-changed'
        && event.payload.activity?.target === 'work-aggregate',
    )
    expect(aggregate).toMatchObject([
      { payload: { activity: { label: '1 active task: 1 child, 0 background', status: 'active' } } },
      { payload: { activity: { label: '2 active tasks: 1 child, 1 background', status: 'active' } } },
      { payload: { activity: { label: '1 active task: 0 children, 1 background', status: 'active' } } },
    ])
  })

  it('isolates repeated-failure advice inside the child run that produced it', () => {
    const bus = new EngineEventBus()
    const seen: InteractionEventEnvelope[] = []
    const adapter = new InteractionEventAdapter({
      runId: 'root-run',
      now: () => '2026-07-29T12:00:00.000Z',
      onEnvelope: (event) => seen.push(event),
    })
    adapter.attach(bus)

    for (const id of ['one', 'two']) {
      bus.emit({
        type: 'child-tool-request',
        runId: 'child-run',
        agent: 'reviewer',
        id,
        name: 'Read',
        input: { file_path: 'private.txt' },
      })
      bus.emit({
        type: 'child-tool-result',
        runId: 'child-run',
        agent: 'reviewer',
        id,
        name: 'Read',
        output: 'private failure output',
        isError: true,
      })
    }

    const advisory = seen.find(
      (event) => event.kind === 'attention-added'
        && event.payload.attention.category === 'advisory',
    )
    expect(advisory).toMatchObject({
      runId: 'child-run',
      payload: { attention: { summary: 'Read failed twice with unchanged input.' } },
    })
    expect(JSON.stringify(advisory)).not.toContain('private.txt')
    expect(JSON.stringify(advisory)).not.toContain('private failure output')
    expect(seen.some((event) => event.runId === 'root-run' && event.kind === 'attention-added')).toBe(false)
  })
})
