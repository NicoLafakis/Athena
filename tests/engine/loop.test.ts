import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { EngineEventBus } from '../../src/engine/events.js'
import { ContextManager } from '../../src/engine/context.js'
import { Engine, zodToJsonSchema, type EngineOptions } from '../../src/engine/loop.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { HookRunner } from '../../src/harness/hooks.js'
import type { EngineEvent, PermissionGate, ToolDefinition } from '../../src/engine/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import {
  MockAnthropicClient,
  textBlock,
  toolUseBlock,
  type ScriptedResponse,
} from '../helpers/mock-client.js'

function allowAllGate(): PermissionGate {
  return {
    check: () => ({ decision: 'allow', reason: 'test gate allows all' }),
    grantSession: () => {},
  }
}

const EchoInput = z.object({ value: z.string() })

function makeEchoTool(
  onExecute?: (value: string) => void | Promise<void>,
): ToolDefinition<z.infer<typeof EchoInput>> {
  return {
    name: 'Echo',
    description: 'Echoes its input back.',
    schema: EchoInput,
    readOnly: false,
    async execute(input) {
      await onExecute?.(input.value)
      return { output: `echo: ${input.value}`, isError: false }
    },
  }
}

function makeEngine(
  script: ScriptedResponse[],
  overrides: Partial<EngineOptions> = {},
  echoTool: ToolDefinition<z.infer<typeof EchoInput>> = makeEchoTool(),
) {
  const bus = new EngineEventBus()
  const events: EngineEvent[] = []
  bus.on((e) => events.push(e))
  const registry = new ToolRegistry()
  registry.register(echoTool as ToolDefinition<never>)
  const client = new MockAnthropicClient(script)
  const engine = new Engine({
    client,
    bus,
    registry,
    model: 'mock',
    systemPrompt: 'sys',
    maxTokens: 4096,
    gate: allowAllGate(),
    hooks: new HookRunner([]),
    contextManager: new ContextManager({ modelWindowTokens: 1_000_000 }),
    toolContext: makeCtx(process.cwd(), { emit: (e) => bus.emit(e) }),
    ...overrides,
  })
  return { engine, events, client }
}

describe('Engine.runTurn', () => {
  it('text-only turn: streams deltas, appends assistant message, emits turn-done', async () => {
    const { engine, events } = makeEngine([{ blocks: [textBlock('Hello!')], stopReason: 'end_turn' }])
    await engine.runTurn('hi')
    expect(events).toContainEqual({ type: 'assistant-text', delta: 'Hello!' })
    expect(events.at(-1)).toMatchObject({ type: 'turn-done' })
    expect(engine.getMessages()).toHaveLength(2) // user + assistant
  })

  it('tool round-trip: executes tool, feeds tool_result back, second call sees it', async () => {
    const { engine, events, client } = makeEngine([
      { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'ping' })], stopReason: 'tool_use' },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ])
    await engine.runTurn('use the tool')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-request', id: 'tu_1', name: 'Echo' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', id: 'tu_1', isError: false }),
    )
    const secondCall = client.calls[1]!
    const toolResultMsg = secondCall.at(-1)!
    expect(toolResultMsg.role).toBe('user')
    expect(JSON.stringify(toolResultMsg.content)).toContain('tu_1')
    expect(JSON.stringify(toolResultMsg.content)).toContain('echo: ping')
  })

  it('permission deny feeds an error tool_result to the model, loop continues', async () => {
    const denyGate: PermissionGate = {
      check: () => ({ decision: 'deny', reason: 'blocked by test' }),
      grantSession: () => {},
    }
    const { engine, events, client } = makeEngine(
      [
        { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'x' })], stopReason: 'tool_use' },
        { blocks: [textBlock('understood')], stopReason: 'end_turn' },
      ],
      { gate: denyGate },
    )
    await engine.runTurn('go')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', id: 'tu_1', isError: true }),
    )
    expect(JSON.stringify(client.calls[1])).toContain('blocked by test')
  })

  it('permission ask with no askUser wired defaults to deny', async () => {
    const askGate: PermissionGate = {
      check: () => ({ decision: 'ask', reason: 'needs approval' }),
      grantSession: () => {},
    }
    const { engine, events } = makeEngine(
      [
        { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'x' })], stopReason: 'tool_use' },
        { blocks: [textBlock('ok')], stopReason: 'end_turn' },
      ],
      { gate: askGate },
    )
    await engine.runTurn('go')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', id: 'tu_1', isError: true }),
    )
    const result = events.find((e) => e.type === 'tool-result') as { output: string }
    expect(result.output).toContain('denied (headless')
    expect(result.output).not.toContain('needs approval') // not the ask reason
  })

  it('ask denied by a wired askUser says "denied by user"', async () => {
    const askGate: PermissionGate = {
      check: () => ({ decision: 'ask', reason: 'needs approval' }),
      grantSession: () => {},
    }
    const { engine, events } = makeEngine(
      [
        { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'x' })], stopReason: 'tool_use' },
        { blocks: [textBlock('ok')], stopReason: 'end_turn' },
      ],
      { gate: askGate, askUser: async () => 'deny' },
    )
    await engine.runTurn('go')
    const result = events.find((e) => e.type === 'tool-result') as { output: string }
    expect(result.output).toContain('denied by user')
  })

  it('parallel tool_use blocks execute sequentially in block order', async () => {
    const order: string[] = []
    const echo = makeEchoTool((v) => {
      order.push(v)
    })
    const { engine, client } = makeEngine(
      [
        {
          blocks: [
            toolUseBlock('tu_1', 'Echo', { value: 'first' }),
            toolUseBlock('tu_2', 'Echo', { value: 'second' }),
          ],
          stopReason: 'tool_use',
        },
        { blocks: [textBlock('done')], stopReason: 'end_turn' },
      ],
      {},
      echo,
    )
    await engine.runTurn('go')
    expect(order).toEqual(['first', 'second'])
    const resultMsg = client.calls[1]!.at(-1)!
    const content = resultMsg.content as { tool_use_id: string }[]
    expect(content.map((b) => b.tool_use_id)).toEqual(['tu_1', 'tu_2'])
  })

  it('a batch of only Agent tool_use blocks dispatches concurrently', async () => {
    const order: string[] = []
    let started = 0
    let releaseAll!: () => void
    const allStarted = new Promise<void>((r) => (releaseAll = r))
    const agentStub: ToolDefinition<z.infer<typeof EchoInput>> = {
      name: 'Agent',
      description: 'stub agent tool',
      schema: EchoInput,
      readOnly: false,
      async execute(input) {
        order.push(`start:${input.value}`)
        started += 1
        if (started === 2) releaseAll()
        // Deadlocks (test timeout) unless both blocks start before either finishes.
        await allStarted
        order.push(`end:${input.value}`)
        return { output: `agent: ${input.value}`, isError: false }
      },
    }
    const { engine, client } = makeEngine(
      [
        {
          blocks: [
            toolUseBlock('tu_1', 'Agent', { value: 'a' }),
            toolUseBlock('tu_2', 'Agent', { value: 'b' }),
          ],
          stopReason: 'tool_use',
        },
        { blocks: [textBlock('done')], stopReason: 'end_turn' },
      ],
      {},
      agentStub,
    )
    await engine.runTurn('go')
    expect(order.slice(0, 2)).toEqual(['start:a', 'start:b'])
    // Result order matches block order regardless of completion order.
    const resultMsg = client.calls[1]!.at(-1)!
    const content = resultMsg.content as { tool_use_id: string; content: string }[]
    expect(content.map((b) => b.tool_use_id)).toEqual(['tu_1', 'tu_2'])
    expect(content.map((b) => b.content)).toEqual(['agent: a', 'agent: b'])
  })

  it('a mixed Agent + non-Agent batch stays sequential', async () => {
    const order: string[] = []
    const makeSlowTool = (name: string): ToolDefinition<z.infer<typeof EchoInput>> => ({
      name,
      description: `stub ${name}`,
      schema: EchoInput,
      readOnly: false,
      async execute(input) {
        order.push(`start:${input.value}`)
        await new Promise((r) => setTimeout(r, 0))
        order.push(`end:${input.value}`)
        return { output: `${name}: ${input.value}`, isError: false }
      },
    })
    const bus = new EngineEventBus()
    const registry = new ToolRegistry()
    registry.register(makeSlowTool('Agent') as ToolDefinition<never>)
    registry.register(makeSlowTool('Echo') as ToolDefinition<never>)
    const client = new MockAnthropicClient([
      {
        blocks: [
          toolUseBlock('tu_1', 'Agent', { value: 'a' }),
          toolUseBlock('tu_2', 'Echo', { value: 'e' }),
        ],
        stopReason: 'tool_use',
      },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ])
    const engine = new Engine({
      client,
      bus,
      registry,
      model: 'mock',
      systemPrompt: 'sys',
      maxTokens: 4096,
      gate: allowAllGate(),
      hooks: new HookRunner([]),
      contextManager: new ContextManager({ modelWindowTokens: 1_000_000 }),
      toolContext: makeCtx(process.cwd(), { emit: (e) => bus.emit(e) }),
    })
    await engine.runTurn('go')
    expect(order).toEqual(['start:a', 'end:a', 'start:e', 'end:e'])
  })

  it('abort mid-turn stops before the next model call and emits a non-fatal error event', async () => {
    const controller = new AbortController()
    const echo = makeEchoTool(() => {
      controller.abort()
    })
    const { engine, events, client } = makeEngine(
      [
        { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'abort-me' })], stopReason: 'tool_use' },
        { blocks: [textBlock('never')], stopReason: 'end_turn' },
      ],
      { abortController: controller },
      echo,
    )
    await engine.runTurn('go')
    expect(client.calls).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', fatal: false }))
    expect(events.at(-1)).toMatchObject({ type: 'turn-done' })
  })

  it('abort mid-batch synthesizes aborted tool_results so every tool_use stays paired', async () => {
    const controller = new AbortController()
    const echo = makeEchoTool(() => {
      controller.abort() // fires during the FIRST block; second must not execute
    })
    const { engine, events, client } = makeEngine(
      [
        {
          blocks: [
            toolUseBlock('tu_1', 'Echo', { value: 'first' }),
            toolUseBlock('tu_2', 'Echo', { value: 'second' }),
          ],
          stopReason: 'tool_use',
        },
        { blocks: [textBlock('never')], stopReason: 'end_turn' },
      ],
      { abortController: controller },
      echo,
    )
    await engine.runTurn('go')
    expect(client.calls).toHaveLength(1)
    // tu_2 never executed but still has a (synthesized, error) tool_result.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', id: 'tu_2', isError: true }),
    )
    const resultMsg = engine.getMessages().at(-1)!
    const ids = (resultMsg.content as { tool_use_id: string }[]).map((b) => b.tool_use_id)
    expect(ids).toEqual(['tu_1', 'tu_2'])
  })

  it('unknown tool produces an error tool_result, not a crash', async () => {
    const { engine, events } = makeEngine([
      { blocks: [toolUseBlock('tu_1', 'Nope', { value: 'x' })], stopReason: 'tool_use' },
      { blocks: [textBlock('ok')], stopReason: 'end_turn' },
    ])
    await engine.runTurn('go')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', id: 'tu_1', isError: true }),
    )
  })

  it('invalid tool input produces an error tool_result', async () => {
    const { engine, events } = makeEngine([
      { blocks: [toolUseBlock('tu_1', 'Echo', { wrong: 1 })], stopReason: 'tool_use' },
      { blocks: [textBlock('ok')], stopReason: 'end_turn' },
    ])
    await engine.runTurn('go')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', id: 'tu_1', isError: true }),
    )
  })

  it('tool that throws becomes an error tool_result and the loop continues', async () => {
    const echo = makeEchoTool(() => {
      throw new Error('kaboom')
    })
    const { engine, client } = makeEngine(
      [
        { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'x' })], stopReason: 'tool_use' },
        { blocks: [textBlock('ok')], stopReason: 'end_turn' },
      ],
      {},
      echo,
    )
    await engine.runTurn('go')
    expect(JSON.stringify(client.calls[1])).toContain('kaboom')
  })

  it('compacts mid-turn when the context manager says so and emits a compaction event', async () => {
    // Window of 1000, threshold 0.8: 900 input tokens on the first response trips compaction.
    const { engine, events, client } = makeEngine(
      [
        {
          blocks: [toolUseBlock('tu_1', 'Echo', { value: 'ping' })],
          stopReason: 'tool_use',
          inputTokens: 900,
        },
        { blocks: [textBlock('done')], stopReason: 'end_turn', inputTokens: 10 },
      ],
      { contextManager: new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 2 }) },
    )
    await engine.runTurn('go')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'compaction', summary: 'mock summary' }),
    )
    // The second model call starts with the summary message.
    const secondCall = client.calls[1]!
    expect(String(secondCall[0]!.content)).toContain('Context compacted')
  })

  it('survives a failed compaction: emits non-fatal error, turn still completes uncompacted', async () => {
    const { engine, events, client } = makeEngine(
      [
        {
          blocks: [toolUseBlock('tu_1', 'Echo', { value: 'ping' })],
          stopReason: 'tool_use',
          inputTokens: 900,
        },
        { blocks: [textBlock('done')], stopReason: 'end_turn', inputTokens: 10 },
      ],
      { contextManager: new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 2 }) },
    )
    client.complete = async () => {
      throw new Error('rate limited')
    }
    await engine.runTurn('go')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', fatal: false, message: expect.stringContaining('rate limited') }),
    )
    expect(events.at(-1)).toMatchObject({ type: 'turn-done' })
    expect(events.some((e) => e.type === 'compaction')).toBe(false)
    // Uncompacted history still fed to the second call.
    expect(client.calls).toHaveLength(2)
    expect(String(client.calls[1]![0]!.content)).toBe('go')
  })

  it('skipped compaction (nothing to compact) emits no compaction event', async () => {
    // Trips needsCompaction, but only 3 messages exist against keepRecentMessages 6.
    const { engine, events } = makeEngine(
      [
        {
          blocks: [toolUseBlock('tu_1', 'Echo', { value: 'ping' })],
          stopReason: 'tool_use',
          inputTokens: 900,
        },
        { blocks: [textBlock('done')], stopReason: 'end_turn', inputTokens: 10 },
      ],
      { contextManager: new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 6 }) },
    )
    await engine.runTurn('go')
    expect(events.some((e) => e.type === 'compaction')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'turn-done' })
  })

  it('runTurn after abort resets the controller so the next turn works', async () => {
    const controller = new AbortController()
    controller.abort()
    const { engine, events } = makeEngine(
      [{ blocks: [textBlock('back')], stopReason: 'end_turn' }],
      { abortController: controller },
    )
    await engine.runTurn('hello again')
    expect(events).toContainEqual({ type: 'assistant-text', delta: 'back' })
  })
})

describe('zodToJsonSchema', () => {
  it('converts the Read tool schema to a JSON Schema object with required file_path', () => {
    const json = zodToJsonSchema(readTool.schema)
    expect(json).toMatchObject({
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    })
  })

  it('handles enum, boolean, array, and default', () => {
    const schema = z.object({
      mode: z.enum(['a', 'b']),
      flag: z.boolean().default(true),
      items: z.array(z.string()).optional(),
    })
    const json = zodToJsonSchema(schema)
    expect(json).toMatchObject({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['a', 'b'] },
        flag: { type: 'boolean' },
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['mode'],
    })
  })
})
