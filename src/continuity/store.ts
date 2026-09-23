import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../tools/files.js'
import { redactSessionValue, sessionLineDigest, stableSessionLineId } from '../harness/sessions.js'
import {
  ContinuityIndexSchema,
  ContinuityEpisodeSchema,
  parseContinuityIndex,
  ContinuityTombstoneLedgerSchema,
  TimeZoneSchema,
  type ContinuityEpisode,
  type ContinuityIndex,
  type ContinuityTombstoneLedger,
  type SpeechAct,
  type SourceRef,
  type TimeRollup,
} from './schemas.js'
import { buildTimeRollups } from './rollups.js'
import {
  canonicalSessionRecords,
  listAllProjectSessions,
  readSessionLineRecordsDetailed,
} from './session-catalog.js'
import type { SessionLineRecord } from '../harness/sessions.js'
import { jevSpeechActsByUserMessage } from './jev-events.js'

export interface ContinuityStoreOptions {
  onWarn?: (warning: string) => void
  maxEpisodes?: number
  maxIndexBytes?: number
  now?: () => Date
}

export interface ContinuityRebuildResult {
  sessionCount: number
  episodeCount: number
  warnings: string[]
  generatedAt: string
}

export interface ContinuityStatus {
  state: 'missing' | 'partial' | 'ready' | 'corrupt'
  episodeCount: number
  projectCount: number
  generatedAt?: string
}

export interface ContinuityRollupResult {
  state: 'missing' | 'partial' | 'ready' | 'corrupt'
  rollups: TimeRollup[]
}

interface TurnGroup {
  records: SessionLineRecord[]
  completion: ContinuityEpisode['completion']
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'being', 'before', 'between',
  'but', 'can', 'could', 'did', 'does', 'doing', 'done', 'each', 'for', 'from', 'get', 'got',
  'had', 'has', 'have', 'her', 'here', 'him', 'his', 'how', 'into', 'its', 'just', 'like', 'make',
  'many', 'may', 'might', 'more', 'most', 'much', 'must', 'need', 'now', 'our', 'out', 'over',
  'same', 'should', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'too', 'under', 'use', 'used', 'using', 'very', 'was', 'were',
  'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'you', 'your', 'athena',
  'assistant', 'user',
])

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const tombstoneKeysByLedger = new WeakMap<object, ReadonlySet<string>>()

function isTombstoned(ledger: ContinuityTombstoneLedger, projectId: string, sessionId: string): boolean {
  return tombstoneKeys(ledger).has(`${projectId}\0${sessionId}`)
}

function tombstoneKeys(ledger: ContinuityTombstoneLedger): ReadonlySet<string> {
  let keys = tombstoneKeysByLedger.get(ledger)
  if (!keys) {
    keys = new Set(ledger.sessions.map((entry) => `${entry.projectId}\0${entry.sessionId}`))
    tombstoneKeysByLedger.set(ledger, keys)
  }
  return keys
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolResultOnly(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => isObject(block) && block.type === 'tool_result')
  )
}

function isUserTurnStart(record: SessionLineRecord): boolean {
  if (record.line.kind !== 'message' || !isObject(record.line.data)) return false
  return record.line.data.role === 'user' && !isToolResultOnly(record.line.data.content)
}

function messageRole(record: SessionLineRecord): 'user' | 'assistant' | null {
  if (record.line.kind !== 'message' || !isObject(record.line.data)) return null
  const role = record.line.data.role
  return role === 'user' || role === 'assistant' ? role : null
}

function messageText(record: SessionLineRecord): string {
  if (record.line.kind !== 'message' || !isObject(record.line.data)) return ''
  const content = record.line.data.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> => isObject(block) && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join(' ')
}

function eventType(record: SessionLineRecord): string | null {
  if (record.line.kind !== 'event' || !isObject(record.line.data)) return null
  return typeof record.line.data.type === 'string' ? record.line.data.type : null
}

function hasInvalidTimestamps(records: SessionLineRecord[]): boolean {
  return canonicalSessionRecords(records).some(
    (record) => Number.isNaN(new Date(record.line.ts).getTime()),
  )
}

function extractTopics(text: string): string[] {
  const counts = new Map<string, number>()
  for (const word of text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{2,63}/gu) ?? []) {
    if (STOP_WORDS.has(word) || /^\d+$/.test(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 24)
    .map(([word]) => word)
}

function extractSpeechActs(text: string): SpeechAct[] {
  const acts: SpeechAct[] = []
  const tests: Array<[SpeechAct, RegExp]> = [
    ['asked', /\?|\b(?:what|when|where|why|how|can you|could you|should we)\b/i],
    ['considered', /\b(?:maybe|might|could consider|considering|what if|thinking about)\b/i],
    ['preferred', /\b(?:i prefer|i'd prefer|i would prefer|i like|i dislike)\b/i],
    ['decided', /\b(?:i decided|we decided|my decision is|i've decided)\b/i],
    ['promised', /\b(?:i promise|i promised|i commit to|i will make sure)\b/i],
    ['corrected', /\b(?:i was wrong|correction:|to correct that|that was incorrect)\b/i],
    ['retracted', /\b(?:i retract|disregard what i said|take that back|i withdraw)\b/i],
  ]
  for (const [act, pattern] of tests) if (pattern.test(text)) acts.push(act)
  return acts
}

function localDate(timestamp: string, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp))
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
    const year = value('year')
    const month = value('month')
    const day = value('day')
    return year && month && day ? `${year}-${month}-${day}` : undefined
  } catch {
    return undefined
  }
}

function makeEpisode(
  projectId: string,
  sessionId: string,
  group: TurnGroup,
): ContinuityEpisode {
  const start = group.records.find(isUserTurnStart)
  if (!start) throw new Error('Episode group has no initiating user message')
  const startTimestamp = new Date(start.line.ts)
  if (Number.isNaN(startTimestamp.getTime())) throw new Error('Episode start has an invalid timestamp')

  const texts = group.records
    .filter((record) => record.line.kind === 'message')
    .map((record) => ({ role: messageRole(record), text: messageText(record) }))
    .filter((item) => item.role && item.text.trim())
  const userText = texts.filter((item) => item.role === 'user').map((item) => item.text).join(' ')
  const assistantText = texts.filter((item) => item.role === 'assistant').map((item) => item.text).join(' ')
  const summaryParts = [
    userText ? `User: ${userText}` : 'User turn with non-text content.',
    assistantText ? `Athena: ${assistantText}` : '',
  ].filter(Boolean)
  const summary = (redactSessionValue(summaryParts.join('\n')) as string)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_200)
  const recordIds = new Set<string>()
  const sourceRefs: SourceRef[] = []
  const participants = new Set<'user' | 'assistant' | 'runtime'>()
  for (const record of group.records) {
    const role = messageRole(record)
    const kind = record.line.kind === 'message' ? 'session-message' : 'session-event'
    const id = stableSessionLineId(record)
    const uniqueKey = `${kind}\0${id}`
    if (recordIds.has(uniqueKey)) continue
    const timestamp = new Date(record.line.ts)
    // Keep a defensive guard so summary text and source refs remain one verifiable set.
    if (Number.isNaN(timestamp.getTime())) throw new Error('Episode contains an invalid timestamp')
    recordIds.add(uniqueKey)
    if (role) participants.add(role)
    else if (record.line.kind === 'event') participants.add('runtime')
    const candidateZone = typeof record.line.timeZone === 'string' && TimeZoneSchema.safeParse(record.line.timeZone).success
      ? record.line.timeZone
      : undefined
    sourceRefs.push({
      kind,
      projectId,
      sessionId,
      recordId: id,
      lineDigest: sessionLineDigest(record),
      timestamp: timestamp.toISOString(),
      ...(candidateZone ? { timeZone: candidateZone } : {}),
    })
  }

  const startZone = typeof start.line.timeZone === 'string' && TimeZoneSchema.safeParse(start.line.timeZone).success
    ? start.line.timeZone
    : undefined
  const allText = texts.map((item) => item.text).join('\n')
  const jevSpeechActs = jevSpeechActsByUserMessage(group.records, projectId, sessionId)
  const speechActs = [...new Set([
    ...extractSpeechActs(userText),
    ...jevSpeechActs.values(),
  ])]
  const episodeId = `episode-${digest(`${projectId}\0${sessionId}\0${sourceRefs[0]?.recordId ?? start.lineNumber}`)}`
  return ContinuityEpisodeSchema.parse({
    schemaVersion: 1,
    id: episodeId,
    sourceRefs,
    projectId,
    sessionId,
    observedAt: startTimestamp.toISOString(),
    ...(startZone ? { localDate: localDate(startTimestamp.toISOString(), startZone), timeZone: startZone } : {}),
    participants: [...participants],
    topics: extractTopics(allText),
    summary,
    sourceDigest: digest(group.records.map((record) => record.rawLine).join('\n')),
    speechActs,
    completion: group.completion,
    createdAt: startTimestamp.toISOString(),
  })
}

function extractSessionEpisodes(
  projectId: string,
  sessionId: string,
  records: SessionLineRecord[],
  malformedLineNumbers: number[] = [],
): ContinuityEpisode[] {
  const canonical = canonicalSessionRecords(records)
  const ordered: Array<{ lineNumber: number; record?: SessionLineRecord }> = [
    ...canonical.map((record) => ({ lineNumber: record.lineNumber, record })),
    ...malformedLineNumbers.map((lineNumber) => ({ lineNumber })),
  ].sort((left, right) => left.lineNumber - right.lineNumber)
  const groups: TurnGroup[] = []
  let current: SessionLineRecord[] = []
  let currentUncertain = false
  const finish = (completion: TurnGroup['completion']) => {
    if (current.length > 0) groups.push({ records: current, completion })
    current = []
    currentUncertain = false
  }

  for (const item of ordered) {
    if (!item.record) {
      if (current.length > 0) currentUncertain = true
      continue
    }
    const record = item.record
    const timestamp = new Date(record.line.ts)
    if (Number.isNaN(timestamp.getTime())) {
      if (current.length === 0) continue
      if (isUserTurnStart(record) || eventType(record) === 'turn-done') {
        finish('uncertain')
      } else {
        currentUncertain = true
      }
      continue
    }
    if (isUserTurnStart(record)) {
      if (current.length) finish(currentUncertain ? 'uncertain' : 'interrupted')
      current = [record]
      continue
    }
    if (!current.length) continue
    current.push(record)
    if (eventType(record) === 'turn-done') finish(currentUncertain ? 'uncertain' : 'completed')
  }
  if (current.length) finish(currentUncertain ? 'uncertain' : 'interrupted')

  return groups.map((group) => makeEpisode(projectId, sessionId, group))
}

export class ContinuityStore {
  private readonly indexFile: string
  private readonly tombstoneFile: string
  private readonly warned = new Set<string>()
  private cachedIndexDigest: string | undefined
  private cachedIndex: ContinuityIndex | null = null
  private cachedVisibleKey: string | undefined
  private cachedVisibleIndex: ContinuityIndex | null = null

  constructor(
    root: string,
    private readonly options: ContinuityStoreOptions = {},
  ) {
    this.indexFile = join(root, 'index.json')
    this.tombstoneFile = join(root, 'tombstones.json')
  }

  listEpisodes(): ContinuityEpisode[] {
    return this.readIndex()?.episodes ?? []
  }

  buildRollups(
    timeZone: string,
    granularities?: TimeRollup['granularity'][],
  ): ContinuityRollupResult {
    const indexExists = existsSync(this.indexFile)
    const index = this.readIndex()
    if (!index) {
      if (indexExists || !this.readTombstones()) return { state: 'corrupt', rollups: [] }
      return { state: 'missing', rollups: [] }
    }
    if (!index.catalogComplete) return { state: 'partial', rollups: [] }
    return {
      state: 'ready',
      rollups: buildTimeRollups(index.episodes, {
        timeZone,
        ...(granularities ? { granularities } : {}),
        ...(this.options.now ? { now: this.options.now() } : {}),
      }),
    }
  }

  status(): ContinuityStatus {
    const indexExists = existsSync(this.indexFile)
    const index = this.readIndex()
    if (!index) {
      if (indexExists || !this.readTombstones()) return { state: 'corrupt', episodeCount: 0, projectCount: 0 }
      return { state: 'missing', episodeCount: 0, projectCount: 0 }
    }
    return {
      state: index.catalogComplete ? 'ready' : 'partial',
      episodeCount: index.episodes.length,
      projectCount: new Set(index.sessions.map((session) => session.projectId)).size,
      generatedAt: index.generatedAt,
    }
  }

  /** Snapshot the content-free suppressed source identities for one local read operation. */
  sessionSuppressionSnapshot(): { state: 'ready' | 'corrupt'; sessionKeys: ReadonlySet<string> } {
    const ledger = this.readTombstones()
    return ledger
      ? { state: 'ready', sessionKeys: tombstoneKeys(ledger) }
      : { state: 'corrupt', sessionKeys: new Set<string>() }
  }

  /** Replace one session's episodes after a completed turn; never scans other projects. */
  indexSession(
    sessionsRoot: string,
    projectId: string,
    sessionId: string,
  ): { state: 'indexed' | 'removed' | 'missing' | 'corrupt'; episodeCount: number } {
    const tombstones = this.readTombstones()
    if (!tombstones) return { state: 'corrupt', episodeCount: 0 }
    if (isTombstoned(tombstones, projectId, sessionId)) {
      return { state: 'removed', episodeCount: 0 }
    }
    const exists = existsSync(this.indexFile)
    const previous = this.readIndex()
    if (exists && !previous) return { state: 'corrupt', episodeCount: 0 }
    const now = (this.options.now?.() ?? new Date()).toISOString()
    const index: ContinuityIndex = previous ?? {
      schemaVersion: 1,
      generatedAt: now,
      catalogComplete: false,
      sessions: [],
      episodes: [],
    }
    const source = listAllProjectSessions(sessionsRoot).find(
      (item) => item.projectId === projectId && item.sessionId === sessionId,
    )
    if (!source) {
      const next = ContinuityIndexSchema.parse({
        ...index,
        generatedAt: now,
        sessions: index.sessions.filter((item) => item.projectId !== projectId || item.sessionId !== sessionId),
        episodes: index.episodes.filter((item) => item.projectId !== projectId || item.sessionId !== sessionId),
      })
      this.writeIndex(next)
      return { state: 'removed', episodeCount: 0 }
    }

    let records: SessionLineRecord[]
    let malformedLineNumbers: number[]
    try {
      const result = readSessionLineRecordsDetailed(source.file)
      records = result.records
      malformedLineNumbers = result.malformedLineNumbers
    } catch {
      this.warn(`source session ${projectId}/${sessionId} could not be read`)
      return { state: 'missing', episodeCount: 0 }
    }
    const canonical = canonicalSessionRecords(records)
    const digestValue = digest(canonical.map((record) => record.rawLine).join('\n'))
    if (malformedLineNumbers.length > 0 || hasInvalidTimestamps(records)) {
      this.warn(`source session ${projectId}/${sessionId} contains malformed records; affected episodes are marked uncertain`)
    }
    let episodes: ContinuityEpisode[]
    try {
      episodes = extractSessionEpisodes(projectId, sessionId, records, malformedLineNumbers)
    } catch {
      this.warn(`source session ${projectId}/${sessionId} contains invalid continuity records`)
      return { state: 'missing', episodeCount: 0 }
    }
    const next = ContinuityIndexSchema.parse({
      ...index,
      generatedAt: now,
      sessions: [
        ...index.sessions.filter((item) => item.projectId !== projectId || item.sessionId !== sessionId),
        { projectId, sessionId, sourceDigest: digestValue, canonicalLineCount: canonical.length },
      ].sort((left, right) => left.projectId.localeCompare(right.projectId) || left.sessionId.localeCompare(right.sessionId)),
      episodes: [
        ...index.episodes.filter((item) => item.projectId !== projectId || item.sessionId !== sessionId),
        ...episodes,
      ].sort(
        (left, right) =>
          left.observedAt.localeCompare(right.observedAt) ||
          left.projectId!.localeCompare(right.projectId!) ||
          left.id.localeCompare(right.id),
      ),
    })
    this.writeIndex(next)
    return { state: 'indexed', episodeCount: episodes.length }
  }

  readIndex(): ContinuityIndex | null {
    const tombstones = this.readTombstonesWithDigest()
    if (!tombstones) {
      this.cachedIndexDigest = undefined
      this.cachedIndex = null
      this.cachedVisibleKey = undefined
      this.cachedVisibleIndex = null
      return null
    }
    if (!existsSync(this.indexFile)) {
      this.cachedIndexDigest = undefined
      this.cachedIndex = null
      this.cachedVisibleKey = undefined
      this.cachedVisibleIndex = null
      return null
    }
    try {
      const statLimit = this.options.maxIndexBytes ?? 64 * 1024 * 1024
      const contentBytes = readFileSync(this.indexFile)
      if (contentBytes.byteLength > statLimit) throw new Error('index exceeds size limit')
      const content = contentBytes.toString('utf8')
      const contentDigest = createHash('sha256').update(contentBytes).digest('hex')
      if (contentDigest !== this.cachedIndexDigest) {
        this.cachedIndex = parseContinuityIndex(JSON.parse(content) as unknown)
        this.cachedIndexDigest = contentDigest
        this.cachedVisibleKey = undefined
        this.cachedVisibleIndex = null
      }
      if (!this.cachedIndex) return null
      if (tombstones.ledger.sessions.length === 0) return this.cachedIndex
      const visibleKey = `${contentDigest}:${tombstones.digest}`
      if (visibleKey === this.cachedVisibleKey) return this.cachedVisibleIndex
      const visible = ContinuityIndexSchema.parse({
        ...this.cachedIndex,
        sessions: this.cachedIndex.sessions.filter(
          (session) => !isTombstoned(tombstones.ledger, session.projectId, session.sessionId),
        ),
        episodes: this.cachedIndex.episodes.filter(
          (episode) => !isTombstoned(tombstones.ledger, episode.projectId ?? '', episode.sessionId),
        ),
      })
      this.cachedVisibleKey = visibleKey
      this.cachedVisibleIndex = parseContinuityIndex(visible)
      return this.cachedVisibleIndex
    } catch {
      this.cachedIndexDigest = undefined
      this.cachedIndex = null
      this.cachedVisibleKey = undefined
      this.cachedVisibleIndex = null
      this.warn(`index ${this.indexFile} is corrupt or unreadable`)
      return null
    }
  }

  rebuild(sessionsRoot: string): ContinuityRebuildResult {
    const tombstones = this.readTombstones()
    if (!tombstones) {
      throw new Error(`Cannot rebuild continuity while tombstone ledger ${this.tombstoneFile} is corrupt; restore a valid ledger before rebuilding.`)
    }
    this.readIndex()
    const generatedAt = (this.options.now?.() ?? new Date()).toISOString()
    const warnings: string[] = []
    const episodes: ContinuityEpisode[] = []
    const indexedSessions: ContinuityIndex['sessions'] = []
    const sources = listAllProjectSessions(sessionsRoot).filter(
      (source) => !isTombstoned(tombstones, source.projectId, source.sessionId),
    )
    for (const source of sources) {
      try {
        const result = readSessionLineRecordsDetailed(source.file)
        const records = result.records
        const canonical = canonicalSessionRecords(records)
        indexedSessions.push({
          projectId: source.projectId,
          sessionId: source.sessionId,
          sourceDigest: digest(canonical.map((record) => record.rawLine).join('\n')),
          canonicalLineCount: canonical.length,
        })
        if (result.malformedLineNumbers.length > 0 || hasInvalidTimestamps(records)) {
          warnings.push(`Skipped malformed continuity records in session ${source.projectId}/${source.sessionId}; affected episodes are marked uncertain`)
        }
        try {
          episodes.push(...extractSessionEpisodes(
            source.projectId,
            source.sessionId,
            records,
            result.malformedLineNumbers,
          ))
        } catch {
          warnings.push(`Skipped invalid continuity records in session ${source.projectId}/${source.sessionId}`)
        }
      } catch {
        warnings.push(`Could not read session ${source.projectId}/${source.sessionId}`)
      }
    }

    episodes.sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) || left.projectId!.localeCompare(right.projectId!) || left.id.localeCompare(right.id),
    )
    if (episodes.length > (this.options.maxEpisodes ?? 100_000)) {
      throw new Error('Continuity rebuild exceeds the configured episode limit')
    }
    const index = ContinuityIndexSchema.parse({
      schemaVersion: 1,
      generatedAt,
      catalogComplete: true,
      sessions: indexedSessions,
      episodes,
    })
    this.writeIndex(index)
    for (const warning of warnings) this.warn(warning)
    return { sessionCount: sources.length, episodeCount: episodes.length, warnings, generatedAt }
  }

  /** Persist a content-free source suppression record before moving a deleted transcript. */
  tombstoneSession(projectId: string, sessionId: string): void {
    const ledger = this.readTombstones()
    if (!ledger) throw new Error(`Cannot update corrupt tombstone ledger ${this.tombstoneFile}`)
    if (!isTombstoned(ledger, projectId, sessionId)) {
      const next = ContinuityTombstoneLedgerSchema.parse({
        ...ledger,
        sessions: [
          ...ledger.sessions,
          { projectId, sessionId, deletedAt: (this.options.now?.() ?? new Date()).toISOString() },
        ].sort((left, right) => left.projectId.localeCompare(right.projectId) || left.sessionId.localeCompare(right.sessionId)),
      })
      this.writeTombstones(next)
    }
    const index = this.readIndex()
    if (!index) return
    this.writeIndex(ContinuityIndexSchema.parse({
      ...index,
      sessions: index.sessions.filter((item) => item.projectId !== projectId || item.sessionId !== sessionId),
      episodes: index.episodes.filter((item) => item.projectId !== projectId || item.sessionId !== sessionId),
    }))
  }

  /** Clear a tombstone only after an explicit restore made the source session live again. */
  restoreSession(
    projectId: string,
    sessionId: string,
    sessionsRoot: string,
  ): { state: 'indexed' | 'removed' | 'missing' | 'corrupt'; episodeCount: number } {
    const source = listAllProjectSessions(sessionsRoot).find(
      (item) => item.projectId === projectId && item.sessionId === sessionId,
    )
    if (!source) return { state: 'missing', episodeCount: 0 }
    const ledger = this.readTombstones()
    if (!ledger) return { state: 'corrupt', episodeCount: 0 }
    if (isTombstoned(ledger, projectId, sessionId)) {
      this.writeTombstones(ContinuityTombstoneLedgerSchema.parse({
        ...ledger,
        sessions: ledger.sessions.filter((item) => item.projectId !== projectId || item.sessionId !== sessionId),
      }))
    }
    return this.indexSession(sessionsRoot, projectId, sessionId)
  }

  private readTombstones(): ContinuityTombstoneLedger | null {
    return this.readTombstonesWithDigest()?.ledger ?? null
  }

  private readTombstonesWithDigest(): { ledger: ContinuityTombstoneLedger; digest: string } | null {
    if (!existsSync(this.tombstoneFile)) {
      return { ledger: { schemaVersion: 1, sessions: [] }, digest: 'missing' }
    }
    try {
      const bytes = readFileSync(this.tombstoneFile)
      if (bytes.byteLength > (this.options.maxIndexBytes ?? 64 * 1024 * 1024)) throw new Error('ledger exceeds size limit')
      const content = bytes.toString('utf8')
      return {
        ledger: ContinuityTombstoneLedgerSchema.parse(JSON.parse(content) as unknown),
        digest: createHash('sha256').update(bytes).digest('hex'),
      }
    } catch {
      this.warnTombstones(`tombstone ledger ${this.tombstoneFile} is corrupt or unreadable`)
      return null
    }
  }

  private writeTombstones(ledger: ContinuityTombstoneLedger): void {
    const content = JSON.stringify(ledger, null, 2) + '\n'
    if (Buffer.byteLength(content, 'utf8') > (this.options.maxIndexBytes ?? 64 * 1024 * 1024)) {
      throw new Error('Continuity tombstone ledger exceeds the configured size limit')
    }
    atomicWriteFileSync(this.tombstoneFile, content, (replacement) => {
      const verified = ContinuityTombstoneLedgerSchema.parse(JSON.parse(replacement) as unknown)
      if (JSON.stringify(verified) !== JSON.stringify(ledger)) {
        throw new Error(`Continuity tombstone ledger ${this.tombstoneFile} did not match its verified replacement`)
      }
    })
    const verifiedBytes = readFileSync(this.tombstoneFile)
    const verified = ContinuityTombstoneLedgerSchema.parse(JSON.parse(verifiedBytes.toString('utf8')) as unknown)
    if (JSON.stringify(verified) !== JSON.stringify(ledger)) {
      throw new Error(`Continuity tombstone ledger ${this.tombstoneFile} did not match its verified replacement`)
    }
    this.cachedVisibleKey = undefined
    this.cachedVisibleIndex = null
  }

  private writeIndex(index: ContinuityIndex): void {
    const content = JSON.stringify(index, null, 2) + '\n'
    if (Buffer.byteLength(content, 'utf8') > (this.options.maxIndexBytes ?? 64 * 1024 * 1024)) {
      throw new Error('Continuity rebuild exceeds the configured index size limit')
    }
    atomicWriteFileSync(this.indexFile, content, (replacement) => {
      const verified = parseContinuityIndex(JSON.parse(replacement) as unknown)
      if (JSON.stringify(verified) !== JSON.stringify(index)) {
        throw new Error(`Continuity index ${this.indexFile} did not match its verified replacement`)
      }
    })
    const verifiedContentBytes = readFileSync(this.indexFile)
    const verifiedContent = verifiedContentBytes.toString('utf8')
    const verified = parseContinuityIndex(JSON.parse(verifiedContent) as unknown)
    if (JSON.stringify(verified) !== JSON.stringify(index)) {
      throw new Error(`Continuity index ${this.indexFile} did not match its verified replacement`)
    }
    this.cachedIndexDigest = createHash('sha256').update(verifiedContentBytes).digest('hex')
    this.cachedIndex = verified
  }

  private warn(reason: string): void {
    if (this.warned.has(reason)) return
    this.warned.add(reason)
    this.options.onWarn?.(
      `Continuity local JSON index ${this.indexFile} ${reason}; no unvalidated memory was loaded. Run \`athena memory rebuild\` to recover it.`,
    )
  }

  private warnTombstones(reason: string): void {
    if (this.warned.has(reason)) return
    this.warned.add(reason)
    this.options.onWarn?.(
      `Continuity ${reason}; recall fails closed. Restore a valid backup or repair the versioned ledger, then run \`athena memory rebuild\`.`,
    )
  }
}
