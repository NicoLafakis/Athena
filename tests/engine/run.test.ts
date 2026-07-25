import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Engine } from '../../src/engine/loop.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { ContextManager } from '../../src/engine/context.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import type { EngineEvent, PermissionGate, RunLimits, ToolDefinition } from '../../src/engine/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import {
  MockAnthropicClient,
  textBlock,
  toolUseBlock,
  type ScriptedResponse,
} from '../helpers/mock-client.js'

const Input = z.object({ value: z.string() })

function createEngine(
  script: ScriptedResponse[],
  limits: RunLimits,
  tool?: ToolDefinition<z.infer<typeof Input>>,
) {
  const bus = new EngineEventBus()
  const events: EngineEvent[] = []
  bus.on((event) => events.push(event))
  const registry = new ToolRegistry()
  if (tool) registry.register(tool as ToolDefinition<never>)
  const client = new MockAnthropicClient(script)
  const gate: PermissionGate = {
    check: () => ({ decision: 'allow', reason: 'test' }),
    grantSession: () => {},
  }
  const engine = new Engine({
    client,
    bus,
    registry,
    gate,
    hooks: new HookRunner([]),
    contextManager: new ContextManager({ modelWindowTokens: 1_000_000 }),
    toolContext: makeCtx(process.cwd(), { emit: (event) => bus.emit(event) }),
    provider: 'anthropic',
    model: 'sonnet',
    effort: 'high',
    systemPrompt: 'test',
    maxTokens: 4096,
    limits,
  })
  return { engine, client, events }
}

describe('Engine run budgets', () => {
  it('accumulates usage across every model/tool cycle', async () => {
    const tool: ToolDefinition<z.infer<typeof Input>> = {
      name: 'Echo',
      description: 'echo',
      schema: Input,
      readOnly: true,
      async execute(input) {
        return { output: input.value, isError: false }
      },
    }
    const { engine } = createEngine(
      [
        {
          blocks: [toolUseBlock('t1', 'Echo', { value: 'x' })],
          stopReason: 'tool_use',
          inputTokens: 100,
          outputTokens: 20,
        },
        { blocks: [textBlock('done')], stopReason: 'end_turn', inputTokens: 200, outputTokens: 30 },
      ],
      {},
      tool,
    )
    const result = await engine.runTurn('go')
    expect(result.status).toBe('completed')
    expect(result.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 50,
      modelCalls: 2,
      toolCalls: 1,
      turns: 1,
    })
    expect(result.usage.costUsd).toBeGreaterThan(0)
  })

  it('stops at max model calls and leaves a valid tool result', async () => {
    const tool: ToolDefinition<z.infer<typeof Input>> = {
      name: 'Echo',
      description: 'echo',
      schema: Input,
      readOnly: true,
      async execute() {
        return { output: 'ok', isError: false }
      },
    }
    const { engine, client, events } = createEngine(
      [
        { blocks: [toolUseBlock('t1', 'Echo', { value: 'x' })], stopReason: 'tool_use' },
        { blocks: [textBlock('never')], stopReason: 'end_turn' },
      ],
      { maxModelCalls: 1 },
      tool,
    )
    const result = await engine.runTurn('go')
    expect(result).toMatchObject({ status: 'limit', reason: 'maxModelCalls' })
    expect(client.calls).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'run-limit', limit: 'maxModelCalls' }))
  })

  it('stops before tool execution when the tool budget is exhausted', async () => {
    let executed = false
    const tool: ToolDefinition<z.infer<typeof Input>> = {
      name: 'Echo',
      description: 'echo',
      schema: Input,
      readOnly: true,
      async execute() {
        executed = true
        return { output: 'ok', isError: false }
      },
    }
    const { engine } = createEngine(
      [{ blocks: [toolUseBlock('t1', 'Echo', { value: 'x' })], stopReason: 'tool_use' }],
      { maxToolCalls: 0 },
      tool,
    )
    const result = await engine.runTurn('go')
    expect(result).toMatchObject({ status: 'limit', reason: 'maxToolCalls' })
    expect(executed).toBe(false)
    expect(JSON.stringify(engine.getMessages())).toContain('Tool not executed')
  })

  it('enforces max turns across repeated prompts', async () => {
    const { engine } = createEngine(
      [{ blocks: [textBlock('first')], stopReason: 'end_turn' }],
      { maxTurns: 1 },
    )
    expect((await engine.runTurn('one')).status).toBe('completed')
    expect(await engine.runTurn('two')).toMatchObject({ status: 'limit', reason: 'maxTurns' })
  })

  it('caps concurrent child-agent tool calls', async () => {
    let active = 0
    let peak = 0
    const agent: ToolDefinition<z.infer<typeof Input>> = {
      name: 'Agent',
      description: 'test child',
      schema: Input,
      readOnly: true,
      async execute(input) {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active--
        return { output: input.value, isError: false }
      },
    }
    const { engine } = createEngine(
      [
        {
          blocks: ['a', 'b', 'c'].map((value, index) =>
            toolUseBlock(`t${index}`, 'Agent', { value }),
          ),
          stopReason: 'tool_use',
        },
        { blocks: [textBlock('done')], stopReason: 'end_turn' },
      ],
      { maxConcurrency: 2 },
      agent,
    )
    expect((await engine.runTurn('go')).status).toBe('completed')
    expect(peak).toBe(2)
  })
})
