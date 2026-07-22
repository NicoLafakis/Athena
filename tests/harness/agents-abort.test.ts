import { describe, it, expect } from 'vitest'
import { AgentOrchestrator } from '../../src/harness/agents.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { HookRunner } from '../../src/harness/hooks.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ModelClient } from '../../src/engine/client.js'
import type { PermissionGate, ToolDefinition } from '../../src/engine/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'

function def(): AgentDef {
  return {
    name: 'researcher',
    description: 'read-only',
    tools: ['Read'],
    model: null,
    systemPrompt: 'You research.',
    file: 'x.md',
  }
}

const gate: PermissionGate = {
  check: () => ({ decision: 'allow', reason: 'test' }),
  grantSession: () => {},
}

/** A client that hangs until the request signal aborts, then rejects like the SDK would. */
function hangingClient(): ModelClient {
  return {
    stream: (params) =>
      new Promise((_resolve, reject) => {
        if (params.signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        params.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      }),
    complete: async () => '',
  }
}

function makeOrchestrator(client: ModelClient): AgentOrchestrator {
  const registry = new ToolRegistry()
  registry.register(readTool as ToolDefinition<never>)
  return new AgentOrchestrator({
    defs: [def()],
    clientFactory: () => client,
    baseRegistry: registry,
    gate,
    hooks: new HookRunner([]),
    defaultModel: 'mock',
    systemPromptBase: 'sys',
  })
}

describe('AgentOrchestrator abort propagation', () => {
  it('aborting the parent signal aborts a running child engine', async () => {
    const orchestrator = makeOrchestrator(hangingClient())
    const controller = new AbortController()
    const ctx = makeCtx(process.cwd(), { abortSignal: controller.signal })
    const promise = orchestrator.runAgent(def(), 'go', ctx)
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    const res = await promise // would hang forever without propagation
    expect(res.output.toLowerCase()).toContain('abort')
  }, 5000)

  it('an already-aborted parent signal aborts the child immediately', async () => {
    const orchestrator = makeOrchestrator(hangingClient())
    const controller = new AbortController()
    controller.abort()
    const ctx = makeCtx(process.cwd(), { abortSignal: controller.signal })
    const res = await orchestrator.runAgent(def(), 'go', ctx)
    expect(res.output.toLowerCase()).toContain('abort')
  }, 5000)
})
