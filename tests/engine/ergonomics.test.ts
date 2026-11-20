import { describe, expect, it, vi } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { ContextManager, pruneOlderToolResults } from '../../src/engine/context.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { Engine } from '../../src/engine/loop.js'
import type { ModelClient, StreamCallbacks, StreamResult } from '../../src/engine/client.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { PermissionEngine } from '../../src/harness/permissions.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { z } from 'zod'
import { makeCtx } from '../helpers/tool-ctx.js'
import { parseSlash } from '../../src/tui/slash.js'

describe('graduated tool-result pruning', () => {
  it('stubs bulky tool_result bodies older than the recent tail while preserving tool_use_id pairing and assistant prose', () => {
    const bigOutput = 'x'.repeat(2_000)
    const messages: MessageParam[] = [
      { role: 'user', content: 'Inspect big file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading now.' },
          { type: 'tool_use', id: 'tu-old', name: 'Read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-old', content: bigOutput }],
      },
      { role: 'assistant', content: 'Found the issue in a.ts.' },
      { role: 'user', content: 'Now check b.ts' },
      { role: 'assistant', content: 'Checking b.ts.' },
    ]

    const pruned = pruneOlderToolResults(messages, 2)
    expect(pruned.prunedCount).toBe(1)
    expect(pruned.savedChars).toBeGreaterThan(1_800)
    const oldResultBlock = (pruned.messages[2]!.content as Array<{ type: string; tool_use_id?: string; content?: string }>)[0]!
    expect(oldResultBlock.tool_use_id).toBe('tu-old')
    expect(oldResultBlock.content).toMatch(/pruned/i)
    // Assistant reasoning stays verbatim.
    expect(pruned.messages[3]!.content).toBe('Found the issue in a.ts.')
  })
})

describe('parallel read-only tool batches', () => {
  it('executes multiple read-only tools concurrently instead of sequentially', async () => {
    let active = 0
    let maxConcurrent = 0
    const slowRead: ToolDefinition<{ id: string }> = {
      name: 'SlowRead',
      description: 'Read-only test tool',
      schema: z.object({ id: z.string() }),
      readOnly: true,
      async execute(input) {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((r) => setTimeout(r, 40))
        active--
        return { output: `read:${input.id}`, isError: false }
      },
    }

    const registry = new ToolRegistry()
    registry.register(slowRead as ToolDefinition<never>)

    let callCount = 0
    const client: ModelClient = {
      async stream(_params, callbacks: StreamCallbacks): Promise<StreamResult> {
        callCount++
        if (callCount === 1) {
          return {
            message: {
              id: 'm1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              content: [
                { type: 'tool_use', id: 't1', name: 'SlowRead', input: { id: 'a' } },
                { type: 'tool_use', id: 't2', name: 'SlowRead', input: { id: 'b' } },
                { type: 'tool_use', id: 't3', name: 'SlowRead', input: { id: 'c' } },
              ],
            } as unknown as StreamResult['message'],
          }
        }
        callbacks.onTextDelta('All three read.')
        return {
          message: {
            id: 'm2',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 150, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [{ type: 'text', text: 'All three read.' }],
          } as unknown as StreamResult['message'],
        }
      },
      complete: vi.fn(async () => 'summary'),
    }

    const engine = new Engine({
      client,
      bus: new EngineEventBus(),
      registry,
      gate: new PermissionEngine({ mode: 'trusted', allow: [], deny: [] }),
      hooks: new HookRunner([]),
      contextManager: new ContextManager({ modelWindowTokens: 100_000 }),
      toolContext: makeCtx(process.cwd()),
      model: 'sonnet',
      effort: 'medium',
      systemPrompt: 'test',
      maxTokens: 4096,
      limits: { maxConcurrency: 3 },
    })

    const result = await engine.runTurn('Read a, b, c')
    expect(result.status).toBe('completed')
    expect(maxConcurrent).toBeGreaterThanOrEqual(2)
  })
})

describe('/cost slash command parsing', () => {
  it('parses /cost as a bare built-in slash command', () => {
    expect(parseSlash('/cost')).toEqual({ kind: 'cost' })
  })
})
