import { z } from 'zod'
import { AttributionEventSchema } from './attribution.js'
import { AttributionFrameSchema, AttributionSession, AttributionWorkerEventSchema } from './attribution-session.js'
import { AttributionWorkerWordSchema, workerWordToSegment } from './attribution-worker-messages.js'

/** A future subprocess adapter supplies this port. No process is launched here.
 * Completion releases the buffer; false means accepted, but wait for drain.
 */
export interface AttributionWorkerPort {
  write(bytes: Uint8Array, complete: (error?: Error) => void): boolean
  close(): void
}

export type IpcDiagnostic = 'waiting-worker' | 'connected' | 'closed' | 'invalid-output'
  | 'write-error' | 'deadline' | 'epoch-changed'

/** Strict NDJSON stdout; stderr must never be passed here or rendered as trusted notices. */
export class AttributionWorkerChannel {
  private buffered = Buffer.alloc(0)
  private pending: { bytes: Buffer; deadline: number } | null = null
  private blocked = false
  private ended = false
  private diagnostic: IpcDiagnostic = 'waiting-worker'
  private readonly epoch: number

  constructor(
    private readonly session: AttributionSession,
    private readonly port: AttributionWorkerPort,
    private readonly now: () => number = () => performance.now(),
    private readonly maxLineBytes = 262_144,
    private readonly writeDeadlineMs = 5_000,
  ) {
    z.number().int().min(1_024).max(262_144).parse(maxLineBytes)
    z.number().finite().min(1).max(60_000).parse(writeDeadlineMs)
    this.epoch = session.status().epoch
  }

  private terminate(reason: IpcDiagnostic, pause: boolean): void {
    if (this.ended) return
    this.ended = true
    this.diagnostic = reason
    this.buffered.fill(0)
    this.buffered = Buffer.alloc(0)
    this.pending?.bytes.fill(0)
    this.pending = null
    this.blocked = false
    // Consent revocation/cleanup must survive errors in an external port.
    if (pause) this.session.pause()
    try { this.port.close() } catch { /* Diagnostics remain canonical, not port prose. */ }
  }

  private current(): boolean {
    if (this.ended) return false
    if (this.session.status().epoch !== this.epoch) {
      this.terminate('epoch-changed', false)
      return false
    }
    if (this.pending && this.now() >= this.pending.deadline) {
      this.terminate('deadline', true)
      return false
    }
    return true
  }

  status(): { diagnostic: IpcDiagnostic; bufferedBytes: number; pendingWrite: boolean; blocked: boolean } {
    this.current()
    return { diagnostic: this.diagnostic, bufferedBytes: this.buffered.length,
      pendingWrite: this.pending !== null, blocked: this.blocked }
  }

  /** Host timer must call this even if neither side produces further traffic. */
  checkDeadline(): void { this.current() }

  /** Explicit host cleanup: call immediately on pause, withdrawal, stop or process exit. */
  close(): void { this.terminate('closed', true) }

  drain(): void { if (this.current()) this.blocked = false }

  receive(chunk: Uint8Array): string[] {
    if (!this.current()) return ['closed']
    // Bound both each callback and each unterminated line before allocation.
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > 65_536) {
      this.terminate('invalid-output', true)
      return ['invalid']
    }
    const results: string[] = []
    let start = 0
    for (let i = 0; i <= chunk.length; i++) {
      if (i < chunk.length && chunk[i] !== 10) continue
      const piece = chunk.subarray(start, i)
      if (this.buffered.length + piece.length > this.maxLineBytes) {
        this.terminate('invalid-output', true)
        return [...results, 'invalid']
      }
      const combined = Buffer.concat([this.buffered, piece])
      this.buffered.fill(0)
      this.buffered = combined
      if (i === chunk.length) break
      let input: unknown
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffered))
      } catch {
        this.terminate('invalid-output', true)
        return [...results, 'invalid']
      }
      this.buffered.fill(0)
      this.buffered = Buffer.alloc(0)
      const worker = AttributionWorkerEventSchema.safeParse(input)
      const event = AttributionEventSchema.safeParse(input)
      const word = AttributionWorkerWordSchema.safeParse(input)
      if (!worker.success && !event.success && !word.success) {
        this.terminate('invalid-output', true)
        return [...results, 'invalid']
      }
      const result = this.session.receive(worker.success ? worker.data
        : word.success ? workerWordToSegment(word.data) : event.data)
      results.push(result)
      if (result === 'ready') this.diagnostic = 'connected'
      if (!this.current()) return results
      start = i + 1
    }
    return results
  }

  /** At most one serialized frame is held. The owner bounds the unsent FIFO.
   * Never resend write(false): stream semantics say those bytes were accepted.
   */
  sendNext(): string {
    if (!this.current()) return 'closed'
    if (this.pending || this.blocked) return 'backpressure'
    if (!this.session.status().active) return 'inactive'
    const frame = this.session.takeFrame()
    if (!frame) return 'empty'
    const parsed = AttributionFrameSchema.safeParse(frame)
    if (!parsed.success) {
      frame.pcm.fill(0)
      this.terminate('write-error', true)
      return 'invalid'
    }
    const bytes = Buffer.from(`${JSON.stringify({ ...parsed.data,
      pcm: Buffer.from(parsed.data.pcm).toString('base64') })}\n`, 'utf8')
    frame.pcm.fill(0)
    const pending = { bytes, deadline: this.now() + this.writeDeadlineMs }
    this.pending = pending
    try {
      const writable = this.port.write(bytes, error => {
        bytes.fill(0)
        // Late callbacks cannot alter a replacement channel or a newer write.
        if (this.pending !== pending || !this.current()) return
        this.pending = null
        if (error) this.terminate('write-error', true)
      })
      if (!this.ended) this.blocked = !writable
    } catch { this.terminate('write-error', true) }
    return this.ended ? 'closed' : 'sent'
  }
}
