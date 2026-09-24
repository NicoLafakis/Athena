import { describe, expect, it } from 'vitest'
import type { ContinuityEpisode, SemanticMemoryRecord, SourceRef, TimeRollup } from '../../src/continuity/schemas.js'
import { buildTimeRollups } from '../../src/continuity/rollups.js'
import { rankContinuityLayers, type WorkingRecallState } from '../../src/continuity/ranking.js'

const ref = (projectId: string, sessionId: string, recordId: string, timestamp: string): SourceRef => ({
  kind: 'session-message',
  projectId,
  sessionId,
  recordId,
  timestamp,
  timeZone: 'America/New_York',
})

function episode(id: string, projectId: string, observedAt: string, summary: string): ContinuityEpisode {
  const source = ref(projectId, 'session-' + id, 'line-' + id, observedAt)
  return {
    schemaVersion: 1,
    id,
    sourceRefs: [source],
    projectId,
    sessionId: source.sessionId!,
    observedAt,
    localDate: observedAt.slice(0, 10),
    timeZone: 'America/New_York',
    participants: ['user', 'assistant'],
    topics: ['continuity', 'memory'],
    summary,
    sourceDigest: id.charCodeAt(0).toString(16).padStart(64, '0'),
    speechActs: ['preferred'],
    completion: 'completed',
    createdAt: observedAt,
  }
}

function semantic(
  overrides: Partial<SemanticMemoryRecord> & { content?: string } = {},
): SemanticMemoryRecord & { content: string } {
  const observedAt = overrides.observedAt ?? '2026-09-10T12:00:00.000Z'
  return {
    schemaVersion: 1,
    memoryId: '11111111-1111-4111-8111-111111111111',
    description: 'Memory preference',
    sourceRefs: [ref('project-a', 'session-memory', 'line-memory', observedAt)],
    supportingEpisodeIds: [],
    observedAt,
    scope: 'global',
    status: 'active',
    confidence: 1,
    speechAct: 'preferred',
    captureMode: 'explicit',
    supersedes: [],
    sensitivity: 'ordinary',
    createdAt: observedAt,
    updatedAt: observedAt,
    content: 'I prefer source-linked continuity summaries.',
    ...overrides,
  }
}

function rollupsFor(episodes: ContinuityEpisode[], timeZone = 'America/New_York'): TimeRollup[] {
  return buildTimeRollups(episodes, { timeZone, now: new Date('2026-09-30T00:00:00.000Z') })
}

describe('rankContinuityLayers', () => {
  it('routes preference questions toward explicit active semantic memory and its source episodes', () => {
    const sourceEpisode = episode('episode-a', 'project-a', '2026-09-10T12:00:00.000Z', 'User prefers source-linked continuity summaries.')
    const ranking = rankContinuityLayers({
      query: 'What do I usually prefer about continuity memory?',
      episodes: [sourceEpisode],
      semanticMemories: [semantic({ supportingEpisodeIds: [sourceEpisode.id] })],
      rollups: rollupsFor([sourceEpisode]),
      currentProjectId: 'project-a',
      now: new Date('2026-09-30T00:00:00.000Z'),
    })

    expect(ranking.intent).toBe('preference')
    expect(ranking.candidates[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      layer: 'semantic',
    })
    expect(ranking.candidates[0]?.sourceIds).toContain('line-memory')
    expect(ranking.candidates[0]?.sourceIds).toContain(sourceEpisode.id)
    expect(ranking.candidates[0]).not.toHaveProperty('content')
    expect(ranking.candidates[0]).not.toHaveProperty('summary')
  })

  it('excludes forgotten semantic records from ranking', () => {
    const forgotten = semantic({
      status: 'tombstoned',
      forgottenAt: '2026-09-23T15:00:00.000Z',
      description: 'Forgotten semantic memory',
      content: '',
    })
    const ranking = rankContinuityLayers({
      query: 'What do I usually prefer about continuity memory?',
      semanticMemories: [forgotten],
      now: new Date('2026-09-30T00:00:00.000Z'),
    })

    expect(ranking.candidates).toEqual([])
  })

  it('requires a topical match instead of ranking unrelated episodes by recall intent words', () => {
    const unrelated = episode(
      'episode-unrelated-model',
      'project-a',
      '2026-09-10T12:00:00.000Z',
      'We decided the model for this session is Sonnet.',
    )

    expect(rankContinuityLayers({
      query: 'What did we decide?',
      episodes: [unrelated],
    }).candidates).toEqual([])
    expect(rankContinuityLayers({
      query: 'What was the Jev decision model decision?',
      episodes: [unrelated],
    }).candidates).toEqual([])
  })

  it('uses explicit time windows as hard filters and favors a matching rollup for recap intent', () => {
    const inWindow = episode('episode-sept', 'project-a', '2026-09-15T12:00:00.000Z', 'The user chose a weekly continuity review.')
    const outside = episode('episode-aug', 'project-a', '2026-08-15T12:00:00.000Z', 'The user chose monthly project planning.')
    const rollups = rollupsFor([inWindow, outside])
    const ranking = rankContinuityLayers({
      query: 'Give me a recap of September',
      window: {
        start: '2026-09-01T04:00:00.000Z',
        end: '2026-10-01T04:00:00.000Z',
        timeZone: 'America/New_York',
        kind: 'calendar',
        label: 'September 2026',
      },
      episodes: [inWindow, outside],
      rollups,
      now: new Date('2026-09-30T00:00:00.000Z'),
    })

    expect(ranking.intent).toBe('summary')
    expect(ranking.candidates[0]?.layer).toBe('rollup')
    expect(ranking.candidates.flatMap((candidate) => candidate.sourceIds)).toContain(inWindow.id)
    expect(ranking.candidates.flatMap((candidate) => candidate.sourceIds)).not.toContain(outside.id)
  })

  it('rejects a rollup after its source episode changes', () => {
    const indexedEpisode = episode('episode-fresh', 'project-a', '2026-09-12T12:00:00.000Z', 'The user chose local continuity.')
    const changedEpisode = { ...indexedEpisode, summary: 'The user chose a different memory design.' }
    const staleRollup = { ...rollupsFor([indexedEpisode]).find((item) => item.granularity === 'day')!, id: 'stale-day' }
    const ranking = rankContinuityLayers({
      query: 'recap local continuity',
      episodes: [changedEpisode],
      rollups: [staleRollup],
    })

    expect(ranking.candidates.map((candidate) => candidate.id)).not.toContain(staleRollup.id)
  })

  it('enforces explicit project scope and does not expose a mixed-project rollup', () => {
    const first = episode('episode-a', 'project-a', '2026-09-10T12:00:00.000Z', 'The user prefers local continuity.')
    const second = episode('episode-b', 'project-b', '2026-09-11T12:00:00.000Z', 'The user prefers local continuity.')
    const globalMemory = semantic({ content: 'I prefer local continuity for all projects.' })
    const projectMemory = semantic({
      memoryId: '22222222-2222-4222-8222-222222222222',
      scope: 'project',
      projectId: 'project-b',
      content: 'In project B, I prefer a different approach.',
      sourceRefs: [ref('project-b', 'session-b', 'line-b', '2026-09-11T12:00:00.000Z')],
    })
    const ranking = rankContinuityLayers({
      query: 'What do I prefer about continuity?',
      projectId: 'project-a',
      currentProjectId: 'project-a',
      episodes: [first, second],
      semanticMemories: [globalMemory, projectMemory],
      rollups: rollupsFor([first, second]),
    })

    expect(ranking.candidates.every((candidate) => candidate.projectId === null || candidate.projectId === 'project-a')).toBe(true)
    expect(ranking.candidates.map((candidate) => candidate.id)).not.toContain(second.id)
    expect(ranking.candidates.map((candidate) => candidate.id)).not.toContain(projectMemory.memoryId)
    const mixedRollupIds = rollupsFor([first, second])
      .filter((item) => item.sourceEpisodeIds.includes(first.id) && item.sourceEpisodeIds.includes(second.id))
      .map((item) => item.id)
    expect(ranking.candidates.filter((candidate) => candidate.layer === 'rollup')
      .some((candidate) => mixedRollupIds.includes(candidate.id))).toBe(false)
    expect(ranking.candidates.some((candidate) => candidate.id === globalMemory.memoryId)).toBe(true)
  })

  it('excludes sensitive semantic memories unless the local recall caller explicitly includes them', () => {
    const sensitive = semantic({
      sensitivity: 'sensitive',
      content: 'Sensitive fact about the user.',
    })
    const options = {
      query: 'Sensitive fact about the user',
      semanticMemories: [sensitive],
      now: new Date('2026-09-30T00:00:00.000Z'),
    }

    expect(rankContinuityLayers(options).candidates).toEqual([])
    expect(rankContinuityLayers({ ...options, includeSensitive: true }).candidates[0]?.id).toBe(sensitive.memoryId)
  })

  it('uses superseded semantic memories only when the requested historical window overlaps them', () => {
    const old = semantic({
      memoryId: '33333333-3333-4333-8333-333333333333',
      observedAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
      validUntil: '2026-09-01T12:00:00.000Z',
      status: 'superseded',
      supersededBy: '44444444-4444-4444-8444-444444444444',
      content: 'I preferred the old continuity format.',
    })
    const current = semantic({
      memoryId: '44444444-4444-4444-8444-444444444444',
      observedAt: '2026-09-01T12:00:00.000Z',
      content: 'I prefer the current continuity format.',
    })
    const historical = rankContinuityLayers({
      query: 'What did I prefer in August?',
      window: {
        start: '2026-08-01T04:00:00.000Z',
        end: '2026-09-01T04:00:00.000Z',
        timeZone: 'America/New_York',
        kind: 'calendar',
        label: 'August 2026',
      },
      semanticMemories: [old, current],
      now: new Date('2026-09-30T00:00:00.000Z'),
    })

    expect(historical.candidates.map((candidate) => candidate.id)).toContain(old.memoryId)
    expect(historical.candidates.map((candidate) => candidate.id)).not.toContain(current.memoryId)
  })

  it('returns deterministic bounded candidates and privacy-safe metric fields without query or content', () => {
    const episodes = Array.from({ length: 12 }, (_, index) =>
      episode(
        'episode-' + index,
        'project-' + (index % 2 ? 'a' : 'b'),
        '2026-09-' + String(10 + index).padStart(2, '0') + 'T12:00:00.000Z',
        'The user chose linked continuity memory.',
      ),
    )
    const working: WorkingRecallState[] = [{
      id: 'working-current',
      projectId: 'project-a',
      observedAt: '2026-09-23T12:00:00.000Z',
      content: 'We are implementing linked continuity memory.',
      sourceIds: ['current-line-id'],
      topics: ['continuity'],
    }]
    const metricEvents: unknown[] = []
    const options = {
      query: 'continue our continuity memory work',
      working,
      episodes,
      now: new Date('2026-09-30T00:00:00.000Z'),
      onMetrics: (metrics: unknown) => metricEvents.push(metrics),
    }
    const first = rankContinuityLayers(options)
    const second = rankContinuityLayers(options)

    expect(first.candidates).toHaveLength(5)
    expect(first.candidates).toEqual(second.candidates)
    expect(first.candidates[0]?.layer).toBe('working')
    expect(metricEvents).toHaveLength(2)
    const serializedMetrics = JSON.stringify(metricEvents[0])
    expect(serializedMetrics).toContain('current-line-id')
    expect(serializedMetrics).not.toContain(options.query)
    expect(serializedMetrics).not.toContain(working[0]!.content)
    expect(serializedMetrics).not.toContain('C:/')
  })
})
