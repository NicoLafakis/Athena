import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync, fstatSync, fsyncSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../engine/types.js'
import { projectId } from '../harness/trust.js'
import { ProtectedPaths } from '../harness/protected-paths.js'
import { realPathForAccess } from '../harness/resource-policy.js'
import { redactSessionValue } from '../harness/redaction.js'
import { digest } from './source.js'
import { InvestigationSnapshotSchema, validateLinks, type InvestigationSnapshot } from './types.js'

const EntrySchema = z.object({
  schemaVersion: z.literal(1), sequence: z.number().int().positive(),
  previousHash: z.string().nullable(), snapshot: InvestigationSnapshotSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const MAX_BYTES = 4_000_000
const MAX_VERSIONS = 128

function validateTransition(before: InvestigationSnapshot, after: InvestigationSnapshot): void {
  if (!before.result) return
  if (!after.result) throw new Error('Recorded result cannot be discarded')
  for (const unknown of before.result.unknowns) {
    if (!after.result.unknowns.some(item => digest(item) === digest(unknown))) throw new Error(`Unknown ${unknown.id} cannot be discarded; start a new investigation for a changed scope`)
  }
  for (const claim of before.result.claims) {
    const updated = after.result.claims.find(item => item.id === claim.id)
    if (!updated || updated.scope !== claim.scope || claim.counterevidenceIds.some(id => !updated.counterevidenceIds.includes(id))) throw new Error(`Claim ${claim.id} cannot lose its scope or counterevidence`)
    if (claim.testIds.some(id => !updated.testIds.includes(id))) throw new Error(`Claim ${claim.id} cannot discard required tests`)
  }
  for (const hypothesis of before.result.hypotheses) {
    const updated = after.result.hypotheses.find(item => item.id === hypothesis.id)
    if (!updated || hypothesis.counterevidence.some(id => !updated.counterevidence.includes(id))) throw new Error(`Hypothesis ${hypothesis.id} cannot discard its counterevidence`)
  }
  for (const test of before.result.tests) {
    const updated = after.result.tests.find(item => item.id === test.id)
    if (!updated || digest(updated) !== digest(test)) throw new Error(`Test ${test.id} cannot discard its required provider or prediction; start a new investigation for a changed scope`)
  }
}

/** Small append-only version ledger. Hashes detect corruption, never establish truth. */
export class InvestigationLedger {
  readonly file: string
  constructor(private readonly ctx: ToolContext, readonly id: string, private readonly protectedPaths: ProtectedPaths) {
    z.string().uuid().parse(id)
    // Harness-owned metadata follows traces/sessions, outside the project's write
    // sandbox. Neither the model nor the input can choose its root or filename.
    const brain = realPathForAccess(ctx.brainDir, ctx.cwd)
    this.file = join(brain, 'investigations', projectId(ctx.cwd), `${id}.jsonl`)
    this.checkPath(this.file)
  }

  private checkPath(path: string): void {
    const actual = realPathForAccess(path, this.ctx.cwd)
    if (actual !== path) throw new Error('Investigation storage path changed after authorization')
    const fenced = this.protectedPaths.deniedRoot(actual, this.ctx.cwd)
    if (fenced) throw new Error(`Investigation storage is in protected system directory ${fenced}`)
  }

  load(): { snapshot: InvestigationSnapshot; hash: string } | null {
    this.checkPath(this.file)
    if (!existsSync(this.file)) return null
    const descriptor = openSync(this.file, 'r')
    let content: string
    try {
      if (fstatSync(descriptor).size > MAX_BYTES) throw new Error('Investigation ledger exceeds its size limit')
      content = readFileSync(descriptor, 'utf8')
    } finally { closeSync(descriptor) }
    if (!content.endsWith('\n')) throw new Error('Incomplete investigation ledger; preserve it for recovery')
    const lines = content.trimEnd().split('\n')
    if (lines.length > MAX_VERSIONS) throw new Error('Investigation version limit exceeded')
    let previous: z.infer<typeof EntrySchema> | null = null
    for (const [index, line] of lines.entries()) {
      const entry = EntrySchema.parse(JSON.parse(line))
      const { hash, ...base } = entry
      if (digest(base) !== hash || entry.previousHash !== (previous?.hash ?? null) || entry.sequence !== index + 1 || entry.snapshot.version !== entry.sequence || entry.snapshot.id !== this.id) throw new Error('Invalid investigation ledger integrity')
      validateLinks(entry.snapshot)
      if (previous) {
        if (digest(previous.snapshot.target) !== digest(entry.snapshot.target)) throw new Error('Investigation target was rewritten')
        if (digest(previous.snapshot.observations) !== digest(entry.snapshot.observations.slice(0, previous.snapshot.observations.length))) throw new Error('Investigation evidence was rewritten')
        validateTransition(previous.snapshot, entry.snapshot)
      }
      previous = entry
    }
    if (!previous) throw new Error('Empty investigation ledger')
    return { snapshot: previous.snapshot, hash: previous.hash }
  }

  async update(change: (current: InvestigationSnapshot | null) => Promise<InvestigationSnapshot>): Promise<InvestigationSnapshot> {
    this.checkPath(this.file)
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const lock = `${this.file}.lock`
    this.checkPath(lock)
    let descriptor: number
    try { descriptor = openSync(lock, 'wx', 0o600) }
    catch { throw new Error('Investigation ledger is locked; retry after its writer finishes. Preserve a crash lock for manual recovery.') }
    try {
      const previous = this.load()
      const next = InvestigationSnapshotSchema.parse(redactSessionValue(await change(previous?.snapshot ?? null)))
      validateLinks(next)
      if (previous && digest(next) === digest(previous.snapshot)) return previous.snapshot
      if (previous) validateTransition(previous.snapshot, next)
      next.version = (previous?.snapshot.version ?? 0) + 1
      if (next.version > MAX_VERSIONS) throw new Error('Investigation version limit reached; start a new bounded investigation')
      const base = { schemaVersion: 1 as const, sequence: next.version, previousHash: previous?.hash ?? null, snapshot: next }
      const entry = EntrySchema.parse({ ...base, hash: digest(base) })
      const line = JSON.stringify(entry) + '\n'
      this.checkPath(this.file)
      const output = openSync(this.file, 'a', 0o600)
      try {
        if (fstatSync(output).size + Buffer.byteLength(line) > MAX_BYTES) throw new Error('Investigation ledger size limit reached')
        writeFileSync(output, line, 'utf8')
        fsyncSync(output)
      } finally { closeSync(output) }
      const loaded = this.load()
      if (loaded?.hash !== entry.hash) throw new Error('Investigation persistence readback failed')
      return loaded.snapshot
    } finally {
      closeSync(descriptor)
      this.checkPath(lock)
      unlinkSync(lock)
    }
  }
}
