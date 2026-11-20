import { z } from 'zod'

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

/**
 * The `local_control` permission answer, validated locally before it can touch the
 * harness. Model-produced arguments are untrusted input, so the identity is bounded by
 * `IdSchema`. The ID is optional here only because exactly one pending request needs no
 * disambiguation; with several waiting, `VoiceAttentionBridge` refuses an answer that
 * omits it.
 */
export const VoicePermissionAnswerSchema = z.object({
  action: z.enum(['allow', 'deny']),
  permissionId: IdSchema.optional(),
}).strict()

export type VoiceTurnSource = 'audio' | 'keyboard'

/**
 * The `submit_turn` argument contract, validated before anything reaches the harness.
 * `.strict()` mirrors the `additionalProperties: false` the tool is advertised with, so a
 * malformed call is refused rather than partially honoured.
 */
export const VoiceTurnSubmissionSchema = z.object({
  text: z.string().min(1).max(4_096),
}).strict()

/**
 * One voice turn, in memory only — no database and no migration.
 *
 * `id` is the idempotency key, not a label: it is derived from the utterance and the
 * submitted text, so a repeated tool call or a reconnect resolves to the SAME record
 * instead of starting a second harness run. `harnessSessionId` is filled in on completion
 * because the durable session the turn landed in is what the result is evidence about.
 */
export const VoiceTurnRecordSchema = z.object({
  id: IdSchema,
  source: z.enum(['audio', 'keyboard']),
  text: z.string().min(1).max(4_096),
  harnessSessionId: IdSchema.optional(),
  state: z.enum(['running', 'completed', 'failed']),
  permissionId: IdSchema.optional(),
}).strict()

export type VoiceTurnRecord = z.infer<typeof VoiceTurnRecordSchema>
