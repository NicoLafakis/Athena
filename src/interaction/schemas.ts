import { z } from 'zod'

const ID_MAX = 256
const LABEL_MAX = 256
const SUMMARY_MAX = 1_024
const DETAIL_MAX = 4_096

const IdSchema = z.string().min(1).max(ID_MAX)
const TimestampSchema = z.string().datetime({ offset: true })

export const InteractionSourceSchema = z.enum(['runtime', 'user', 'agent'])
export const RuntimePhaseSchema = z.enum([
  'idle',
  'thinking',
  'acting',
  'waiting-permission',
  'waiting-user',
  'blocked',
  'completed',
  'failed',
  'aborted',
  'limited',
])

export const ProvenanceSchema = z.object({
  source: InteractionSourceSchema,
  runId: IdSchema,
  sequence: z.number().int().positive(),
  sourceEventType: z.string().min(1).max(LABEL_MAX),
  sourceEventId: IdSchema.optional(),
}).strict()

export const ActivitySchema = z.object({
  type: z.enum(['tool', 'background', 'child', 'system']),
  label: z.string().min(1).max(LABEL_MAX),
  status: z.enum(['active', 'succeeded', 'failed']),
  target: z.string().min(1).max(LABEL_MAX).optional(),
}).strict()

const AttentionInputSchema = z.object({
  id: IdSchema,
  category: z.enum(['permission', 'error', 'blocked', 'decision', 'limit']),
  priority: z.enum(['polite', 'assertive', 'blocking']),
  summary: z.string().min(1).max(SUMMARY_MAX),
  action: z.string().min(1).max(SUMMARY_MAX).optional(),
}).strict()

export const AttentionItemSchema = AttentionInputSchema.extend({
  provenance: ProvenanceSchema,
}).strict()

export const OutcomeSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'limited', 'aborted']),
  summary: z.string().min(1).max(SUMMARY_MAX),
  verified: z.boolean(),
  operation: z.string().min(1).max(LABEL_MAX).optional(),
}).strict()

const EnvelopeBase = {
  schemaVersion: z.literal(1),
  id: IdSchema,
  runId: IdSchema,
  sequence: z.number().int().positive(),
  timestamp: TimestampSchema,
  source: InteractionSourceSchema,
  sourceRef: IdSchema.optional(),
}

export const InteractionEventEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...EnvelopeBase,
    kind: z.literal('objective-set'),
    payload: z.object({ objective: z.string().min(1).max(DETAIL_MAX) }).strict(),
  }).strict(),
  z.object({
    ...EnvelopeBase,
    kind: z.literal('phase-changed'),
    payload: z.object({ phase: RuntimePhaseSchema }).strict(),
  }).strict(),
  z.object({
    ...EnvelopeBase,
    kind: z.literal('activity-changed'),
    payload: z.object({ activity: ActivitySchema.nullable() }).strict(),
  }).strict(),
  z.object({
    ...EnvelopeBase,
    kind: z.literal('attention-added'),
    payload: z.object({ attention: AttentionInputSchema }).strict(),
  }).strict(),
  z.object({
    ...EnvelopeBase,
    kind: z.literal('attention-resolved'),
    payload: z.object({ attentionId: IdSchema }).strict(),
  }).strict(),
  z.object({
    ...EnvelopeBase,
    kind: z.literal('outcome-recorded'),
    payload: z.object({ outcome: OutcomeSchema }).strict(),
  }).strict(),
  z.object({
    ...EnvelopeBase,
    kind: z.literal('next-expected-set'),
    payload: z.object({ nextExpected: z.string().min(1).max(SUMMARY_MAX).nullable() }).strict(),
  }).strict(),
])

const sourced = <T extends z.ZodTypeAny>(value: T) => z.object({
  value,
  provenance: ProvenanceSchema.nullable(),
}).strict()

export const InteractionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  reducerVersion: z.literal(1),
  runId: IdSchema,
  lastSequence: z.number().int().nonnegative(),
  objective: sourced(z.string().max(DETAIL_MAX).nullable()),
  phase: sourced(RuntimePhaseSchema),
  activity: sourced(ActivitySchema.nullable()),
  attention: z.array(AttentionItemSchema).max(256),
  lastVerifiedOutcome: sourced(OutcomeSchema.nullable()),
  nextExpected: sourced(z.string().max(SUMMARY_MAX).nullable()),
  updatedAt: TimestampSchema,
}).strict()

export const AnnouncementSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  runId: IdSchema,
  priority: z.enum(['silent', 'polite', 'assertive', 'blocking']),
  category: z.string().min(1).max(LABEL_MAX),
  text: z.string().min(1).max(SUMMARY_MAX),
  detail: z.string().min(1).max(DETAIL_MAX).optional(),
  dedupeKey: z.string().min(1).max(512),
  requiresAcknowledgement: z.boolean(),
  provenance: z.array(ProvenanceSchema).min(1).max(32),
  createdAt: TimestampSchema,
}).strict()
