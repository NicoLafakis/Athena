import { z } from 'zod'

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const Integer = z.number().int().nonnegative().safe()
const Speaker = z.object({
  speakerId: Id,
  source: z.enum(['track-metadata', 'diarization', 'human-correction']),
}).strict()
const Identity = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['disabled', 'unknown']), reason: Id }).strict(),
  z.object({
    status: z.literal('suggested'), profileId: Id,
    scoreType: z.literal('cosine-similarity'), score: z.number().finite().min(-1).max(1),
    calibrationVersion: Id,
  }).strict(),
])
export const AttributionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), eventId: Id, eventSeq: Integer,
  captureSessionId: Id, harnessSessionId: Id, streamEpoch: Integer,
  emittedAt: z.string().datetime(), modelRevision: Id, policyVersion: Id,
}).strict()

/** Internal attribution only: never accepted as submit_turn or permission arguments. */
export const AttributionEventSchema = z.discriminatedUnion('type', [
  AttributionEnvelopeSchema.extend({
    type: z.literal('transcript.segment'), segmentId: Id, revision: Integer,
    startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative(),
    text: z.string().min(1).max(4_096), state: z.enum(['partial', 'final']),
    speakers: z.array(Speaker).max(8), overlap: z.boolean(), identity: Identity,
  }).strict(),
  AttributionEnvelopeSchema.extend({ type: z.literal('capture.gap'), reason: Id }).strict(),
]).superRefine((event, ctx) => {
  if (event.type !== 'transcript.segment') return
  if (event.endMs <= event.startMs) ctx.addIssue({ code: 'custom', message: 'Invalid time interval' })
  if (new Set(event.speakers.map(s => s.speakerId)).size !== event.speakers.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate speaker labels' })
  }
  if (event.speakers.length > 1 && !event.overlap) {
    ctx.addIssue({ code: 'custom', message: 'Multiple speakers require overlap' })
  }
  if (event.identity.status === 'suggested' && (event.overlap || event.speakers.length !== 1)) {
    ctx.addIssue({ code: 'custom', message: 'Identity requires one clean speaker' })
  }
})

export type AttributionEvent = z.infer<typeof AttributionEventSchema>
export type AttributedSegment = Extract<AttributionEvent, { type: 'transcript.segment' }>
export type AttributionResult = 'applied' | 'stale' | 'wrong-session' | 'epoch-gap-required' | 'capacity'

/** Bounded ephemeral preview. Higher epochs require an explicit gap before new labels. */
export class AttributionPreview {
  private epoch = 0
  private sequence = -1
  private readonly segments = new Map<string, AttributedSegment>()

  constructor(
    private readonly captureSessionId: string,
    private readonly harnessSessionId: string,
    private readonly maxSegments = 128,
    initialEpoch = 0,
  ) {
    Id.parse(captureSessionId)
    Id.parse(harnessSessionId)
    z.number().int().min(1).max(1_024).parse(maxSegments)
    this.epoch = Integer.parse(initialEpoch)
  }

  apply(input: unknown): AttributionResult {
    const event = AttributionEventSchema.parse(input)
    if (event.captureSessionId !== this.captureSessionId || event.harnessSessionId !== this.harnessSessionId) {
      return 'wrong-session'
    }
    if (event.streamEpoch < this.epoch || event.eventSeq <= this.sequence) return 'stale'
    if (event.streamEpoch > this.epoch && event.type !== 'capture.gap') return 'epoch-gap-required'
    if (event.type === 'capture.gap') {
      this.epoch = event.streamEpoch
      this.sequence = event.eventSeq
      this.segments.clear()
      return 'applied'
    }
    const previous = this.segments.get(event.segmentId)
    if (previous && (event.revision <= previous.revision || (previous.state === 'final' && event.state === 'partial'))) {
      return 'stale'
    }
    if (!previous && this.segments.size >= this.maxSegments) return 'capacity'
    this.sequence = event.eventSeq
    this.segments.set(event.segmentId, structuredClone(event))
    return 'applied'
  }

  snapshot(): AttributedSegment[] { return structuredClone([...this.segments.values()]) }

  clear(): void { this.segments.clear() }
}
