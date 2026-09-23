import { createHash } from 'node:crypto'
import {
  ContinuityEpisodeSchema,
  TimeRollupSchema,
  TimeZoneSchema,
  type ContinuityEpisode,
  type TimeRollup,
} from './schemas.js'

const GRANULARITY_ORDER: TimeRollup['granularity'][] = ['day', 'week', 'month', 'quarter', 'year']

export interface BuildTimeRollupOptions {
  timeZone: string
  now?: Date
  granularities?: TimeRollup['granularity'][]
  maxSummaryChars?: number
  maxRollups?: number
}

interface CalendarDate {
  year: number
  month: number
  day: number
}

interface Bucket {
  granularity: TimeRollup['granularity']
  id: string
  periodStart: string
  periodEnd: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function dateKey(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function localDate(instant: string, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day') }
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() }
}

function bucketFor(date: CalendarDate, granularity: TimeRollup['granularity']): Bucket {
  const startOfMonth = { year: date.year, month: date.month, day: 1 }
  switch (granularity) {
    case 'day': {
      const start = dateKey(date)
      return { granularity, id: `day-${start}`, periodStart: start, periodEnd: dateKey(addDays(date, 1)) }
    }
    case 'week': {
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
      const start = addDays(date, -((weekday + 6) % 7))
      const startKey = dateKey(start)
      return {
        granularity,
        id: `week-${startKey}`,
        periodStart: startKey,
        periodEnd: dateKey(addDays(start, 7)),
      }
    }
    case 'month': {
      const end = date.month === 12 ? { year: date.year + 1, month: 1, day: 1 } : { ...startOfMonth, month: date.month + 1 }
      return {
        granularity,
        id: `month-${date.year}-${String(date.month).padStart(2, '0')}`,
        periodStart: dateKey(startOfMonth),
        periodEnd: dateKey(end),
      }
    }
    case 'quarter': {
      const firstMonth = Math.floor((date.month - 1) / 3) * 3 + 1
      const year = firstMonth === 10 ? date.year + 1 : date.year
      const endMonth = firstMonth === 10 ? 1 : firstMonth + 3
      return {
        granularity,
        id: `quarter-${date.year}-Q${Math.floor((date.month - 1) / 3) + 1}`,
        periodStart: dateKey({ year: date.year, month: firstMonth, day: 1 }),
        periodEnd: dateKey({ year, month: endMonth, day: 1 }),
      }
    }
    case 'year':
      return {
        granularity,
        id: `year-${date.year}`,
        periodStart: `${String(date.year).padStart(4, '0')}-01-01`,
        periodEnd: `${String(date.year + 1).padStart(4, '0')}-01-01`,
      }
  }
}

function summaryFor(
  episodes: ContinuityEpisode[],
  dates: Map<string, string>,
  maxChars: number,
): string {
  const lines = episodes.map((episode) =>
    `[${dates.get(episode.id)} | ${episode.projectId ?? 'unknown-project'}] ${episode.summary}`,
  )
  const included: string[] = []
  let length = 0
  for (const line of lines) {
    const addedLength = line.length + (included.length ? 1 : 0)
    if (length + addedLength > maxChars) break
    included.push(line)
    length += addedLength
  }
  const omitted = lines.length - included.length
  let summary = included.join('\n')
  if (omitted > 0) {
    const suffix = `\n… ${omitted} additional episode${omitted === 1 ? '' : 's'} omitted; source IDs retain full coverage.`
    summary = `${summary.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`
  }
  return summary.slice(0, maxChars)
}

/** Build local calendar rollups from the current, already-redacted episode index. */
export function buildTimeRollups(
  inputEpisodes: ContinuityEpisode[],
  options: BuildTimeRollupOptions,
): TimeRollup[] {
  const timeZone = TimeZoneSchema.parse(options.timeZone)
  const maxSummaryChars = options.maxSummaryChars ?? 4_000
  if (!Number.isInteger(maxSummaryChars) || maxSummaryChars < 128 || maxSummaryChars > 4_000) {
    throw new Error('maxSummaryChars must be an integer between 128 and 4000')
  }
  const maxRollups = options.maxRollups ?? 250_000
  if (!Number.isInteger(maxRollups) || maxRollups < 1) throw new Error('maxRollups must be a positive integer')
  const now = (options.now ?? new Date()).toISOString()
  const episodes = inputEpisodes
    .map((episode) => ContinuityEpisodeSchema.parse(episode))
    .sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        (left.projectId ?? '').localeCompare(right.projectId ?? '') ||
        left.id.localeCompare(right.id),
    )
  if (new Set(episodes.map((episode) => episode.id)).size !== episodes.length) {
    throw new Error('Rollup input contains duplicate episode IDs')
  }
  const granularities = options.granularities ?? GRANULARITY_ORDER
  for (const granularity of granularities) {
    if (!GRANULARITY_ORDER.includes(granularity)) throw new Error(`Unsupported rollup granularity: ${granularity}`)
  }

  const grouped = new Map<string, { bucket: Bucket; episodes: ContinuityEpisode[]; dates: Map<string, string> }>()
  for (const episode of episodes) {
    const date = localDate(episode.observedAt, timeZone)
    const localDateKey = dateKey(date)
    for (const granularity of granularities) {
      const bucket = bucketFor(date, granularity)
      const key = `${granularity}\0${bucket.id}`
      let group = grouped.get(key)
      if (!group) {
        group = { bucket, episodes: [], dates: new Map() }
        grouped.set(key, group)
      }
      group.episodes.push(episode)
      group.dates.set(episode.id, localDateKey)
    }
  }
  if (grouped.size > maxRollups) throw new Error('Time rollup generation exceeds the configured rollup limit')

  return [...grouped.values()]
    .map(({ bucket, episodes: sourceEpisodes, dates }) => {
      const sortedIds = sourceEpisodes.map((episode) => episode.id)
      const sourceDigest = sha256(JSON.stringify(sourceEpisodes))
      return TimeRollupSchema.parse({
        schemaVersion: 1,
        ...bucket,
        timeZone,
        summary: summaryFor(sourceEpisodes, dates, maxSummaryChars),
        sourceEpisodeIds: sortedIds,
        sourceDigest,
        generator: 'athena-rollup-v1',
        createdAt: now,
      })
    })
    .sort(
      (left, right) =>
        left.periodStart.localeCompare(right.periodStart) ||
        GRANULARITY_ORDER.indexOf(left.granularity) - GRANULARITY_ORDER.indexOf(right.granularity),
    )
}
