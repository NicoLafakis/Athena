import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import type { BrainPaths } from '../brain/paths.js'
import { atomicWriteFileSync } from '../tools/files.js'
import { CandidateStore } from './candidates.js'
import { compareEvaluationRuns, LearningEvaluator } from './evaluation.js'
import { LearningMemoryStore } from './memory.js'
import {
  PromotionRecordSchema,
  type EvaluationComparison,
  type EvaluationRun,
  type LearningCandidate,
  type PromotionRecord,
} from './types.js'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function git(repo: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, {
    cwd: repo,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function signingKey(paths: BrainPaths): ReturnType<typeof createPrivateKey> {
  if (!existsSync(paths.learningSigningKeyFile)) {
    const pair = generateKeyPairSync('ed25519')
    atomicWriteFileSync(
      paths.learningSigningKeyFile,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    )
    try {
      chmodSync(paths.learningSigningKeyFile, 0o600)
    } catch {
      // Best effort; Windows relies on the user-profile ACL.
    }
  }
  return createPrivateKey(readFileSync(paths.learningSigningKeyFile, 'utf8'))
}

function unsignedRecord(
  record: Omit<PromotionRecord, 'signature'>,
): Omit<PromotionRecord, 'signature'> {
  return record
}

export function verifyPromotionRecord(record: PromotionRecord): boolean {
  const { signature, ...unsigned } = record
  try {
    return verify(
      null,
      Buffer.from(JSON.stringify(unsigned)),
      record.publicKey,
      Buffer.from(signature, 'base64'),
    )
  } catch {
    return false
  }
}

export class PromotionManager {
  private readonly candidates: CandidateStore
  private readonly evaluator: LearningEvaluator

  constructor(private readonly paths: BrainPaths) {
    this.candidates = new CandidateStore(paths)
    this.evaluator = new LearningEvaluator(paths)
  }

  lineage(): PromotionRecord[] {
    if (!existsSync(this.paths.learningLineageFile)) return []
    return readFileSync(this.paths.learningLineageFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => PromotionRecordSchema.parse(JSON.parse(line)))
  }

  private appendRecord(
    candidate: LearningCandidate,
    action: PromotionRecord['action'],
    commitBefore: string,
    commitAfter: string,
    comparison: EvaluationComparison,
  ): PromotionRecord {
    const lineage = this.verifyLineage()
    if (!lineage.valid) {
      throw new Error(`Cannot extend invalid promotion lineage: ${lineage.error}`)
    }
    const key = signingKey(this.paths)
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString()
    const previous = this.lineage().at(-1)
    const unsigned = unsignedRecord({
      schemaVersion: 1,
      id: randomUUID(),
      candidateId: candidate.id,
      parentRecordId: previous?.id ?? null,
      action,
      commitBefore,
      commitAfter,
      patchHash: createHash('sha256').update(candidate.patch).digest('hex'),
      comparisonHash: digest(comparison),
      createdAt: new Date().toISOString(),
      publicKey,
    })
    const record = PromotionRecordSchema.parse({
      ...unsigned,
      signature: sign(null, Buffer.from(JSON.stringify(unsigned)), key).toString('base64'),
    })
    const current = existsSync(this.paths.learningLineageFile)
      ? readFileSync(this.paths.learningLineageFile, 'utf8')
      : ''
    atomicWriteFileSync(this.paths.learningLineageFile, current + JSON.stringify(record) + '\n')
    return record
  }

  promoteCanary(
    candidateId: string,
    repository: string,
    humanApproved: boolean,
  ): PromotionRecord {
    if (!humanApproved) throw new Error('Promotion requires explicit human approval')
    const candidate = this.candidates.load(candidateId)
    if (candidate.status !== 'evaluated') {
      throw new Error(`Candidate ${candidateId} must be evaluated, not ${candidate.status}`)
    }
    if (candidate.confidence < 0.5) {
      throw new Error('Candidate confidence is below the 0.5 promotion floor')
    }
    if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= Date.now()) {
      throw new Error(`Candidate ${candidateId} has expired`)
    }
    const comparison = this.evaluator.loadComparison(candidateId)
    if (!comparison.promotable) {
      throw new Error(`Held-out gate failed: ${comparison.reasons.join('; ')}`)
    }
    const repo = git(repository, ['rev-parse', '--show-toplevel'])
    if (git(repo, ['status', '--porcelain'])) {
      throw new Error('Promotion requires a clean worktree and index')
    }
    const before = git(repo, ['rev-parse', 'HEAD'])
    this.candidates.transition(candidateId, 'approved', 'explicit human approval')
    try {
      const apply = ['-c', 'core.autocrlf=false', 'apply', '--whitespace=error-all']
      git(repo, [...apply, '--check', '-'], candidate.patch)
      git(repo, [...apply, '-'], candidate.patch)
    } catch (error) {
      this.candidates.transition(candidateId, 'rejected', `promotion apply failed: ${(error as Error).message}`)
      throw error
    }
    const after = digest({ before, patch: candidate.patch })
    this.candidates.transition(candidateId, 'canary', 'patch applied for canary measurement')
    try {
      return this.appendRecord(candidate, 'promote-canary', before, after, comparison)
    } catch (error) {
      git(repo, ['-c', 'core.autocrlf=false', 'apply', '--reverse', '-'], candidate.patch)
      this.candidates.transition(candidateId, 'rolled-back', 'lineage write failed; canary reverted')
      throw error
    }
  }

  finalize(
    candidateId: string,
    canaryRunId: string,
    repository: string,
  ): PromotionRecord {
    const candidate = this.candidates.load(candidateId)
    if (candidate.status !== 'canary') throw new Error(`Candidate ${candidateId} is not a canary`)
    const run = this.evaluator.loadRun(canaryRunId)
    const comparison = this.evaluator.loadComparison(candidateId)
    this.assertCanary(run, candidateId, comparison)
    const repo = git(repository, ['rev-parse', '--show-toplevel'])
    git(
      repo,
      ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', '-'],
      candidate.patch,
    )
    const before = digest({ commit: git(repo, ['rev-parse', 'HEAD']), patch: candidate.patch })
    const after = digest({ before, canaryRunId })
    this.candidates.transition(candidateId, 'promoted', `canary ${canaryRunId} passed`)
    let record: PromotionRecord
    try {
      record = this.appendRecord(candidate, 'finalize', before, after, comparison)
    } catch (error) {
      git(repo, ['-c', 'core.autocrlf=false', 'apply', '--reverse', '-'], candidate.patch)
      this.candidates.transition(candidateId, 'rolled-back', 'lineage write failed; promotion reverted')
      throw error
    }
    if (candidate.target === 'memory') {
      new LearningMemoryStore(this.paths).fromCandidate(candidate)
      new LearningMemoryStore(this.paths).consolidate()
    }
    return record
  }

  rollback(candidateId: string, repository: string): PromotionRecord {
    const candidate = this.candidates.load(candidateId)
    if (candidate.status !== 'canary' && candidate.status !== 'promoted') {
      throw new Error(`Candidate ${candidateId} is not deployed`)
    }
    const comparison = this.evaluator.loadComparison(candidateId)
    const repo = git(repository, ['rev-parse', '--show-toplevel'])
    const before = digest({ commit: git(repo, ['rev-parse', 'HEAD']), patch: candidate.patch })
    git(repo, ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', '-'], candidate.patch)
    git(repo, ['-c', 'core.autocrlf=false', 'apply', '--reverse', '-'], candidate.patch)
    const after = git(repo, ['rev-parse', 'HEAD'])
    let record: PromotionRecord
    try {
      record = this.appendRecord(candidate, 'rollback', before, after, comparison)
    } catch (error) {
      git(repo, ['-c', 'core.autocrlf=false', 'apply', '-'], candidate.patch)
      throw error
    }
    this.candidates.transition(candidateId, 'rolled-back', 'operator rollback')
    if (candidate.target === 'memory') {
      const memory = new LearningMemoryStore(this.paths)
      for (const claim of memory.list().filter((item) => item.candidateId === candidateId)) {
        memory.reject(claim.id)
      }
      memory.consolidate()
    }
    return record
  }

  verifyLineage(): { valid: boolean; records: number; error?: string } {
    const records = this.lineage()
    let parent: string | null = null
    for (const record of records) {
      if (record.parentRecordId !== parent) {
        return { valid: false, records: records.length, error: `parent mismatch at ${record.id}` }
      }
      if (!verifyPromotionRecord(record)) {
        return { valid: false, records: records.length, error: `invalid signature at ${record.id}` }
      }
      try {
        const candidate = this.candidates.load(record.candidateId)
        if (createHash('sha256').update(candidate.patch).digest('hex') !== record.patchHash) {
          return { valid: false, records: records.length, error: `patch mismatch at ${record.id}` }
        }
        if (digest(this.evaluator.loadComparison(record.candidateId)) !== record.comparisonHash) {
          return {
            valid: false,
            records: records.length,
            error: `comparison mismatch at ${record.id}`,
          }
        }
      } catch (error) {
        return {
          valid: false,
          records: records.length,
          error: `missing promotion evidence at ${record.id}: ${(error as Error).message}`,
        }
      }
      parent = record.id
    }
    return { valid: true, records: records.length }
  }

  private assertCanary(
    run: EvaluationRun,
    candidateId: string,
    storedComparison: EvaluationComparison,
  ): void {
    if (run.role !== 'canary' || run.candidateId !== candidateId) {
      throw new Error(`Evaluation ${run.id} is not a canary for ${candidateId}`)
    }
    const heldout = run.measurements.filter((measurement) => measurement.split === 'heldout')
    if (heldout.length < 5) throw new Error('Canary needs at least five held-out cases')
    if (heldout.some((measurement) => !measurement.success)) {
      throw new Error('Canary has a failed held-out case')
    }
    if (heldout.some((measurement) => measurement.safetyViolations > 0)) {
      throw new Error('Canary has a safety violation')
    }
    const baseline = this.evaluator.loadRun(storedComparison.baselineRunId)
    const comparison = compareEvaluationRuns(candidateId, baseline, run)
    if (!comparison.promotable) {
      throw new Error(`Canary regression gate failed: ${comparison.reasons.join('; ')}`)
    }
  }
}
