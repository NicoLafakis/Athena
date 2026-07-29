import { z } from 'zod'

const IdSchema = z.string().min(1).max(256)
const TimestampSchema = z.string().datetime({ offset: true })

export const ExperienceRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  projectScope: IdSchema,
  situation: z.string().min(1).max(4_096),
  actions: z.array(z.string().min(1).max(512)).max(64),
  outcome: z.enum(['succeeded', 'failed', 'mixed', 'aborted', 'limited']),
  evidenceRefs: z.array(z.string().min(1).max(512)).min(1).max(64),
  tags: z.array(z.string().min(1).max(64)).max(64),
  createdAt: TimestampSchema,
}).strict()

export const GuidanceRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  experienceIds: z.array(IdSchema).min(1).max(64),
  signal: z.enum(['consider', 'avoid', 'stop-if', 'switch-if']),
  text: z.string().min(1).max(2_048),
  status: z.enum(['provisional', 'active', 'retired']),
  confidence: z.number().min(0).max(1),
  reviewedAt: TimestampSchema.optional(),
}).strict()
