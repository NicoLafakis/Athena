import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { AgentOrchestrator, type AgentOrchestratorOptions } from '../../src/harness/agents.js'
import { makeAgentTool } from '../../src/tools/agent.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { grepTool } from '../../src/tools/grep.js'
import { bashTool, taskOutputTool } from '../../src/tools/shell.js'
import { HookRunner } from '../../src/harness/hooks.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ModelFamily } from '../../src/brain/models.js'
import type { ModelClient, StreamCallbacks, StreamResult } from '../../src/engine/client.js'
import type { PermissionGate, ToolContext, ToolDefinition } from '../../src/engine/types.js'
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
    defaultModel: () => 'sonnet',
    defaultEffort: () => 'high',
    systemPromptBase: 'sys',
    ...overrides,
  })
  ref.current = orchestrator
  return orchestrator
}

/** Wraps a MockAnthropicClient so stream() also records the model it was called with. */
function modelCapturingClient(script: ScriptedResponse[], seen: string[]): ModelClient {
  const inner = new MockAnthropicClient(script)
  return {
    async stream(
      params: Parameters<ModelClient['stream']>[0],
      callbacks: StreamCallbacks,
    ): Promise<StreamResult> {
      seen.push(params.model)
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

  it('a Bash-capable child also gets TaskOutput (to poll its background tasks); others do not', () => {
    const registry = new ToolRegistry()
    registry.register(bashTool as ToolDefinition<never>)
    registry.register(taskOutputTool as ToolDefinition<never>)
    registry.register(readTool as ToolDefinition<never>)
    const orchestrator = makeOrchestrator(() => new MockAnthropicClient([]), {
      baseRegistry: registry,
    })
    const withBash = orchestrator.buildChildRegistry({ ...researcherDef(), tools: ['Bash'] })
    expect(withBash.list().map((t) => t.name).sort()).toEqual(['Bash', 'TaskOutput'])
    const withoutShell = orchestrator.buildChildRegistry({ ...researcherDef(), tools: ['Read'] })
    expect(withoutShell.get('TaskOutput')).toBeUndefined()
    expect(withoutShell.list().map((t) => t.name)).toEqual(['Read'])
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

  it('each child gets a FRESH fileReadRegistry and todo list (no cross-contamination with the parent)', async () => {
    const captured: ToolContext[] = []
    const probe: ToolDefinition<never> = {
      name: 'Probe',
      description: 'captures the ToolContext it runs with',
      schema: z.object({}) as never,
      readOnly: true,
      async execute(_input, ctx) {
        captured.push(ctx)
        return { output: 'probed', isError: false }
      },
    } as ToolDefinition<never>
    const registry = new ToolRegistry()
    registry.register(probe)
    const childScript: ScriptedResponse[] = [
      { blocks: [toolUseBlock('t1', 'Probe', {})], stopReason: 'tool_use' },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ]
    const orchestrator = makeOrchestrator(() => new MockAnthropicClient(childScript), {
      baseRegistry: registry,
    })
    const parentCtx = makeCtx(process.cwd())
    parentCtx.fileReadRegistry.add('C:/parent/secret.ts') // a parent Read must NOT unlock child writes (or vice versa)
    const res = await orchestrator.runAgent(
      { ...researcherDef(), tools: ['Probe'] },
      'probe',
      parentCtx,
    )
    expect(res.isError).toBe(false)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.fileReadRegistry).not.toBe(parentCtx.fileReadRegistry)
    expect(captured[0]!.fileReadRegistry.size).toBe(0)
    expect(captured[0]!.todos).not.toBe(parentCtx.todos)
  })

  it('defaultModel is a thunk read at spawn time, so /model reaches later sub-agents', async () => {
    let model: ModelFamily = 'haiku'
    const seen: string[] = []
    const orchestrator = makeOrchestrator(
      () =>
        modelCapturingClient([{ blocks: [textBlock('ok')], stopReason: 'end_turn' }], seen),
      { defaultModel: () => model },
    )
    await orchestrator.runAgent(researcherDef(), 'go', makeCtx(process.cwd()))
    model = 'sonnet'
    await orchestrator.runAgent(researcherDef(), 'go', makeCtx(process.cwd()))
    // seen captures the RESOLVED wire id the child stream was called with.
    expect(seen).toEqual(['claude-haiku-4-5', 'claude-sonnet-5'])
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
