import { describe, expect, it } from 'vitest'
import {
  ContinuityEpisodeSchema,
  ContinuityIndexSchema,
  SemanticMemoryLinkSchema,
  SemanticMemoryRecordSchema,
  SpeechActSchema,
  SourceRefSchema,
  TemporalWindowSchema,
  TimeRollupSchema,
  TimeZoneSchema,
} from '../../src/continuity/schemas.js'

const stamp = '2026-09-23T15:00:00.000Z'
const sourceRef = {
  kind: 'session-message',
  projectId: 'athena-a1b2c3d4e5f6',
  sessionId: 'session-1',
  recordId: 'line-1',
  timestamp: stamp,
  timeZone: 'America/New_York',
}

describe('continuity schemas', () => {
  it('accepts valid IANA zones and rejects invalid or fixed-offset aliases', () => {
    expect(TimeZoneSchema.parse('America/New_York')).toBe('America/New_York')
    expect(TimeZoneSchema.parse('UTC')).toBe('UTC')
    expect(TimeZoneSchema.safeParse('Mars/Olympus_Mons').success).toBe(false)
    expect(TimeZoneSchema.safeParse('+05:00').success).toBe(false)
  })

  it('keeps speech-act categories distinct and closed', () => {
    const acts = ['asked', 'stated', 'considered', 'preferred', 'decided', 'promised', 'corrected', 'retracted']
    for (const act of acts) expect(SpeechActSchema.parse(act)).toBe(act)
    expect(SpeechActSchema.safeParse('asserted').success).toBe(false)
  })

  it('requires source references to be typed, scoped, and path-safe', () => {
    expect(SourceRefSchema.parse(sourceRef)).toEqual(sourceRef)
    expect(SourceRefSchema.safeParse({ ...sourceRef, kind: 'transcript-copy' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...sourceRef, sessionId: '../other' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...sourceRef, recordId: 'C:\\private\\session.jsonl' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...sourceRef, recordId: 'C:private\\session.jsonl' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...sourceRef, timeZone: 'Not/A_Zone' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...sourceRef, path: 'C:\\private\\session.jsonl' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...sourceRef, kind: 'run-event', projectId: null }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...sourceRef, kind: 'memory-file', recordId: 'facts/preference.md' }).success).toBe(true)
  })

  it('validates versioned, bounded episodes and rejects duplicate evidence refs', () => {
    const episode = {
      schemaVersion: 1,
      id: 'episode-1',
      sourceRefs: [sourceRef],
      projectId: 'athena-a1b2c3d4e5f6',
      sessionId: 'session-1',
      observedAt: stamp,
      localDate: '2026-09-23',
      timeZone: 'America/New_York',
      participants: ['user', 'assistant'],
      topics: ['memory', 'continuity'],
    summary: 'We decided to index source-linked episodes.',
    sourceDigest: 'b'.repeat(64),
    speechActs: ['decided'],
    completion: 'completed',
    createdAt: stamp,
    }
    expect(ContinuityEpisodeSchema.parse(episode)).toEqual(episode)
    expect(ContinuityEpisodeSchema.safeParse({ ...episode, schemaVersion: 2 }).success).toBe(false)
    expect(ContinuityEpisodeSchema.safeParse({ ...episode, sourceRefs: [] }).success).toBe(false)
    expect(ContinuityEpisodeSchema.safeParse({ ...episode, sourceRefs: [sourceRef, sourceRef] }).success).toBe(false)
    expect(ContinuityEpisodeSchema.safeParse({ ...episode, summary: 's'.repeat(1_201) }).success).toBe(false)
    expect(ContinuityEpisodeSchema.safeParse({ ...episode, localDate: '2026-02-30' }).success).toBe(false)
    expect(
      ContinuityEpisodeSchema.safeParse({
        ...episode,
        sourceRefs: [{ ...sourceRef, projectId: 'other-project-a1b2c3d4e5f6' }],
      }).success,
    ).toBe(false)
    expect(
      ContinuityEpisodeSchema.safeParse({
        ...episode,
        sourceRefs: [{ ...sourceRef, sessionId: 'other-session' }],
      }).success,
    ).toBe(false)
    expect(ContinuityEpisodeSchema.safeParse({ ...episode, sourceDigest: 'stale' }).success).toBe(false)
  })

  it('validates the complete versioned index and rejects duplicate episode identities', () => {
    const episode = {
      schemaVersion: 1,
      id: 'episode-1',
      sourceRefs: [sourceRef],
      projectId: 'athena-a1b2c3d4e5f6',
      sessionId: 'session-1',
      observedAt: stamp,
      localDate: '2026-09-23',
      timeZone: 'America/New_York',
      participants: ['user', 'assistant'],
      topics: ['memory'],
      summary: 'A bounded linked summary.',
      sourceDigest: 'b'.repeat(64),
      speechActs: ['decided'],
      completion: 'completed',
      createdAt: stamp,
    }
    const index = {
      schemaVersion: 1,
      generatedAt: stamp,
      catalogComplete: true,
      sessions: [{ projectId: 'athena-a1b2c3d4e5f6', sessionId: 'session-1', sourceDigest: 'c'.repeat(64), canonicalLineCount: 3 }],
      episodes: [episode],
    }
    expect(ContinuityIndexSchema.parse(index)).toEqual(index)
    expect(ContinuityIndexSchema.safeParse({ ...index, episodes: [episode, episode] }).success).toBe(false)
  })

  it('preserves semantic-memory lifecycle, provenance, speech act, and validity ordering', () => {
    const memory = {
      memoryId: 'memory-1',
      sourceRefs: [sourceRef],
      observedAt: stamp,
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: '2026-10-01T00:00:00.000Z',
      scope: 'global',
      status: 'candidate',
      confidence: 0.75,
      speechAct: 'preferred',
      captureMode: 'inferred',
      sensitivity: 'ordinary',
    }
    expect(SemanticMemoryLinkSchema.parse(memory)).toEqual(memory)
    for (const status of ['candidate', 'active', 'flagged', 'superseded', 'rejected', 'tombstoned']) {
      expect(SemanticMemoryLinkSchema.safeParse({ ...memory, status }).success).toBe(true)
    }
    expect(SemanticMemoryLinkSchema.safeParse({ ...memory, scope: 'project' }).success).toBe(false)
    expect(SemanticMemoryLinkSchema.safeParse({ ...memory, scope: 'global', projectId: 'athena-a1b2c3d4e5f6' }).success).toBe(false)
    expect(
      SemanticMemoryLinkSchema.safeParse({ ...memory, scope: 'project', projectId: 'athena-a1b2c3d4e5f6' }).success,
    ).toBe(true)
    expect(SemanticMemoryLinkSchema.safeParse({ ...memory, status: 'forgotten' }).success).toBe(false)
    expect(SemanticMemoryLinkSchema.safeParse({ ...memory, confidence: 1.1 }).success).toBe(false)
    expect(SemanticMemoryLinkSchema.safeParse({ ...memory, validUntil: '2026-08-01T00:00:00.000Z' }).success).toBe(false)
    expect(SemanticMemoryLinkSchema.safeParse({ ...memory, sourceRefs: [] }).success).toBe(false)
  })

  it('validates durable semantic memory records and requires independent support for inferences', () => {
    const secondSourceRef = { ...sourceRef, recordId: 'line-2', timestamp: '2026-09-21T13:00:00.000Z' }
    const memory = {
      schemaVersion: 1,
      memoryId: 'a5f06819-fac0-4d47-a12b-b53f23833e14',
      description: 'Cross-project memory preference',
      sourceRefs: [sourceRef, secondSourceRef],
      supportingEpisodeIds: [],
      observedAt: stamp,
      scope: 'global',
      status: 'active',
      confidence: 1,
      speechAct: 'preferred',
      captureMode: 'explicit',
      supersedes: [],
      sensitivity: 'ordinary',
      createdAt: stamp,
      updatedAt: stamp,
    }
    expect(SemanticMemoryRecordSchema.parse(memory)).toEqual(memory)
    expect(SemanticMemoryRecordSchema.safeParse({ ...memory, scope: 'project' }).success).toBe(false)
    expect(SemanticMemoryRecordSchema.safeParse({ ...memory, validFrom: stamp, validUntil: stamp }).success).toBe(false)
    expect(
      SemanticMemoryRecordSchema.safeParse({
        ...memory,
        captureMode: 'inferred',
        supportingEpisodeIds: ['episode-one'],
      }).success,
    ).toBe(false)
    expect(
      SemanticMemoryRecordSchema.safeParse({
        ...memory,
        captureMode: 'inferred',
        supportingEpisodeIds: ['episode-one', 'episode-one'],
      }).success,
    ).toBe(false)
    expect(
      SemanticMemoryRecordSchema.safeParse({
        ...memory,
        captureMode: 'inferred',
        supportingEpisodeIds: ['episode-one', 'episode-two'],
      }).success,
    ).toBe(true)
    expect(
      SemanticMemoryRecordSchema.safeParse({
        ...memory,
        sourceRefs: [sourceRef],
        captureMode: 'inferred',
        supportingEpisodeIds: ['episode-one', 'episode-two'],
      }).success,
    ).toBe(false)
    expect(
      SemanticMemoryRecordSchema.safeParse({
        ...memory,
        captureMode: 'inferred',
        supportingEpisodeIds: ['episode-one', 'episode-two'],
        sensitivity: 'sensitive',
        status: 'active',
        reviewedAt: stamp,
      }).success,
    ).toBe(false)
    expect(
      SemanticMemoryRecordSchema.safeParse({ ...memory, supersedes: [memory.memoryId] }).success,
    ).toBe(false)
    expect(
      SemanticMemoryRecordSchema.safeParse({ ...memory, status: 'superseded' }).success,
    ).toBe(false)
  })

  it('validates rollup calendar bounds, timezone, digest, and unique coverage', () => {
    const rollup = {
      schemaVersion: 1,
      id: 'week-2026-09-21',
      granularity: 'week',
      periodStart: '2026-09-21',
      periodEnd: '2026-09-28',
      timeZone: 'America/New_York',
      summary: 'Continuity design and implementation planning.',
      sourceEpisodeIds: ['episode-1', 'episode-2'],
      sourceDigest: 'a'.repeat(64),
      generator: 'athena-continuity-v1',
      createdAt: stamp,
    }
    expect(TimeRollupSchema.parse(rollup)).toEqual(rollup)
    expect(TimeRollupSchema.safeParse({ ...rollup, periodEnd: rollup.periodStart }).success).toBe(false)
    expect(TimeRollupSchema.safeParse({ ...rollup, sourceDigest: 'bad' }).success).toBe(false)
    expect(TimeRollupSchema.safeParse({ ...rollup, sourceEpisodeIds: ['episode-1', 'episode-1'] }).success).toBe(false)
  })

  it('requires temporal windows to be bounded, ordered instants in an IANA timezone', () => {
    const window = {
      start: '2026-09-23T04:00:00.000Z',
      end: '2026-09-24T04:00:00.000Z',
      timeZone: 'America/New_York',
      kind: 'calendar',
      label: 'today',
    }
    expect(TemporalWindowSchema.parse(window)).toEqual(window)
    expect(TemporalWindowSchema.safeParse({ ...window, end: window.start }).success).toBe(false)
    expect(TemporalWindowSchema.safeParse({ ...window, timeZone: 'No/Such_Zone' }).success).toBe(false)
  })
})
