import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeInvestigationTool } from '../../src/tools/investigation.js'
import { InvestigationInput, type InvestigationReport, type InvestigationDraft } from '../../src/investigation/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { toolInputSchema } from '../../src/engine/loop.js'
import { createHash } from 'node:crypto'
import { ProtectedPaths } from '../../src/harness/protected-paths.js'

let root: string
let tool: ReturnType<typeof makeInvestigationTool>
let ctx: ReturnType<typeof makeCtx>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-investigation-'))
  writeFileSync(join(root, 'feature.ts'), 'export function price() { return 20 }\n')
  writeFileSync(join(root, 'decoy.ts'), '// price used to return 10\n')
  ctx = makeCtx(root, { brainDir: join(root, '.brain'), runId: 'run-a', toolCallId: 'call-a' })
  tool = makeInvestigationTool()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function call(input: unknown, selected = tool): Promise<InvestigationReport> {
  const out = await selected.execute(InvestigationInput.parse(input), ctx)
  if (out.isError) throw new Error(out.output)
  return JSON.parse(out.output) as InvestigationReport
}

async function begin() {
  const started = await call({ op: 'start', question: 'Trace the price implementation', files: ['feature.ts', 'decoy.ts'] })
  return call({ op: 'read', id: started.id, file_path: 'feature.ts', offset: 1, limit: 1 })
}

function draft(evidence: string): InvestigationDraft {
  return {
    hypotheses: [
      { id: 'live', statement: 'The implementation returns 20', supports: [evidence], counterevidence: [] },
      { id: 'old', statement: 'The implementation returns 10', supports: [], counterevidence: [evidence] },
    ],
    claims: [{ id: 'literal', statement: 'The observed line contains return 20', scope: 'source-text', evidenceIds: [evidence], counterevidenceIds: [], testIds: ['live-test'] }],
    tests: [
      { id: 'live-test', hypothesisId: 'live', provider: 'source-text', observationId: evidence, contains: 'return 20', expect: 'present' },
      { id: 'old-test', hypothesisId: 'old', provider: 'source-text', observationId: evidence, contains: 'return 10', expect: 'present' },
    ],
    unknowns: [],
  }
}

async function submit(report: InvestigationReport, result = draft(report.observations[0]!.id)) {
  return call({ op: 'submit', id: report.id, expectedVersion: report.version, result })
}

describe('bounded source investigation', () => {
  it('advertises its operation and result contract to the model rather than an empty schema', () => {
    const schema = toolInputSchema(tool)
    expect((schema.properties as Record<string, unknown>)['op']).toMatchObject({ enum: ['start', 'read', 'note', 'submit', 'complete', 'result'] })
    expect(JSON.stringify(schema)).toContain('hypothesisId')
    expect(JSON.stringify(schema)).toContain('expectedVersion')
    expect(JSON.stringify(schema)).toContain('counterevidenceIds')
  })
  it('traces a small feature with competing hypotheses and actual Read evidence', async () => {
    const read = await begin()
    expect(ctx.fileReadRegistry.has(join(root, 'feature.ts'))).toBe(true)
    expect(read.target.revision.files.every(file => file.hash !== null)).toBe(true)
    expect(read.observations[0]).toMatchObject({ kind: 'observed', tool: { name: 'Read', version: '1' }, runId: 'run-a', toolCallId: 'call-a' })
    const recorded = await submit(read)
    const complete = await call({ op: 'complete', id: recorded.id })
    expect(complete.verification.complete).toBe(true)
    expect(complete.verification.tests.map(test => test.status)).toEqual(['passed', 'failed'])
    expect(complete.verification.claims[0]).toMatchObject({ status: 'passed', independentEvidenceCount: 1 })
    expect(complete.limitations.join(' ')).toContain('static')
  })

  it('rejects a misleading search path and distinguishes text from behavior', async () => {
    const started = await begin()
    const decoy = await call({ op: 'read', id: started.id, file_path: 'decoy.ts', offset: 1, limit: 1 })
    const result = draft(decoy.observations[1]!.id)
    result.claims[0]!.scope = 'source-behavior'
    result.claims[0]!.statement = 'Price currently returns 10 because a comment says so'
    result.tests[0]!.contains = 'return 10'
    const recorded = await submit(decoy, result)
    expect(recorded.verification.claims[0]!.status).toBe('unknown')
    expect(recorded.verification.complete).toBe(false)
    expect((await tool.execute({ op: 'complete', id: recorded.id }, ctx)).isError).toBe(true)
  })

  it('does not inflate confidence for repeated requests, duplicate ranges, or repeated assertions', async () => {
    const first = await begin()
    ctx.toolCallId = 'repeated-call'
    const repeated = await call({ op: 'read', id: first.id, file_path: 'feature.ts', offset: 1, limit: 1 })
    expect(repeated.version).toBe(first.version)
    expect(repeated.observations).toEqual(first.observations)
    const noted = await call({ op: 'note', id: first.id, expectedVersion: first.version, kind: 'inferred', statement: 'It must return 20 at runtime', evidenceIds: [first.observations[0]!.id], limitations: ['No runtime observation'] })
    const result = draft(first.observations[0]!.id)
    result.claims[0]!.evidenceIds.push(noted.observations[1]!.id, first.observations[0]!.id)
    const recorded = await submit(noted, result)
    const repeatedSubmit = await call({ op: 'submit', id: recorded.id, expectedVersion: noted.version, result })
    expect(repeatedSubmit.version).toBe(recorded.version)
    expect(recorded.verification.claims[0]!.independentEvidenceCount).toBe(1)
  })

  it('keeps derived and inferred notes separate and never upgrades them into observations', async () => {
    const read = await begin()
    const noted = await call({ op: 'note', id: read.id, expectedVersion: read.version, kind: 'derived', statement: 'The visible implementation is consistent with the hypothesis', evidenceIds: [read.observations[0]!.id], limitations: ['No call graph or execution'] })
    expect(noted.observations.map(e => e.kind)).toEqual(['observed', 'derived'])
    const result = draft(noted.observations[1]!.id)
    const recorded = await submit(noted, result)
    expect(recorded.verification.claims[0]!.status).toBe('unknown')
  })

  it('makes contradictory observed evidence block a pass', async () => {
    const read = await begin()
    const decoy = await call({ op: 'read', id: read.id, file_path: 'decoy.ts', offset: 1, limit: 1 })
    const result = draft(read.observations[0]!.id)
    result.claims[0]!.counterevidenceIds = [decoy.observations[1]!.id]
    const recorded = await submit(decoy, result)
    expect(recorded.verification.claims[0]!.status).toBe('contradicted')
    expect(recorded.verification.complete).toBe(false)
  })

  it('cannot complete with an unsupported alternative, contradicted selected hypothesis, or nondiscriminating tests', async () => {
    const read = await begin()
    const incomplete = draft(read.observations[0]!.id)
    incomplete.hypotheses[0]!.counterevidence = [read.observations[0]!.id]
    incomplete.tests[1]!.provider = 'runtime'
    const recorded = await submit(read, incomplete)
    expect(recorded.verification.complete).toBe(false)
    const newRead = await begin()
    const newDraft = draft(newRead.observations[0]!.id)
    newDraft.hypotheses[1]!.counterevidence = []
    newDraft.tests[1]!.contains = 'return 20'
    expect((await submit(newRead, newDraft)).verification.complete).toBe(false)
  })

  it('marks verification stale after a behavior-changing dirty revision, including reload', async () => {
    const read = await begin()
    const recorded = await submit(read)
    const completed = await call({ op: 'complete', id: recorded.id })
    writeFileSync(join(root, 'feature.ts'), 'export function price() { return 99 }\n')
    const reloaded = await call({ op: 'result', id: completed.id }, makeInvestigationTool())
    expect(reloaded.verification.claims[0]!.status).toBe('stale')
    expect(reloaded.verification.complete).toBe(false)
    expect(reloaded.target.revision.id).not.toBe(reloaded.verification.currentRevision.id)
    expect((await tool.execute({ op: 'read', id: read.id, file_path: 'feature.ts' }, ctx)).isError).toBe(true)
  })

  it('records Git HEAD and invalidates a changed commit even if the selected file is unchanged', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
    git('init')
    git('add', 'feature.ts', 'decoy.ts')
    git('-c', 'user.name=Athena test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture')
    const read = await begin()
    expect(read.target.revision.gitHead).toMatch(/^[a-f0-9]{40}$/)
    const recorded = await submit(read)
    git('-c', 'user.name=Athena test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'revision')
    expect((await call({ op: 'result', id: recorded.id })).verification.claims[0]!.status).toBe('stale')
  })

  it('preserves a missing runtime provider and cannot use a unit assertion to pass runtime behavior', async () => {
    const read = await begin()
    const result = draft(read.observations[0]!.id)
    result.claims[0]!.scope = 'runtime'
    result.tests[0]!.provider = 'unit'
    result.unknowns = [{ id: 'runtime-gap', question: 'What happens in the actual runtime?', requiredProvider: 'runtime', evidenceIds: [read.observations[0]!.id] }]
    const recorded = await submit(read, result)
    expect(recorded.verification.tests[0]).toMatchObject({ status: 'unsupported' })
    expect(recorded.verification.claims[0]!.status).toBe('unsupported')
    expect(recorded.verification.remainingUnknowns).toEqual(result.unknowns)
    expect(recorded.verification.complete).toBe(false)
  })

  it('persists immutable versions with hash integrity, reloads, and fails closed on malformed history', async () => {
    const read = await begin()
    const recorded = await submit(read)
    const loaded = await call({ op: 'result', id: read.id }, makeInvestigationTool())
    expect(loaded.observations).toEqual(recorded.observations)
    expect(loaded.version).toBe(recorded.version)
    const lines = readFileSync(loaded.ledgerFile, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(recorded.version)
    const entry = JSON.parse(lines[0]!)
    entry.snapshot.target.question = 'tampered'
    writeFileSync(loaded.ledgerFile, JSON.stringify(entry) + '\n' + lines.slice(1).join('\n') + '\n')
    expect((await tool.execute({ op: 'result', id: loaded.id }, ctx)).isError).toBe(true)
    appendFileSync(loaded.ledgerFile, '{broken\n')
    expect((await tool.execute({ op: 'complete', id: loaded.id }, ctx)).isError).toBe(true)
  })

  it('does not treat a rehashed forged observation as true source evidence', async () => {
    const read = await begin()
    const result = draft(read.observations[0]!.id)
    result.tests[0]!.contains = 'return 99'
    const recorded = await submit(read, result)
    const lines = readFileSync(recorded.ledgerFile, 'utf8').trim().split('\n')
    let previousHash: string | null = null
    const forged = lines.map(line => {
      const entry = JSON.parse(line)
      for (const observation of entry.snapshot.observations) observation.text = observation.text.replace('return 20', 'return 99')
      entry.previousHash = previousHash
      delete entry.hash
      entry.hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex')
      previousHash = entry.hash
      return JSON.stringify(entry)
    })
    writeFileSync(recorded.ledgerFile, forged.join('\n') + '\n')
    const reloaded = await call({ op: 'result', id: recorded.id }, makeInvestigationTool())
    expect(reloaded.ledgerIntegrity).toBe('valid')
    expect(reloaded.verification.claims[0]!.status).toBe('unknown')
    expect(reloaded.verification.complete).toBe(false)
  })

  it('rejects forged outcomes, cross-investigation evidence, stale writes, and malformed inputs', async () => {
    expect(InvestigationInput.safeParse({ op: 'start', question: '', files: [] }).success).toBe(false)
    expect(InvestigationInput.safeParse({ op: 'read', id: '../escape', file_path: 'feature.ts' }).success).toBe(false)
    const read = await begin()
    const result = draft('a'.repeat(64))
    expect((await tool.execute({ op: 'submit', id: read.id, expectedVersion: read.version, result }, ctx)).isError).toBe(true)
    expect((await tool.execute({ op: 'submit', id: read.id, expectedVersion: 0, result: draft(read.observations[0]!.id) }, ctx)).isError).toBe(true)
    expect(InvestigationInput.safeParse({ op: 'submit', id: read.id, expectedVersion: read.version, result: { ...draft(read.observations[0]!.id), complete: true } }).success).toBe(false)
    expect((await tool.execute({ op: 'read', id: read.id, file_path: '../feature.ts' }, ctx)).isError).toBe(true)
  })

  it('does not certify missing files, absent tests, redacted evidence, or an empty selected range', async () => {
    const missing = await call({ op: 'start', question: 'Inspect missing input', files: ['missing.ts'] })
    expect(missing.target.revision.files[0]!.hash).toBe(null)
    expect(missing.verification.complete).toBe(false)
    const read = await begin()
    const empty = await call({ op: 'read', id: read.id, file_path: 'feature.ts', offset: 900, limit: 1 })
    const result = draft(empty.observations.at(-1)!.id)
    result.tests[0]!.expect = 'absent'
    const recorded = await submit(empty, result)
    expect(recorded.verification.claims[0]!.status).toBe('unknown')
    writeFileSync(join(root, 'feature.ts'), 'const apiKey = "sk-proj-123456789012345678901234"\n')
    const secretStart = await call({ op: 'start', question: 'Read redacted evidence', files: ['feature.ts'] })
    const secretRead = await call({ op: 'read', id: secretStart.id, file_path: 'feature.ts', offset: 1, limit: 1 })
    expect(readFileSync(secretRead.ledgerFile, 'utf8')).not.toContain('sk-proj-1234')
    const secretDraft = draft(secretRead.observations[0]!.id)
    secretDraft.tests[0]!.expect = 'absent'
    secretDraft.tests[0]!.contains = 'sk-proj-1234'
    expect((await submit(secretRead, secretDraft)).verification.claims[0]!.status).toBe('unknown')
  })

  it('isolates completion checks by run and releases the check after the turn', async () => {
    await begin()
    expect(await tool.completionCheck!(makeCtx(root, { ...ctx, runId: 'other-run' }))).toBe(null)
    expect(await tool.completionCheck!(ctx)).toContain('not verified')
    expect(await tool.completionCheck!(ctx)).toBe(null)
  })

  it('does not leave a phantom completion check after a failed start followed by a valid retry', async () => {
    const invalid = await tool.execute({ op: 'start', question: 'Invalid path', files: ['../outside.ts'] }, ctx)
    expect(invalid.isError).toBe(true)
    const read = await begin()
    await submit(read)
    expect(await tool.completionCheck!(ctx)).toBe(null)
  })

  it('explicitly refuses another project namespace instead of treating its ledger ID as shared evidence', async () => {
    const read = await begin()
    const other = mkdtempSync(join(tmpdir(), 'athena-investigation-other-project-'))
    try {
      writeFileSync(join(other, 'feature.ts'), 'export function price() { return 20 }\n')
      const otherCtx = makeCtx(other, { brainDir: ctx.brainDir, runId: 'other-project' })
      const result = await tool.execute({ op: 'result', id: read.id }, otherCtx)
      expect(result.isError).toBe(true)
      expect(result.output).toContain('Unknown investigation')
    } finally { rmSync(other, { recursive: true, force: true }) }
  })

  it('cannot silently discard an unknown or downgrade a missing provider after recording it', async () => {
    const read = await begin()
    const result = draft(read.observations[0]!.id)
    result.tests[1]!.provider = 'runtime'
    result.unknowns = [{ id: 'runtime', question: 'Runtime behavior is unobserved', requiredProvider: 'runtime', evidenceIds: [] }]
    const recorded = await submit(read, result)
    const changed = { ...result, unknowns: [] }
    const output = await tool.execute({ op: 'submit', id: read.id, expectedVersion: recorded.version, result: changed }, ctx)
    expect(output.isError).toBe(true)
    expect(output.output).toContain('cannot be discarded')
    const downgraded = structuredClone(result)
    downgraded.tests[1]!.provider = 'source-text'
    expect((await tool.execute({ op: 'submit', id: read.id, expectedVersion: recorded.version, result: downgraded }, ctx)).isError).toBe(true)
  })

  it('retains hypothesis counterevidence and required predictions across report versions', async () => {
    const read = await begin()
    const result = draft(read.observations[0]!.id)
    result.hypotheses[0]!.counterevidence = [read.observations[0]!.id]
    const recorded = await submit(read, result)
    const erased = structuredClone(result)
    erased.hypotheses[0]!.counterevidence = []
    expect((await tool.execute({ op: 'submit', id: read.id, expectedVersion: recorded.version, result: erased }, ctx)).isError).toBe(true)
    const changedPrediction = structuredClone(result)
    changedPrediction.tests[1]!.contains = 'return 999'
    expect((await tool.execute({ op: 'submit', id: read.id, expectedVersion: recorded.version, result: changedPrediction }, ctx)).isError).toBe(true)
  })

  it('keeps invalid UTF-8, binary, oversized, and truncated source explicitly unsupported or unknown', async () => {
    for (const bytes of [Buffer.from([0xff, 0xfe, 0xff]), Buffer.from([0x61, 0x00]), Buffer.alloc(1_000_001, 0x61)]) {
      writeFileSync(join(root, 'unsupported.dat'), bytes)
      const started = await call({ op: 'start', question: 'Probe source boundary', files: ['unsupported.dat'] })
      expect(started.target.revision.files[0]!.hash).toBe(null)
      expect(started.target.revision.files[0]!.problem).toBeTruthy()
      expect(started.verification.complete).toBe(false)
    }
    writeFileSync(join(root, 'feature.ts'), 'a'.repeat(20_001) + '\n')
    const read = await begin()
    expect(read.observations[0]!.usable).toBe(false)
    expect((await submit(read)).verification.complete).toBe(false)
  })

  it('rejects redirected ledger directories and applies the existing protected-path fence', async () => {
    mkdirSync(ctx.brainDir, { recursive: true })
    const outside = join(root, 'outside-ledgers')
    mkdirSync(outside)
    symlinkSync(outside, join(ctx.brainDir, 'investigations'), process.platform === 'win32' ? 'junction' : 'dir')
    const output = await tool.execute({ op: 'start', question: 'Reject redirected store', files: ['feature.ts'] }, ctx)
    expect(output.isError).toBe(true)
    expect(readdirSync(outside)).toEqual([])
    const fenced = makeInvestigationTool(ProtectedPaths.from([ctx.brainDir]))
    expect((await fenced.execute({ op: 'start', question: 'Protected store', files: ['feature.ts'] }, ctx)).isError).toBe(true)
  })
})
