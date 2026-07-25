import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { BrainPaths } from '../brain/paths.js'
import { atomicWriteFileSync } from '../tools/files.js'
import {
  MemoryClaimSchema,
  type LearningCandidate,
  type MemoryClaim,
} from './types.js'

function normalize(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, ' ')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function decayedConfidence(claim: MemoryClaim, now: number): number {
  const anchor = Date.parse(claim.lastUsedAt ?? claim.updatedAt)
  const months = Math.max(0, (now - anchor) / (30 * 24 * 60 * 60_000))
  return Math.max(0, Math.min(1, claim.confidence * 0.98 ** months))
}

export class LearningMemoryStore {
  constructor(private readonly paths: BrainPaths) {}

  list(): MemoryClaim[] {
    if (!existsSync(this.paths.learnedMemoryFile)) return []
    const latest = new Map<string, MemoryClaim>()
    for (const line of readFileSync(this.paths.learnedMemoryFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const claim = MemoryClaimSchema.parse(JSON.parse(line))
      latest.set(claim.id, claim)
    }
    return [...latest.values()]
  }

  append(claim: MemoryClaim): void {
    const parsed = MemoryClaimSchema.parse(claim)
    const previous = existsSync(this.paths.learnedMemoryFile)
      ? readFileSync(this.paths.learnedMemoryFile, 'utf8')
      : ''
    atomicWriteFileSync(
      this.paths.learnedMemoryFile,
      previous + JSON.stringify(parsed) + '\n',
    )
  }

  fromCandidate(candidate: LearningCandidate): MemoryClaim {
    if (candidate.target !== 'memory') {
      throw new Error(`Candidate ${candidate.id} targets ${candidate.target}, not memory`)
    }
    const now = new Date().toISOString()
    const claim = MemoryClaimSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      statement: candidate.hypothesis,
      sourceRunIds: candidate.sourceRunIds,
      candidateId: candidate.id,
      provenanceHashes: candidate.provenance.traceHashes,
      confidence: candidate.confidence,
      applicability: candidate.applicability,
      counterexamples: candidate.counterexamples,
      createdAt: now,
      updatedAt: now,
      expiresAt: candidate.expiresAt,
      status: candidate.confidence >= 0.5 ? 'active' : 'provisional',
      contradicts: [],
    })
    this.append(claim)
    return claim
  }

  markUsed(id: string): void {
    const claim = this.list().find((item) => item.id === id)
    if (!claim) throw new Error(`Unknown memory claim ${id}`)
    this.append({ ...claim, lastUsedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  }

  reject(id: string): void {
    const claim = this.list().find((item) => item.id === id)
    if (!claim) throw new Error(`Unknown memory claim ${id}`)
    this.append({ ...claim, status: 'rejected', updatedAt: new Date().toISOString() })
  }

  /** Deduplicate equivalent claims, decay stale confidence, expire bounded
   * hypotheses, surface explicit contradictions, and regenerate a prompt-safe
   * active-memory index. */
  consolidate(now = new Date()): MemoryClaim[] {
    const byStatement = new Map<string, MemoryClaim[]>()
    for (const claim of this.list()) {
      // Rejection is a terminal human/governance decision. Never allow a later
      // consolidation pass to recompute confidence and resurrect the claim.
      if (claim.status === 'rejected') continue
      const key = normalize(claim.statement)
      byStatement.set(key, [...(byStatement.get(key) ?? []), claim])
    }
    const consolidated: MemoryClaim[] = []
    for (const claims of byStatement.values()) {
      const [first, ...rest] = claims.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      if (!first) continue
      const confidence = 1 - claims.reduce(
        (remaining, claim) => remaining * (1 - decayedConfidence(claim, now.getTime())),
        1,
      )
      const expiresAt = claims
        .map((claim) => claim.expiresAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1)
      const expired = expiresAt ? Date.parse(expiresAt) <= now.getTime() : false
      const contradicts = unique(claims.flatMap((claim) => claim.contradicts))
      const merged: MemoryClaim = {
        ...first,
        sourceRunIds: unique(claims.flatMap((claim) => claim.sourceRunIds)),
        provenanceHashes: unique(claims.flatMap((claim) => claim.provenanceHashes)),
        applicability: unique(claims.flatMap((claim) => claim.applicability)),
        counterexamples: unique(claims.flatMap((claim) => claim.counterexamples)),
        confidence,
        updatedAt: now.toISOString(),
        expiresAt,
        contradicts,
        status: expired
          ? 'expired'
          : contradicts.length > 0
            ? 'contradicted'
            : confidence >= 0.5
              ? 'active'
              : 'provisional',
      }
      consolidated.push(merged)
      this.append(merged)
      for (const duplicate of rest) {
        this.append({ ...duplicate, status: 'rejected', updatedAt: now.toISOString() })
      }
    }
    const active = consolidated
      .filter((claim) => claim.status === 'active')
      .sort((a, b) => b.confidence - a.confidence)
    const markdown = [
      '# Evaluated Learned Memory',
      '',
      'Only active, provenance-bearing claims appear here. Provisional, expired, contradicted, and rejected claims stay in learned.jsonl for audit.',
      '',
      ...active.flatMap((claim) => [
        `## ${claim.statement}`,
        '',
        `- Confidence: ${claim.confidence.toFixed(3)}`,
        `- Applies to: ${claim.applicability.join('; ') || '(unspecified)'}`,
        `- Counterexamples: ${claim.counterexamples.join('; ') || '(none recorded)'}`,
        `- Source runs: ${claim.sourceRunIds.join(', ')}`,
        '',
      ]),
    ].join('\n')
    atomicWriteFileSync(
      `${this.paths.memoryDir}/LEARNED.md`,
      markdown.endsWith('\n') ? markdown : `${markdown}\n`,
    )
    return consolidated
  }
}
