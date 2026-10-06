import { z } from 'zod'
import { plainBounded } from '../interaction/format.js'
import type { AttributedSegment } from './attribution.js'
import { AttributionEventSchema } from './attribution.js'
import { VoiceTurnSubmissionSchema } from './schemas.js'

const ParticipantId = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
export const AttributionPolicySchema = z.object({
  mode: z.enum(['observation', 'command']).default('observation'),
  processing: z.enum(['local', 'cloud']).default('local'),
  persistTranscript: z.boolean().default(false),
  transcriptRetentionDays: z.number().int().positive().max(3_650).nullable().default(null),
  matchProfiles: z.boolean().default(false),
  profileExpiryDays: z.number().int().positive().max(3_650).nullable().default(null),
}).strict().superRefine((policy, ctx) => {
  if (policy.persistTranscript && policy.transcriptRetentionDays === null) {
    ctx.addIssue({ code: 'custom', message: 'Transcript persistence needs an explicit retention period' })
  }
  if (policy.matchProfiles && policy.profileExpiryDays === null) {
    ctx.addIssue({ code: 'custom', message: 'Matching needs an explicit profile expiry period' })
  }
})

const ConsentSchema = z.object({
  capture: z.boolean(), cloudTransfer: z.boolean(), transcriptPersistence: z.boolean(),
  profileMatching: z.boolean(),
}).strict()
export type ParticipantConsent = z.infer<typeof ConsentSchema>
export type CaptureState = 'disabled' | 'disclosed' | 'active' | 'paused' | 'stopped'

/** Consent gate only; this class opens no device, creates no profile, and writes no file. */
export class AttributionConsent {
  private state: CaptureState = 'disabled'
  private readonly participants = new Map<string, ParticipantConsent | null>()
  readonly policy: Readonly<z.infer<typeof AttributionPolicySchema>>

  constructor(policy: unknown = {}) {
    this.policy = Object.freeze(AttributionPolicySchema.parse(policy))
  }

  disclose(participantIds: string[]): void {
    z.array(ParticipantId).min(1).max(64).refine(ids => new Set(ids).size === ids.length).parse(participantIds)
    this.participants.clear()
    for (const id of participantIds) this.participants.set(id, null)
    this.state = 'disclosed'
  }

  join(id: string): void {
    ParticipantId.parse(id)
    if (this.state === 'disabled' || this.state === 'stopped') throw new Error('Disclosure required')
    if (this.participants.has(id)) throw new Error('Participant already present')
    if (this.participants.size >= 64) throw new Error('Participant capacity reached')
    this.participants.set(id, null)
    this.state = 'paused'
  }

  consent(id: string, input: unknown): void {
    if (this.state === 'disabled' || this.state === 'stopped' || !this.participants.has(id)) {
      throw new Error('Participant disclosure required')
    }
    this.participants.set(id, ConsentSchema.parse(input))
    if (this.state === 'active' && !this.permitted()) this.state = 'paused'
  }

  withdraw(id: string): void {
    if (!this.participants.has(id)) throw new Error('Unknown participant')
    this.participants.set(id, null)
    if (this.state !== 'stopped') this.state = 'paused'
  }

  private permitted(): boolean {
    return this.participants.size > 0 && [...this.participants.values()].every(c => c !== null
      && c.capture && (this.policy.processing !== 'cloud' || c.cloudTransfer)
      && (!this.policy.persistTranscript || c.transcriptPersistence)
      && (!this.policy.matchProfiles || c.profileMatching))
  }

  start(): boolean {
    if ((this.state !== 'disclosed' && this.state !== 'paused') || !this.permitted()) return false
    this.state = 'active'
    return true
  }

  stop(): void {
    this.state = 'stopped'
    for (const id of this.participants.keys()) this.participants.set(id, null)
  }

  pause(): void { if (this.state === 'active') this.state = 'paused' }

  status(): CaptureState { return this.state }
  canProcess(): boolean { return this.state === 'active' && this.permitted() }
}

/** Explicit operator admission only. Names and scores cannot grant permission authority. */
export function attributedTurn(
  input: unknown,
  consent: AttributionConsent,
  operatorRequested: boolean,
): { text: string } | null {
  const parsed = AttributionEventSchema.safeParse(input)
  if (!parsed.success || parsed.data.type !== 'transcript.segment') return null
  const segment: AttributedSegment = parsed.data
  if (!consent.canProcess() || !operatorRequested || segment.state !== 'final'
    || segment.overlap || segment.speakers.length !== 1) return null
  const turn = VoiceTurnSubmissionSchema.safeParse({ text: plainBounded(segment.text, 4_096) })
  return turn.success ? turn.data : null
}
