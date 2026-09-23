import { describe, expect, it } from 'vitest'
import { resolveTemporalWindow } from '../../src/continuity/time.js'

const now = new Date('2026-09-23T15:00:00.000Z')
const newYork = { now, configuredTimeZone: 'America/New_York' }

describe('resolveTemporalWindow', () => {
  it('resolves today using query-zone calendar boundaries across the spring DST change', () => {
    const result = resolveTemporalWindow('earlier today', {
      ...newYork,
      now: new Date('2026-03-08T16:00:00.000Z'),
    })
    expect(result).toMatchObject({ status: 'resolved', timeZoneSource: 'configured', timeZoneInferred: false })
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.window).toMatchObject({
      start: '2026-03-08T05:00:00.000Z',
      end: '2026-03-09T04:00:00.000Z',
      timeZone: 'America/New_York',
      kind: 'calendar',
    })
  })

  it('resolves yesterday as a local calendar day, not a rolling 24 hours', () => {
    const result = resolveTemporalWindow('yesterday', newYork)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.window.start).toBe('2026-09-22T04:00:00.000Z')
    expect(result.window.end).toBe('2026-09-23T04:00:00.000Z')
  })

  it('resolves ISO weeks Monday through Monday in the configured timezone', () => {
    const result = resolveTemporalWindow('last week', newYork)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.window.start).toBe('2026-09-14T04:00:00.000Z')
    expect(result.window.end).toBe('2026-09-21T04:00:00.000Z')
  })

  it('resolves an unqualified weekday to its most recent occurrence', () => {
    const result = resolveTemporalWindow('What did we discuss Tuesday?', newYork)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.window.start).toBe('2026-09-22T04:00:00.000Z')
    expect(result.window.end).toBe('2026-09-23T04:00:00.000Z')
  })

  it('resolves a weekday qualified by this or last ISO week', () => {
    const thisWeek = resolveTemporalWindow('Tuesday this week', newYork)
    const lastWeek = resolveTemporalWindow('Tuesday last week', newYork)
    expect(thisWeek.status).toBe('resolved')
    expect(lastWeek.status).toBe('resolved')
    if (thisWeek.status === 'resolved') expect(thisWeek.window.start).toBe('2026-09-22T04:00:00.000Z')
    if (lastWeek.status === 'resolved') expect(lastWeek.window.start).toBe('2026-09-15T04:00:00.000Z')
  })

  it('resolves calendar month, named month, quarter, and year boundaries', () => {
    const lastMonth = resolveTemporalWindow('last month', newYork)
    const namedMonth = resolveTemporalWindow('in August 2026', newYork)
    const quarter = resolveTemporalWindow('Q2 2025', newYork)
    const year = resolveTemporalWindow('last year', newYork)
    for (const result of [lastMonth, namedMonth, quarter, year]) {
      expect(result.status).toBe('resolved')
      if (result.status !== 'resolved') continue
      expect(Date.parse(result.window.start)).toBeLessThan(Date.parse(result.window.end))
    }
    expect(lastMonth.status === 'resolved' && lastMonth.window.start).toBe('2026-08-01T04:00:00.000Z')
    expect(namedMonth.status === 'resolved' && namedMonth.window.end).toBe('2026-09-01T04:00:00.000Z')
    expect(quarter.status === 'resolved' && quarter.window.start).toBe('2025-04-01T04:00:00.000Z')
    expect(quarter.status === 'resolved' && quarter.window.end).toBe('2025-07-01T04:00:00.000Z')
    expect(year.status === 'resolved' && year.window.start).toBe('2025-01-01T05:00:00.000Z')
    expect(year.status === 'resolved' && year.window.end).toBe('2026-01-01T05:00:00.000Z')
  })

  it('resolves a relative named month and explicit calendar dates', () => {
    const lastSeptember = resolveTemporalWindow('last September', newYork)
    const thisSeptember = resolveTemporalWindow('this September', newYork)
    const monthDay = resolveTemporalWindow('November 1, 2026', newYork)
    expect(lastSeptember.status).toBe('resolved')
    expect(thisSeptember.status).toBe('resolved')
    expect(monthDay.status).toBe('resolved')
    if (lastSeptember.status === 'resolved') expect(lastSeptember.window.start).toBe('2025-09-01T04:00:00.000Z')
    if (thisSeptember.status === 'resolved') expect(thisSeptember.window.start).toBe('2026-09-01T04:00:00.000Z')
    if (monthDay.status === 'resolved') expect(monthDay.window.start).toBe('2026-11-01T04:00:00.000Z')
  })

  it('treats “past N days” as an elapsed rolling interval', () => {
    const result = resolveTemporalWindow('past 7 days', newYork)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.window).toMatchObject({
      start: '2026-09-16T15:00:00.000Z',
      end: '2026-09-23T15:00:00.000Z',
      kind: 'rolling',
    })
  })

  it('lets an explicitly named timezone override configuration', () => {
    const result = resolveTemporalWindow('2026-09-23 in Asia/Tokyo', newYork)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.timeZoneSource).toBe('explicit')
    expect(result.window.start).toBe('2026-09-22T15:00:00.000Z')
    expect(result.window.end).toBe('2026-09-23T15:00:00.000Z')
  })

  it('labels OS-local timezone fallback as inferred', () => {
    const result = resolveTemporalWindow('today', { now, systemTimeZone: 'UTC' })
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.timeZoneSource).toBe('system')
    expect(result.timeZoneInferred).toBe(true)
    expect(result.window.timeZone).toBe('UTC')
  })

  it('asks for clarification on unknown timezones or unbounded temporal wording', () => {
    expect(resolveTemporalWindow('today in Mars/Olympus_Mons', newYork)).toMatchObject({
      status: 'clarify',
      reason: 'invalid-time-zone',
    })
    expect(resolveTemporalWindow('recently', newYork)).toMatchObject({
      status: 'clarify',
      reason: 'no-bounded-window',
    })
    expect(resolveTemporalWindow('last Tuesday and today', newYork)).toMatchObject({
      status: 'clarify',
      reason: 'ambiguous-time-range',
    })
    expect(resolveTemporalWindow('today in UTC and in Asia/Tokyo', newYork)).toMatchObject({
      status: 'clarify',
      reason: 'invalid-time-zone',
    })
  })

  it('uses a 25-hour local day across the autumn DST transition', () => {
    const result = resolveTemporalWindow('November 1 2026', newYork)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    expect(result.window.start).toBe('2026-11-01T04:00:00.000Z')
    expect(result.window.end).toBe('2026-11-02T05:00:00.000Z')
  })

  it.each([
    ['America/New_York', '2026-03-08'],
    ['America/New_York', '2026-11-01'],
    ['Europe/Berlin', '2026-03-29'],
    ['Europe/Berlin', '2026-10-25'],
    ['Australia/Lord_Howe', '2026-10-04'],
    ['Asia/Kathmandu', '2026-03-08'],
  ])('keeps local-day boundaries aligned for %s on %s', (timeZone, date) => {
    const result = resolveTemporalWindow(date, {
      now: new Date(`${date}T12:00:00.000Z`),
      configuredTimeZone: timeZone,
    })
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected a resolved window')
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const dateAt = (instant: Date): string => {
      const parts = formatter.formatToParts(instant)
      const part = (type: 'year' | 'month' | 'day') => parts.find((value) => value.type === type)!.value
      return `${part('year')}-${part('month')}-${part('day')}`
    }
    const localStart = dateAt(new Date(result.window.start))
    const expectedEnd = new Date(`${date}T00:00:00.000Z`)
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() + 1)
    const localEnd = dateAt(new Date(result.window.end))
    expect(localStart).toBe(date)
    expect(localEnd).toBe(expectedEnd.toISOString().slice(0, 10))
    expect(Date.parse(result.window.end)).toBeGreaterThan(Date.parse(result.window.start))
  })
})
