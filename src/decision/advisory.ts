import { z } from 'zod'
import { sha256Text } from '../harness/hash.js'
import { redactSessionValue } from '../harness/redaction.js'
import type { JevBudgetGuard, JevBudgetRejectReason } from './budget.js'
import type { DecisionClient, DecisionFallbackReason, DecisionUsage } from './client.js'
import { JEV_MODEL } from './jev.js'

export const WORKFLOW_HINT_LABELS = [
  'explanation',
  'investigation',
  'implementation',
  'review',
  'planning',
] as const

export type WorkflowHintLabel = (typeof WORKFLOW_HINT_LABELS)[number]

export const SHORTLIST_MAX_SKILLS = 12
const MAX_REQUEST_CHARS = 12_000
const MAX_STATE_BYTES = 24 * 1024

const WorkflowProbabilitiesSchema = z.object({
  explanation: z.number().min(0).max(1),
  investigation: z.number().min(0).max(1),
  implementation: z.number().min(0).max(1),
  review: z.number().min(0).max(1),
  planning: z.number().min(0).max(1),
}).strict()

export const WorkflowHintDecisionSchema = z.object({
  workflow: z.enum(WORKFLOW_HINT_LABELS),
  confidence: z.number().min(0).max(1),
  probabilities: WorkflowProbabilitiesSchema,
  fitsWorkflow: z.number().min(0).max(1),
}).strict().superRefine((decision, ctx) => {
  const entries = Object.entries(decision.probabilities)
  const mass = entries.reduce((sum, [, p]) => sum + p, 0)
  const chosen = entries.find(([k]) => k === decision.workflow)?.[1]
  if (Math.abs(mass - 1) > 0.001 || chosen === undefined || chosen < Math.max(...entries.map(([, v]) => v))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid workflow Choice distribution' })
  }
})

export type WorkflowHintDecision = z.infer<typeof WorkflowHintDecisionSchema>

export const SkillSuggestionDecisionSchema = z.object({
  needsSkill: z.number().min(0).max(1),
  scores: z.record(z.string(), z.number().int().min(0).max(2)),
}).strict()

export type SkillSuggestionDecision = z.infer<typeof SkillSuggestionDecisionSchema>

export interface SkillCandidateMetadata {
  id: string
  description: string
}

export type ShadowAdvisoryFallbackReason = DecisionFallbackReason | JevBudgetRejectReason

export type WorkflowHintShadowResult =
  | { status: 'decision'; value: WorkflowHintDecision; cached: boolean; usage?: DecisionUsage }
  | { status: 'fallback'; reason: ShadowAdvisoryFallbackReason }

export type SkillSuggestionShadowResult =
  | {
      status: 'decision'
      value: SkillSuggestionDecision
      suggestedSkillId: string | null
      cached: boolean
      usage?: DecisionUsage
    }
  | { status: 'fallback'; reason: ShadowAdvisoryFallbackReason }

export interface WorkflowHintShadowInput {
  enabled: boolean
  client: DecisionClient
  budget: JevBudgetGuard
  turnId: string
  request: string
  signal?: AbortSignal
}

export interface SkillSuggestionShadowInput {
  enabled: boolean
  client: DecisionClient
  budget: JevBudgetGuard
  turnId: string
  request: string
  skills: readonly SkillCandidateMetadata[]
  signal?: AbortSignal
}

function isTransientFailure(reason: DecisionFallbackReason): boolean {
  return reason === 'timeout' || reason === 'rate-limited' || reason === 'provider-error'
}

/**
 * P1 shadow-mode workflow hint evaluator.
 * Current redacted request only; advisory only; never executes tools or changes authority.
 */
export async function evaluateWorkflowHintShadow(
  input: WorkflowHintShadowInput,
): Promise<WorkflowHintShadowResult> {
  if (!input.enabled) return { status: 'fallback', reason: 'disabled' }
  const redacted = redactSessionValue(input.request)
  if (typeof redacted !== 'string' || redacted.trim().length === 0) {
    return { status: 'fallback', reason: 'invalid-input' }
  }
  if (redacted.length > MAX_REQUEST_CHARS || Buffer.byteLength(redacted, 'utf8') > MAX_STATE_BYTES) {
    return { status: 'fallback', reason: 'input-too-large' }
  }

  const cacheKey = `workflow-hint:v1:${JEV_MODEL}:${sha256Text(redacted)}`
  const cached = input.budget.getCached<WorkflowHintDecision>(cacheKey)
  if (cached) return { status: 'decision', value: cached, cached: true }

  const reservation = input.budget.tryReserve(input.turnId)
  if (!reservation.allowed) return { status: 'fallback', reason: reservation.reason }

  const startedAt = Date.now()
  const result = await input.client.evaluate(
    {
      payload: { feature: 'workflow-hint', version: 1, request: redacted },
      responseSchema: WorkflowHintDecisionSchema,
    },
    { ...(input.signal ? { signal: input.signal } : {}) },
  )
  input.budget.recordElapsed(input.turnId, Date.now() - startedAt)

  if (result.status === 'fallback') {
    if (isTransientFailure(result.reason)) input.budget.recordTransientFailure()
    return { status: 'fallback', reason: result.reason }
  }
  input.budget.recordSuccess()
  input.budget.setCached(cacheKey, result.value)
  return {
    status: 'decision',
    value: result.value,
    cached: false,
    ...(result.usage ? { usage: result.usage } : {}),
  }
}

/**
 * P1 shadow-mode skill suggestion evaluator.
 * Locally shortlists at most 12 eligible skill metadata records, scores via Jev,
 * and returns at most one deterministic stable skill ID (never hides tools or bypasses trust).
 */
export async function evaluateSkillSuggestionShadow(
  input: SkillSuggestionShadowInput,
): Promise<SkillSuggestionShadowResult> {
  if (!input.enabled) return { status: 'fallback', reason: 'disabled' }
  const redacted = redactSessionValue(input.request)
  if (typeof redacted !== 'string' || redacted.trim().length === 0) {
    return { status: 'fallback', reason: 'invalid-input' }
  }
  if (redacted.length > MAX_REQUEST_CHARS) {
    return { status: 'fallback', reason: 'input-too-large' }
  }

  const shortlist = [...input.skills]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, SHORTLIST_MAX_SKILLS)
    .map((s) => ({ id: s.id, description: s.description.slice(0, 240) }))
  if (shortlist.length === 0) {
    return { status: 'fallback', reason: 'invalid-input' }
  }

  const payload = { feature: 'skill-suggestion', version: 1, request: redacted, candidates: shortlist }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_STATE_BYTES) {
    return { status: 'fallback', reason: 'input-too-large' }
  }

  const cacheKey = `skill-suggestion:v1:${JEV_MODEL}:${sha256Text(JSON.stringify(payload))}`
  const cached = input.budget.getCached<{ value: SkillSuggestionDecision; suggestedSkillId: string | null }>(cacheKey)
  if (cached) return { status: 'decision', ...cached, cached: true }

  const reservation = input.budget.tryReserve(input.turnId)
  if (!reservation.allowed) return { status: 'fallback', reason: reservation.reason }

  const startedAt = Date.now()
  const result = await input.client.evaluate(
    { payload, responseSchema: SkillSuggestionDecisionSchema },
    { ...(input.signal ? { signal: input.signal } : {}) },
  )
  input.budget.recordElapsed(input.turnId, Date.now() - startedAt)

  if (result.status === 'fallback') {
    if (isTransientFailure(result.reason)) input.budget.recordTransientFailure()
    return { status: 'fallback', reason: result.reason }
  }

  input.budget.recordSuccess()
  const validIds = new Set(shortlist.map((s) => s.id))
  const ranked = Object.entries(result.value.scores)
    .filter(([id, score]) => validIds.has(id) && score === 2)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b))
  const suggestedSkillId = result.value.needsSkill >= 0.5 && ranked.length > 0 ? ranked[0]! : null

  input.budget.setCached(cacheKey, { value: result.value, suggestedSkillId })
  return {
    status: 'decision',
    value: result.value,
    suggestedSkillId,
    cached: false,
    ...(result.usage ? { usage: result.usage } : {}),
  }
}
