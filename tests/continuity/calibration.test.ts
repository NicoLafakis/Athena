import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryHygieneStore } from '../../src/brain/hygiene.js'
import { generateSemanticCandidates } from '../../src/continuity/candidates.js'
import type { ContinuityEpisode, SemanticMemoryRecord, SourceRef } from '../../src/continuity/schemas.js'
import { rankContinuityLayers } from '../../src/continuity/ranking.js'
import { ContinuityStore } from '../../src/continuity/store.js'
import { resolveTemporalWindow } from '../../src/continuity/time.js'
import { SessionStore } from '../../src/harness/sessions.js'

const now = new Date('2026-09-23T12:00:00.000Z')

function source(projectId: string, sessionId: string, recordId: string, observedAt: string): SourceRef {
  return {
    kind: 'session-message',
    projectId,
    sessionId,
    recordId,
    timestamp: observedAt,
    timeZone: 'UTC',
  }
}

function episode(id: string, projectId: string, observedAt: string, summary: string): ContinuityEpisode {
  const sessionId = `session-${id}`
  return {
    schemaVersion: 1,
    id,
    sourceRefs: [source(projectId, sessionId, `line-${id}`, observedAt)],
    projectId,
    sessionId,
    observedAt,
    localDate: observedAt.slice(0, 10),
    timeZone: 'UTC',
    participants: ['user', 'assistant'],
    topics: ['continuity', 'memory', 'decision'],
    summary,
    sourceDigest: id.charCodeAt(0).toString(16).padStart(64, '0'),
    speechActs: ['decided'],
    completion: 'completed',
    createdAt: observedAt,
  }
}

function semantic(
  memoryId: string,
  content: string,
  observedAt: string,
  status: SemanticMemoryRecord['status'],
  overrides: Partial<SemanticMemoryRecord> = {},
): SemanticMemoryRecord & { content: string } {
  return {
    schemaVersion: 1,
    memoryId,
    description: content,
    sourceRefs: [source('project-alpha', `session-${memoryId}`, `line-${memoryId}`, observedAt)],
    supportingEpisodeIds: [],
    observedAt,
    ...(overrides.validFrom ? { validFrom: overrides.validFrom } : {}),
    ...(overrides.validUntil ? { validUntil: overrides.validUntil } : {}),
    scope: 'global',
    status,
    confidence: 1,
    speechAct: 'preferred',
    captureMode: 'explicit',
    supersedes: [],
    sensitivity: 'ordinary',
    createdAt: observedAt,
    updatedAt: observedAt,
    content,
    ...overrides,
  }
}

describe('continuity calibration on a synthetic multi-project history', () => {
  const corpus = [
    episode(
      'alpha-sept15',
      'project-alpha',
      '2026-09-15T12:00:00.000Z',
      'The user decided to keep linked episode continuity in the alpha architecture.',
    ),
    episode(
      'beta-aug18',
      'project-beta',
      '2026-08-18T12:00:00.000Z',
      'The user decided to keep dashboard memory separate from project continuity.',
    ),
    episode(
      'beta-sept16',
      'project-beta',
      '2026-09-16T12:00:00.000Z',
      'The user decided to defer dashboard color changes until later.',
    ),
    episode(
      'alpha-sept22',
      'project-alpha',
      '2026-09-22T12:00:00.000Z',
      'Correction: the user decided to use a source-linked continuity index.',
    ),
  ]

  it('gets the expected project and period result at rank one for dated cross-project questions', () => {
    const cases = [
      {
        query: 'What did we decide about linked episode continuity last week?',
        timePhrase: 'last week',
        projectId: 'project-alpha',
        expectedId: 'alpha-sept15',
      },
      {
        query: 'What changed about the continuity index this week?',
        timePhrase: 'this week',
        projectId: 'project-alpha',
        expectedId: 'alpha-sept22',
      },
      {
        query: 'What did we decide about dashboard memory last month?',
        timePhrase: 'last month',
        projectId: 'project-beta',
        expectedId: 'beta-aug18',
      },
    ]

    const reciprocalRanks = cases.map((item) => {
      const resolution = resolveTemporalWindow(item.timePhrase, { now, configuredTimeZone: 'UTC' })
      expect(resolution.status).toBe('resolved')
      if (resolution.status !== 'resolved') throw new Error('Expected a bounded calibration time window')
      const result = rankContinuityLayers({
        query: item.query,
        projectId: item.projectId,
        episodes: corpus,
        window: resolution.window,
        now,
      })
      const position = result.candidates.findIndex((candidate) => candidate.id === item.expectedId)
      expect(result.candidates.every((candidate) => candidate.projectId === item.projectId)).toBe(true)
      expect(position).toBe(0)
      return 1 / (position + 1)
    })

    const meanReciprocalRank = reciprocalRanks.reduce((total, score) => total + score, 0) / reciprocalRanks.length
    const recallAtFive = reciprocalRanks.filter((score) => score > 0).length / reciprocalRanks.length
    expect(meanReciprocalRank).toBe(1)
    expect(recallAtFive).toBe(1)
  })

  it('resolves current and historical preference correctly after an explicit correction', () => {
    const previous = semantic(
      '11111111-1111-4111-8111-111111111111',
      'I prefer the old continuity summary.',
      '2026-09-15T12:00:00.000Z',
      'superseded',
      { validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-09-22T12:00:00.000Z',
        supersededBy: '22222222-2222-4222-8222-222222222222' },
    )
    const current = semantic(
      '22222222-2222-4222-8222-222222222222',
      'I prefer the source-linked continuity summary.',
      '2026-09-22T12:00:00.000Z',
      'active',
      { validFrom: '2026-09-22T12:00:00.000Z', supersedes: [previous.memoryId] },
    )
    const currentResult = rankContinuityLayers({
      query: 'What do I prefer about continuity summaries?',
      semanticMemories: [previous, current],
      now,
    })
    const historicalWindow = resolveTemporalWindow('last week', { now, configuredTimeZone: 'UTC' })
    expect(historicalWindow.status).toBe('resolved')
    if (historicalWindow.status !== 'resolved') throw new Error('Expected a bounded historical window')
    const historicalResult = rankContinuityLayers({
      query: 'What did I prefer about continuity summaries last week?',
      semanticMemories: [previous, current],
      window: historicalWindow.window,
      now,
    })

    const correctedCurrentWins = currentResult.candidates[0]?.id === current.memoryId
    const priorVersionRemainsFindable = historicalResult.candidates[0]?.id === previous.memoryId
    const correctionSuccessRate = [correctedCurrentWins, priorVersionRemainsFindable].filter(Boolean).length / 2
    expect(correctedCurrentWins).toBe(true)
    expect(priorVersionRemainsFindable).toBe(true)
    expect(correctionSuccessRate).toBe(1)
  })

  it('keeps candidate inference precise across repeated, paraphrased, tentative, and sensitive claims', () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-continuity-calibration-'))
    try {
      const sessionsRoot = join(root, 'sessions')
      const continuityStore = new ContinuityStore(join(root, 'continuity'))
      const semanticStore = new MemoryHygieneStore(join(root, 'memory'), { now: () => now })
      const addTurn = (project: string, content: string) => {
        const session = new SessionStore(sessionsRoot, project).create()
        session.appendMessage({ role: 'user', content })
        session.appendMessage({ role: 'assistant', content: 'The statement remains linked to its source.' })
        session.appendEvent({ type: 'turn-done' })
      }

      const expectedClaim = 'I prefer a deterministic local episode index.'
      addTurn('C:/calibration/alpha', expectedClaim)
      addTurn('C:/calibration/alpha', expectedClaim)
      addTurn('C:/calibration/paraphrase-a', 'I prefer a deterministic local index for the episode history.')
      addTurn('C:/calibration/paraphrase-b', 'I prefer a local index of deterministic episodes.')
      addTurn('C:/calibration/tentative-a', 'Maybe I prefer tentative memory to stay local.')
      addTurn('C:/calibration/tentative-b', 'Maybe I prefer tentative memory to stay local.')
      addTurn('C:/calibration/sensitive-a', 'I prefer keeping my salary details private.')
      addTurn('C:/calibration/sensitive-b', 'I prefer keeping my salary details private.')
      continuityStore.rebuild(sessionsRoot)
      const generated = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
      const memories = semanticStore.listAll()
      const exactExpected = memories.length === 1 && memories[0]?.content === expectedClaim
      const candidatePrecision = exactExpected ? 1 : 0

      expect(generated.createdCount).toBe(1)
      expect(memories).toHaveLength(1)
      expect(memories[0]).toMatchObject({ status: 'candidate', captureMode: 'inferred', scope: 'project' })
      expect(new Set(memories[0]?.sourceRefs.map((item) => item.sessionId)).size).toBe(2)
      expect(candidatePrecision).toBe(1)
      expect(memories[0]?.content).not.toContain('salary')
      expect(semanticStore.listActive()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps temporal interpretations bounded across near, medium, and long periods', () => {
    const cases = [
      ['earlier today', '2026-09-23T00:00:00.000Z', '2026-09-24T00:00:00.000Z'],
      ['earlier this week', '2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z'],
      ['earlier this month', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
      ['last quarter', '2026-04-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'],
      ['last year', '2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    ] as const
    const correct = cases.filter(([phrase, start, end]) => {
      const result = resolveTemporalWindow(phrase, { now, configuredTimeZone: 'UTC' })
      return result.status === 'resolved' && result.window.start === start && result.window.end === end
    }).length
    const interpretationAccuracy = correct / cases.length

    expect(interpretationAccuracy).toBe(1)
  })
})
