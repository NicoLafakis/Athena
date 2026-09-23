import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../src/harness/sessions.js'
import { ContinuityStore } from '../../src/continuity/store.js'
import { buildTimeRollups } from '../../src/continuity/rollups.js'
import { formatContinuityRollups } from '../../src/continuity/presentation.js'
import type { ContinuityEpisode, TimeRollup } from '../../src/continuity/schemas.js'

const base = {
  schemaVersion: 1 as const,
  sourceRefs: [
    {
      kind: 'session-message' as const,
      projectId: 'project-one',
      sessionId: 'session-one',
      recordId: 'line-one',
      timestamp: '2026-09-29T23:30:00.000Z',
      timeZone: 'America/New_York',
    },
  ],
  projectId: 'project-one',
  sessionId: 'session-one',
  timeZone: 'America/New_York',
  participants: ['user', 'assistant'] as ContinuityEpisode['participants'],
  topics: ['continuity'],
  sourceDigest: 'a'.repeat(64),
  speechActs: ['decided'] as ContinuityEpisode['speechActs'],
  completion: 'completed' as const,
  createdAt: '2026-09-30T00:00:00.000Z',
}

function episode(id: string, observedAt: string, summary: string): ContinuityEpisode {
  return {
    ...base,
    id,
    observedAt,
    summary,
    sourceRefs: [{ ...base.sourceRefs[0]!, recordId: `line-${id}`, timestamp: observedAt }],
    sourceDigest: id.charCodeAt(0).toString(16).padStart(64, '0'),
  }
}

let root: string
let sessionsRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-time-rollups-'))
  sessionsRoot = join(root, 'sessions')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('buildTimeRollups', () => {
  it('formats an end-exclusive interval and bounds displayed source IDs', () => {
    const rollup: TimeRollup = {
      schemaVersion: 1,
      id: 'year-2026',
      granularity: 'year',
      periodStart: '2026-01-01',
      periodEnd: '2027-01-01',
      timeZone: 'UTC',
      summary: 'A bounded year summary.',
      sourceEpisodeIds: Array.from({ length: 7 }, (_, index) => 'episode-' + (index + 1)),
      sourceDigest: 'a'.repeat(64),
      generator: 'athena-rollup-v1',
      createdAt: '2026-10-01T00:00:00.000Z',
    }
    const fakeStore = {
      buildRollups: () => ({ state: 'ready' as const, rollups: [rollup] }),
    } as unknown as ContinuityStore

    const formatted = formatContinuityRollups(fakeStore, 'UTC', 'year')
    expect(formatted).toContain('YEAR [2026-01-01, 2027-01-01)')
    expect(formatted).toContain('episode-1, episode-2, episode-3, episode-4, episode-5 (+2 more)')
    expect(formatted).not.toContain('episode-6')
    expect(formatted).toContain('athena memory show <episode-id>')
  })

  it('builds local calendar day, ISO week, month, quarter, and year layers', () => {
    const episodes = [
      episode('a', '2026-09-30T03:30:00.000Z', 'Late evening on September 29 in New York.'),
      episode('b', '2026-09-30T04:30:00.000Z', 'Early morning on September 30 in New York.'),
    ]
    const rollups = buildTimeRollups(episodes, {
      timeZone: 'America/New_York',
      now: new Date('2026-10-01T00:00:00.000Z'),
    })

    expect(rollups.filter((item) => item.granularity === 'day').map((item) => item.periodStart)).toEqual([
      '2026-09-29',
      '2026-09-30',
    ])
    for (const granularity of ['week', 'month', 'quarter', 'year'] as const) {
      expect(rollups.filter((item) => item.granularity === granularity)).toHaveLength(1)
      expect(rollups.find((item) => item.granularity === granularity)?.sourceEpisodeIds).toEqual(['a', 'b'])
    }
    expect(rollups.find((item) => item.granularity === 'week')).toMatchObject({
      periodStart: '2026-09-28',
      periodEnd: '2026-10-05',
      timeZone: 'America/New_York',
    })
  })

  it('keeps DST repeated-hour episodes in the same local day and preserves all source IDs', () => {
    const episodes = [
      episode('a', '2026-11-01T05:30:00.000Z', 'First occurrence of 1:30 AM.'),
      episode('b', '2026-11-01T06:30:00.000Z', 'Second occurrence of 1:30 AM.'),
    ]
    const day = buildTimeRollups(episodes, {
      timeZone: 'America/New_York',
      granularities: ['day'],
      now: new Date('2026-11-02T00:00:00.000Z'),
    })[0]
    expect(day?.periodStart).toBe('2026-11-01')
    expect(day?.sourceEpisodeIds).toEqual(['a', 'b'])
  })

  it('uses every source episode in its digest and caps summary text without losing coverage refs', () => {
    const episodes = Array.from({ length: 10 }, (_, index) =>
      episode(String.fromCharCode(97 + index), '2026-09-30T04:30:00.000Z', `${index}: ${'detail '.repeat(170)}`),
    )
    const rollup = buildTimeRollups(episodes, {
      timeZone: 'America/New_York',
      granularities: ['day'],
      now: new Date('2026-10-01T00:00:00.000Z'),
      maxSummaryChars: 1_000,
    })[0]!

    expect(rollup.summary.length).toBeLessThanOrEqual(1_000)
    expect(rollup.summary).toContain('additional episode')
    expect(rollup.sourceEpisodeIds).toHaveLength(10)
    expect(rollup.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic for a fixed clock and source set, and rejects an invalid timezone', () => {
    const input = [episode('a', '2026-09-30T04:30:00.000Z', 'A source-backed summary.')]
    const options = { timeZone: 'America/New_York', now: new Date('2026-10-01T00:00:00.000Z') }
    expect(buildTimeRollups(input, options)).toEqual(buildTimeRollups(input, options))
    expect(() => buildTimeRollups(input, { ...options, timeZone: 'No/Such_Zone' })).toThrow()
  })

  it('reuses timezone formatters across large episode sets and repeated rollup views', () => {
    const timezone = 'Pacific/Marquesas'
    const episodes = Array.from({ length: 20 }, (_, index) =>
      episode(`formatter-${index}`, `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`, `Episode ${index}.`),
    )
    const originalDateTimeFormat = Intl.DateTimeFormat
    const dateTimeFormat = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      (locales, formatOptions) => new originalDateTimeFormat(locales, formatOptions),
    )
    try {
      const options = {
        timeZone: timezone,
        granularities: ['day' as const],
        now: new Date('2026-10-01T00:00:00.000Z'),
      }
      const first = buildTimeRollups(episodes, options)
      const second = buildTimeRollups(episodes, options)
      expect(second).toEqual(first)
      const timezoneProbes = dateTimeFormat.mock.calls.filter(([, formatOptions]) => formatOptions?.timeZone === timezone)
      // One IANA-zone validation plus one cached calendar formatter; none per episode or later view.
      expect(timezoneProbes).toHaveLength(2)
    } finally {
      dateTimeFormat.mockRestore()
    }
  })

  it('builds only from a complete index and reflects source correction/deletion immediately', () => {
    const sessions = new SessionStore(sessionsRoot, 'C:/projects/rollup-refresh')
    const session = sessions.create()
    session.appendMessage({ role: 'user', content: 'The user decided to use linked episodes.' })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'), {
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    })
    store.rebuild(sessionsRoot)
    const first = store.buildRollups('America/New_York', ['year'])
    expect(first.state).toBe('ready')
    expect(first.rollups[0]?.sourceEpisodeIds).toHaveLength(1)
    const firstDigest = first.rollups[0]!.sourceDigest

    session.appendMessage({ role: 'user', content: 'Correction: the user decided on weekly rollups.' })
    session.appendEvent({ type: 'turn-done' })
    store.indexSession(sessionsRoot, sessions.projectId, session.id)
    const corrected = store.buildRollups('America/New_York', ['year'])
    expect(corrected.rollups[0]?.sourceEpisodeIds).toHaveLength(2)
    expect(corrected.rollups[0]?.sourceDigest).not.toBe(firstDigest)

    sessions.delete(session.id)
    store.indexSession(sessionsRoot, sessions.projectId, session.id)
    expect(store.buildRollups('America/New_York', ['year'])).toMatchObject({ state: 'ready', rollups: [] })
  })

  it('does not summarize an unbuilt partial archive as complete history', () => {
    const sessions = new SessionStore(sessionsRoot, 'C:/projects/partial-rollup')
    const session = sessions.create()
    session.appendMessage({ role: 'user', content: 'A partial session.' })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))
    store.indexSession(sessionsRoot, sessions.projectId, session.id)

    expect(store.buildRollups('America/New_York')).toEqual({ state: 'partial', rollups: [] })
  })
})
