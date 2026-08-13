import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { plainBounded } from '../interaction/format.js'
import { REALTIME_MODELS, sanitizeVoiceUsage, type RealtimeVoiceModel } from './realtime.js'
import type { VoiceTurnSource } from './schemas.js'

export const VOICE_TELEMETRY_SCHEMA_VERSION = 2

/**
 * Lifecycle events the voice ledger records. Closed on purpose: an event name is part of
 * the persisted record, so an open string here would be a place for text to arrive.
 *
 * These are cost and latency meters, NOT a second activity history. The hash-chained run
 * trace remains the evidence for what the harness did; nothing here may be read as a claim
 * that work happened.
 */
export const VOICE_EVENTS = [
  /** Command launch to the spoken/printed ready cue — the p95-under-3s budget. */
  'session.ready',
  'wake.accepted',
  'wake.rejected',
  'wake.restart',
  /** The wake listener exhausted its restart budget and gave up. */
  'wake.failed',
  'realtime.connect',
  'realtime.renewal',
  'realtime.lost',
  'turn.submitted',
  'turn.refused',
  /** End of user speech to the first thing Athena actually says — the p95-under-2.5s budget. */
  'turn.feedback',
  /** Harness work, measured separately from the feedback budget because it runs on after it. */
  'turn.completed',
  'turn.failed',
  'permission.wait',
  'permission.resolved',
  'permission.refused',
  'playback.spoken',
  'playback.failed',
  'provider.usage',
  /** A record this ledger refused to persist. Bounding must never look like coverage. */
  'ledger.dropped',
] as const

export type VoiceEventName = (typeof VOICE_EVENTS)[number]

/**
 * Every label any event may carry, as one closed set. A counter is a number and a bounded
 * enum label, nothing else — so the label vocabulary is fixed here rather than assembled
 * by callers, where a summary or a transcript fragment could slip in.
 *
 * Grouped by the events that use them:
 * - `wake.accepted`: how the utterance was released by the local gate.
 * - `wake.rejected`: why post-wake audio never left the machine.
 * - `wake.restart` / `wake.failed`: what the supervised listener died of.
 * - `realtime.connect` / `realtime.lost`: which session episode this was.
 * - `turn.refused`: why `submit_turn` ran nothing.
 * - `permission.*`: the decision, or the canonical refusal reason.
 * - `playback.*`: which output path spoke, or failed to.
 * - `ledger.dropped`: why this ledger lost a record.
 */
export const VOICE_EVENT_LABELS = [
  // wake.accepted
  'wake-phrase', 'wake-word', 'capture-window',
  // wake.rejected
  'low-confidence', 'ambient', 'malformed-audio',
  // wake.restart / wake.failed
  'crash', 'not-ready',
  // realtime.connect / realtime.lost
  'initial', 'recovery', 'recovered', 'unrecoverable',
  // turn.refused
  'duplicate', 'busy', 'malformed', 'no-controller',
  // permission.resolved / permission.refused
  'allow', 'deny', 'shutdown',
  'none-pending', 'stale', 'unknown', 'ambiguous', 'same-turn',
  // playback.spoken / playback.failed
  'realtime-audio', 'local-speech',
  // ledger.dropped
  'invalid-record', 'write-failed',
] as const

export type VoiceEventLabel = (typeof VOICE_EVENT_LABELS)[number]

/**
 * Provider usage, after {@link sanitizeVoiceUsage}: numbers, and containers of numbers.
 * The schema is not belt-and-braces decoration — it is the assertion that makes "no
 * transcript reached the ledger" checkable rather than remembered.
 */
export type VoiceMeters = number | VoiceMeters[] | { [key: string]: VoiceMeters }

export const VoiceMetersSchema: z.ZodType<VoiceMeters> = z.lazy(() => z.union([
  z.number().finite(),
  z.array(VoiceMetersSchema),
  z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), VoiceMetersSchema),
]))

/**
 * ID shapes, pinned to their generators rather than to a permissive "looks like an ID"
 * pattern. This is the structural half of the privacy rule: a transcript, an absolute path,
 * or an API key cannot satisfy any of them, so there is no string field on the record that
 * a caller could smuggle content through even by mistake.
 *
 * `tests/voice/telemetry.test.ts` and `tests/voice/integration.test.ts` assert the real
 * generators still satisfy these, so tightening the ID format breaks a test instead of
 * silently dropping every record.
 */
const VoiceTurnIdSchema = z.string().regex(/^voice-turn:\d{1,12}:[0-9a-f]{16}$/)
const PermissionIdSchema = z.string().regex(/^permission:[A-Za-z0-9._-]{1,120}$/)
const HarnessSessionIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}$/)
const RunIdSchema = z.string().uuid()

/**
 * One persisted ledger line.
 *
 * There is deliberately NO free-text field on this object. Every value is a literal, a
 * closed enum, a bounded integer, a generator-shaped ID, or a numbers-only meters tree —
 * and `.strict()` means an unexpected key fails the whole record rather than riding along.
 */
export const VoiceTelemetryRecordSchema = z.object({
  schemaVersion: z.literal(VOICE_TELEMETRY_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  model: z.enum(REALTIME_MODELS),
  event: z.enum(VOICE_EVENTS),
  label: z.enum(VOICE_EVENT_LABELS).optional(),
  source: z.enum(['audio', 'keyboard']).optional(),
  voiceTurnId: VoiceTurnIdSchema.optional(),
  permissionId: PermissionIdSchema.optional(),
  harnessSessionId: HarnessSessionIdSchema.optional(),
  runId: RunIdSchema.optional(),
  /** Latency in milliseconds, bounded at one day so a broken clock cannot write nonsense. */
  ms: z.number().int().nonnegative().max(86_400_000).optional(),
  meters: VoiceMetersSchema.optional(),
}).strict()

export type VoiceTelemetryRecord = z.infer<typeof VoiceTelemetryRecordSchema>

/** What a caller may ask to be recorded; timestamp, model, and version are filled in here. */
export interface VoiceTelemetryEvent {
  event: VoiceEventName
  label?: VoiceEventLabel
  source?: VoiceTurnSource
  voiceTurnId?: string
  permissionId?: string
  harnessSessionId?: string
  runId?: string
  ms?: number
  /** Raw provider usage; sanitized to numbers before it can reach the record. */
  meters?: unknown
}

/**
 * The seam the voice stack instruments against. Kept to three members so a test double is
 * three lines, and so telemetry can never be the thing that ends a session: a recorder is
 * only ever asked to swallow numbers.
 */
export interface VoiceTelemetryRecorder {
  record(event: VoiceTelemetryEvent): void
  /** The recorder's clock, so latency measurement has one seam instead of many. */
  now(): number
  /** Milliseconds since this process started — the ready-cue budget's own measure. */
  sinceLaunch(): number
}

/** The no-op recorder, so instrumented code never has to test for a missing sink. */
export const NULL_VOICE_TELEMETRY: VoiceTelemetryRecorder = {
  record: () => {},
  now: () => Date.now(),
  sinceLaunch: () => Math.max(0, Math.round(performance.now())),
}

export interface VoiceTelemetryOptions {
  model: RealtimeVoiceModel
  /** Appends one framed line. Throwing is expected and handled, never propagated. */
  write: (line: string) => void
  /** Stable text for a degraded ledger; voice itself is never interrupted for this. */
  onWarn?: (message: string) => void
  /** Artifact name used in warnings. Never an absolute path — that is a ledger value. */
  artifact?: string
  now?: () => number
  /** Epoch milliseconds of command launch; defaults to this process's own start. */
  launchedAt?: number
  /** Write failures tolerated before the ledger stops trying, and says so. */
  maxWriteFailures?: number
}

/**
 * The voice usage and lifecycle ledger.
 *
 * Two properties are load-bearing and neither is a convention callers have to remember.
 *
 * 1. Nothing but scalars can be persisted. Every candidate is parsed by
 *    {@link VoiceTelemetryRecordSchema} and only the PARSED object is serialized, so a
 *    transcript handed to an ID field, an extra key, or a string inside provider usage
 *    fails the record instead of being written.
 * 2. Telemetry cannot break voice. A failed, full, or locked file is caught, counted, and
 *    reported once in stable text; the session and the turn carry on regardless
 *    (AGENTS.md rule 2 — optional machinery is never fatal).
 *
 * Whatever it cannot persist it counts, because a bounded ledger that reads as full
 * coverage is worse than one that admits the gap.
 */
export class VoiceTelemetry implements VoiceTelemetryRecorder {
  private readonly model: RealtimeVoiceModel
  private readonly writeLine: (line: string) => void
  private readonly warn: (message: string) => void
  private readonly artifact: string
  private readonly clock: () => number
  private readonly launchedAt: number
  private readonly maxWriteFailures: number
  private readonly counts = new Map<string, number>()

  private writeFailures = 0
  private disabled = false
  /** Guards the drop record from re-entering the drop path and recursing. */
  private reporting = false

  constructor(options: VoiceTelemetryOptions) {
    this.model = options.model
    this.writeLine = options.write
    this.warn = options.onWarn ?? (() => {})
    this.artifact = options.artifact ?? 'voice-usage.jsonl'
    this.clock = options.now ?? (() => Date.now())
    this.launchedAt = options.launchedAt ?? performance.timeOrigin
    this.maxWriteFailures = Math.max(1, Math.round(options.maxWriteFailures ?? 3))
  }

  now(): number {
    return this.clock()
  }

  sinceLaunch(): number {
    return Math.max(0, Math.round(this.now() - this.launchedAt))
  }

  record(event: VoiceTelemetryEvent): void {
    const candidate: Record<string, unknown> = {
      schemaVersion: VOICE_TELEMETRY_SCHEMA_VERSION,
      timestamp: new Date(this.now()).toISOString(),
      model: this.model,
      ...event,
    }
    if (event.ms !== undefined) {
      candidate['ms'] = Number.isFinite(event.ms) ? Math.round(event.ms) : event.ms
    }
    if (event.meters !== undefined) {
      const meters = sanitizeVoiceUsage(event.meters)
      if (meters === undefined) delete candidate['meters']
      else candidate['meters'] = meters
    }
    const parsed = VoiceTelemetryRecordSchema.safeParse(candidate)
    if (!parsed.success) {
      this.drop('invalid-record')
      return
    }
    this.tally(parsed.data.event, parsed.data.label)
    this.emit(parsed.data)
  }

  /** Counts by event, and by event and label, for tests and for degraded-mode reporting. */
  counters(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
  }

  /** True once repeated write failures took the ledger offline for this session. */
  isDegraded(): boolean {
    return this.disabled
  }

  private drop(label: Extract<VoiceEventLabel, 'invalid-record' | 'write-failed'>): void {
    this.tally('ledger.dropped', label)
    if (this.reporting) return
    this.reporting = true
    try {
      // A drop must itself be visible on disk, and it is built here rather than round
      // tripped through record() so a broken caller cannot make the report unwritable too.
      this.emit(VoiceTelemetryRecordSchema.parse({
        schemaVersion: VOICE_TELEMETRY_SCHEMA_VERSION,
        timestamp: new Date(this.now()).toISOString(),
        model: this.model,
        event: 'ledger.dropped',
        label,
      }))
    } finally {
      this.reporting = false
    }
  }

  private tally(event: VoiceEventName, label?: VoiceEventLabel): void {
    this.counts.set(event, (this.counts.get(event) ?? 0) + 1)
    if (!label) return
    const key = `${event}/${label}`
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }

  private emit(record: VoiceTelemetryRecord): void {
    if (this.disabled) return
    try {
      this.writeLine(`${JSON.stringify(record)}\n`)
    } catch (error) {
      this.onWriteError(error)
    }
  }

  /**
   * A ledger that cannot be written is a degraded optional backend, not a session-ending
   * failure — so it names the artifact, the reason, and the recovery in one sentence and
   * then gets out of the way. Silence here would read as "no voice turns happened".
   */
  private onWriteError(error: unknown): void {
    this.writeFailures += 1
    if (this.writeFailures === 1) {
      this.warn(
        `Athena voice telemetry could not append to ${this.artifact}: ` +
        `${plainBounded((error as Error).message, 200)}. ` +
        'Voice is unaffected, but this session\'s cost and latency records are incomplete. ' +
        'Check free disk space and file permissions on your Athena home directory, ' +
        'then run `athena doctor`.',
      )
    }
    if (this.writeFailures < this.maxWriteFailures || this.disabled) return
    this.disabled = true
    this.tally('ledger.dropped', 'write-failed')
    this.warn(
      `Athena voice telemetry stopped after ${this.writeFailures} failed writes to ` +
      `${this.artifact}; the rest of this session is not recorded. Voice continues normally.`,
    )
  }
}
