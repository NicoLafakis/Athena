import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import {
  SemanticMemoryRecordSchema,
  TemporalWindowSchema,
  TimeRollupSchema,
  parseContinuityEpisode,
  type ContinuityEpisode,
  type SemanticMemoryRecord,
  type SpeechAct,
  type TemporalWindow,
  type TimeRollup,
} from './schemas.js'

export type RecallIntent = 'continuation' | 'temporal' | 'summary' | 'decision' | 'preference' | 'fact' | 'topic'
export type RecallLayer = 'working' | 'episodic' | 'semantic' | 'rollup'

export interface WorkingRecallState {
  id: string
  projectId: string | null
  observedAt: string
  content: string
  sourceIds: string[]
  topics?: string[]
}

export type SemanticRecallMemory = SemanticMemoryRecord & { content: string; file?: string }

export interface RankedRecallCandidate {
  id: string
  layer: RecallLayer
  projectId: string | null
  observedAt: string
  score: number
  sourceIds: string[]
  sourceCount: number
  speechActs: SpeechAct[]
  status?: SemanticMemoryRecord['status']
  confidence?: number
  reasons: string[]
}

const WorkingRecallStateSchema = z.object({
  id: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256).nullable(),
  observedAt: z.string().datetime({ offset: true }),
  content: z.string().min(1).max(32_000),
  sourceIds: z.array(z.string().min(1).max(512)).max(256),
  topics: z.array(z.string().min(1).max(64)).max(64).optional(),
}).strict()

export interface RecallRankingMetrics {
  inputCounts: Record<RecallLayer, number>
  selectedCount: number
  elapsedMs: number
  sourceIds: string[]
}

export interface RecallRankingResult {
  intent: RecallIntent
  candidates: RankedRecallCandidate[]
  metrics: RecallRankingMetrics
}

export interface RankContinuityLayersOptions {
  query: string
  working?: WorkingRecallState[]
  episodes?: ContinuityEpisode[]
  semanticMemories?: SemanticRecallMemory[]
  rollups?: TimeRollup[]
  currentProjectId?: string
  projectId?: string
  window?: TemporalWindow
  now?: Date
  limit?: number
  includeSensitive?: boolean
  onMetrics?: (metrics: RecallRankingMetrics) => void
}

const STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or',
  'our', 'the', 'then', 'this', 'that', 'these', 'those', 'to', 'was', 'we', 'what', 'when',
  'where', 'which', 'who', 'why', 'with', 'you', 'your', 'yesterday', 'today', 'earlier', 'last',
  'week', 'month', 'quarter', 'year', 'current', 'talk', 'talked', 'discuss', 'discussed',
  'remember', 'recall', 'happen', 'happened', 'say', 'said', 'agree', 'agreed', 'tell', 'told',
  'give', 'me', 'please', 'about',
])

const LAYER_ORDER: Record<RecallLayer, number> = {
  working: 0,
  semantic: 1,
  episodic: 2,
  rollup: 3,
}

const MAX_SOURCE_IDS_PER_CANDIDATE = 12
const MAX_METRIC_SOURCE_IDS = 64

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter((term) => !STOP_WORDS.has(term) && !/^\d+$/.test(term))
}

function matchesTerm(query: string, source: string): boolean {
  return query === source || source.startsWith(query) || query.startsWith(source)
}

function intentHas(queryTerms: string[], candidates: string[]): boolean {
  return queryTerms.some((term) => candidates.some((candidate) => matchesTerm(candidate, term)))
}

function inferIntent(query: string, window?: TemporalWindow): RecallIntent {
  const normalized = query.toLowerCase()
  const queryTerms = terms(query)
  if (intentHas(queryTerms, ['recap', 'summarize', 'summarise', 'overview']) ||
    normalized.includes('what changed this') || normalized.includes('what happened this')) return 'summary'
  if (intentHas(queryTerms, ['prefer', 'preference', 'usually', 'tend', 'like'])) return 'preference'
  if (intentHas(queryTerms, ['decide', 'decision', 'agree', 'chose', 'choice', 'commit'])) return 'decision'
  if (intentHas(queryTerms, ['continue', 'pick', 'same', 'left'])) return 'continuation'
  if (intentHas(queryTerms, ['true', 'fact'])) return 'fact'
  if (window) return 'temporal'
  return 'topic'
}
function lexicalScore(query: string, queryTerms: string[], fields: string[]): number {
  if (queryTerms.length === 0) return 0
  const normalizedQuery = query.trim().toLowerCase()
  const normalizedFields = fields.map((field) => field.toLowerCase())
  let score = normalizedFields.some((field) => normalizedQuery.length > 3 && field.includes(normalizedQuery)) ? 4 : 0
  const fieldTerms = normalizedFields.map((field) => terms(field))
  for (const term of queryTerms) {
    if (fieldTerms.some((tokens) => tokens.some((token) => matchesTerm(term, token)))) score += 2
  }
  return score
}

function isInWindow(timestamp: string, window?: TemporalWindow): boolean {
  if (!window) return true
  const value = Date.parse(timestamp)
  return value >= Date.parse(window.start) && value < Date.parse(window.end)
}

function semanticOverlapsWindow(memory: SemanticMemoryRecord, window: TemporalWindow): boolean {
  const start = Date.parse(memory.validFrom ?? memory.observedAt)
  const end = memory.validUntil ? Date.parse(memory.validUntil) : Number.POSITIVE_INFINITY
  return start < Date.parse(window.end) && end > Date.parse(window.start)
}

function localDateKey(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00'
  return value('year') + '-' + value('month') + '-' + value('day')
}

function sourceDigest(episodes: ContinuityEpisode[]): string {
  return createHash('sha256').update(JSON.stringify(episodes), 'utf8').digest('hex')
}

function rollupOverlapsWindow(rollup: TimeRollup, window?: TemporalWindow): boolean {
  if (!window) return true
  const startDate = localDateKey(window.start, rollup.timeZone)
  const endExclusive = Date.parse(window.end)
  if (!Number.isFinite(endExclusive) || endExclusive <= Date.parse(window.start)) return false
  const lastInstant = new Date(endExclusive - 1).toISOString()
  const lastDate = localDateKey(lastInstant, rollup.timeZone)
  return rollup.periodStart <= lastDate && rollup.periodEnd > startDate
}

function isAllowedProject(projectId: string | null | undefined, requestedProject?: string): boolean {
  return requestedProject === undefined || projectId === null || projectId === undefined || projectId === requestedProject
}

function layerBoost(layer: RecallLayer, intent: RecallIntent): number {
  if (layer === 'working') return intent === 'continuation' ? 8 : 0
  if (layer === 'semantic') {
    if (intent === 'preference') return 6
    if (intent === 'decision' || intent === 'fact') return 5
    return 0
  }
  if (layer === 'rollup') {
    if (intent === 'summary') return 8
    if (intent === 'temporal') return 4
    return intent === 'decision' || intent === 'preference' || intent === 'fact' ? -2 : 0
  }
  return intent === 'summary' ? 1 : 3
}

function speechActBoost(speechActs: SpeechAct[], intent: RecallIntent): number {
  if (intent === 'preference' && speechActs.includes('preferred')) return 2
  if (intent === 'decision' && speechActs.includes('decided')) return 2
  if (speechActs.includes('corrected')) return 3
  return 0
}

function recencyBoost(observedAt: string, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(observedAt)) / 86_400_000)
  return 0.25 / (1 + ageDays / 30)
}

function cappedSourceIds(ids: string[]): string[] {
  return [...new Set(ids)].slice(0, MAX_SOURCE_IDS_PER_CANDIDATE)
}

function makeCandidate(
  input: Omit<RankedRecallCandidate, 'score' | 'sourceIds' | 'sourceCount' | 'reasons'> & { rawSourceIds: string[] },
  score: number,
  reasons: string[],
): RankedRecallCandidate {
  const { rawSourceIds, ...candidate } = input
  return {
    ...candidate,
    score: Math.round(score * 1_000) / 1_000,
    reasons,
    sourceIds: cappedSourceIds(rawSourceIds),
    sourceCount: new Set(rawSourceIds).size,
  }
}

function candidateScore(
  layer: RecallLayer,
  query: string,
  queryTerms: string[],
  fields: string[],
  observedAt: string,
  projectId: string | null,
  sourceAuthority: number,
  speechActs: SpeechAct[],
  intent: RecallIntent,
  window?: TemporalWindow,
  currentProjectId?: string,
  now = Date.now(),
): { score: number; reasons: string[] } {
  const textScore = lexicalScore(query, queryTerms, fields)
  if (queryTerms.length > 0 && textScore === 0 && !window) return { score: Number.NEGATIVE_INFINITY, reasons: [] }
  const reasons: string[] = []
  if (textScore > 0) reasons.push('topic or phrase match')
  if (window) reasons.push('inside requested time range')
  if (layerBoost(layer, intent) > 0) reasons.push(intent + ' intent favors ' + layer)
  if (currentProjectId && projectId === currentProjectId) reasons.push('matches current project')
  if (sourceAuthority >= 2) reasons.push('explicit user-authored memory')
  else if (sourceAuthority > 0) reasons.push('inferred memory with independent support')
  if (intent === 'preference' && speechActs.includes('preferred')) reasons.push('preference speech act')
  if (intent === 'decision' && speechActs.includes('decided')) reasons.push('decision speech act')
  if (speechActs.includes('corrected')) reasons.push('direct correction')
  const timeFit = window ? 10 : 0
  const projectBoost = currentProjectId && projectId === currentProjectId ? 0.75 : 0
  return {
    score: textScore + layerBoost(layer, intent) + timeFit + projectBoost + sourceAuthority +
      speechActBoost(speechActs, intent) + recencyBoost(observedAt, now),
    reasons,
  }
}
function countInputs(options: RankContinuityLayersOptions): Record<RecallLayer, number> {
  return {
    working: options.working?.length ?? 0,
    episodic: options.episodes?.length ?? 0,
    semantic: options.semanticMemories?.length ?? 0,
    rollup: options.rollups?.length ?? 0,
  }
}

/**
 * Rank local continuity sources without returning their content. The caller must expand
 * selected source IDs through the existing source-verification path before using text.
 */
export function rankContinuityLayers(options: RankContinuityLayersOptions): RecallRankingResult {
  const startedAt = performance.now()
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const query = options.query.trim()
  const queryTerms = [...new Set(terms(query))]
  const window = options.window ? TemporalWindowSchema.parse(options.window) : undefined
  const intent = inferIntent(query, window)
  const limit = Math.max(1, Math.min(options.limit ?? 5, 8))
  const candidates: RankedRecallCandidate[] = []
  const episodes = (options.episodes ?? []).map(parseContinuityEpisode)
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]))

  for (const input of options.working ?? []) {
    if (!isAllowedProject(input.projectId, options.projectId) || !isInWindow(input.observedAt, window)) continue
    const working = WorkingRecallStateSchema.parse(input)
    const ranking = candidateScore(
      'working', query, queryTerms, [working.content, ...(working.topics ?? [])], working.observedAt,
      working.projectId, 0, [], intent, window, options.currentProjectId, nowMs,
    )
    if (Number.isFinite(ranking.score)) {
      candidates.push(makeCandidate({
        id: working.id,
        layer: 'working',
        projectId: working.projectId,
        observedAt: working.observedAt,
        speechActs: [],
        rawSourceIds: working.sourceIds,
      }, ranking.score, ranking.reasons))
    }
  }

  for (const episode of episodes) {
    if (!isAllowedProject(episode.projectId, options.projectId) || !isInWindow(episode.observedAt, window)) continue
    const ranking = candidateScore(
      'episodic', query, queryTerms, [episode.summary, ...episode.topics], episode.observedAt,
      episode.projectId, 0, episode.speechActs, intent, window, options.currentProjectId, nowMs,
    )
    if (Number.isFinite(ranking.score)) {
      candidates.push(makeCandidate({
        id: episode.id,
        layer: 'episodic',
        projectId: episode.projectId,
        observedAt: episode.observedAt,
        speechActs: episode.speechActs,
        rawSourceIds: episode.sourceRefs.map((source) => source.recordId),
      }, ranking.score, ranking.reasons))
    }
  }

  for (const input of options.semanticMemories ?? []) {
    const { content, file: _file, ...recordInput } = input
    const memory = SemanticMemoryRecordSchema.parse(recordInput)
    void _file
    if (memory.status !== 'active' && !(window && memory.status === 'superseded')) continue
    if (memory.sensitivity === 'sensitive' && !options.includeSensitive) continue
    if (memory.scope === 'project' && !isAllowedProject(memory.projectId, options.projectId)) continue
    if (memory.scope === 'global' && !isAllowedProject(null, options.projectId)) continue
    if (window) {
      if (!semanticOverlapsWindow(memory, window)) continue
    } else if (
      memory.status !== 'active' ||
      (memory.validFrom !== undefined && Date.parse(memory.validFrom) > nowMs) ||
      (memory.validUntil !== undefined && Date.parse(memory.validUntil) <= nowMs)
    ) {
      continue
    }
    const sourceAuthority = memory.captureMode === 'explicit' ? 2 : 1 + Math.min(1, memory.supportingEpisodeIds.length / 4)
    const ranking = candidateScore(
      'semantic', query, queryTerms, [memory.description, content], memory.observedAt,
      memory.scope === 'project' ? memory.projectId! : null, sourceAuthority, [memory.speechAct],
      intent, window, options.currentProjectId, nowMs,
    )
    if (Number.isFinite(ranking.score)) {
      candidates.push(makeCandidate({
        id: memory.memoryId,
        layer: 'semantic',
        projectId: memory.scope === 'project' ? memory.projectId! : null,
        observedAt: memory.observedAt,
        speechActs: [memory.speechAct],
        status: memory.status,
        confidence: memory.confidence,
        rawSourceIds: [
          ...memory.sourceRefs.map((source) => source.recordId),
          ...memory.supportingEpisodeIds,
        ],
      }, ranking.score, ranking.reasons))
    }
  }

  for (const input of options.rollups ?? []) {
    const rollup = TimeRollupSchema.parse(input)
    if (!rollupOverlapsWindow(rollup, window)) continue
    const coveredEpisodes = rollup.sourceEpisodeIds.map((id) => episodeById.get(id))
    if (coveredEpisodes.some((episode) => episode === undefined)) continue
    const validEpisodes = coveredEpisodes as ContinuityEpisode[]
    if (sourceDigest(validEpisodes) !== rollup.sourceDigest) continue
    if (window && validEpisodes.some((episode) => !isInWindow(episode.observedAt, window))) continue
    if (options.projectId && validEpisodes.some((episode) => episode.projectId !== options.projectId)) continue
    const projectIds = [...new Set(validEpisodes.map((episode) => episode.projectId).filter((id): id is string => id !== null))]
    const projectId = projectIds.length === 1 ? projectIds[0]! : null
    const ranking = candidateScore(
      'rollup', query, queryTerms, [rollup.summary], rollup.createdAt,
      projectId, 0, [], intent, window, options.currentProjectId, nowMs,
    )
    if (Number.isFinite(ranking.score)) {
      candidates.push(makeCandidate({
        id: rollup.id,
        layer: 'rollup',
        projectId,
        observedAt: rollup.periodStart + 'T00:00:00.000Z',
        speechActs: [],
        rawSourceIds: rollup.sourceEpisodeIds,
      }, ranking.score, ranking.reasons))
    }
  }

  const inputCounts = countInputs(options)
  const ranked = candidates.sort(
    (left, right) =>
      right.score - left.score ||
      LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer] ||
      right.observedAt.localeCompare(left.observedAt) ||
      (left.projectId ?? '').localeCompare(right.projectId ?? '') ||
      left.id.localeCompare(right.id),
  ).slice(0, limit)
  const sourceIds = [...new Set(ranked.flatMap((candidate) => candidate.sourceIds))]
    .slice(0, MAX_METRIC_SOURCE_IDS)
  const metrics: RecallRankingMetrics = {
    inputCounts,
    selectedCount: ranked.length,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    sourceIds,
  }
  options.onMetrics?.(metrics)
  return { intent, candidates: ranked, metrics }
}
