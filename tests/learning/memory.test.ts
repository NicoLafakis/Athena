import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { LearningMemoryStore } from '../../src/learning/memory.js'
import { MemoryClaimSchema } from '../../src/learning/types.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-memory-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-memory-project-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('LearningMemoryStore', () => {
  it('deduplicates provenance-bearing claims, raises combined confidence, and builds the active index', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const store = new LearningMemoryStore(paths)
    const now = new Date()
    for (const run of ['run-a', 'run-b']) {
      store.append(
        MemoryClaimSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          statement: 'Read the file before editing it.',
          sourceRunIds: [run],
          provenanceHashes: [(run === 'run-a' ? 'a' : 'b').repeat(64)],
          confidence: 0.4,
          applicability: ['file edits'],
          counterexamples: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          status: 'provisional',
          contradicts: [],
        }),
      )
    }
    const claims = store.consolidate(now)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.confidence).toBeCloseTo(0.64)
    expect(claims[0]!.status).toBe('active')
    expect(readFileSync(join(paths.memoryDir, 'LEARNED.md'), 'utf8')).toContain(
      'Read the file before editing it.',
    )
  })

  it('expires bounded claims instead of prompting with stale guidance', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const store = new LearningMemoryStore(paths)
    const past = new Date(Date.now() - 60_000).toISOString()
    store.append(
      MemoryClaimSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        statement: 'A temporary release workaround.',
        sourceRunIds: ['run'],
        provenanceHashes: ['c'.repeat(64)],
        confidence: 0.9,
        applicability: ['old release'],
        counterexamples: [],
        createdAt: past,
        updatedAt: past,
        expiresAt: past,
        status: 'active',
        contradicts: [],
      }),
    )
    expect(store.consolidate()[0]!.status).toBe('expired')
    expect(readFileSync(join(paths.memoryDir, 'LEARNED.md'), 'utf8')).not.toContain(
      'A temporary release workaround.',
    )
  })

  it('never resurrects an explicitly rejected claim during consolidation', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const store = new LearningMemoryStore(paths)
    const id = randomUUID()
    const now = new Date().toISOString()
    store.append(
      MemoryClaimSchema.parse({
        schemaVersion: 1,
        id,
        statement: 'Do not restore this claim.',
        sourceRunIds: ['run'],
        provenanceHashes: ['d'.repeat(64)],
        confidence: 0.99,
        applicability: ['test'],
        counterexamples: [],
        createdAt: now,
        updatedAt: now,
        status: 'active',
        contradicts: [],
      }),
    )
    store.reject(id)
    expect(store.consolidate()).toEqual([])
    expect(readFileSync(join(paths.memoryDir, 'LEARNED.md'), 'utf8')).not.toContain(
      'Do not restore this claim.',
    )
  })
})
