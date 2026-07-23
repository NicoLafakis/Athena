import { describe, it, expect } from 'vitest'
import { AgentOrchestrator } from '../../src/harness/agents.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { ClientHolder } from '../../src/engine/client-holder.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ProviderId, ModelKey } from '../../src/brain/models.js'
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
      log.push(`${name}:${params.model}`) // capture the wire model id each client is asked for
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
    // Mutable state behind the thunks, same as engine.getProvider()/getModel() in cli.ts:
    // the /provider handler mutates these AND swaps the holder.
    let activeProvider: ProviderId = 'anthropic'
    let activeModel: ModelKey = 'sonnet'
    const orchestrator = new AgentOrchestrator({
      defs: [def],
      clientFactory: () => holder, // same wiring as cli.ts: the factory returns the holder
      baseRegistry: registry,
      gate,
      hooks: new HookRunner([]),
      defaultModel: () => activeModel,
      defaultEffort: () => 'high',
      defaultProvider: () => activeProvider,
      systemPromptBase: 'sys',
    })

    const before = await orchestrator.runAgent(def, 'q1', makeCtx(process.cwd()))
    expect(before.output).toBe('old')

    // What the /provider handler does: swap the holder AND move the provider/model state.
    holder.swap(namedClient('new', log))
    activeProvider = 'kimi'
    activeModel = 'kimi-k3'

    const after = await orchestrator.runAgent(def, 'q2', makeCtx(process.cwd()))
    expect(after.output).toBe('new')

    // Compactor path: /compact calls complete() on the same holder.
    expect(await holder.complete({ model: 'm', prompt: 'p', maxTokens: 8 })).toBe('new-summary')
    // Thunk propagation: the post-swap sub-agent run asked the NEW client for kimi-k3's wire id.
    expect(log).toEqual(['old:claude-sonnet-5', 'new:kimi-k3', 'new:complete'])
  })
})
