import { TemporalWindowSchema, TimeZoneSchema, type TemporalWindow } from './schemas.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

type TimeZoneSource = 'explicit' | 'configured' | 'system'

export type TemporalWindowResolution =
  | {
      status: 'resolved'
      window: TemporalWindow
      timeZoneSource: TimeZoneSource
      timeZoneInferred: boolean
      timeZoneNote?: string
    }
  | {
      status: 'clarify'
      reason: 'invalid-time-zone' | 'no-bounded-window' | 'invalid-date' | 'ambiguous-time-range'
      message: string
    }

export interface TemporalWindowOptions {
  now?: Date
  configuredTimeZone?: string
  /** Test seam for the detected OS zone; normally resolved from Intl at runtime. */
  systemTimeZone?: string
}

interface CalendarDate {
  year: number
  month: number
  day: number
}

interface LocalDateTime extends CalendarDate {
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, value)
  }
  return value
}

function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  const parts = formatter(timeZone).formatToParts(instant)
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type)?.value
    if (!part) throw new Error(`Timezone formatter omitted ${type}`)
    return Number(part)
  }
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

function utcMillis(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const value = new Date(0)
  value.setUTCFullYear(year, month - 1, day)
  value.setUTCHours(hour, minute, second, 0)
  return value.getTime()
}

function wallMillis(parts: LocalDateTime): number {
  return utcMillis(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)
}

function dateKey(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function dateFromKey(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  return dateKey(date) === value && new Date(utcMillis(date.year, date.month, date.day)).toISOString().slice(0, 10) === value
    ? date
    : null
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const result = new Date(utcMillis(date.year, date.month, date.day) + days * DAY_MS)
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() }
}

function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const first = new Date(utcMillis(date.year, date.month + months, 1))
  return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: 1 }
}

function offsetAt(instantMs: number, timeZone: string): number {
  const wholeSecond = Math.floor(instantMs / 1_000) * 1_000
  return wallMillis(localDateTime(new Date(wholeSecond), timeZone)) - wholeSecond
}

/** Earliest representable instant at or after a local calendar day's start. */
function startOfLocalDay(date: CalendarDate, timeZone: string): Date {
  const targetDate = dateKey(date)
  const targetWall = utcMillis(date.year, date.month, date.day)
  const priorNoon = targetWall - DAY_MS + 12 * 60 * 60 * 1_000
  let candidate = targetWall - offsetAt(priorNoon, timeZone)
  const visited = new Set<number>()

  for (let attempt = 0; attempt < 6; attempt++) {
    const wall = localDateTime(new Date(candidate), timeZone)
    const wallDate = dateKey(wall)
    if (wallDate > targetDate) return new Date(candidate)
    if (wallDate === targetDate) {
      // If midnight was skipped, the prior-offset candidate lands on the first
      // valid wall time after the gap, which is the day's true first instant.
      if (wall.hour !== 0 || wall.minute !== 0 || wall.second !== 0) return new Date(candidate)
      return new Date(candidate)
    }

    const next = targetWall - offsetAt(candidate, timeZone)
    if (visited.has(next) || next === candidate) break
    visited.add(candidate)
    candidate = next
  }

  // Midnight can be ambiguous or skipped in historical timezone transitions.
  // Probe the two adjacent offset interpretations and choose the first instant
  // whose local calendar date is the requested date or later.
  const offsets = new Set([
    offsetAt(priorNoon, timeZone),
    offsetAt(targetWall - DAY_MS + 18 * 60 * 60 * 1_000, timeZone),
    offsetAt(candidate, timeZone),
  ])
  const choices = [...offsets]
    .map((offset) => new Date(targetWall - offset))
    .filter((instant) => dateKey(localDateTime(instant, timeZone)) >= targetDate)
    .sort((left, right) => left.getTime() - right.getTime())
  if (choices[0]) return choices[0]
  throw new Error(`Could not resolve start of ${targetDate} in ${timeZone}`)
}

function calendarWindow(
  start: CalendarDate,
  end: CalendarDate,
  timeZone: string,
  label: string,
): TemporalWindow {
  return TemporalWindowSchema.parse({
    start: startOfLocalDay(start, timeZone).toISOString(),
    end: startOfLocalDay(end, timeZone).toISOString(),
    timeZone,
    kind: 'calendar',
    label,
  })
}

function clarify(
  reason: Extract<TemporalWindowResolution, { status: 'clarify' }>['reason'],
  message: string,
): TemporalWindowResolution {
  return { status: 'clarify', reason, message }
}

function explicitTimeZone(query: string): string | null | undefined {
  const matches = [...query.matchAll(/\b(?:in|timezone|time zone|zone)\s+((?:[A-Za-z_+-]+\/)+[A-Za-z0-9._+-]+|UTC)\b/gi)]
  const unique = [...new Set(matches.map((match) => match[1]!))]
  if (unique.length > 1) return null
  return unique[0]
}

function hasMultipleTemporalCues(query: string): boolean {
  const month = '(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec)'
  const weekday = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)'
  const alternatives = [
    '\\b(?:past|last)\\s+\\d{1,4}\\s+days?\\b',
    '\\b(?:earlier today|this morning|this afternoon|today|yesterday|tonight|this week|last week|this month|last month|previous month|current month|this quarter|last quarter|previous quarter|current quarter|this year|last year|previous year|current year)\\b',
    `\\b(?:this|last)\\s+${weekday}\\b`,
    `\\b${weekday}\\s+(?:this|last)\\s+week\\b`,
    `\\b(?:this|last)\\s+week\\s+${weekday}\\b`,
    `\\b${month}\\s+\\d{1,2},?\\s+\\d{4}\\b`,
    `\\b(?:in|during|throughout)\\s+${month}\\s+\\d{4}\\b`,
    `^\\s*${month}\\s+\\d{4}\\s*$`,
    `\\b(?:this|last)\\s+${month}\\b`,
    '\\bq[1-4]\\s+\\d{4}\\b',
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    `\\b(?:in|during|throughout)\\s+${month}\\b`,
    `^\\s*${month}\\s*$`,
    `\\b${weekday}\\b`,
    '\\b(?:in\\s+)?(?:19|20)\\d{2}\\b',
  ]
  const cues = query.match(new RegExp(alternatives.join('|'), 'gi')) ?? []
  return cues.length > 1
}

function currentCalendarDate(now: Date, timeZone: string): CalendarDate {
  const { year, month, day } = localDateTime(now, timeZone)
  return { year, month, day }
}

function startOfIsoWeek(date: CalendarDate): CalendarDate {
  const weekday = new Date(utcMillis(date.year, date.month, date.day)).getUTCDay()
  return addCalendarDays(date, -((weekday + 6) % 7))
}

function monthIndex(name: string): number | null {
  const normalized = name.toLowerCase()
  const full = MONTHS.indexOf(normalized)
  if (full >= 0) return full + 1
  const short = MONTHS.findIndex((month) => month.slice(0, 3) === normalized)
  return short >= 0 ? short + 1 : null
}

function resolveTimeZone(
  query: string,
  options: TemporalWindowOptions,
): { timeZone: string; source: TimeZoneSource; inferred: boolean; note?: string } | TemporalWindowResolution {
  const explicit = explicitTimeZone(query)
  if (explicit === null) {
    return clarify('invalid-time-zone', 'More than one timezone was named; specify one timezone for this time range.')
  }
  if (explicit !== undefined) {
    const parsed = TimeZoneSchema.safeParse(explicit)
    if (!parsed.success) return clarify('invalid-time-zone', `“${explicit}” is not a supported IANA timezone.`)
    return { timeZone: parsed.data, source: 'explicit', inferred: false }
  }

  if (options.configuredTimeZone) {
    const configured = TimeZoneSchema.safeParse(options.configuredTimeZone)
    if (configured.success) {
      return { timeZone: configured.data, source: 'configured', inferred: false }
    }
  }

  let system = options.systemTimeZone
  if (system === undefined) {
    try {
      system = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      system = undefined
    }
  }
  const detected = TimeZoneSchema.safeParse(system)
  if (!detected.success) {
    return clarify('invalid-time-zone', 'Athena could not determine a valid local timezone; specify an IANA timezone.')
  }
  return {
    timeZone: detected.data,
    source: 'system',
    inferred: true,
    ...(options.configuredTimeZone
      ? { note: 'The configured timezone is invalid; the OS local timezone is being used as an inference.' }
      : {}),
  }
}

function resolved(
  window: TemporalWindow,
  zone: { source: TimeZoneSource; inferred: boolean; note?: string },
): TemporalWindowResolution {
  return {
    status: 'resolved',
    window,
    timeZoneSource: zone.source,
    timeZoneInferred: zone.inferred,
    ...(zone.note ? { timeZoneNote: zone.note } : {}),
  }
}

function namedMonthWindow(
  query: string,
  today: CalendarDate,
  timeZone: string,
): TemporalWindow | null {
  const names = MONTHS.map((month) => `${month}|${month.slice(0, 3)}`).join('|')
  const fullDate = new RegExp(`\\b(${names})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i').exec(query)
  if (fullDate) {
    const month = monthIndex(fullDate[1]!)!
    const start = { year: Number(fullDate[3]), month, day: Number(fullDate[2]) }
    if (!dateFromKey(dateKey(start))) return null
    return calendarWindow(start, addCalendarDays(start, 1), timeZone, fullDate[0])
  }

  const monthYear = new RegExp(`\\b(?:in|during|throughout)\\s+(${names})\\s+(\\d{4})\\b|^\\s*(${names})\\s+(\\d{4})\\s*$`, 'i').exec(query)
  if (monthYear) {
    const name = monthYear[1] ?? monthYear[3]!
    const year = Number(monthYear[2] ?? monthYear[4])
    const month = monthIndex(name)!
    const start = { year, month, day: 1 }
    return calendarWindow(start, addCalendarMonths(start, 1), timeZone, `${MONTHS[month - 1]} ${year}`)
  }

  const relativeMonth = new RegExp(`\\b(this|last)\\s+(${names})\\b`, 'i').exec(query)
  if (relativeMonth) {
    const mode = relativeMonth[1]!.toLowerCase()
    const month = monthIndex(relativeMonth[2]!)!
    let year = today.year
    if (mode === 'last' && month >= today.month) year--
    const start = { year, month, day: 1 }
    return calendarWindow(start, addCalendarMonths(start, 1), timeZone, `${mode} ${MONTHS[month - 1]} ${year}`)
  }

  const monthOnly = new RegExp(`\\b(?:in|during|throughout)\\s+(${names})\\b|^\\s*(${names})\\s*$`, 'i').exec(query)
  if (!monthOnly) return null
  const month = monthIndex(monthOnly[1] ?? monthOnly[2]!)!
  let year = today.year
  if (month > today.month) year--
  const start = { year, month, day: 1 }
  return calendarWindow(start, addCalendarMonths(start, 1), timeZone, `${MONTHS[month - 1]} ${year}`)
}

function resolveCalendarWindow(
  query: string,
  now: Date,
  timeZone: string,
): TemporalWindow | null | 'invalid-date' | 'ambiguous-time-range' {
  const today = currentCalendarDate(now, timeZone)
  const normalized = query.toLowerCase()

  const weekQualified = /\b(?:this\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(this|last)\s+week|(this|last)\s+week\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i.exec(normalized)
  if (weekQualified) {
    const mode = weekQualified[3] ?? weekQualified[4] ?? 'this'
    const weekdayName = weekQualified[1] ?? weekQualified[2] ?? weekQualified[5]!
    const monday = startOfIsoWeek(today)
    const weekStart = mode === 'last' ? addCalendarDays(monday, -7) : monday
    const target = addCalendarDays(weekStart, (WEEKDAYS.indexOf(weekdayName) + 6) % 7)
    return calendarWindow(target, addCalendarDays(target, 1), timeZone, `${mode} ${weekdayName} of the ISO week`)
  }

  if (hasMultipleTemporalCues(query)) return 'ambiguous-time-range'

  const rolling = /\b(?:past|last)\s+(\d{1,4})\s+days?\b/i.exec(query)
  if (rolling) {
    const days = Number(rolling[1])
    if (days < 1 || days > 3_660) return null
    return TemporalWindowSchema.parse({
      start: new Date(now.getTime() - days * DAY_MS).toISOString(),
      end: now.toISOString(),
      timeZone,
      kind: 'rolling',
      label: `${days} elapsed days`,
    })
  }

  const isoDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(query)
  if (isoDate) {
    const start = dateFromKey(isoDate[1]!)
    if (!start) return 'invalid-date'
    return calendarWindow(start, addCalendarDays(start, 1), timeZone, isoDate[1]!)
  }

  const monthDay = namedMonthWindow(query, today, timeZone)
  if (monthDay) return monthDay
  if (/(?:\b\w+\s+\d{1,2},?\s+\d{4}\b)/i.test(query)) return 'invalid-date'

  if (/\b(?:earlier today|today|this morning|this afternoon|tonight)\b/i.test(normalized)) {
    return calendarWindow(today, addCalendarDays(today, 1), timeZone, 'today')
  }
  if (/\byesterday\b/i.test(normalized)) {
    const start = addCalendarDays(today, -1)
    return calendarWindow(start, today, timeZone, 'yesterday')
  }

  if (/\bthis week\b/i.test(normalized)) {
    const start = startOfIsoWeek(today)
    return calendarWindow(start, addCalendarDays(start, 7), timeZone, 'this ISO week')
  }
  if (/\blast week\b/i.test(normalized)) {
    const start = addCalendarDays(startOfIsoWeek(today), -7)
    return calendarWindow(start, addCalendarDays(start, 7), timeZone, 'last ISO week')
  }

  const weekdayMatch = /\b(last|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(normalized)
  if (weekdayMatch) {
    const targetDay = WEEKDAYS.indexOf(weekdayMatch[2]!)
    const currentDay = new Date(utcMillis(today.year, today.month, today.day)).getUTCDay()
    let delta = (currentDay - targetDay + 7) % 7
    if (weekdayMatch[1] === 'last' && delta === 0) delta = 7
    if (weekdayMatch[1] === 'this') {
      const monday = startOfIsoWeek(today)
      const target = addCalendarDays(monday, (targetDay + 6) % 7)
      return calendarWindow(target, addCalendarDays(target, 1), timeZone, `this ${weekdayMatch[2]}`)
    }
    const start = addCalendarDays(today, -delta)
    return calendarWindow(start, addCalendarDays(start, 1), timeZone, weekdayMatch[2]!)
  }

  if (/\b(?:this|current) month\b/i.test(normalized)) {
    const start = { year: today.year, month: today.month, day: 1 }
    return calendarWindow(start, addCalendarMonths(start, 1), timeZone, 'this month')
  }
  if (/\b(?:last|previous) month\b/i.test(normalized)) {
    const start = addCalendarMonths({ year: today.year, month: today.month, day: 1 }, -1)
    return calendarWindow(start, addCalendarMonths(start, 1), timeZone, 'last month')
  }

  if (/\b(?:this|current) quarter\b/i.test(normalized)) {
    const month = Math.floor((today.month - 1) / 3) * 3 + 1
    const start = { year: today.year, month, day: 1 }
    return calendarWindow(start, addCalendarMonths(start, 3), timeZone, 'this quarter')
  }
  if (/\b(?:last|previous) quarter\b/i.test(normalized)) {
    const month = Math.floor((today.month - 1) / 3) * 3 + 1
    const start = addCalendarMonths({ year: today.year, month, day: 1 }, -3)
    return calendarWindow(start, addCalendarMonths(start, 3), timeZone, 'last quarter')
  }
  const quarter = /\bq([1-4])\s+(\d{4})\b/i.exec(query)
  if (quarter) {
    const start = { year: Number(quarter[2]), month: (Number(quarter[1]) - 1) * 3 + 1, day: 1 }
    return calendarWindow(start, addCalendarMonths(start, 3), timeZone, `Q${quarter[1]} ${quarter[2]}`)
  }

  if (/\b(?:this|current) year\b/i.test(normalized)) {
    return calendarWindow({ year: today.year, month: 1, day: 1 }, { year: today.year + 1, month: 1, day: 1 }, timeZone, 'this year')
  }
  if (/\b(?:last|previous) year\b/i.test(normalized)) {
    return calendarWindow({ year: today.year - 1, month: 1, day: 1 }, { year: today.year, month: 1, day: 1 }, timeZone, 'last year')
  }
  const year = /\b(?:in\s+)?(19\d{2}|20\d{2})\b/.exec(query)
  if (year) {
    const value = Number(year[1])
    return calendarWindow({ year: value, month: 1, day: 1 }, { year: value + 1, month: 1, day: 1 }, timeZone, year[1]!)
  }

  return null
}

export function resolveTemporalWindow(
  query: string,
  options: TemporalWindowOptions = {},
): TemporalWindowResolution {
  const now = options.now ?? new Date()
  if (Number.isNaN(now.getTime())) return clarify('no-bounded-window', 'The current time is invalid, so the requested range cannot be resolved.')

  const zone = resolveTimeZone(query, options)
  if ('status' in zone) return zone
  let window: TemporalWindow | null | 'invalid-date' | 'ambiguous-time-range'
  try {
    window = resolveCalendarWindow(query, now, zone.timeZone)
  } catch {
    return clarify('invalid-date', 'The requested calendar range could not be represented in that timezone.')
  }
  if (window === 'invalid-date') {
    return clarify('invalid-date', 'The requested date is not a valid calendar date.')
  }
  if (window === 'ambiguous-time-range') {
    return clarify('ambiguous-time-range', 'The request names more than one time range; please clarify which one you mean.')
  }
  if (!window) {
    return clarify('no-bounded-window', 'I could not resolve that phrase to one time range. Please name a date or calendar period.')
  }
  return resolved(window, zone)
}
