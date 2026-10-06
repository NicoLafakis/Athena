import { z } from 'zod'
import { plainBounded } from '../interaction/format.js'
import { AttributionSession, type SessionNotice } from './attribution-session.js'

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const Empty = z.object({}).strict()
export const AttributionLocalControlSchema = z.discriminatedUnion('action', [
  Empty.extend({ action: z.enum(['start', 'pause', 'stop', 'status', 'review']) }).strict(),
  Empty.extend({ action: z.literal('disclose'), participantIds: z.array(Id).min(1).max(64) }).strict(),
  Empty.extend({ action: z.enum(['join', 'withdraw']), participantId: Id }).strict(),
  Empty.extend({ action: z.literal('consent'), participantId: Id, consent: z.object({
    capture: z.boolean(), cloudTransfer: z.boolean(), transcriptPersistence: z.boolean(), profileMatching: z.boolean(),
  }).strict() }).strict(),
  Empty.extend({ action: z.literal('submit'), segmentId: Id,
    captureSessionId: Id, streamEpoch: z.number().int().nonnegative().safe(),
    revision: z.number().int().nonnegative().safe(), utterance: z.number().int().nonnegative().safe(),
  }).strict(),
])

const NOTICE_TEXT: Record<SessionNotice, string> = {
  disclosed: 'Attribution preview disclosed. Capture is off until each participant opts in.',
  'waiting-consent': 'Attribution cannot start. Participant consent is missing or capture is stopped.',
  'waiting-worker': 'Attribution is waiting for its worker. No frames are accepted yet.',
  ready: 'Attribution adapter is ready for this session. This does not verify anyone’s identity.',
  'consent-paused': 'Attribution paused for participant consent. Queued audio and preview were cleared.',
  paused: 'Attribution paused. Queued audio and preview were cleared. Restart is explicit.',
  gap: 'Attribution interrupted. Speaker labels reset; waiting for a fresh worker.',
  overload: 'Attribution paused by overload. Queued audio and preview were cleared; worker readiness must be re-established.',
  'worker-error': 'Attribution worker failed. Queued audio and preview were cleared; ordinary Athena remains available.',
  stopped: 'Attribution stopped. Consent, queued audio and preview were cleared.',
}
export function formatAttributionNotice(code: SessionNotice): string { return NOTICE_TEXT[code] }

export function formatAttributionReview(session: AttributionSession): string[] {
  const segments = session.snapshot()
  if (!segments.length) return ['No attributed transcript is available.']
  return segments.map(segment => {
    const label = segment.overlap ? `Overlapping speakers ${segment.speakers.map(s => s.speakerId).join(', ')}`
      : segment.speakers.length ? `Speaker ${segment.speakers[0]!.speakerId}` : 'Unknown speaker'
    const sources = [...new Set(segment.speakers.map(s => s.source))].join(', ')
    return `${label}; ${segment.state}; ${segment.startMs} to ${segment.endMs} milliseconds; `
      + `${sources || 'unknown source'}: ${plainBounded(segment.text, 4_096)}`
  })
}

/**
 * Presentation-neutral, trusted local-operator seam. Never register this contract as a
 * model tool or worker RPC. The host must collect actual participant consent and own
 * text/Braille/speech output. Returning admission does not execute the harness.
 */
export class AttributionLocalControls {
  constructor(private readonly session: AttributionSession) {}

  handle(input: unknown): { lines: string[]; admission?: ReturnType<AttributionSession['admit']> } {
    const parsed = AttributionLocalControlSchema.safeParse(input)
    if (!parsed.success) return { lines: ['Invalid attribution control. Nothing changed.'] }
    const action = parsed.data
    try {
      switch (action.action) {
        case 'disclose': this.session.disclose(action.participantIds); return { lines: [formatAttributionNotice('disclosed')] }
        case 'consent': this.session.setConsent(action.participantId, action.consent); return { lines: ['Participant consent recorded for this session. Use start when everyone has opted in.'] }
        case 'join': this.session.join(action.participantId); return { lines: [formatAttributionNotice('consent-paused')] }
        case 'withdraw': this.session.withdraw(action.participantId); return { lines: [formatAttributionNotice('consent-paused')] }
        case 'start': return { lines: [formatAttributionNotice(this.session.start() ? 'waiting-worker' : 'waiting-consent')] }
        case 'pause': this.session.pause(); return { lines: [formatAttributionNotice('paused')] }
        case 'stop': this.session.stop(); return { lines: [formatAttributionNotice('stopped')] }
        case 'review': return { lines: formatAttributionReview(this.session) }
        case 'status': {
          const state = this.session.status()
          return { lines: [`Attribution ${state.active ? 'active' : 'inactive'}; epoch ${state.epoch}; `
            + `${state.queuedFrames} queued frames; ${state.pendingJobs} pending jobs. Identity is advisory.`] }
        }
        case 'submit': {
          const admission = this.session.admit(action.segmentId, action.revision, action.utterance, true,
            { captureSessionId: action.captureSessionId, streamEpoch: action.streamEpoch })
          return { lines: [admission.ok ? 'Transcript turn admitted to the existing voice ledger. Harness execution is the host’s next step.'
            : `Transcript turn refused: ${admission.reason}. Nothing was executed.`], admission }
        }
      }
    } catch {
      // No arbitrary worker/exception text enters spoken output, and no fallback consent.
      return { lines: ['Attribution control refused. Check participant disclosure and session state.'] }
    }
  }
}
