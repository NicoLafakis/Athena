import { createHash } from 'node:crypto'
import { plainBounded } from '../interaction/format.js'
import {
  VoiceTurnRecordSchema,
  type VoiceTurnRecord,
  type VoiceTurnSource,
} from './schemas.js'

export type VoiceTurnRefusal = 'duplicate' | 'busy'

export type VoiceTurnAdmission =
  | { ok: true; record: VoiceTurnRecord }
  | { ok: false; reason: VoiceTurnRefusal; record: VoiceTurnRecord }

export interface VoiceTurnRequest {
  /** Monotonic spoken or typed utterance this request came out of. */
  utterance: number
  source: VoiceTurnSource
  text: string
}

/** Same words, different spacing, casing, or trailing punctuation, are the same request. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:]+$/, '').trim()
}

/**
 * The in-memory voice turn ledger: the single place that decides whether a `submit_turn`
 * becomes a real harness run.
 *
 * The idempotency key is scoped to (utterance, submitted text), not to text alone, and the
 * scoping is the whole point. Two calls inside ONE utterance — a model that emits
 * `submit_turn` twice, or a tool call repeated after the function-call round trip — are the
 * same request and must run once. The same words spoken again ten minutes later are a new
 * request and must run again; deduplicating those would make Athena refuse to repeat work
 * on purpose.
 */
export class VoiceTurnLedger {
  private readonly records = new Map<string, VoiceTurnRecord>()
  private readonly order: string[] = []
  private readonly maxRecords: number

  constructor(maxRecords = 64) {
    this.maxRecords = Math.max(2, Math.round(maxRecords))
  }

  static idFor(utterance: number, text: string): string {
    const digest = createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16)
    return `voice-turn:${utterance}:${digest}`
  }

  /**
   * Admit a request, or refuse it with the record that already owns it. `duplicate` means
   * this exact request is already known; `busy` means a different one is still running,
   * which the harness itself would reject anyway — better to say so than to race it.
   */
  admit(request: VoiceTurnRequest): VoiceTurnAdmission {
    const text = plainBounded(request.text, 4_096)
    const id = VoiceTurnLedger.idFor(request.utterance, text)
    const existing = this.records.get(id)
    if (existing) return { ok: false, reason: 'duplicate', record: existing }
    const active = this.active()
    if (active) return { ok: false, reason: 'busy', record: active }
    const record = VoiceTurnRecordSchema.parse({ id, source: request.source, text, state: 'running' })
    this.records.set(id, record)
    this.order.push(id)
    this.prune()
    return { ok: true, record }
  }

  settle(id: string, state: 'completed' | 'failed', harnessSessionId?: string): void {
    const record = this.records.get(id)
    if (!record) return
    this.records.set(id, VoiceTurnRecordSchema.parse({
      ...record,
      state,
      ...(harnessSessionId ? { harnessSessionId } : {}),
    }))
  }

  /** Stamp the permission a running turn is gated on, so status and trace agree on it. */
  recordPermission(permissionId: string): void {
    const active = this.active()
    if (!active) return
    this.records.set(active.id, VoiceTurnRecordSchema.parse({ ...active, permissionId }))
  }

  active(): VoiceTurnRecord | undefined {
    for (const record of this.records.values()) {
      if (record.state === 'running') return record
    }
    return undefined
  }

  get(id: string): VoiceTurnRecord | undefined {
    return this.records.get(id)
  }

  private prune(): void {
    while (this.order.length > this.maxRecords) {
      const oldest = this.order.shift()
      if (oldest === undefined) return
      // A running turn is live state: evicting it would let a duplicate submission
      // through and double-run the harness, which is exactly what the ledger prevents.
      if (this.records.get(oldest)?.state === 'running') {
        this.order.unshift(oldest)
        return
      }
      this.records.delete(oldest)
    }
  }
}
