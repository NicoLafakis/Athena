import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExperienceRecordSchema,
  GuidanceRecordSchema,
  ExperienceStore,
  retrieveGuidance,
} from '../../src/experience/index.js'

const now = '2026-07-29T12:00:00.000Z'

function experience(id: string, overrides: Record<string, unknown> = {}) {
  return ExperienceRecordSchema.parse({
    schemaVersion: 1,
    id,
    projectScope: 'project-1',
    situation: 'Release the accessibility changes safely.',
    actions: ['Write succeeded.', 'Bash succeeded.'],
    outcome: 'succeeded',
    evidenceRefs: ['trace:run-1:abc'],
    tags: ['release', 'bash', 'write'],
    createdAt: now,
    ...overrides,
  })
}

function guidance(id: string, experienceId: string, overrides: Record<string, unknown> = {}) {
  return GuidanceRecordSchema.parse({
    schemaVersion: 1,
    id,
    experienceIds: [experienceId],
    signal: 'consider',
    text: 'Consider the recorded successful tool sequence for similar release work.',
    status: 'provisional',
    confidence: 0.4,
    ...overrides,
  })
}

describe('ExperienceStore', () => {
  it('persists validated records and requires explicit review before guidance becomes active', () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-experience-'))
    try {
      const store = new ExperienceStore(root)
      store.appendExperience(experience('exp-1'))
      store.appendGuidance(guidance('guide-1', 'exp-1'))
      expect(store.listGuidance()).toMatchObject([{ id: 'guide-1', status: 'provisional' }])

      const active = store.reviewGuidance('guide-1', 'active', 0.8, now)
      expect(active).toMatchObject({ status: 'active', confidence: 0.8, reviewedAt: now })
      expect(store.listGuidance()).toHaveLength(1)
      expect(readFileSync(join(root, 'guidance.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)

      expect(() => store.reviewGuidance('guide-1', 'provisional', 0.2, now)).toThrow(/transition/)
      expect(() => store.appendExperience({ ...experience('bad'), situation: 'x'.repeat(4_097) })).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades a corrupt optional line to bounded warning plus valid records', () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-experience-'))
    try {
      const warnings: string[] = []
      const store = new ExperienceStore(root, { onWarn: (warning) => warnings.push(warning) })
      store.appendExperience(experience('exp-1'))
      writeFileSync(
        join(root, 'experiences.jsonl'),
        '{broken json\n' + JSON.stringify(experience('exp-2')) + '\n',
      )

      expect(store.listExperiences().map((record) => record.id)).toEqual(['exp-2'])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('experiences.jsonl')
      expect(warnings[0]).toContain('athena experience rebuild')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats an unreadable optional index as no guidance and enforces bounded capacity', () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-experience-'))
    try {
      const warnings: string[] = []
      mkdirSync(join(root, 'experiences.jsonl'))
      const unreadable = new ExperienceStore(root, { onWarn: (warning) => warnings.push(warning) })
      expect(unreadable.listExperiences()).toEqual([])
      expect(warnings).toHaveLength(1)

      const boundedRoot = join(root, 'bounded')
      const bounded = new ExperienceStore(boundedRoot, { maxRecords: 1 })
      bounded.appendExperience(experience('exp-1'))
      expect(() => bounded.appendExperience(experience('exp-2'))).toThrow(/record limit/)
      expect(bounded.listExperiences().map((record) => record.id)).toEqual(['exp-1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('retrieveGuidance', () => {
  it('filters to active scoped guidance and ranks deterministically within count/character budgets', () => {
    const experiences = [
      experience('exp-a'),
      experience('exp-b', { situation: 'Investigate a database migration failure.', tags: ['database'] }),
    ]
    const guidanceRecords = [
      guidance('guide-z', 'exp-a', { status: 'active', confidence: 0.8, reviewedAt: now }),
      guidance('guide-a', 'exp-a', { status: 'active', confidence: 0.8, reviewedAt: now, text: 'A'.repeat(80) }),
      guidance('guide-db', 'exp-b', { status: 'active', confidence: 0.99, reviewedAt: now }),
      guidance('guide-provisional', 'exp-a'),
    ]

    const result = retrieveGuidance(experiences, guidanceRecords, {
      projectScope: 'project-1',
      objective: 'Release accessibility changes.',
      tags: ['release'],
      limit: 2,
      charBudget: 150,
      now: new Date(now),
    })
    expect(result.map((item) => item.guidance.id)).toEqual(['guide-a'])
    expect(result[0]!.score).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain('guide-provisional')
    expect(JSON.stringify(result)).not.toContain('guide-db')
  })

  it('returns a normal no-hit for unrelated, stale, or wrong-project guidance', () => {
    const record = experience('exp-a')
    const active = guidance('guide-a', 'exp-a', {
      status: 'active',
      confidence: 0.9,
      reviewedAt: '2025-01-01T00:00:00.000Z',
    })
    expect(retrieveGuidance([record], [active], {
      projectScope: 'project-1',
      objective: 'Unrelated database work.',
      tags: ['database'],
      now: new Date(now),
    })).toEqual([])
    expect(retrieveGuidance([record], [active], {
      projectScope: 'another-project',
      objective: 'Release accessibility changes.',
      tags: ['release'],
      now: new Date(now),
    })).toEqual([])
  })
})
