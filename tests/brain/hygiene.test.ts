import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryHygieneStore } from '../../src/brain/hygiene.js'
import type { SourceRef } from '../../src/continuity/schemas.js'

let root: string
const observedAt = '2026-09-23T15:00:00.000Z'
const firstRef: SourceRef = {
  kind: 'session-message',
  projectId: 'project-one',
  sessionId: 'session-one',
  recordId: 'line-one',
  timestamp: observedAt,
  timeZone: 'America/New_York',
}
const secondRef: SourceRef = {
  ...firstRef,
  sessionId: 'session-two',
  recordId: 'line-two',
  timestamp: '2026-09-21T13:00:00.000Z',
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-memory-hygiene-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function explicitInput(content = 'I prefer linked memory across projects.') {
  return {
    description: 'Cross-project memory preference',
    content,
    sourceRefs: [firstRef],
    scope: 'global' as const,
    speechAct: 'preferred' as const,
    captureMode: 'explicit' as const,
    confidence: 1,
    sensitivity: 'ordinary' as const,
  }
}

describe('MemoryHygieneStore', () => {
  it('writes a source-linked explicit memory to the existing memory-file tree', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    const memory = store.create(explicitInput())

    expect(memory.status).toBe('active')
    expect(memory.scope).toBe('global')
    expect(memory.sourceRefs).toEqual([firstRef])
    expect(memory.file).toContain(join('memory', 'semantic'))
    expect(readFileSync(memory.file, 'utf8')).toContain('I prefer linked memory across projects.')
    expect(store.listActive()).toEqual([memory])
  })

  it('bounds semantic memory bodies so the lifecycle cannot become a transcript archive', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    expect(() => store.create(explicitInput('x'.repeat(2_001)))).toThrow(/2000 characters/i)
  })

  it('excludes records outside their valid-time interval from active retrieval', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    const future = store.create({
      ...explicitInput('A future preference.'),
      validFrom: '2026-09-24T00:00:00.000Z',
    })
    const expired = store.create({
      ...explicitInput('An expired preference.'),
      sourceRefs: [secondRef],
      validUntil: '2026-09-22T00:00:00.000Z',
    })

    expect(store.listActive()).toEqual([])
    expect(store.get(future.memoryId)?.status).toBe('active')
    expect(store.get(expired.memoryId)?.status).toBe('active')
  })

  it('only permits inferred candidates backed by two distinct episodes', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    const input = {
      ...explicitInput('The user repeatedly prefers linked memory.'),
      captureMode: 'inferred' as const,
      confidence: 0.65,
      sourceRefs: [firstRef, secondRef],
      supportingEpisodeIds: ['episode-one'],
    }

    expect(() => store.create(input)).toThrow(/independent episodes/i)
    const candidate = store.create({ ...input, supportingEpisodeIds: ['episode-one', 'episode-two'] })
    expect(candidate.status).toBe('candidate')
    expect(candidate.captureMode).toBe('inferred')
    expect(store.listActive()).toEqual([])
  })

  it('keeps sensitive inferences out of active semantic memory', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    const candidate = store.create({
      ...explicitInput('A sensitive inferred trait.'),
      captureMode: 'inferred',
      sensitivity: 'sensitive',
      confidence: 0.8,
      sourceRefs: [firstRef, secondRef],
      supportingEpisodeIds: ['episode-one', 'episode-two'],
    })

    expect(() => store.promote(candidate.memoryId)).toThrow(/sensitive.*cannot be promoted/i)
    expect(store.get(candidate.memoryId)?.status).toBe('candidate')
  })

  it('promotes a reviewed candidate without changing its body and keeps rejection terminal', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    const candidate = store.create({
      ...explicitInput('An inferred preference backed by repeated episodes.'),
      captureMode: 'inferred',
      confidence: 0.7,
      sourceRefs: [firstRef, secondRef],
      supportingEpisodeIds: ['episode-one', 'episode-two'],
    })
    const originalBody = candidate.content
    const active = store.promote(candidate.memoryId)
    expect(active.status).toBe('active')
    expect(active.content).toBe(originalBody)

    const rejected = store.create({
      ...explicitInput('Do not retain this inference.'),
      captureMode: 'inferred',
      confidence: 0.4,
      sourceRefs: [firstRef, secondRef],
      supportingEpisodeIds: ['episode-three', 'episode-four'],
    })
    expect(store.reject(rejected.memoryId).status).toBe('rejected')
    expect(() => store.promote(rejected.memoryId)).toThrow(/terminal/i)
  })

  it('supersedes by metadata and retains both source-linked bodies', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    const oldMemory = store.create(explicitInput('The old preference was dark mode.'))
    const replacement = store.supersede(oldMemory.memoryId, {
      ...explicitInput('The corrected preference is light mode.'),
      sourceRefs: [secondRef],
      speechAct: 'corrected',
    })

    const prior = store.get(oldMemory.memoryId)!
    expect(prior.status).toBe('superseded')
    expect(prior.supersededBy).toBe(replacement.memoryId)
    expect(prior.content).toBe('The old preference was dark mode.')
    expect(replacement.supersedes).toEqual([oldMemory.memoryId])
    expect(replacement.content).toBe('The corrected preference is light mode.')
    expect(store.listActive()).toEqual([replacement])
    expect(store.listAll().map((memory) => memory.memoryId)).toEqual(
      expect.arrayContaining([replacement.memoryId, oldMemory.memoryId]),
    )
  })

  it('tombstones without deleting source-backed content and excludes the record from active retrieval', () => {
    const store = new MemoryHygieneStore(join(root, 'memory'), { now: () => new Date(observedAt) })
    const memory = store.create(explicitInput())
    const tombstoned = store.tombstone(memory.memoryId)

    expect(tombstoned.status).toBe('tombstoned')
    expect(tombstoned.content).toBe(memory.content)
    expect(store.listActive()).toEqual([])
    expect(readFileSync(memory.file, 'utf8')).toContain('I prefer linked memory across projects.')
    expect(() => store.promote(memory.memoryId)).toThrow(/terminal/i)
  })

  it('skips malformed managed memory files with an actionable warning', () => {
    const warnings: string[] = []
    const memoryDir = join(root, 'memory')
    const store = new MemoryHygieneStore(memoryDir, { onWarn: (warning) => warnings.push(warning) })
    const badFile = join(memoryDir, 'semantic', 'bad.md')
    mkdirSync(join(memoryDir, 'semantic'), { recursive: true })
    writeFileSync(badFile, '---\nstatus: active\n---\nnot a validated memory\n', 'utf8')

    expect(store.listActive()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('athena memory rebuild')
  })
})
