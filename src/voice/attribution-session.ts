import { z } from 'zod'
import { AttributionConsent, attributedTurn } from './attribution-consent.js'
import { AttributionEnvelopeSchema, AttributionEventSchema, AttributionPreview } from './attribution.js'
import { VoiceTurnLedger, type VoiceTurnAdmission } from './turns.js'

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const Integer = z.number().int().nonnegative().safe()

/** Synthetic/local IPC frame contract. Signed 16-bit little-endian mono PCM only. */
export const AttributionFrameSchema = z.object({
  captureSessionId: Id, streamEpoch: Integer, frameSeq: Integer,
  sampleStart: Integer, sampleCount: z.number().int().positive().max(48_000),
  sampleRate: z.union([z.literal(16_000), z.literal(24_000), z.literal(48_000)]),
  channels: z.literal(1), format: z.literal('pcm16le'),
  pcm: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength <= 96_000, 'Frame too large'),
}).strict().superRefine((frame, ctx) => {
  if (frame.sampleCount > frame.sampleRate || frame.pcm.byteLength !== frame.sampleCount * 2
    || !Number.isSafeInteger(frame.sampleStart + frame.sampleCount)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid PCM frame duration or byte count' })
  }
})
export type AttributionFrame = z.infer<typeof AttributionFrameSchema>

export const AttributionWorkerEventSchema = z.discriminatedUnion('type', [
  AttributionEnvelopeSchema.extend({ type: z.literal('worker.ready') }).strict(),
  AttributionEnvelopeSchema.extend({ type: z.literal('worker.heartbeat') }).strict(),
  AttributionEnvelopeSchema.extend({
    type: z.literal('worker.error'), reason: z.enum(['unavailable', 'overload', 'invalid-output']),
  }).strict(),
  AttributionEnvelopeSchema.extend({ type: z.literal('worker.stopped') }).strict(),
])

export type SessionNotice = 'disclosed' | 'waiting-consent' | 'waiting-worker' | 'ready'
  | 'consent-paused' | 'paused' | 'gap' | 'overload' | 'worker-error' | 'stopped'
export type FrameResult = 'queued' | 'invalid' | 'inactive' | 'wrong-session' | 'stale' | 'gap' | 'overload'
export type SessionAdmission = VoiceTurnAdmission | {
  ok: false; reason: 'inactive' | 'stale-segment' | 'not-explicit' | 'unsupported' | 'already-admitted'
}

/**
 * Dormant owner for synthetic adapters. No devices, subprocesses, persistence or network.
 * Notices are canonical codes for a future accessible presentation, never worker prose.
 */
export class AttributionSession {
  private readonly consent: AttributionConsent
  private preview: AttributionPreview
  private epoch = 0
  private sequence = -1
  private ready = false
  private closed = false
  private frameSeq = -1
  private sampleEnd: number | null = null
  private sampleRate: number | null = null
  private readonly frames: AttributionFrame[] = []
  private readonly admitted = new Set<string>()
  private readonly jobs = new Set<AbortController>()

  constructor(
    private readonly captureSessionId: string,
    private readonly harnessSessionId: string,
    private readonly ledger: VoiceTurnLedger,
    policy: unknown = {},
    private readonly notice: (code: SessionNotice) => void = () => {},
    private readonly maxFrames = 8,
  ) {
    this.consent = new AttributionConsent(policy)
    if (this.consent.policy.processing !== 'local' || this.consent.policy.persistTranscript
      || this.consent.policy.matchProfiles) throw new Error('This synthetic owner supports ephemeral local attribution only')
    z.number().int().min(1).max(32).parse(maxFrames)
    this.preview = new AttributionPreview(captureSessionId, harnessSessionId)
  }

  private announce(code: SessionNotice): void {
    // Presentation failures cannot prevent revocation or cleanup.
    try { this.notice(code) } catch { /* The future UI owns reporting its own output failure. */ }
  }

  private reset(code: SessionNotice): void {
    this.ready = false
    for (const frame of this.frames) frame.pcm.fill(0)
    this.frames.length = 0
    for (const job of this.jobs) job.abort()
    // Keep cancelled jobs counted until they settle: an adapter that ignores abort
    // must not permit an unbounded number of promises across restart cycles.
    this.preview.clear()
    this.admitted.clear()
    this.epoch++
    this.sequence = -1
    this.frameSeq = -1
    this.sampleEnd = null
    this.sampleRate = null
    this.preview = new AttributionPreview(this.captureSessionId, this.harnessSessionId, 128, this.epoch)
    this.announce(code)
  }

  disclose(participants: string[]): void {
    if (this.closed) throw new Error('Capture session is stopped; create a new session')
    this.consent.disclose(participants)
    this.reset('disclosed')
  }

  setConsent(id: string, consent: unknown): void {
    const wasActive = this.consent.canProcess()
    this.consent.consent(id, consent)
    if (wasActive && !this.consent.canProcess()) this.reset('consent-paused')
  }

  join(id: string): void { this.consent.join(id); this.reset('consent-paused') }
  withdraw(id: string): void { this.consent.withdraw(id); this.reset('consent-paused') }

  start(): boolean {
    if (this.closed || !this.consent.start()) { this.announce('waiting-consent'); return false }
    this.announce('waiting-worker')
    return true
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    this.consent.stop()
    this.reset('stopped')
  }

  pause(): void {
    if (this.closed) return
    this.consent.pause()
    this.reset('paused')
  }

  status(): { epoch: number; active: boolean; queuedFrames: number; pendingJobs: number } {
    return { epoch: this.epoch, active: !this.closed && this.ready && this.consent.canProcess(),
      queuedFrames: this.frames.length, pendingJobs: this.jobs.size }
  }

  pushFrame(input: unknown): FrameResult {
    const parsed = AttributionFrameSchema.safeParse(input)
    if (!parsed.success) return 'invalid'
    const frame = parsed.data
    if (frame.captureSessionId !== this.captureSessionId) return 'wrong-session'
    if (!this.status().active) return 'inactive'
    if (frame.streamEpoch !== this.epoch || frame.frameSeq <= this.frameSeq) return 'stale'
    if ((this.frameSeq >= 0 && frame.frameSeq !== this.frameSeq + 1)
      || (this.sampleEnd !== null && frame.sampleStart !== this.sampleEnd)
      || (this.sampleRate !== null && frame.sampleRate !== this.sampleRate)) {
      this.reset('gap')
      return 'gap'
    }
    if (this.frames.length >= this.maxFrames) { this.reset('overload'); return 'overload' }
    this.frames.push({ ...frame, pcm: new Uint8Array(frame.pcm) })
    this.frameSeq = frame.frameSeq
    this.sampleEnd = frame.sampleStart + frame.sampleCount
    this.sampleRate = frame.sampleRate
    return 'queued'
  }

  /** Ownership of a dequeued copy passes to the adapter, which must release it on abort. */
  takeFrame(): AttributionFrame | undefined { return this.status().active ? this.frames.shift() : undefined }

  receive(input: unknown): string {
    const parsed = AttributionWorkerEventSchema.safeParse(input)
    const attributed = AttributionEventSchema.safeParse(input)
    const event = parsed.success ? parsed.data : attributed.success ? attributed.data : null
    if (!event) return 'invalid'
    if (event.captureSessionId !== this.captureSessionId || event.harnessSessionId !== this.harnessSessionId) return 'wrong-session'
    if (event.streamEpoch !== this.epoch || event.eventSeq <= this.sequence) return 'stale'
    if (!this.consent.canProcess() || this.closed) return 'inactive'
    if (event.type === 'worker.error' || event.type === 'worker.stopped' || event.type === 'capture.gap') {
      this.reset(event.type === 'worker.error' ? 'worker-error' : 'gap')
      return 'reset'
    }
    if (event.type === 'worker.ready') {
      this.ready = true
      this.sequence = event.eventSeq
      this.announce('ready')
      return 'ready'
    }
    if (!this.ready) return 'inactive'
    if (event.type === 'worker.heartbeat') {
      this.sequence = event.eventSeq
      return 'heartbeat'
    }
    if (event.identity.status === 'suggested') return 'profile-matching-disabled'
    const result = this.preview.apply(event)
    if (result === 'capacity') { this.reset('overload'); return 'overload' }
    if (result === 'applied') this.sequence = event.eventSeq
    return result
  }

  snapshot(): ReturnType<AttributionPreview['snapshot']> { return this.preview.snapshot() }

  /** Future trusted local UI supplies this request, never a model/worker event. */
  admit(segmentId: string, revision: number, utterance: number, operatorRequested: boolean,
    selection: { captureSessionId: string; streamEpoch: number }): SessionAdmission {
    if (!this.status().active) return { ok: false, reason: 'inactive' }
    if (!operatorRequested) return { ok: false, reason: 'not-explicit' }
    if (selection.captureSessionId !== this.captureSessionId || selection.streamEpoch !== this.epoch) {
      return { ok: false, reason: 'stale-segment' }
    }
    Integer.parse(utterance)
    const segment = this.preview.snapshot().find(s => s.segmentId === segmentId && s.revision === revision && s.streamEpoch === this.epoch)
    if (!segment) return { ok: false, reason: 'stale-segment' }
    if (this.admitted.has(segmentId)) return { ok: false, reason: 'already-admitted' }
    const turn = attributedTurn(segment, this.consent, true)
    if (!turn) return { ok: false, reason: 'unsupported' }
    const admission = this.ledger.admit({ ...turn, utterance, source: 'audio' })
    if (admission.ok || admission.reason === 'duplicate') this.admitted.add(segmentId)
    return admission
  }

  /** Synthetic adapter jobs: cancelled and late completions cannot repopulate preview. */
  async runJob(work: (signal: AbortSignal) => Promise<unknown>): Promise<string> {
    if (!this.status().active) return 'inactive'
    if (this.jobs.size >= this.maxFrames) { this.reset('overload'); return 'overload' }
    const controller = new AbortController()
    const epoch = this.epoch
    this.jobs.add(controller)
    try {
      const result = await work(controller.signal)
      if (controller.signal.aborted || epoch !== this.epoch || !this.status().active) return 'cancelled'
      return this.receive(result)
    } catch {
      if (controller.signal.aborted || epoch !== this.epoch) return 'cancelled'
      this.reset('worker-error')
      return 'worker-error'
    } finally { this.jobs.delete(controller) }
  }
}
