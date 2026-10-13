import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../../src/engine/loop.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { ContextManager } from '../../src/engine/context.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { memoryTool } from '../../src/tools/memory.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { PermissionEngine } from '../../src/harness/permissions.js'
import { realPathForAccess, ResourcePolicy } from '../../src/harness/resource-policy.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'

let root: string
let memory: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-engine-memory-'))
  memory = join(root, 'brain', 'memory')
  mkdirSync(memory, { recursive: true })
  mkdirSync(join(root, 'workspace'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('effective Memory action binding', () => {
  it('keeps the approved canonical target when an alias changes during approval', async () => {
    for (const name of ['first', 'second']) mkdirSync(join(memory, name))
    const alias = join(memory, 'alias')
    symlinkSync(join(memory, 'first'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('memory-1', 'Memory', { op: 'write', path: 'alias/fact.md', content: 'approved' })], stopReason: 'tool_use' },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ])
    const registry = new ToolRegistry()
    registry.register(memoryTool as ToolDefinition<never>)
    const cwd = join(root, 'workspace')
    let shownPath: unknown
    const engine = new Engine({ client, registry, bus: new EngineEventBus(), model: 'sonnet', effort: 'high',
      systemPrompt: 'sys', maxTokens: 4096, hooks: new HookRunner([]),
      contextManager: new ContextManager({ modelWindowTokens: 1_000_000 }),
      gate: new PermissionEngine({ mode: 'normal', allow: [], deny: [], cwd, memoryRoot: memory,
        sandboxMode: 'workspace-write', resourcePolicy: new ResourcePolicy(cwd) }),
      toolContext: makeCtx(cwd, { brainDir: join(root, 'brain') }),
      askUser: async (request) => {
        shownPath = (request.input as { path: string }).path
        rmSync(alias)
        symlinkSync(join(memory, 'second'), alias, process.platform === 'win32' ? 'junction' : 'dir')
        return 'allow-once'
      },
    })
    await engine.runTurn('write memory')
    expect(shownPath).toBe(realPathForAccess(join(memory, 'first', 'fact.md'), cwd))
    expect(readFileSync(join(memory, 'first', 'fact.md'), 'utf8')).toBe('approved')
    expect(readFileSync(join(memory, 'MEMORY.md'), 'utf8')).toContain('first/fact.md')
  })

  it('sends operation-specific read-only metadata to hooks and runs memory reads in plan mode', async () => {
    writeFileSync(join(memory, 'fact.md'), 'retained fact')
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('memory-2', 'Memory', { op: 'read', path: 'fact.md' })], stopReason: 'tool_use' },
      { blocks: [textBlock('done')], stopReason: 'end_turn' },
    ])
    const registry = new ToolRegistry()
    registry.register(memoryTool as ToolDefinition<never>)
    const cwd = join(root, 'workspace')
    let hookPayload: unknown
    const hooks = new HookRunner([{ version: 1, type: 'prompt', event: 'PermissionRequest', prompt: 'check' }], {
      evaluatePrompt: async (_prompt, invocation) => { hookPayload = invocation.payload; return { decision: 'allow' } },
    })
    const engine = new Engine({ client, registry, bus: new EngineEventBus(), model: 'sonnet', effort: 'high',
      systemPrompt: 'sys', maxTokens: 4096, hooks,
      contextManager: new ContextManager({ modelWindowTokens: 1_000_000 }),
      gate: new PermissionEngine({ mode: 'plan', allow: [], deny: [], cwd, memoryRoot: memory, sandboxMode: 'read-only' }),
      toolContext: makeCtx(cwd, { brainDir: join(root, 'brain'), sandboxMode: 'read-only' }),
    })
    await engine.runTurn('read memory')
    expect(hookPayload).toMatchObject({ readOnly: true, input: { path: realPathForAccess(join(memory, 'fact.md'), cwd) } })
    expect(JSON.stringify(client.calls[1])).toContain('retained fact')
  })
})
