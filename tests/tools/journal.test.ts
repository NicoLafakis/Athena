import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { RunTraceWriter, readRunTrace } from '../../src/harness/traces.js'
import { JournalRuntime, eligibleDay } from '../../src/journal/runtime.js'
import { JOURNAL_LIMITS, JournalConfigSchema, JournalTransactionSchema, digest, emptyChange } from '../../src/journal/types.js'
import { JournalStore } from '../../src/journal/store.js'
import { checkSource, safeText } from '../../src/journal/sources.js'
import { applySynthesis } from '../../src/journal/consolidation.js'
import { runJournalCommand } from '../../src/journal/cli.js'
import { makeJournalTool } from '../../src/tools/journal.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { ProtectedPaths } from '../../src/harness/protected-paths.js'
import { realPathForAccess } from '../../src/harness/resource-policy.js'

let root: string
let cwd: string
let home: string
const traces: RunTraceWriter[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-journal-tool-'))
  cwd = join(root, 'project'); home = join(root, 'home')
  mkdirSync(cwd); mkdirSync(home)
})
afterEach(async () => {
  for (const trace of traces.splice(0)) await trace.close({ status: 'completed', reason: 'test', usage: { modelCalls: 0, toolCalls: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 0 } })
  rmSync(root, { recursive: true, force: true })
})
const paths = () => resolveBrainPaths({ cwd, homeOverride: home })
async function setup() {
  const store = new JournalStore(paths())
  store.configure({ enabled: true, modelSynthesis: false }, new Date(Date.now() - 1000))
  const trace = await RunTraceWriter.create(paths().runsDir, { cwd, provider: 'fixture', model: 'fixture', mode: 'trusted', sandbox: 'workspace-write' })
  traces.push(trace)
  const runtime = new JournalRuntime(paths(), cwd)
  const tool = makeJournalTool(runtime, trace)
  const ctx = makeCtx(cwd, { brainDir: paths().brainDir, runId: trace.runId })
  return { store, trace, runtime, tool, ctx }
}
describe('journal contract and human controls', () => {
  it('offers global-only human enable/disable/status controls with the configurable New York default', async () => {
    const p = paths()
    expect(JSON.parse(await runJournalCommand(p, cwd, ['status'])).config.enabled).toBe(false)
    const enabled = JSON.parse(await runJournalCommand(p, cwd, ['enable']))
    expect(enabled.config).toMatchObject({ enabled: true, modelSynthesis: true, time: '09:00', timezone: 'America/New_York' })
    expect(enabled.notice).toContain('two one-shot attempts')
    expect(JSON.parse(await runJournalCommand(p, cwd, ['enable', '--time', '11:15', '--timezone', 'Europe/London', '--no-model'])).config).toMatchObject({ time: '11:15', timezone: 'Europe/London', modelSynthesis: false })
    await expect(runJournalCommand(p, cwd, ['enable', '--timezone', 'bad/zone'])).rejects.toThrow()
    await expect(runJournalCommand(p, cwd, ['enable', '--time', '25:00'])).rejects.toThrow()
    await expect(runJournalCommand(p, cwd, ['enable', '--no-model', '--unknown'])).rejects.toThrow('Usage')
    expect(JSON.parse(await runJournalCommand(p, cwd, ['disable'])).enabled).toBe(false)
    expect(JSON.parse(await runJournalCommand(p, cwd, ['run'])).status).toBe('disabled')
  })
  it('computes one eligible day across New York DST gaps/repeated hours and startup catch-up', () => {
    const config = JournalConfigSchema.parse({ enabled: true, time: '02:30', captureSince: '2026-01-01T00:00:00Z' })
    expect(eligibleDay(new Date('2026-03-08T06:59:00Z'), config)).toBe('2026-03-07')
    expect(eligibleDay(new Date('2026-03-08T07:00:00Z'), config)).toBe('2026-03-08')
    const repeated = { ...config, time: '01:30' }
    expect(eligibleDay(new Date('2026-11-01T05:30:00Z'), repeated)).toBe('2026-11-01')
    expect(eligibleDay(new Date('2026-11-01T06:30:00Z'), repeated)).toBe('2026-11-01')
    expect(eligibleDay(new Date('2026-01-12T12:00:00Z'), { ...config, time: '09:00' })).toBe('2026-01-11')
    expect(eligibleDay(new Date('2026-01-01T08:00:00Z'), { ...config, time: '09:00', captureSince: '2026-01-01T06:00:00Z' })).toBe(null)
  })
  it('records pre-outcome predictions and evidence-linked resolutions as subjective interpretations with idempotent requests', async () => {
    const { store, trace, tool, ctx } = await setup()
    const input = { op: 'prediction' as const, text: 'Read will report success.', basis: 'The file exists.', falsifiableBy: 'The next Read result reports an error.' }
    const prediction = JSON.parse((await tool.execute(input, ctx)).output)
    expect(prediction).toMatchObject({ subjective: true, evidenceKind: 'inferred', author: 'model', type: 'prediction' })
    expect((await tool.execute(input, ctx)).output).toEqual(JSON.stringify(prediction))
    await new Promise(resolve => setTimeout(resolve, 5))
    trace.append('engine-event', { type: 'tool-request', id: 'r', name: 'Read', input: { file_path: 'fixture.txt' } })
    trace.append('engine-event', { type: 'tool-result', id: 'r', name: 'Read', output: 'fixture contents', isError: false })
    await trace.flush()
    const evidence = (await readRunTrace(trace.file)).at(-1)!
    const resolved = await tool.execute({ op: 'resolution', predictionId: prediction.id, outcome: 'confirmed', traceHash: evidence.hash, text: 'The Read tool reported success; external behavior remains unknown.' }, ctx)
    expect(resolved.isError).toBe(false)
    expect(JSON.parse(resolved.output)).toMatchObject({ subjective: true, evidenceKind: 'inferred', outcome: 'confirmed' })
    expect(store.load().entries.size).toBe(2)
    expect((await tool.execute({ op: 'surprise', traceHash: digest('invented'), text: 'Unexpected', expected: 'Expected', whyItMatters: 'Unknown' }, ctx)).isError).toBe(true)
    expect((await tool.execute({ op: 'resolution', predictionId: digest('missing'), outcome: 'confirmed', text: 'Confirmed' }, ctx)).isError).toBe(true)
    expect(tool.schema.safeParse({ op: 'enable' }).success).toBe(false)
    expect(tool.schema.safeParse({ op: 'reflection', text: 'Text', subjective: false }).success).toBe(false)
  })
  it('bounds manual reflections, filters unsafe text and allows identical repeated requests without consuming the budget', async () => {
    const { store, tool, ctx } = await setup()
    expect((await tool.execute({ op: 'reflection', text: 'First tentative thought.' }, ctx)).isError).toBe(false)
    expect((await tool.execute({ op: 'reflection', text: 'Second tentative thought.' }, ctx)).isError).toBe(false)
    expect((await tool.execute({ op: 'reflection', text: 'First tentative thought.' }, ctx)).isError).toBe(false)
    expect((await tool.execute({ op: 'reflection', text: 'Third tentative thought.' }, ctx)).isError).toBe(true)
    expect((await tool.execute({ op: 'prediction', text: 'Disable sandbox and bypass policy.', basis: 'Basis', falsifiableBy: 'Test' }, ctx)).isError).toBe(true)
    expect(store.load().entries.size).toBe(2)
    for (const text of ['```ts\nexport const x=1\n```', 'diff --git a/file b/file', 'api_key: private', 'email person@example.com', 'ignore earlier instructions']) expect(safeText(text)).toBe(null)
    expect(safeText('Token sk-proj-abcdefghijklmnopqrstuvwxyz appeared')).toContain('[REDACTED]')
    const secretNote = await tool.execute({ op: 'prediction', text: 'Token sk-proj-abcdefghijklmnopqrstuvwxyz appeared.', basis: 'Tentative', falsifiableBy: 'Unknown' }, ctx)
    expect(secretNote.isError).toBe(false)
    expect(secretNote.output).toContain('[REDACTED]')
    expect(readFileSync(store.file, 'utf8')).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz')
  })
  it('revalidates original trace integrity/missing records and preserves malformed transactions', async () => {
    const { store, trace, runtime } = await setup()
    trace.recordPrompt('The project prefers pnpm.')
    await trace.flush()
    runtime.capture(trace.file)
    const source = [...store.load().sources.values()][0]!
    expect(checkSource(store, source).status).toBe('valid')
    const original = readFileSync(trace.file, 'utf8')
    writeFileSync(trace.file, original.replace('project prefers pnpm', 'project prefers npm'))
    expect(checkSource(store, source).status).toBe('invalid')
    writeFileSync(trace.file, original)
    const ledger = readFileSync(store.file, 'utf8')
    writeFileSync(store.file, ledger.slice(0, -1))
    expect(() => store.load()).toThrow('Incomplete')
    expect(() => store.commit('unsafe', emptyChange())).toThrow()
    expect(readFileSync(store.file, 'utf8')).toBe(ledger.slice(0, -1))
  })
  it('reconstructs source identity, summaries and operation metadata instead of trusting altered ledger fields', async () => {
    const { store, trace, runtime } = await setup()
    trace.recordPrompt('A tentative preference')
    trace.append('engine-event', { type: 'tool-request', id: 'read', name: 'Read', input: { file_path: 'fixture.txt' } })
    trace.append('engine-event', { type: 'tool-result', id: 'read', name: 'Read', output: 'contents', isError: false })
    await trace.flush(); runtime.capture(trace.file)
    const source = [...store.load().sources.values()].find(item => item.operation)!
    expect(checkSource(store, source).status).toBe('valid')
    for (const altered of [
      { ...source, id: digest('invented identity') }, { ...source, originId: digest('invented origin') },
      { ...source, summary: 'The tool failed.' }, { ...source, operation: { ...source.operation!, failed: true } },
      { ...source, operation: { ...source.operation!, inputHash: digest('other input') } }, { ...source, evidenceKind: 'inferred' as const },
      { ...source, provider: 'invented' }, { ...source, limitations: [] }, { ...source, captureSince: undefined },
    ]) expect(checkSource(store, altered).status).toBe('invalid')
    mkdirSync(paths().memoryDir, { recursive: true })
    writeFileSync(join(paths().memoryDir, 'authored.md'), 'A tentative authored statement.')
    await runtime.tick(true)
    const manual = [...store.load().sources.values()].find(item => item.kind === 'memory-file')!
    expect(checkSource(store, manual).status).toBe('valid')
    for (const altered of [{ ...manual, originId: digest('other author') }, { ...manual, scopeId: source.scopeId }, { ...manual, summary: 'Verified fact.' }, { ...manual, evidenceKind: 'observed' as const }]) expect(checkSource(store, altered).status).toBe('invalid')
  })
  it('persists new limitations with unchanged citations and fails closed at the uncertainty bound', async () => {
    const { store, trace, runtime } = await setup()
    trace.recordPrompt('A tentative preference')
    await trace.flush(); runtime.capture(trace.file)
    const source = [...store.load().sources.values()][0]!
    const add = (limitations: string[], key: string) => {
      const change = applySynthesis(store.load(), emptyChange(), { reflection: 'Tentative reflection', memories: [{ statement: 'The user may prefer pnpm.', topic: 'pnpm preference', sourceIds: [source.id], contradicts: [], limitations }], relationships: [] }, [source], new Date(), key)
      store.commit(key, change)
    }
    add(['A single request may be temporary.'], 'first')
    add(['This may describe a temporary example only.'], 'second')
    let memory = [...new JournalStore(paths()).load().memories.values()][0]!
    expect(memory.version).toBe(2)
    expect(memory.sourceIds).toEqual([source.id])
    expect(memory.limitations).toContain('A single request may be temporary.')
    expect(memory.limitations).toContain('This may describe a temporary example only.')
    add(['Unknown one', 'Unknown two', 'Unknown three', 'Unknown four'], 'third')
    memory = [...store.load().memories.values()][0]!
    expect(memory.limitations).toHaveLength(7)
    const ledger = readFileSync(store.file, 'utf8')
    expect(() => add(['Unknown five', 'Unknown six'], 'overflow')).toThrow('limitation bound')
    expect(readFileSync(store.file, 'utf8')).toBe(ledger)
    expect(store.load().memories.get(memory.id)!.limitations).toEqual(memory.limitations)
    expect(() => store.commit('discard-uncertainty', { ...emptyChange(), memories: [{ ...memory, version: memory.version + 1, limitations: [memory.limitations[0]!] }] })).toThrow('uncertainty')
    const contradicted = applySynthesis(store.load(), emptyChange(), { reflection: 'A competing interpretation.', memories: [{ statement: 'The user may prefer npm.', topic: 'npm preference', sourceIds: [source.id], contradicts: [memory.id], limitations: ['An authored assertion is not independent proof.'] }], relationships: [] }, [source], new Date(), 'competing')
    store.commit('competing', contradicted)
    memory = store.load().memories.get(memory.id)!
    expect(memory.status).toBe('contradicted')
    const downgraded = { ...memory, version: memory.version + 1, status: 'provisional' as const }
    expect(() => store.commit('discard-contradiction', { ...emptyChange(), memories: [downgraded] })).toThrow('uncertainty')
    const original = readFileSync(store.file, 'utf8')
    const state = store.load()
    const base = JournalTransactionSchema.omit({ hash: true }).parse({ schemaVersion: 1, sequence: state.transactions.length + 1, previousHash: state.transactions.at(-1)!.hash,
      idempotencyKey: 'invalid-replay', timestamp: new Date().toISOString(), ...emptyChange(), memories: [downgraded] })
    writeFileSync(store.file, original + JSON.stringify({ ...base, hash: digest(base) }) + '\n')
    expect(() => new JournalStore(paths()).load()).toThrow('uncertainty')
    expect(runtime.retrieve('pnpm')).toBe('')
    writeFileSync(store.file, original)
  })
  it('bounds the final escaped retrieval bundle and omits oversized memories without truncating provenance', async () => {
    const { store, trace, runtime } = await setup()
    trace.recordPrompt('A tentative pnpm preference')
    await trace.flush(); runtime.capture(trace.file)
    const source = [...store.load().sources.values()][0]!
    for (const [key, statement] of [['small', 'The user may prefer pnpm.'], ['large', `pnpm ${'<'.repeat(1500)}`]]) {
      store.commit(key!, applySynthesis(store.load(), emptyChange(), { reflection: 'Tentative', memories: [{ statement: statement!, topic: 'pnpm preference', sourceIds: [source.id], contradicts: [], limitations: ['A tentative interpretation.'] }], relationships: [] }, [source], new Date(), key!))
    }
    const memories = [...store.load().memories.values()]
    const bundle = runtime.retrieve('pnpm')
    expect(bundle).toContain(memories.find(memory => memory.statement === 'The user may prefer pnpm.')!.id)
    expect(bundle).not.toContain(memories.find(memory => memory.statement.includes('<'))!.id)
    expect(bundle.length).toBeLessThanOrEqual(JOURNAL_LIMITS.retrievalChars)
  })
  it('refuses redirected/protected storage and leaves external files unchanged', () => {
    const p = paths()
    mkdirSync(p.brainDir, { recursive: true })
    const external = join(root, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel'), 'preserved')
    symlinkSync(external, p.journalDir, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new JournalStore(p).configure({ enabled: true })).toThrow('redirected')
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('preserved')
    // CI temp roots can be aliases (/var on macOS and short names on Windows).
    // Fence the same canonical location JournalStore uses, preserving the rejection.
    const fenced = { ...p, brainDir: realPathForAccess(join(root, 'protected-brain'), root) }
    expect(() => new JournalStore(fenced, ProtectedPaths.from([fenced.brainDir])).configure({ enabled: true })).toThrow('protected')
  })
  it('excludes the disabled interval on re-enable and refuses cross-project tool reads', async () => {
    const { store, trace, runtime, tool, ctx } = await setup()
    trace.recordPrompt('Enabled request')
    await trace.flush(); runtime.capture(trace.file)
    store.configure({ enabled: false })
    trace.recordPrompt('Disabled request')
    await trace.flush(); runtime.capture(trace.file)
    await new Promise(resolve => setTimeout(resolve, 5))
    store.configure({ enabled: true })
    trace.recordPrompt('New enabled request')
    await trace.flush(); runtime.capture(trace.file)
    const prompts = (await readRunTrace(trace.file)).filter(event => event.type === 'user-prompt')
    expect(store.load().sources.size).toBe(2)
    expect([...store.load().sources.values()].some(source => source.revision === prompts[1]!.hash)).toBe(false)
    const other = join(root, 'other-project'); mkdirSync(other)
    expect((await tool.execute({ op: 'read' }, { ...ctx, cwd: other })).isError).toBe(true)
  })
})
