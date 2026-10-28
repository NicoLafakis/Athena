import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LibraryRuntime } from '../../src/library/runtime.js'
import { LibraryConfigSchema, loadLibraryConfig } from '../../src/library/config.js'
import { AgentOrchestrator } from '../../src/harness/agents.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { HookRunner } from '../../src/harness/hooks.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import { libraryCommand } from '../../src/library/cli.js'
import { makeLibraryReadTool, makeLibraryWriteTool } from '../../src/tools/library.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { HarnessSessionController } from '../../src/harness/controller.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { makeSettingsSchema } from '../../src/brain/settings.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'
import { digest, type LibraryNote, type Review } from '../../src/library/core.js'

const roots: string[] = []
const controllers: HarnessSessionController[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(enabled = true, autocrlf = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'athena-library-integration-')); roots.push(cwd)
  mkdirSync(join(cwd, '.athena')); mkdirSync(join(cwd, 'reviews')); mkdirSync(join(cwd, 'empty-hooks'))
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=' + String(autocrlf), '-c', `core.hooksPath=${join(cwd, 'empty-hooks')}`, '-c', 'user.name=Synthetic Reviewer', '-c', 'user.email=fixture@example.invalid', ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--initial-branch=main')
  git('config', 'core.autocrlf', String(autocrlf))
  writeFileSync(join(cwd, 'detail.md'), autocrlf ? 'Detailed context retention rationale: keep original sources.\r\nQualify uncertain claims.\r\n' : 'Detailed context retention rationale: keep original sources and qualify uncertain claims.\n')
  writeFileSync(join(cwd, 'summary.md'), 'Retain source-linked context.\n')
  writeFileSync(join(cwd, 'check.mjs'), "import { readFileSync } from 'node:fs'; if (!readFileSync('detail.md','utf8').includes('original sources')) process.exit(1);\n")
  const config = LibraryConfigSchema.parse({ enabled, publicSources: ['detail.md', 'summary.md'], categories: ['context'], checks: [{ id: 'source-fixture', args: ['check.mjs'] }] })
  writeFileSync(join(cwd, '.athena', 'library.config.json'), JSON.stringify(config))
  git('add', '--', 'detail.md', 'summary.md', 'check.mjs', '.athena/library.config.json')
  git('commit', '--no-gpg-sign', '-m', 'synthetic original sources')
  const library = new LibraryRuntime(cwd, config)
  const input = { detailPath: 'detail.md', summaryPath: 'summary.md', categories: ['context'] }
  function reviewed(note: LibraryNote) {
    const stages: Review['stage'][] = ['request', 'implementation', 'verification', 'librarian']
    for (const stage of stages) writeFileSync(join(cwd, 'reviews', `${stage}.json`), JSON.stringify({ schemaVersion: 1, stage, noteId: note.id, reviewer: `synthetic-${stage}`, verdict: 'approve', rationale: `Synthetic fixture ${stage} independently inspects the declared source contract.` }, null, autocrlf ? 2 : undefined).replace(/\n/g, autocrlf ? '\r\n' : '\n'))
    git('add', '--', ...stages.map(stage => `reviews/${stage}.json`)); git('commit', '--no-gpg-sign', '-m', 'synthetic review evidence')
    const commit = git('rev-parse', 'HEAD')
    for (const stage of stages) library.review(note.id, commit, `reviews/${stage}.json`)
    return commit
  }
  return { cwd, git, config, library, input, reviewed }
}
async function controller(cwd: string, client: MockAnthropicClient) {
  const home = join(cwd, 'synthetic-home'); mkdirSync(home)
  const paths = resolveBrainPaths({ cwd, homeOverride: home })
  const value = await HarnessSessionController.create({ paths, effectivePaths: paths, cwd, client, provider: 'anthropic', settings: makeSettingsSchema().parse({ permissionMode: 'trusted' }), projectTrust: { trusted: true, allowProjectHooks: false, allowProjectMcp: false } })
  controllers.push(value); return value
}

describe('project librarian operator and tool interfaces', () => {
  it('uses Git canonical blobs for CRLF sources and multiline reviews under core.autocrlf=true', () => {
    const f = fixture(true, true)
    expect(readFileSync(join(f.cwd, 'detail.md'), 'utf8')).toContain('\r\n')
    expect(f.git('show', 'HEAD:detail.md')).not.toContain('\r')
    expect(f.git('diff', '--name-only', 'HEAD')).toBe('')
    const note = f.library.submit(f.input)
    const commit = f.reviewed(note)
    expect(readFileSync(join(f.cwd, 'reviews', 'librarian.json'), 'utf8')).toContain('\r\n')
    expect(f.library.promote(note.id, commit).note.status).toBe('durable')
    expect(f.library.retrieve({ keys: ['context'] })).toHaveLength(1)
    // Checkout line-ending representation is equivalent; semantic edits are not.
    const original = readFileSync(join(f.cwd, 'detail.md'), 'utf8')
    writeFileSync(join(f.cwd, 'detail.md'), original.replace(/\r\n/g, '\n'))
    expect(f.library.retrieve({ keys: ['context'] })).toHaveLength(1)
    writeFileSync(join(f.cwd, 'detail.md'), original.replace('Qualify', 'Discard'))
    expect(f.library.retrieve({ keys: ['context'] })).toEqual([])
  })
  it('refuses custom clean filters before hashing sources', () => {
    const f = fixture()
    writeFileSync(join(f.cwd, '.gitattributes'), 'detail.md filter=blocked\n')
    f.git('config', 'filter.blocked.clean', 'this-command-must-never-run')
    expect(() => f.library.submit(f.input)).toThrow('custom filters')
  })
  it('requires fresh verification when exact check arguments change, even with the same ID', () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    writeFileSync(join(f.cwd, 'failing.mjs'), 'process.exit(1)\n')
    const config = { ...f.config, checks: [{ id: 'source-fixture', args: ['failing.mjs'] }] }
    writeFileSync(join(f.cwd, '.athena', 'library.config.json'), JSON.stringify(config))
    f.git('add', '--', 'failing.mjs', '.athena/library.config.json'); f.git('commit', '--no-gpg-sign', '-m', 'synthetic changed check definition')
    const restarted = LibraryRuntime.open(f.cwd, true)!
    expect(restarted.retrieve({ keys: ['context'] })).toEqual([])
    expect(() => restarted.reverify(note.id, f.git('rev-parse', 'HEAD'))).toThrow('checks failed')
    writeFileSync(join(f.cwd, 'failing.mjs'), 'process.exit(0)\n')
    f.git('add', '--', 'failing.mjs'); f.git('commit', '--no-gpg-sign', '-m', 'synthetic fixed check')
    expect(restarted.reverify(note.id, f.git('rev-parse', 'HEAD')).note.checks?.[0]?.definitionHash).toBe(restarted.verifier.definitionHash(config.checks[0]!))
    expect(restarted.retrieve({ keys: ['context'] })).toHaveLength(1)
  })
  it('invalidates receipts when the executed entry script changes without renaming it', () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    writeFileSync(join(f.cwd, 'check.mjs'), 'process.exit(1)\n')
    expect(LibraryRuntime.open(f.cwd, true)!.retrieve({ keys: ['context'] })).toEqual([])
  })
  it('excludes legacy receipts missing their executed-definition digest', () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    const before = f.library.store.read()
    f.library.store.save(before.notes.map(item => ({ ...item, checks: item.checks?.map(({ definitionHash: _missing, ...receipt }) => receipt) })), before.revision)
    expect(LibraryRuntime.open(f.cwd, true)!.retrieve({ keys: ['context'] })).toEqual([])
  })
  it('executes checks against committed sources and returns detailed notes through the CLI', () => {
    const f = fixture(); const note = f.library.submit(f.input); const commit = f.reviewed(note)
    expect(f.library.promote(note.id, commit).checks).toEqual([expect.objectContaining({ id: 'source-fixture', passed: true })])
    expect(libraryCommand(f.cwd, 'retrieve', { keys: ['context'] })).toEqual([expect.objectContaining({ content: readFileSync(join(f.cwd, 'detail.md'), 'utf8').trim() })])
    expect(libraryCommand(f.cwd, 'retrieve', { keys: ['context'], shape: 'summary' })).toEqual([expect.objectContaining({ content: 'Retain source-linked context.' })])
    writeFileSync(join(f.cwd, 'detail.md'), 'Changed original sources.\n')
    expect(libraryCommand(f.cwd, 'retrieve', { keys: ['context'] })).toEqual([])
  })
  it('refuses self-attested review hashes, changed check scripts and failed real checks', () => {
    const f = fixture(); const note = f.library.submit(f.input)
    expect(() => f.library.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow('Four distinct')
    const before = f.library.store.read()
    const forged = { ...note, reviews: (['request', 'implementation', 'verification', 'librarian'] as const).map(stage => ({ stage, evidence: digest(stage), reviewer: 'self-attested' })) }
    f.library.store.save([forged], before.revision)
    expect(() => f.library.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow('hashes alone')
    f.library.store.save([note], f.library.store.read().revision)
    const commit = f.reviewed(note)
    writeFileSync(join(f.cwd, 'check.mjs'), 'process.exit(0)')
    expect(() => f.library.promote(note.id, commit)).toThrow('committed implementation')
    f.git('checkout', '--', 'check.mjs')
    writeFileSync(join(f.cwd, 'check.mjs'), 'process.exit(1)')
    f.git('add', '--', 'check.mjs'); f.git('commit', '--no-gpg-sign', '-m', 'synthetic failing check')
    expect(() => f.library.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow('checks failed')
  })
  it('does not let tool input invoke promotion or store arbitrary/unapproved/sensitive text', async () => {
    const f = fixture(); const tool = makeLibraryWriteTool(f.library); const ctx = makeCtx(f.cwd)
    expect(tool.schema.safeParse({ op: 'promote', id: 'a'.repeat(64) }).success).toBe(false)
    expect(tool.schema.safeParse({ op: 'submit', text: 'arbitrary content' }).success).toBe(false)
    const rejected = await tool.execute(tool.schema.parse({ op: 'submit', ...f.input, detailPath: 'check.mjs' }), ctx)
    expect(rejected.isError).toBe(true)
    writeFileSync(join(f.cwd, 'detail.md'), 'password=synthetic-only')
    expect((await tool.execute(tool.schema.parse({ op: 'submit', ...f.input }), ctx)).isError).toBe(true)
    expect(existsSync(join(f.cwd, '.athena', 'library', 'library.json'))).toBe(false)
  })
  it('keeps recovery candidates quarantined across restart and clears reviews on release', () => {
    const f = fixture(); const note = f.library.submit({ ...f.input, recovery: true })
    const restarted = LibraryRuntime.open(f.cwd, true)!
    expect(restarted.retrieve({ keys: ['context'] })).toEqual([])
    expect(() => restarted.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow()
    expect(restarted.release(note.id)).toMatchObject({ status: 'candidate', reviews: [] })
    restarted.reject(note.id)
    expect(restarted.submit(f.input).status).toBe('rejected')
  })
  it('supersedes atomically and rolls back only the exact reviewed revision', () => {
    const f = fixture(); const first = f.library.submit(f.input); f.library.promote(first.id, f.reviewed(first))
    writeFileSync(join(f.cwd, 'detail.md'), 'Revised detailed original sources rationale.\n')
    f.git('add', '--', 'detail.md'); f.git('commit', '--no-gpg-sign', '-m', 'synthetic revised source')
    const second = f.library.submit(f.input); const commit = f.reviewed(second)
    f.library.promote(second.id, commit, first.id)
    expect(f.library.store.read().notes.find(note => note.id === first.id)?.status).toBe('superseded')
    const revision = f.library.store.read().revision
    expect(() => f.library.rollback(second.id, 'wrong')).toThrow('changed')
    f.library.rollback(second.id, revision)
    expect(f.library.store.read().notes.find(note => note.id === first.id)?.status).toBe('durable')
    // Restoring status never makes the old, changed source eligible again.
    expect(f.library.retrieve({ keys: ['context'] })).toEqual([])
  })
  it('revokes an existing runtime immediately when public-source opt-in changes', () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    f.library.select({ keys: ['context'] })
    writeFileSync(join(f.cwd, '.athena', 'library.config.json'), JSON.stringify({ ...f.config, enabled: false }))
    expect(f.library.context()).not.toContain('Detailed context retention rationale')
    expect(() => f.library.submit(f.input)).toThrow('opt-in changed')
  })
  it('invalidates recall when committed review evidence is changed', () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    writeFileSync(join(f.cwd, 'reviews', 'librarian.json'), '{}')
    expect(f.library.retrieve({ keys: ['context'] })).toEqual([])
  })
  it('defaults disabled and ignores untrusted project opt-in', () => {
    const f = fixture(false)
    expect(loadLibraryConfig(f.cwd, true)).toBeNull()
    expect(libraryCommand(f.cwd, 'status')).toEqual({ enabled: false })
    expect(existsSync(join(f.cwd, '.athena', 'library'))).toBe(false)
    expect(loadLibraryConfig(f.cwd, false)).toBeNull()
  })
  it('runs the actual standalone CLI without the installed dist build', () => {
    const f = fixture(false)
    const output = execFileSync(process.execPath, ['--import', 'tsx', resolve('src/library/cli.ts'), 'status', f.cwd], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true })
    expect(JSON.parse(output)).toEqual({ enabled: false })
  })
})

describe('shared controller integration', () => {
  it('excludes stateful library tools from children and preserves the parent selection', async () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    f.library.select({ keys: ['context'] })
    const parentContext = f.library.context()
    const child = new MockAnthropicClient([
      { blocks: [toolUseBlock('child-lookup', 'LibraryRead', { keys: ['other-category'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Library is unavailable in this child.')], stopReason: 'end_turn' },
    ])
    const registry = new ToolRegistry()
    registry.register(makeLibraryReadTool(f.library) as ToolDefinition<never>)
    registry.register(makeLibraryWriteTool(f.library) as ToolDefinition<never>)
    const def: AgentDef = { name: 'synthetic-child', description: 'isolation test', tools: null, model: null, systemPrompt: 'Synthetic child.', file: 'synthetic.md' }
    const orchestrator = new AgentOrchestrator({ defs: [def], clientFactory: () => child, baseRegistry: registry,
      gate: { check: () => ({ decision: 'allow', reason: 'synthetic fixture' }), grantSession: () => {} },
      hooks: new HookRunner([]), defaultModel: () => 'sonnet', defaultEffort: () => 'high', systemPromptBase: 'Synthetic parent.' })
    expect(orchestrator.buildChildRegistry(def).list()).toEqual([])
    expect(orchestrator.buildChildRegistry({ ...def, tools: ['LibraryRead', 'LibraryWrite'] }).list()).toEqual([])
    expect((await orchestrator.runAgent(def, 'Request category B.', makeCtx(f.cwd))).isError).toBe(false)
    expect(JSON.stringify(child.calls[1])).toContain('Unknown tool')
    expect(f.library.context()).toBe(parentContext)
  })
  it('revalidates ephemeral notes and excludes their text from persistent sessions', async () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('lookup', 'LibraryRead', { keys: ['context'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Source-linked answer.')], stopReason: 'end_turn' },
      { blocks: [textBlock('A new turn.')], stopReason: 'end_turn' },
    ])
    const c = await controller(f.cwd, client)
    expect((await c.submitTurn('Recall context.')).status).toBe('completed')
    const detail = readFileSync(join(f.cwd, 'detail.md'), 'utf8').trim()
    expect(JSON.stringify(client.calls[1])).toContain(detail)
    expect(JSON.stringify(c.engine.getMessages())).not.toContain(detail)
    expect(readFileSync(c.session.file, 'utf8')).not.toContain(detail)
    expect(c.library?.status().recoveries.at(-1)?.status).toBe('completed')
    await c.submitTurn('A new unrelated turn.')
    expect(JSON.stringify(client.calls[2])).not.toContain(detail)
  })
  it('does not mount the tool or create library storage when disabled', async () => {
    const f = fixture(false)
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('lookup', 'LibraryRead', { keys: ['context'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Unavailable.')], stopReason: 'end_turn' },
    ])
    const c = await controller(f.cwd, client); await c.submitTurn('Lookup.')
    expect(c.library).toBeNull()
    expect(existsSync(join(f.cwd, '.athena', 'library'))).toBe(false)
    expect(JSON.stringify(c.engine.getMessages())).toContain('Unknown tool')
  })
  it('records an actually aborted controller turn as interrupted', async () => {
    const f = fixture(); const client = new MockAnthropicClient([{ blocks: [textBlock('unused')], stopReason: 'end_turn' }])
    const c = await controller(f.cwd, client)
    const turn = c.submitTurn('Synthetic interrupted turn.')
    c.abort()
    expect((await turn).status).toBe('aborted')
    expect(c.library?.status().recoveries.at(-1)?.status).toBe('interrupted')
  })
  it('fails soft on malformed opt-in without mounting a partially configured library', async () => {
    const f = fixture(); writeFileSync(join(f.cwd, '.athena', 'library.config.json'), '{torn')
    const c = await controller(f.cwd, new MockAnthropicClient([{ blocks: [textBlock('Still available.')], stopReason: 'end_turn' }]))
    expect(c.library).toBeNull()
    expect((await c.submitTurn('Synthetic normal turn.')).status).toBe('completed')
    expect(existsSync(join(f.cwd, '.athena', 'library'))).toBe(false)
  })
  it('bounds interrupted checkpoint metadata and never stores prompts', () => {
    const f = fixture(); const runId = '00000000-0000-4000-8000-000000000001'
    f.library.checkpoint(runId, 1, 'active')
    expect(LibraryRuntime.open(f.cwd, true)!.status().recoveries[0]?.status).toBe('unresolved')
    f.library.checkpoint(runId, 1, 'interrupted')
    expect(f.library.status().recoveries[0]?.status).toBe('interrupted')
    for (let turn = 2; turn <= 70; turn++) f.library.checkpoint(runId, turn, 'completed')
    expect(f.library.status().recoveries).toHaveLength(64)
    expect(Object.keys(f.library.status().recoveries[0]!)).toEqual(['id', 'runId', 'turn', 'status'])
  })
  it('returns IDs rather than durable content through the real read tool', async () => {
    const f = fixture(); const note = f.library.submit(f.input); f.library.promote(note.id, f.reviewed(note))
    const tool = makeLibraryReadTool(f.library)
    const result = await tool.execute(tool.schema.parse({ keys: ['context'] }), makeCtx(f.cwd))
    expect(result.isError).toBe(false); expect(result.output).toContain(note.id)
    expect(result.output).not.toContain('Detailed context retention rationale')
    expect(f.library.context()).toContain('Detailed context retention rationale')
    writeFileSync(join(f.cwd, 'detail.md'), 'Changed source.\n')
    expect(f.library.context()).not.toContain('Detailed context retention rationale')
  })
})
