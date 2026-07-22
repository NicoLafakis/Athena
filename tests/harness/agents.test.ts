import { describe, it, expect } from 'vitest'
import { AgentOrchestrator, type AgentOrchestratorOptions } from '../../src/harness/agents.js'
import { makeAgentTool } from '../../src/tools/agent.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { grepTool } from '../../src/tools/grep.js'
import { HookRunner } from '../../src/harness/hooks.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ModelClient, StreamCallbacks, StreamResult } from '../../src/engine/client.js'
import type { PermissionGate, ToolDefinition } from '../../src/engine/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import {
  MockAnthropicClient,
  textBlock,
  toolUseBlock,
  type ScriptedResponse,
} from '../helpers/mock-client.js'

function researcherDef(): AgentDef {
  return {
    name: 'researcher',
    description: 'read-only',
    tools: ['Read', 'Grep'],
    model: null,
    systemPrompt: 'You research.',
    file: 'x.md',
  }
}

function allowAllGate(): PermissionGate {
  return {
    check: () => ({ decision: 'allow', reason: 'test gate allows all' }),
    grantSession: () => {},
  }
}

/** Base registry with Read, Grep, and an Agent tool (so exclusion is observable). */
function fullRegistry(orchestratorRef: { current: AgentOrchestrator | null }): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readTool as ToolDefinition<never>)
  registry.register(grepTool as ToolDefinition<never>)
  registry.register({
    name: 'Agent',
    description: 'stub Agent tool (replaced by makeAgentTool in production wiring)',
    schema: readTool.schema,
    readOnly: false,
    execute: async (input, ctx) => {
      if (!orchestratorRef.current) return { output: 'no orchestrator', isError: true }
      return makeAgentTool(orchestratorRef.current).execute(input as never, ctx)
    },
  } as ToolDefinition<never>)
  return registry
}

function makeOrchestrator(
  clientFactory: () => ModelClient,
  overrides: Partial<AgentOrchestratorOptions> = {},
): AgentOrchestrator {
  const ref: { current: AgentOrchestrator | null } = { current: null }
  const orchestrator = new AgentOrchestrator({
    defs: [researcherDef()],
    clientFactory,
    baseRegistry: fullRegistry(ref),
    gate: allowAllGate(),
    hooks: new HookRunner([]),
    defaultModel: 'mock',
    systemPromptBase: 'sys',
    ...overrides,
  })
  ref.current = orchestrator
  return orchestrator
}

/** Wraps a MockAnthropicClient so stream() waits for an external gate promise first. */
function gatedClient(script: ScriptedResponse[], gate: Promise<void>): ModelClient {
  const inner = new MockAnthropicClient(script)
  return {
    async stream(
      params: Parameters<ModelClient['stream']>[0],
      callbacks: StreamCallbacks,
    ): Promise<StreamResult> {
      await gate
      return inner.stream(params, callbacks)
    },
    complete: (params) => inner.complete(params),
  }
}

describe('AgentOrchestrator + Agent tool', () => {
  it('Agent tool runs a child loop and returns its final text as the tool result', async () => {
    const childScript: ScriptedResponse[] = [
      { blocks: [textBlock('child answer')], stopReason: 'end_turn' },
    ]
    const orchestrator = makeOrchestrator(() => new MockAnthropicClient(childScript))
    const agentTool = makeAgentTool(orchestrator)
    const res = await agentTool.execute(
      { agent: 'researcher', prompt: 'find X' },
      makeCtx(process.cwd()),
    )
    expect(res.isError).toBe(false)
    expect(res.output).toBe('child answer')
  })

  it('child registry is restricted to the frontmatter tools and NEVER contains Agent (one-level nesting)', () => {
    const orchestrator = makeOrchestrator(() => new MockAnthropicClient([]))
    const child = orchestrator.buildChildRegistry(researcherDef())
    expect(child.list().map((t) => t.name).sort()).toEqual(['Grep', 'Read'])
    const unrestricted = orchestrator.buildChildRegistry({ ...researcherDef(), tools: null })
    expect(unrestricted.get('Agent')).toBeUndefined()
    expect(unrestricted.get('Read')).toBeDefined()
  })

  it('child tool calls pass through the SAME permission gate and hook runner instances', async () => {
    const checks: string[] = []
    const spyGate: PermissionGate = {
      check: (r) => {
        checks.push(r.toolName)
        return { decision: 'deny', reason: 'spy' }
      },
      grantSession: () => {},
    }
    const hookEvents: string[] = []
    const hooks = new HookRunner([])
    const originalRun = hooks.run.bind(hooks)
    hooks.run = async (event, payload) => {
      hookEvents.push(event)
      return originalRun(event, payload)
    }
    const childScript: ScriptedResponse[] = [
      { blocks: [toolUseBlock('t1', 'Read', { file_path: 'x' })], stopReason: 'tool_use' },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ]
    const orchestrator = makeOrchestrator(() => new MockAnthropicClient(childScript), {
      gate: spyGate,
      hooks,
    })
    const res = await orchestrator.runAgent(researcherDef(), 'read x', makeCtx(process.cwd()))
    expect(checks).toContain('Read')
    expect(hookEvents).toContain('UserPromptSubmit')
    expect(res.isError).toBe(false)
    expect(res.output).toBe('done')
  })

  it('unknown agent name returns an error tool result, not a throw', async () => {
    const orchestrator = makeOrchestrator(() => new MockAnthropicClient([]))
    const agentTool = makeAgentTool(orchestrator)
    const res = await agentTool.execute(
      { agent: 'nonexistent', prompt: 'do things' },
      makeCtx(process.cwd()),
    )
    expect(res.isError).toBe(true)
    expect(res.output).toContain('researcher')
  })

  it('spawnMany runs children concurrently and preserves result order', async () => {
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((r) => (releaseA = r))
    const gateB = new Promise<void>((r) => (releaseB = r))
    const gates = [gateA, gateB]
    const answers = ['answer A', 'answer B']
    let next = 0
    const orchestrator = makeOrchestrator(() => {
      const i = next++
      const script: ScriptedResponse[] = [
        { blocks: [textBlock(answers[i]!)], stopReason: 'end_turn' },
      ]
      return gatedClient(script, gates[i]!)
    })
    const defA = { ...researcherDef(), name: 'a' }
    const defB = { ...researcherDef(), name: 'b' }
    const promise = orchestrator.spawnMany(
      [
        { def: defA, prompt: 'task A' },
        { def: defB, prompt: 'task B' },
      ],
      makeCtx(process.cwd()),
    )
    // Release B first: B can only finish first if children run concurrently.
    releaseB()
    await new Promise((r) => setImmediate(r))
    releaseA()
    const outs = await promise
    expect(outs.map((o) => o.output)).toEqual(['answer A', 'answer B'])
    expect(outs.every((o) => !o.isError)).toBe(true)
  })

  it('fatal child error surfaces as an error tool result', async () => {
    const failingClient: ModelClient = {
      stream: async () => {
        throw new Error('api down')
      },
      complete: async () => '',
    }
    const orchestrator = makeOrchestrator(() => failingClient)
    const res = await orchestrator.runAgent(researcherDef(), 'go', makeCtx(process.cwd()))
    expect(res.isError).toBe(true)
    expect(res.output).toContain('researcher')
    expect(res.output).toContain('api down')
  })
})
