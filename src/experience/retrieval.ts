import type { ExperienceRecord, GuidanceMatch, GuidanceQuery, GuidanceRecord } from './types.js'

const DEFAULT_LIMIT = 3
const DEFAULT_CHAR_BUDGET = 2_048
const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_MAX_AGE_MS = 180 * 24 * 60 * 60_000

function terms(value: string): Set<string> {
  return new Set(
    value.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [],
  )
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const value of left) if (right.has(value)) count++
  return count
}

export function retrieveGuidance(
  experiences: readonly ExperienceRecord[],
  guidanceRecords: readonly GuidanceRecord[],
  query: GuidanceQuery,
): GuidanceMatch[] {
  const now = (query.now ?? new Date()).getTime()
  const maxAgeMs = Math.max(0, query.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
  const minConfidence = Math.max(0, Math.min(1, query.minConfidence ?? DEFAULT_MIN_CONFIDENCE))
  const objectiveTerms = terms(query.objective)
  const queryTags = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()))
  const experienceById = new Map(experiences.map((record) => [record.id, record]))
  const candidates: GuidanceMatch[] = []

  for (const guidance of guidanceRecords) {
    if (guidance.status !== 'active' || guidance.confidence < minConfidence || !guidance.reviewedAt) continue
    const reviewedAt = Date.parse(guidance.reviewedAt)
    if (!Number.isFinite(reviewedAt) || now - reviewedAt > maxAgeMs) continue
    const scoped = guidance.experienceIds
      .map((id) => experienceById.get(id))
      .filter((record): record is ExperienceRecord => record?.projectScope === query.projectScope)
    if (scoped.length === 0) continue
    const tagScore = scoped.reduce(
      (score, record) => score + record.tags.filter((tag) => queryTags.has(tag.toLowerCase())).length,
      0,
    )
    const textScore = scoped.reduce(
      (score, record) => score + overlap(objectiveTerms, terms(record.situation)),
      0,
    )
    const relevance = tagScore * 10 + textScore
    if (relevance <= 0) continue
    candidates.push({
      guidance,
      experienceIds: scoped.map((record) => record.id).sort(),
      score: relevance + guidance.confidence,
    })
  }

  candidates.sort((left, right) =>
    right.score - left.score
      || right.guidance.confidence - left.guidance.confidence
      || left.guidance.id.localeCompare(right.guidance.id),
  )
  const limit = Math.max(0, Math.min(20, query.limit ?? DEFAULT_LIMIT))
  const charBudget = Math.max(0, Math.min(16_384, query.charBudget ?? DEFAULT_CHAR_BUDGET))
  const selected: GuidanceMatch[] = []
  let chars = 0
  for (const candidate of candidates) {
    if (selected.length >= limit) break
    if (chars + candidate.guidance.text.length > charBudget) continue
    selected.push(candidate)
    chars += candidate.guidance.text.length
  }
  return selected
}
