import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrainPaths } from '../brain/paths.js'
import { atomicWriteFileSync } from '../tools/files.js'
import {
  LearningCandidateSchema,
  type LearningCandidate,
} from './types.js'
import { TraceWarehouse, type TraceRecord } from './warehouse.js'

const TRANSITIONS: Record<LearningCandidate['status'], LearningCandidate['status'][]> = {
  provisional: ['evaluated', 'rejected'],
  evaluated: ['approved', 'rejected'],
  rejected: [],
  approved: ['canary', 'rejected'],
  canary: ['promoted', 'rolled-back'],
  promoted: ['rolled-back'],
  'rolled-back': [],
}

interface CandidateStatusRecord {
  schemaVersion: 1
  candidateId: string
  status: LearningCandidate['status']
  timestamp: string
  reason: string
}

function candidateFile(paths: BrainPaths, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(`Invalid candidate id: ${id}`)
  return join(paths.learningCandidatesDir, `${id}.json`)
}

function statusFile(paths: BrainPaths, id: string): string {
  return join(paths.learningCandidatesDir, `${id}.status.jsonl`)
}

export class CandidateStore {
  constructor(private readonly paths: BrainPaths) {}

  save(candidate: LearningCandidate): void {
    const parsed = LearningCandidateSchema.parse(candidate)
    const file = candidateFile(this.paths, parsed.id)
    if (existsSync(file)) throw new Error(`Candidate ${parsed.id} already exists`)
    atomicWriteFileSync(file, JSON.stringify(parsed, null, 2) + '\n')
  }

  load(id: string): LearningCandidate {
    const file = candidateFile(this.paths, id)
    if (!existsSync(file)) throw new Error(`Unknown candidate ${id}`)
    const candidate = LearningCandidateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    const statuses = this.statuses(id)
    return statuses.length ? { ...candidate, status: statuses.at(-1)!.status } : candidate
  }

  list(): LearningCandidate[] {
    if (!existsSync(this.paths.learningCandidatesDir)) return []
    return readdirSync(this.paths.learningCandidatesDir)
      .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
      .map((file) => this.load(file.slice(0, -5)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  transition(id: string, status: LearningCandidate['status'], reason: string): void {
    const candidate = this.load(id)
    if (!TRANSITIONS[candidate.status].includes(status)) {
      throw new Error(`Invalid candidate transition ${candidate.status} -> ${status}`)
    }
    const record: CandidateStatusRecord = {
      schemaVersion: 1,
      candidateId: id,
      status,
      timestamp: new Date().toISOString(),
      reason,
    }
    const file = statusFile(this.paths, id)
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
    atomicWriteFileSync(file, previous + JSON.stringify(record) + '\n')
  }

  statuses(id: string): CandidateStatusRecord[] {
    const file = statusFile(this.paths, id)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CandidateStatusRecord)
  }
}

function lessonFor(record: TraceRecord): string {
  if (record.status === 'limit') {
    return `Runs like ${record.runId} exhausted a configured budget; narrow the task or reduce tool/model cycles before retrying.`
  }
  if (record.safetyDenials > 0) {
    return `Runs like ${record.runId} encountered a trust or permission boundary; plan within the approved sandbox and request authority explicitly when needed.`
  }
  if (record.toolErrors > 0) {
    return `Runs like ${record.runId} produced tool errors; validate preconditions and inspect tool results before continuing.`
  }
  if (record.status === 'error' || record.fatalErrors > 0) {
    return `Runs like ${record.runId} failed at the provider/runtime boundary; preserve the trace and retry only after diagnosing the terminal error.`
  }
  return `Run ${record.runId} completed; retain its successful task pattern as a provisional, scoped hypothesis pending held-out evaluation.`
}

function memoryPatch(id: string, statement: string, records: TraceRecord[]): string {
  const path = `.athena/learned/${id}.md`
  const body = [
    '---',
    `candidate: ${id}`,
    `source-runs: ${records.map((record) => record.runId).join(', ')}`,
    'status: provisional',
    '---',
    statement,
    '',
  ]
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`,
    ...body.map((line) => `+${line}`),
    '',
  ].join('\n')
}

/** Conservative reflection: one or more immutable traces can create a
 * low-confidence memory hypothesis, never a trusted procedure or code edit. */
export async function reflectTraces(
  paths: BrainPaths,
  runIds: string[],
  generator = 'athena-reflector',
): Promise<LearningCandidate> {
  const records = await new TraceWarehouse(paths.runsDir).requireEvidence(runIds)
  const id = randomUUID()
  const statement = records.map(lessonFor).join(' ')
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString()
  const candidate = LearningCandidateSchema.parse({
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    sourceRunIds: records.map((record) => record.runId),
    hypothesis: statement,
    target: 'memory',
    patch: memoryPatch(id, statement, records),
    expectedMetricDelta: { taskSuccessRate: 0.01, safetyViolations: 0 },
    applicability: ['tasks matching the source-run failure or success mode'],
    counterexamples: ['unrelated projects', 'tasks with different tool or permission constraints'],
    confidence: 0.25,
    expiresAt: expires,
    provenance: {
      traceHashes: records.map((record) => record.finalHash),
      generator,
      generatorVersion: '1',
    },
    status: 'provisional',
  })
  new CandidateStore(paths).save(candidate)
  return candidate
}

export async function admitCandidate(
  paths: BrainPaths,
  raw: unknown,
): Promise<LearningCandidate> {
  const candidate = LearningCandidateSchema.parse(raw)
  const evidence = await new TraceWarehouse(paths.runsDir).requireEvidence(candidate.sourceRunIds)
  const actual = evidence.map((record) => record.finalHash)
  if (
    actual.length !== candidate.provenance.traceHashes.length ||
    actual.some((hash, index) => hash !== candidate.provenance.traceHashes[index])
  ) {
    throw new Error('Candidate provenance hashes do not match its immutable source traces')
  }
  new CandidateStore(paths).save(candidate)
  return candidate
}
