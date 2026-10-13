import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../../src/engine/types.js'
import { Engine } from '../../src/engine/loop.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { ContextManager } from '../../src/engine/context.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { MockAnthropicClient, toolUseBlock, textBlock } from '../helpers/mock-client.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('approval revision binding', () => {
  it('rejects approval when the file changed while its details were open', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'athena-permission-revision-')); roots.push(cwd)
    const file = join(cwd, 'file.txt'); writeFileSync(file, 'before')
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => ({ output: 'executed', isError: false }))
    registry.register({ name: 'Write', description: 'test write', readOnly: false, schema: z.object({ file_path: z.string(), content: z.string() }), execute } as unknown as ToolDefinition<never>)
    const grantSession = vi.fn()
    const engine = new Engine({ client: new MockAnthropicClient([
      { blocks: [toolUseBlock('w', 'Write', { file_path: file, content: 'replacement' })], stopReason: 'tool_use' },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ]), registry, bus: new EngineEventBus(), model: 'sonnet', effort: 'high', systemPrompt: 'sys', maxTokens: 4096,
      contextManager: new ContextManager({ modelWindowTokens: 1_000_000 }), hooks: new HookRunner([]), toolContext: makeCtx(cwd),
      gate: { check: () => ({ decision: 'ask', reason: 'review' }), grantSession },
      askUser: async () => { writeFileSync(file, 'concurrent change'); return 'allow-always' },
    })
    await engine.runTurn('edit')
    expect(execute).not.toHaveBeenCalled()
    expect(grantSession).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe('concurrent change')
    expect(JSON.stringify(engine.getMessages())).toContain('changed during approval')
  })
})
