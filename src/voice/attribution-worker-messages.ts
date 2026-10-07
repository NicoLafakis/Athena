import { z } from 'zod'
import { AlignmentInputSchema, alignWords } from './attribution-alignment.js'
import { AttributionEnvelopeSchema, AttributionEventSchema } from './attribution.js'

/** One revisable word per message preserves the envelope's one-event sequence.
 * Participant-track provenance belongs to the trusted host, never this worker.
 */
export const AttributionWorkerWordSchema = AttributionEnvelopeSchema.extend({
  type: z.literal('worker.word'), segmentId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
  revision: z.number().int().nonnegative().safe(), state: z.enum(['partial', 'final']),
  alignment: AlignmentInputSchema,
}).strict().superRefine((message, ctx) => {
  if (message.alignment.words.length !== 1
    || message.alignment.captureSessionId !== message.captureSessionId
    || message.alignment.streamEpoch !== message.streamEpoch
    || message.alignment.activity.some(item => item.source !== 'diarization')) {
    ctx.addIssue({ code: 'custom', message: 'Invalid single-word worker scope or provenance' })
  }
})

export function workerWordToSegment(input: unknown): z.infer<typeof AttributionEventSchema> {
  const message = AttributionWorkerWordSchema.parse(input)
  const aligned = alignWords(message.alignment)[0]!
  const envelope = AttributionEnvelopeSchema.strip().parse(message)
  return AttributionEventSchema.parse({ ...envelope, type: 'transcript.segment',
    segmentId: message.segmentId, revision: message.revision, state: message.state,
    startMs: aligned.startMs, endMs: aligned.endMs, text: aligned.text,
    speakers: aligned.speakers, overlap: aligned.overlap,
    identity: { status: 'unknown', reason: aligned.reason },
  })
}
