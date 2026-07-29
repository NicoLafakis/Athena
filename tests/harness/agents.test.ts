import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { AgentOrchestrator, type AgentOrchestratorOptions } from '../../src/harness/agents.js'
import { makeAgentTool } from '../../src/tools/agent.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { grepTool } from '../../src/tools/grep.js'
import { writeTool } from '../../src/tools/write.js'
import { bashTool, taskOutputTool } from '../../src/tools/shell.js'
import { statusUpdateTool } from '../../src/tools/status-update.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { TraceWarehouse } from '../../src/learning/warehouse.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ModelKey } from '../../src/brain/models.js'
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
    expect(res.output).toContain('run_id:')
    expect(res.output).toContain('child answer')
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
    expect(res.output).toContain('done')
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
    let model: ModelKey = 'haiku'
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

  it('defaultProvider is a thunk: sub-agents spawn under the active provider, and anthropic-only frontmatter models fall back to defaultModel()', async () => {
    const seen: string[] = []
    const orchestrator = makeOrchestrator(
      () =>
        modelCapturingClient([{ blocks: [textBlock('ok')], stopReason: 'end_turn' }], seen),
      { defaultProvider: () => 'kimi', defaultModel: () => 'kimi-k3' },
    )
    await orchestrator.runAgent(researcherDef(), 'go', makeCtx(process.cwd()))
    // Frontmatter model 'opus' does not exist under kimi -> falls back to defaultModel().
    await orchestrator.runAgent({ ...researcherDef(), model: 'opus' }, 'go', makeCtx(process.cwd()))
    expect(seen).toEqual(['kimi-k3', 'kimi-k3'])
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

  it('forwards child agent status assertions with the child run identity', async () => {
    const registry = new ToolRegistry()
    registry.register(statusUpdateTool as ToolDefinition<never>)
    const childScript: ScriptedResponse[] = [
      {
        blocks: [toolUseBlock('status-1', 'StatusUpdate', { nextExpected: 'Review the result.' })],
        stopReason: 'tool_use',
      },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ]
    const orchestrator = makeOrchestrator(() => new MockAnthropicClient(childScript), {
      baseRegistry: registry,
    })
    const parentCtx = makeCtx(process.cwd())

    await orchestrator.runAgent(
      { ...researcherDef(), tools: ['StatusUpdate'] },
      'report status',
      parentCtx,
    )

    const update = parentCtx.events.find((event) => event.type === 'agent-status-update')
    expect(update).toMatchObject({
      type: 'agent-status-update',
      nextExpected: 'Review the result.',
      sourceRef: 'status-1',
      runId: expect.any(String),
    })
  })

  it('records a separate child trace linked to its parent run', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'athena-child-trace-'))
    try {
      const orchestrator = makeOrchestrator(
        () =>
          new MockAnthropicClient([
            { blocks: [textBlock('child answer')], stopReason: 'end_turn' },
          ]),
        { traceRootDir: traceRoot },
      )
      const ctx = makeCtx(process.cwd())
      ctx.runId = 'parent-run'
      const result = await orchestrator.runAgent(researcherDef(), 'find X', ctx)
      expect(result.isError).toBe(false)
      const traces = await new TraceWarehouse(traceRoot).list()
      expect(traces).toHaveLength(1)
      expect(traces[0]).toMatchObject({
        parentRunId: 'parent-run',
        status: 'completed',
        integrity: 'valid',
      })
    } finally {
      rmSync(traceRoot, { recursive: true, force: true })
    }
  })

  it('returns a durable run id and supports follow-up with prior messages', async () => {
    const first = new MockAnthropicClient([
      { blocks: [textBlock('first answer')], stopReason: 'end_turn' },
    ])
    const second = new MockAnthropicClient([
      { blocks: [textBlock('follow-up answer')], stopReason: 'end_turn' },
    ])
    const clients = [first, second]
    const orchestrator = makeOrchestrator(() => clients.shift()!)
    const parent = makeCtx(process.cwd())
    const initial = await orchestrator.runAgent(researcherDef(), 'first prompt', parent)
    const runId = initial.runId
    expect(runId).toBeTruthy()

    const followup = await orchestrator.followUp(runId!, 'second prompt', parent)
    expect(followup.output).toContain('follow-up answer')
    expect(second.calls[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'first prompt' }),
        expect.objectContaining({ role: 'user', content: 'second prompt' }),
      ]),
    )
  })

  it('only marks read-only child definitions safe for parallel execution', () => {
    const registry = new ToolRegistry()
    registry.register(readTool as ToolDefinition<never>)
    registry.register({
      name: 'Mutate',
      description: 'mutates',
      schema: z.object({}),
      readOnly: false,
      async execute() {
        return { output: 'ok', isError: false }
      },
    } as unknown as ToolDefinition<never>)
    const orchestrator = makeOrchestrator(
      () => new MockAnthropicClient([]),
      { baseRegistry: registry },
    )
    expect(orchestrator.isConcurrencySafe(researcherDef())).toBe(true)
    expect(orchestrator.isConcurrencySafe({ ...researcherDef(), tools: null })).toBe(false)
  })

  it('runs mutating worktree-isolated agents off-tree and merges their reviewed patch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'athena-agent-isolation-'))
    try {
      execFileSync('git', ['init'], { cwd: repo, windowsHide: true })
      execFileSync('git', ['config', 'user.email', 'athena@example.invalid'], {
        cwd: repo,
        windowsHide: true,
      })
      execFileSync('git', ['config', 'user.name', 'Athena Test'], {
        cwd: repo,
        windowsHide: true,
      })
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
      execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, windowsHide: true })
      const registry = new ToolRegistry()
      registry.register(writeTool as ToolDefinition<never>)
      const definition: AgentDef = {
        name: 'isolated-writer',
        description: 'writes in an isolated worktree',
        tools: ['Write'],
        model: null,
        isolation: 'worktree',
        systemPrompt: 'Write the requested file.',
        file: 'isolated.md',
      }
      const orchestrator = makeOrchestrator(
        () =>
          new MockAnthropicClient([
            {
              blocks: [
                toolUseBlock('write-1', 'Write', {
                  file_path: 'from-agent.txt',
                  content: 'child output\n',
                }),
              ],
              stopReason: 'tool_use',
            },
            { blocks: [textBlock('done')], stopReason: 'end_turn' },
          ]),
        { defs: [definition], baseRegistry: registry },
      )
      const ctx = makeCtx(repo)
      ctx.brainDir = join(repo, '.brain')
      ctx.sandboxMode = 'workspace-write'
      const result = await orchestrator.runAgent(definition, 'write it', ctx)
      expect(result.isError, result.output).toBe(false)
      expect(readFileSync(join(repo, 'from-agent.txt'), 'utf8')).toBe('child output\n')
      expect(orchestrator.isConcurrencySafe(definition)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)
})
