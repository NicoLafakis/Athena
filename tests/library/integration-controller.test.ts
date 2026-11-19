import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LibraryRuntime } from '../../src/library/runtime.js'
import { AgentOrchestrator } from '../../src/harness/agents.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { HookRunner } from '../../src/harness/hooks.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import { makeLibraryReadTool, makeLibraryWriteTool } from '../../src/tools/library.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'
import { createLibraryFixtureHarness } from '../helpers/library-fixture.js'

const harness = createLibraryFixtureHarness()
afterEach(async () => {
  vi.restoreAllMocks()
  await harness.cleanupEach()
})
afterAll(() => harness.cleanupAll())

describe('shared controller integration', () => {
  it('excludes stateful library tools from children and preserves the parent selection', async () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    f.library.select({ keys: ['context'] })
    const parentContext = f.library.context()
    const child = new MockAnthropicClient([
      { blocks: [toolUseBlock('child-lookup', 'LibraryRead', { keys: ['other-category'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Library is unavailable in this child.')], stopReason: 'end_turn' },
    ])
    const registry = new ToolRegistry()
    registry.register(makeLibraryReadTool(f.library) as ToolDefinition<never>)
    registry.register(makeLibraryWriteTool(f.library) as ToolDefinition<never>)
    const def: AgentDef = {
      name: 'synthetic-child',
      description: 'isolation test',
      tools: null,
      model: null,
      systemPrompt: 'Synthetic child.',
      file: 'synthetic.md',
    }
    const orchestrator = new AgentOrchestrator({
      defs: [def],
      clientFactory: () => child,
      baseRegistry: registry,
      gate: { check: () => ({ decision: 'allow', reason: 'synthetic fixture' }), grantSession: () => {} },
      hooks: new HookRunner([]),
      defaultModel: () => 'sonnet',
      defaultEffort: () => 'high',
      systemPromptBase: 'Synthetic parent.',
    })
    expect(orchestrator.buildChildRegistry(def).list()).toEqual([])
    expect(orchestrator.buildChildRegistry({ ...def, tools: ['LibraryRead', 'LibraryWrite'] }).list()).toEqual([])
    expect((await orchestrator.runAgent(def, 'Request category B.', makeCtx(f.cwd))).isError).toBe(false)
    expect(JSON.stringify(child.calls[1])).toContain('Unknown tool')
    expect(f.library.context()).toBe(parentContext)
  })

  it('revalidates ephemeral notes and excludes their text from persistent sessions', async () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('lookup', 'LibraryRead', { keys: ['context'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Source-linked answer.')], stopReason: 'end_turn' },
      { blocks: [textBlock('A new turn.')], stopReason: 'end_turn' },
    ])
    const c = await harness.controller(f.cwd, client)
    expect((await c.submitTurn('Recall context.')).status).toBe('completed')
    const detail = readFileSync(join(f.cwd, 'detail.md'), 'utf8').trim()
    expect(JSON.stringify(client.calls[1])).toContain(detail)
    expect(JSON.stringify(c.engine.getMessages())).not.toContain(detail)
    expect(readFileSync(c.session.file, 'utf8')).not.toContain(detail)
    expect(c.library?.status().recoveries.at(-1)?.status).toBe('completed')
    await c.submitTurn('A new unrelated turn.')
    expect(JSON.stringify(client.calls[2])).not.toContain(detail)
  })

  it('gives active LibraryRead selection precedence over provisional journal recall on that turn and resumes journal recall on the next turn', async () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('lookup', 'LibraryRead', { keys: ['context'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Answered with library context.')], stopReason: 'end_turn' },
      { blocks: [textBlock('Next turn answered.')], stopReason: 'end_turn' },
    ])
    const c = await harness.controller(f.cwd, client)
    const journalSentinel = '<journal-memory>provisional-journal-sentinel</journal-memory>'
    vi.spyOn(c.reflectionJournal, 'retrieve').mockReturnValue(`\n\n${journalSentinel}`)
    const detail = readFileSync(join(f.cwd, 'detail.md'), 'utf8').trim()

    await c.submitTurn('First turn with library read.')
    // Before LibraryRead selects notes, provisional journal recall applies.
    expect(JSON.stringify(client.calls[0])).toContain(journalSentinel)
    // Once LibraryRead is active on the turn, library context takes exclusive precedence.
    expect(JSON.stringify(client.calls[1])).toContain(detail)
    expect(JSON.stringify(client.calls[1])).not.toContain(journalSentinel)

    // On the next turn, library selection resets and provisional journal recall resumes.
    await c.submitTurn('Second turn without library read.')
    expect(JSON.stringify(client.calls[2])).toContain(journalSentinel)
    expect(JSON.stringify(client.calls[2])).not.toContain(detail)
  })

  it('does not mount the tool or create library storage when disabled', async () => {
    const f = harness.fixture(false)
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('lookup', 'LibraryRead', { keys: ['context'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Unavailable.')], stopReason: 'end_turn' },
    ])
    const c = await harness.controller(f.cwd, client)
    await c.submitTurn('Lookup.')
    expect(c.library).toBeNull()
    expect(existsSync(join(f.cwd, '.athena', 'library'))).toBe(false)
    expect(JSON.stringify(c.engine.getMessages())).toContain('Unknown tool')
  })

  it('records an actually aborted controller turn as interrupted', async () => {
    const f = harness.fixture()
    const client = new MockAnthropicClient([{ blocks: [textBlock('unused')], stopReason: 'end_turn' }])
    const c = await harness.controller(f.cwd, client)
    const turn = c.submitTurn('Synthetic interrupted turn.')
    c.abort()
    expect((await turn).status).toBe('aborted')
    expect(c.library?.status().recoveries.at(-1)?.status).toBe('interrupted')
  })

  it('fails soft on malformed opt-in without mounting a partially configured library', async () => {
    const f = harness.fixture()
    writeFileSync(join(f.cwd, '.athena', 'library.config.json'), '{torn')
    const c = await harness.controller(
      f.cwd,
      new MockAnthropicClient([{ blocks: [textBlock('Still available.')], stopReason: 'end_turn' }]),
    )
    expect(c.library).toBeNull()
    expect((await c.submitTurn('Synthetic normal turn.')).status).toBe('completed')
    expect(existsSync(join(f.cwd, '.athena', 'library'))).toBe(false)
  })

  it('bounds interrupted checkpoint metadata and never stores prompts', () => {
    const f = harness.fixture()
    const runId = '00000000-0000-4000-8000-000000000001'
    f.library.checkpoint(runId, 1, 'active')
    expect(LibraryRuntime.open(f.cwd, true)!.status().recoveries[0]?.status).toBe('unresolved')
    f.library.checkpoint(runId, 1, 'interrupted')
    expect(f.library.status().recoveries[0]?.status).toBe('interrupted')
    for (let turn = 2; turn <= 70; turn++) f.library.checkpoint(runId, turn, 'completed')
    expect(f.library.status().recoveries).toHaveLength(64)
    expect(Object.keys(f.library.status().recoveries[0]!)).toEqual(['id', 'runId', 'turn', 'status'])
  })

  it('returns IDs rather than durable content through the real read tool', async () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    const tool = makeLibraryReadTool(f.library)
    const result = await tool.execute(tool.schema.parse({ keys: ['context'] }), makeCtx(f.cwd))
    expect(result.isError).toBe(false)
    expect(result.output).toContain(note.id)
    expect(result.output).not.toContain('Detailed context retention rationale')
    expect(f.library.context()).toContain('Detailed context retention rationale')
    writeFileSync(join(f.cwd, 'detail.md'), 'Changed source.\n')
    expect(f.library.context()).not.toContain('Detailed context retention rationale')
  })
})
