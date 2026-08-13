import { z } from 'zod'

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

export const VoiceContextSchema = z.object({
  schemaVersion: z.literal(1),
  runId: IdSchema,
  objective: z.string().min(1).max(1_024).optional(),
  phase: z.enum([
    'idle', 'thinking', 'acting', 'waiting-permission', 'waiting-user',
    'blocked', 'completed', 'failed', 'aborted', 'limited',
  ]),
  pendingAttention: z.array(z.object({
    id: IdSchema,
    priority: z.enum(['polite', 'assertive', 'blocking']),
    summary: z.string().min(1).max(512),
  }).strict()).max(8),
  lastVerifiedOutcome: z.object({
    status: z.enum(['succeeded', 'failed', 'limited', 'aborted']),
    summary: z.string().min(1).max(512),
  }).strict().optional(),
  latestAnnouncement: z.object({
    id: IdSchema,
    priority: z.enum(['polite', 'assertive', 'blocking']),
    text: z.string().min(1).max(1_024),
  }).strict().optional(),
}).strict()

/**
 * The `local_control` permission answer, validated locally before it can touch the
 * harness. Model-produced arguments are untrusted input, so the identity is bounded by
 * the same `IdSchema` the `approve`/`deny` contract below uses. The ID is optional here
 * and only because exactly one pending request needs no disambiguation; with several
 * waiting, `VoiceAttentionBridge` refuses an answer that omits it.
 */
export const VoicePermissionAnswerSchema = z.object({
  action: z.enum(['allow', 'deny']),
  permissionId: IdSchema.optional(),
}).strict()

export const VoiceFunctionCallSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('delegate'),
    arguments: z.object({ prompt: z.string().min(1).max(4_096) }).strict(),
  }).strict(),
  z.object({ name: z.literal('status'), arguments: z.object({}).strict() }).strict(),
  z.object({
    name: z.literal('focus'),
    arguments: z.object({ sessionId: IdSchema }).strict(),
  }).strict(),
  z.object({
    name: z.literal('approve'),
    arguments: z.object({ permissionId: IdSchema }).strict(),
  }).strict(),
  z.object({
    name: z.literal('deny'),
    arguments: z.object({ permissionId: IdSchema }).strict(),
  }).strict(),
  z.object({
    name: z.literal('cancel'),
    arguments: z.object({ sessionId: IdSchema }).strict(),
  }).strict(),
])
