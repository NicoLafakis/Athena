import { z } from 'zod'

export const LearningTargetSchema = z.enum([
  'memory',
  'skill',
  'prompt',
  'policy',
  'code',
])

export const LearningCandidateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  sourceRunIds: z.array(z.string().min(1)).min(1),
  hypothesis: z.string().min(10).max(10_000),
  target: LearningTargetSchema,
  // Candidates use ordinary unified diffs so git can check, isolate, reverse,
  // inspect, and promote the exact same artifact.
  patch: z.string().min(1).max(2_000_000),
  expectedMetricDelta: z.record(z.string(), z.number()),
  applicability: z.array(z.string().min(1)).min(1),
  counterexamples: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  expiresAt: z.string().datetime().optional(),
  provenance: z.object({
    traceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    generator: z.string().min(1),
    generatorVersion: z.string().min(1),
  }),
  status: z
    .enum(['provisional', 'evaluated', 'rejected', 'approved', 'canary', 'promoted', 'rolled-back'])
    .default('provisional'),
})

export type LearningCandidate = z.infer<typeof LearningCandidateSchema>

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  split: z.enum(['training', 'heldout']),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().positive().max(30 * 60_000).default(120_000),
  expectedExitCode: z.number().int().default(0),
  evaluators: z
    .array(z.enum(['exit-code', 'athena-usage', 'safety-invariant']))
    .default(['exit-code', 'athena-usage', 'safety-invariant']),
  maxCostUsd: z.number().nonnegative().optional(),
  maxLatencyMs: z.number().positive().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  safetyInvariant: z.boolean().default(false),
})

export const EvalSuiteSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  cases: z.array(EvalCaseSchema).min(1),
})

export type EvalSuite = z.infer<typeof EvalSuiteSchema>
export type EvalCase = z.infer<typeof EvalCaseSchema>

export const EvalMeasurementSchema = z.object({
  caseId: z.string(),
  split: z.enum(['training', 'heldout']),
  success: z.boolean(),
  exitCode: z.number().int().nullable(),
  safetyViolations: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputTail: z.string(),
  error: z.string().nullable(),
})

export type EvalMeasurement = z.infer<typeof EvalMeasurementSchema>

export const EvaluationRunSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().uuid(),
  suiteId: z.string(),
  candidateId: z.string().uuid().nullable(),
  role: z.enum(['baseline', 'candidate', 'canary']),
  commit: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  measurements: z.array(EvalMeasurementSchema),
})

export type EvaluationRun = z.infer<typeof EvaluationRunSchema>

export interface EvaluationComparison {
  schemaVersion: 1
  candidateId: string
  baselineRunId: string
  candidateRunId: string
  heldoutCases: number
  baselineSuccessRate: number
  candidateSuccessRate: number
  pairedMeanDelta: number
  pairedLowerConfidenceBound: number
  safetyRegressions: number
  previouslyPassingRegressions: string[]
  costRatio: number
  latencyRatio: number
  toolCallRatio: number
  promotable: boolean
  reasons: string[]
}

export const MemoryClaimSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().uuid(),
  statement: z.string().min(1),
  sourceRunIds: z.array(z.string().min(1)).min(1),
  candidateId: z.string().uuid().optional(),
  provenanceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
  confidence: z.number().min(0).max(1),
  applicability: z.array(z.string()),
  counterexamples: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  status: z.enum(['provisional', 'active', 'contradicted', 'expired', 'rejected']),
  contradicts: z.array(z.string().uuid()).default([]),
})

export type MemoryClaim = z.infer<typeof MemoryClaimSchema>

export const PromotionRecordSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  parentRecordId: z.string().uuid().nullable(),
  action: z.enum(['promote-canary', 'finalize', 'rollback']),
  commitBefore: z.string(),
  commitAfter: z.string(),
  patchHash: z.string().regex(/^[a-f0-9]{64}$/),
  comparisonHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  publicKey: z.string(),
  signature: z.string(),
})

export type PromotionRecord = z.infer<typeof PromotionRecordSchema>
