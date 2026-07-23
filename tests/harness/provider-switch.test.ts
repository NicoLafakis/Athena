import { describe, it, expect } from 'vitest'
import { AgentOrchestrator } from '../../src/harness/agents.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { ClientHolder } from '../../src/engine/client-holder.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ModelClient, StreamResult } from '../../src/engine/client.js'
import type { PermissionGate, ToolDefinition } from '../../src/engine/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { MockAnthropicClient, textBlock } from '../helpers/mock-client.js'

function namedClient(name: string, log: string[]): ModelClient {
  const inner = new MockAnthropicClient(
    [{ blocks: [textBlock(name)], stopReason: 'end_turn' }],
    `${name}-summary`,
  )
  return {
    stream(params, callbacks): Promise<StreamResult> {
      log.push(`${name}:stream`)
      return inner.stream(params, callbacks)
    },
    complete(params): Promise<string> {
      log.push(`${name}:complete`)
      return inner.complete(params)
    },
  }
}

const def: AgentDef = {
  name: 'researcher',
  description: 'read-only',
  tools: ['Read'],
  model: null,
  systemPrompt: 'You research.',
  file: 'x.md',
}

const gate: PermissionGate = {
  check: () => ({ decision: 'allow', reason: 'test gate allows all' }),
  grantSession: () => {},
}

describe('provider switch through the ClientHolder', () => {
  it('sub-agent calls and compactor calls go through the NEW client after swap', async () => {
    const log: string[] = []
    const holder = new ClientHolder(namedClient('old', log))
    const registry = new ToolRegistry()
    registry.register(readTool as ToolDefinition<never>)
    const orchestrator = new AgentOrchestrator({
      defs: [def],
      clientFactory: () => holder, // same wiring as cli.ts: the factory returns the holder
      baseRegistry: registry,
      gate,
      hooks: new HookRunner([]),
      defaultModel: () => 'sonnet',
      defaultEffort: () => 'high',
      defaultProvider: () => 'anthropic',
      systemPromptBase: 'sys',
    })

    const before = await orchestrator.runAgent(def, 'q1', makeCtx(process.cwd()))
    expect(before.output).toBe('old')

    holder.swap(namedClient('new', log)) // what the /provider handler does

    const after = await orchestrator.runAgent(def, 'q2', makeCtx(process.cwd()))
    expect(after.output).toBe('new')

    // Compactor path: /compact calls complete() on the same holder.
    expect(await holder.complete({ model: 'm', prompt: 'p', maxTokens: 8 })).toBe('new-summary')
    expect(log).toEqual(['old:stream', 'new:stream', 'new:complete'])
  })
})
