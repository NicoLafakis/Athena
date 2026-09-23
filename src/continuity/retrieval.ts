import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { parseContinuityEpisode, type ContinuityEpisode, type TemporalWindow } from './schemas.js'
import { canonicalSessionRecords, listAllProjectSessions, readSessionLineRecords } from './session-catalog.js'
import { stableSessionLineId } from '../harness/sessions.js'
import type { SessionLineRecord } from '../harness/sessions.js'

export interface EpisodeSearchOptions {
  text?: string
  window?: TemporalWindow
  projectId?: string
  limit?: number
}

export interface EpisodeSearchHit {
  episode: ContinuityEpisode
  score: number
}

export interface EpisodeSourceContext {
  status: 'ok'
  episode: ContinuityEpisode
  messages: ContextMessage[]
  adjacentMessages: Array<ContextMessage & { relation: 'preceding-turn' | 'following-turn' }>
  sourceRefs: ContinuityEpisode['sourceRefs']
  truncated: boolean
}

export interface ContextMessage {
  sourceLineId: string
  timestamp: string
  role: 'user' | 'assistant'
  content: unknown
}

export type EpisodeSourceContextResult =
  | EpisodeSourceContext
  | { status: 'stale' | 'missing'; reason: string; episodeId: string }

const SEARCH_STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'at', 'be', 'been', 'but', 'by', 'did', 'do', 'does', 'for',
  'from', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our',
  'the', 'then', 'this', 'that', 'to', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why',
  'with', 'you', 'your', 'yesterday', 'today', 'earlier', 'last', 'week', 'month', 'quarter', 'year',
  'current', 'this', 'talk', 'talked', 'discuss', 'discussed', 'remember', 'recall', 'happen', 'happened',
  'say', 'said', 'agree', 'agreed', 'tell', 'told',
])

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function terms(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter((term) => !SEARCH_STOP_WORDS.has(term) && !/^\d+$/.test(term))
}

function matchesTerm(query: string, source: string): boolean {
  return query === source || source.startsWith(query) || query.startsWith(source)
}

function scoreEpisode(episode: ContinuityEpisode, queryTerms: string[], query: string): number {
  const topicTerms = episode.topics.flatMap(terms)
  const summaryTerms = terms(episode.summary)
  let score = 0
  for (const term of queryTerms) {
    if (topicTerms.some((candidate) => matchesTerm(term, candidate))) score += 5
    else if (summaryTerms.some((candidate) => matchesTerm(term, candidate))) score += 2
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (normalizedQuery.length > 3 && episode.summary.toLocaleLowerCase().includes(normalizedQuery)) score += 4
  if (episode.completion !== 'completed') score -= 0.25
  return score
}

/** Deterministic bounded lexical/timeline ranking; no model call and no archive disclosure. */
export function searchEpisodes(
  episodes: ContinuityEpisode[],
  options: EpisodeSearchOptions = {},
): EpisodeSearchHit[] {
  const query = options.text?.trim() ?? ''
  const queryTerms = [...new Set(terms(query))]
  const start = options.window ? Date.parse(options.window.start) : Number.NEGATIVE_INFINITY
  const end = options.window ? Date.parse(options.window.end) : Number.POSITIVE_INFINITY
  const candidates = episodes
    .map((input) => {
      const episode = parseContinuityEpisode(input)
      return { episode, score: scoreEpisode(episode, queryTerms, query) }
    })
    .filter(({ episode, score }) => {
      const time = Date.parse(episode.observedAt)
      return (
        (options.projectId === undefined || episode.projectId === options.projectId) &&
        time >= start && time < end &&
        (queryTerms.length === 0 || score > 0)
      )
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.episode.observedAt.localeCompare(left.episode.observedAt) ||
        left.episode.projectId!.localeCompare(right.episode.projectId!) ||
        left.episode.id.localeCompare(right.episode.id),
    )
  const limit = Math.max(1, Math.min(options.limit ?? 5, 8))
  return candidates.slice(0, limit)
}

function messageRole(record: SessionLineRecord): 'user' | 'assistant' | null {
  if (record.line.kind !== 'message' || typeof record.line.data !== 'object' || record.line.data === null) return null
  const role = (record.line.data as { role?: unknown }).role
  return role === 'user' || role === 'assistant' ? role : null
}

function isUserTurnStart(record: SessionLineRecord): boolean {
  if (messageRole(record) !== 'user' || typeof record.line.data !== 'object' || record.line.data === null) return false
  const content = (record.line.data as { content?: unknown }).content
  return !(
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result')
  )
}

function contextMessage(record: SessionLineRecord): ContextMessage | null {
  const role = messageRole(record)
  if (!role || typeof record.line.data !== 'object' || record.line.data === null) return null
  const timestamp = new Date(record.line.ts)
  if (Number.isNaN(timestamp.getTime())) return null
  return {
    sourceLineId: stableSessionLineId(record),
    timestamp: timestamp.toISOString(),
    role,
    content: (record.line.data as { content?: unknown }).content,
  }
}

function boundedTurnMessages(records: SessionLineRecord[]): ContextMessage[] {
  const messages = records.flatMap((record) => {
    const message = contextMessage(record)
    return message ? [message] : []
  })
  return messages.length > 2 ? [messages[0]!, messages[messages.length - 1]!] : messages
}

function adjacentTurnMessages(
  records: SessionLineRecord[],
  episodeRefs: ContinuityEpisode['sourceRefs'],
): Array<ContextMessage & { relation: 'preceding-turn' | 'following-turn' }> {
  const canonical = canonicalSessionRecords(records).filter(
    (record) => !Number.isNaN(new Date(record.line.ts).getTime()),
  )
  const byId = canonical.map((record) => ({ record, id: stableSessionLineId(record) }))
  const episodeIds = new Set(episodeRefs.map((ref) => ref.recordId))
  const positions = byId.flatMap((item, index) => (episodeIds.has(item.id) ? [index] : []))
  if (positions.length === 0) return []
  const first = Math.min(...positions)
  const last = Math.max(...positions)

  let previousStart = -1
  for (let index = first - 1; index >= 0; index--) {
    if (isUserTurnStart(byId[index]!.record)) {
      previousStart = index
      break
    }
  }

  let nextStart = -1
  for (let index = last + 1; index < byId.length; index++) {
    if (isUserTurnStart(byId[index]!.record)) {
      nextStart = index
      break
    }
  }

  const priorRecords = previousStart < 0 ? [] : byId.slice(previousStart, first).map((item) => item.record)
  let nextEnd = nextStart
  if (nextStart >= 0) {
    while (nextEnd + 1 < byId.length && !isUserTurnStart(byId[nextEnd + 1]!.record)) nextEnd++
  }
  const followingRecords = nextStart < 0 ? [] : byId.slice(nextStart, nextEnd + 1).map((item) => item.record)

  return [
    ...boundedTurnMessages(priorRecords).map((message) => ({ ...message, relation: 'preceding-turn' as const })),
    ...boundedTurnMessages(followingRecords).map((message) => ({ ...message, relation: 'following-turn' as const })),
  ]
}

function fitAdjacentMessages(
  messages: Array<ContextMessage & { relation: 'preceding-turn' | 'following-turn' }>,
  limit: number,
): { messages: Array<ContextMessage & { relation: 'preceding-turn' | 'following-turn' }>; truncated: boolean } {
  if (messages.length <= limit) return { messages, truncated: false }
  const preceding = messages.filter((message) => message.relation === 'preceding-turn')
  const following = messages.filter((message) => message.relation === 'following-turn')
  const selectedPreceding: typeof preceding = []
  const selectedFollowing: typeof following = []
  let precedingIndex = 0
  let followingIndex = 0
  let preferPreceding = true
  while (selectedPreceding.length + selectedFollowing.length < limit) {
    if (preferPreceding && precedingIndex < preceding.length) {
      selectedPreceding.push(preceding[precedingIndex++]!)
    } else if (followingIndex < following.length) {
      selectedFollowing.push(following[followingIndex++]!)
    } else if (precedingIndex < preceding.length) {
      selectedPreceding.push(preceding[precedingIndex++]!)
    } else {
      break
    }
    preferPreceding = !preferPreceding
  }
  return { messages: [...selectedPreceding, ...selectedFollowing], truncated: true }
}

/** Resolve and digest-check an episode before returning source text for local inspection. */
export function loadEpisodeSourceContext(
  sessionsRoot: string,
  input: ContinuityEpisode,
  maxMessages = 8,
  includeAdjacentTurns = false,
): EpisodeSourceContextResult {
  const episode = parseContinuityEpisode(input)
  const source = listAllProjectSessions(sessionsRoot).find(
    (item) => item.projectId === episode.projectId && item.sessionId === episode.sessionId,
  )
  if (!source) return { status: 'missing', reason: 'The linked source session is unavailable.', episodeId: episode.id }

  let records: SessionLineRecord[]
  try {
    // Recheck after enumeration so a replaced path cannot redirect source loading.
    const metadata = lstatSync(source.file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { status: 'missing', reason: 'The linked source session is not a regular local file.', episodeId: episode.id }
    }
    records = readSessionLineRecords(source.file)
  } catch {
    return { status: 'missing', reason: 'The linked source session could not be read.', episodeId: episode.id }
  }
  return verifyEpisodeSourceContext(episode, records, maxMessages, includeAdjacentTurns)
}

/** Verify a set of episodes while enumerating and reading each source session only once. */
export function loadEpisodeSourceContexts(
  sessionsRoot: string,
  inputs: ContinuityEpisode[],
  maxMessages = 8,
): EpisodeSourceContextResult[] {
  const episodes = inputs.map(parseContinuityEpisode)
  const sources = new Map(
    listAllProjectSessions(sessionsRoot).map((source) => [`${source.projectId}\0${source.sessionId}`, source]),
  )
  const results: Array<EpisodeSourceContextResult | undefined> = Array(episodes.length)
  const episodeIndexes = new Map<string, number[]>()
  for (let index = 0; index < episodes.length; index++) {
    const episode = episodes[index]!
    const key = `${episode.projectId}\0${episode.sessionId}`
    episodeIndexes.set(key, [...(episodeIndexes.get(key) ?? []), index])
  }

  for (const [key, indexes] of episodeIndexes) {
    const source = sources.get(key)
    const group = indexes.map((index) => ({ index, episode: episodes[index]! }))
    if (!source) {
      for (const { index, episode } of group) {
        results[index] = { status: 'missing', reason: 'The linked source session is unavailable.', episodeId: episode.id }
      }
      continue
    }

    let records: SessionLineRecord[]
    try {
      const metadata = lstatSync(source.file)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('not a regular file')
      records = readSessionLineRecords(source.file)
    } catch {
      for (const { index, episode } of group) {
        results[index] = { status: 'missing', reason: 'The linked source session could not be read.', episodeId: episode.id }
      }
      continue
    }
    for (const { index, episode } of group) {
      results[index] = verifyEpisodeSourceContext(episode, records, maxMessages, false)
    }
  }
  return results.map((result, index) => result ?? {
    status: 'missing',
    reason: 'The linked source session is unavailable.',
    episodeId: episodes[index]!.id,
  })
}

function verifyEpisodeSourceContext(
  episode: ContinuityEpisode,
  records: SessionLineRecord[],
  maxMessages: number,
  includeAdjacentTurns: boolean,
): EpisodeSourceContextResult {
  const byId = new Map(records.map((record) => [stableSessionLineId(record), record]))
  const sourceRecords: SessionLineRecord[] = []
  for (const ref of episode.sourceRefs) {
    if (ref.projectId !== episode.projectId || ref.sessionId !== episode.sessionId) {
      return { status: 'stale', reason: 'The episode contains a cross-session source reference.', episodeId: episode.id }
    }
    const record = byId.get(ref.recordId)
    const expectedKind = ref.kind === 'session-message' ? 'message' : ref.kind === 'session-event' ? 'event' : null
    if (!record || !expectedKind || record.line.kind !== expectedKind) {
      return { status: 'stale', reason: 'One or more linked source lines changed or disappeared.', episodeId: episode.id }
    }
    sourceRecords.push(record)
  }
  if (sha256(sourceRecords.map((record) => record.rawLine).join('\n')) !== episode.sourceDigest) {
    return { status: 'stale', reason: 'The linked source content changed after indexing.', episodeId: episode.id }
  }

  const messages = sourceRecords.flatMap((record) => {
    const message = contextMessage(record)
    return message ? [message] : []
  })
  const cap = Math.max(1, Math.min(maxMessages, 8))
  const episodeTruncated = messages.length > cap
  const selected = episodeTruncated && cap > 1
    ? [...messages.slice(0, 1), ...messages.slice(-(cap - 1))]
    : messages.slice(0, cap)
  const adjacentCandidates = includeAdjacentTurns ? adjacentTurnMessages(records, episode.sourceRefs) : []
  const fitAdjacent = fitAdjacentMessages(adjacentCandidates, cap - selected.length)
  const adjacentMessages = fitAdjacent.messages
  const truncated = episodeTruncated || fitAdjacent.truncated
  return { status: 'ok', episode, messages: selected, adjacentMessages, sourceRefs: episode.sourceRefs, truncated }
}
