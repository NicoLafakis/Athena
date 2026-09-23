import { MemoryHygieneStore, type ManagedSemanticMemory } from '../brain/hygiene.js'
import type { SourceRef, SpeechAct } from './schemas.js'
import type { ContinuityStatus, ContinuityStore } from './store.js'
import { loadEpisodeSourceContexts, type ContextMessage, type EpisodeSourceContext } from './retrieval.js'

export interface SemanticCandidateGenerationResult {
  state: ContinuityStatus['state']
  createdCount: number
  updatedCount: number
  unchangedCount: number
}

interface CandidateOccurrence {
  content: string
  normalized: string
  speechAct: Extract<SpeechAct, 'preferred' | 'decided' | 'promised'>
  episodeId: string
  sourceRef: SourceRef
  projectId: string
  sessionId: string
}

const DIRECT_CLAIM_PATTERNS: Array<[
  CandidateOccurrence['speechAct'],
  RegExp,
]> = [
  ['preferred', /^(?:i prefer|i['’]d prefer|i would prefer|i like|i dislike)\b/i],
  ['decided', /^(?:i decided|we decided|my decision is|i['’]ve decided)\b/i],
  ['promised', /^(?:i promise|i promised|i commit to|i will make sure)\b/i],
]

const SENSITIVE_CUES = /\b(?:health|medical|diagnos\w*|disabilit\w*|medication|symptom\w*|therapy|mental health|politic\w*|religio\w*|sexual\w*|orientation|race|ethnic\w*|salary|income|debt|bank\w*|account\w*|password|api key|address|phone|ssn|social security)\b/i
const TENTATIVE_CUES = /\b(?:maybe|might|what if|could consider|considering|thinking about)\b/i

function messageText(message: ContextMessage): string | null {
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content) || message.content.length === 0) return null
  const blocks: string[] = []
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'text') return null
    const text = (block as { text?: unknown }).text
    if (typeof text !== 'string') return null
    blocks.push(text)
  }
  const text = blocks.join(' ').trim()
  return text || null
}

function normalizeClaim(content: string): string {
  return content.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? ''
}

function directClaim(content: string, episodeSpeechActs: SpeechAct[]): CandidateOccurrence['speechAct'] | null {
  if (
    content.length > 2_000 ||
    content.includes('?') ||
    TENTATIVE_CUES.test(content) ||
    episodeSpeechActs.length !== 1
  ) return null
  const match = DIRECT_CLAIM_PATTERNS.find(([speechAct, pattern]) =>
    speechAct === episodeSpeechActs[0] && pattern.test(content),
  )
  return match?.[0] ?? null
}

function occurrenceOrder(left: CandidateOccurrence, right: CandidateOccurrence): number {
  return left.sourceRef.timestamp.localeCompare(right.sourceRef.timestamp) ||
    left.projectId.localeCompare(right.projectId) ||
    left.sessionId.localeCompare(right.sessionId) ||
    left.episodeId.localeCompare(right.episodeId)
}

function boundedIndependentSupport(occurrences: CandidateOccurrence[]): CandidateOccurrence[] {
  const newestFirst = [...occurrences].sort((left, right) => occurrenceOrder(right, left))
  const latestByProject = new Map<string, CandidateOccurrence>()
  for (const occurrence of newestFirst) {
    if (!latestByProject.has(occurrence.projectId)) latestByProject.set(occurrence.projectId, occurrence)
  }
  const selected = [...latestByProject.values()].sort((left, right) => occurrenceOrder(right, left)).slice(0, 32)
  const selectedSessions = new Set(selected.map((item) => `${item.projectId}\0${item.sessionId}`))
  for (const occurrence of newestFirst) {
    if (selected.length >= 32) break
    const key = `${occurrence.projectId}\0${occurrence.sessionId}`
    if (selectedSessions.has(key)) continue
    selected.push(occurrence)
    selectedSessions.add(key)
  }
  return selected.sort(occurrenceOrder)
}

/**
 * Create only reviewable candidates from exact repeated, direct user claims. Every
 * supporting episode is source-digest-verified first; incomplete catalogs cannot infer.
 */
export function generateSemanticCandidates(
  continuityStore: ContinuityStore,
  sessionsRoot: string,
  semanticStore: MemoryHygieneStore,
): SemanticCandidateGenerationResult {
  const state = continuityStore.status().state
  const result: SemanticCandidateGenerationResult = {
    state,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
  }
  if (state !== 'ready') return result

  const episodes = continuityStore.listEpisodes().filter(
    (episode) =>
      episode.completion === 'completed' &&
      episode.projectId !== null &&
      episode.speechActs.length === 1 &&
      ['preferred', 'decided', 'promised'].includes(episode.speechActs[0]!),
  )
  const contexts = loadEpisodeSourceContexts(sessionsRoot, episodes)
  const groups = new Map<string, Map<string, CandidateOccurrence>>()

  for (const context of contexts) {
    if (context.status !== 'ok' || context.truncated) continue
    for (const message of context.messages) {
      if (message.role !== 'user') continue
      const content = messageText(message)
      if (!content) continue
      const speechAct = directClaim(content, context.episode.speechActs)
      if (!speechAct) continue
      const sourceRef = context.episode.sourceRefs.find(
        (source) => source.kind === 'session-message' && source.recordId === message.sourceLineId,
      )
      if (!sourceRef?.projectId || sourceRef.projectId !== context.episode.projectId || !sourceRef.sessionId) continue
      const normalized = normalizeClaim(content)
      if (!normalized) continue
      const occurrence: CandidateOccurrence = {
        content,
        normalized,
        speechAct,
        episodeId: context.episode.id,
        sourceRef,
        projectId: sourceRef.projectId,
        sessionId: sourceRef.sessionId,
      }
      const groupKey = `${speechAct}\0${normalized}`
      const group = groups.get(groupKey) ?? new Map<string, CandidateOccurrence>()
      const sessionKey = `${occurrence.projectId}\0${occurrence.sessionId}`
      const previous = group.get(sessionKey)
      if (!previous || occurrenceOrder(previous, occurrence) < 0) group.set(sessionKey, occurrence)
      groups.set(groupKey, group)
    }
  }

  for (const occurrencesBySession of groups.values()) {
    if (occurrencesBySession.size < 2) continue
    const support = boundedIndependentSupport([...occurrencesBySession.values()])
    if (support.length < 2) continue
    const projectIds = [...new Set(support.map((item) => item.projectId))]
    const scope = projectIds.length > 1 ? 'global' : 'project'
    const sensitive = support.some((item) => SENSITIVE_CUES.test(item.content))
    const latest = support.at(-1)!
    const upsert = semanticStore.upsertInferredCandidate({
      description: latest.content.slice(0, 256),
      content: latest.content,
      sourceRefs: support.map((item) => item.sourceRef),
      supportingEpisodeIds: support.map((item) => item.episodeId),
      observedAt: latest.sourceRef.timestamp,
      scope,
      ...(scope === 'project' ? { projectId: projectIds[0]! } : {}),
      speechAct: latest.speechAct,
      captureMode: 'inferred',
      confidence: 0.5,
      sensitivity: sensitive ? 'sensitive' : 'ordinary',
    })
    if (upsert.outcome === 'created') result.createdCount++
    else if (upsert.outcome === 'updated') result.updatedCount++
    else result.unchangedCount++
  }
  return result
}

/** Revalidate every inferred source at the moment the user explicitly promotes it. */
export function reviewSemanticCandidate(
  semanticStore: MemoryHygieneStore,
  continuityStore: ContinuityStore,
  sessionsRoot: string,
  memoryId: string,
  decision: 'promote' | 'reject',
): ManagedSemanticMemory {
  const memory = semanticStore.get(memoryId)
  if (!memory) throw new Error(`No valid semantic memory ${memoryId}`)
  if (decision === 'reject') return semanticStore.reject(memoryId)
  if (memory.status !== 'candidate') return semanticStore.promote(memoryId)
  if (memory.sensitivity === 'sensitive') return semanticStore.promote(memoryId)

  const status = continuityStore.status()
  if (status.state !== 'ready') {
    throw new Error('Cannot promote an inferred memory without a complete continuity index. Run `athena memory rebuild`.')
  }

  const supportingIds = [...new Set(memory.supportingEpisodeIds)]
  if (memory.captureMode !== 'inferred' || supportingIds.length < 2) {
    throw new Error('Inferred memory source verification failed: independent episode support is missing.')
  }
  const episodes = continuityStore.listEpisodes().filter((episode) => supportingIds.includes(episode.id))
  if (episodes.length !== supportingIds.length) {
    throw new Error('Inferred memory source verification failed: one or more supporting episodes are missing.')
  }
  const contexts = loadEpisodeSourceContexts(sessionsRoot, episodes)
  const contextByEpisodeId = new Map<string, EpisodeSourceContext>()
  for (const context of contexts) {
    if (context.status !== 'ok' || context.truncated) {
      throw new Error('Inferred memory source verification failed: a supporting session is stale, unavailable, or too large.')
    }
    contextByEpisodeId.set(context.episode.id, context)
  }

  const sourceRefs = memory.sourceRefs
  if (sourceRefs.length < 2 || sourceRefs.some((source) => source.kind !== 'session-message')) {
    throw new Error('Inferred memory source verification failed: expected direct user-message sources.')
  }
  const verifiedEpisodes = new Set<string>()
  const verifiedSessions = new Set<string>()
  for (const source of sourceRefs) {
    const owner = episodes.find((episode) =>
      episode.sourceRefs.some((episodeSource) =>
        episodeSource.kind === source.kind &&
        episodeSource.projectId === source.projectId &&
        episodeSource.sessionId === source.sessionId &&
        episodeSource.recordId === source.recordId &&
        episodeSource.timestamp === source.timestamp,
      ),
    )
    const context = owner ? contextByEpisodeId.get(owner.id) : undefined
    const message = context?.messages.find((item) => item.sourceLineId === source.recordId)
    const content = message ? messageText(message) : null
    if (
      !owner || !context || !message || message.role !== 'user' || message.timestamp !== source.timestamp ||
      !content || normalizeClaim(content) !== normalizeClaim(memory.content) ||
      directClaim(content, owner.speechActs) !== memory.speechAct
    ) {
      throw new Error('Inferred memory source verification failed: a supporting user claim no longer matches.')
    }
    verifiedEpisodes.add(owner.id)
    verifiedSessions.add(`${source.projectId}\0${source.sessionId}`)
  }
  if (verifiedEpisodes.size !== supportingIds.length || verifiedSessions.size < 2) {
    throw new Error('Inferred memory source verification failed: at least two distinct source sessions are required.')
  }
  return semanticStore.promote(memoryId)
}
