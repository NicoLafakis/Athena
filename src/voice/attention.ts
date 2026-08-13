import type { AskUserFn } from '../engine/loop.js'
import type { PermissionAnswer } from '../engine/types.js'
import { plainBounded } from '../interaction/format.js'
import type { Announcement } from '../interaction/types.js'
import { permissionDiff, permissionDiffStats } from '../presentation/permission-diff.js'
import {
  createAccessiblePermissionRequest,
  formatSpokenPermission,
} from '../presentation/permission-format.js'
import type { AccessiblePermissionRequest } from '../presentation/types.js'
import { speechDecision, speechOwnershipReason, type SpeechOwnership } from './speech.js'
import { NULL_VOICE_TELEMETRY, type VoiceTelemetryRecorder } from './telemetry.js'

export type VoicePermissionAction = 'allow' | 'deny'

export type VoicePermissionRefusal =
  | 'none-pending'
  | 'stale'
  | 'unknown'
  | 'ambiguous'
  | 'same-turn'

export type VoicePermissionResolution =
  | { ok: true; id: string; action: VoicePermissionAction; answer: PermissionAnswer }
  | {
    ok: false
    reason: VoicePermissionRefusal
    clarification: string
    pendingIds: string[]
  }

export interface PendingVoicePermission {
  id: string
  summary: string
}

/**
 * A change in what is waiting on the user, for whatever model session is listening.
 *
 * This is CONTEXT, never authority. The canonical request is still spoken locally, and the
 * only path from a spoken answer to a harness answer is {@link VoiceAttentionBridge.resolve}
 * — a notice cannot grant, deny, or unblock anything. It exists because a model that is
 * never told a decision is outstanding has nothing to act on when the user answers, and
 * correctly refuses to invent an approval instead of reaching for the control tool.
 *
 * Every field is an ID or a closed literal except `summary`, which is bounded at the seam.
 */
export type VoicePermissionNotice =
  | { kind: 'pending'; id: string; summary: string }
  | { kind: 'resolved'; id: string; action: VoicePermissionAction }
  | { kind: 'refused'; reason: VoicePermissionRefusal }
  | { kind: 'shutdown'; id: string }

/** What the voice session hands back so semantic-plane text can reach the user. */
export interface VoiceAttentionSpeaker {
  /** Voice turn currently in flight; 0 before the first Realtime turn. */
  currentTurn(): number
  /** `spoken: false` means stable text only — something else already owns saying it. */
  present(item: { text: string; spoken: boolean }): void
  /**
   * Optional sink for {@link VoicePermissionNotice}. Optional because a speaker with no
   * model behind it has nothing to tell, and because losing a notice must never be able to
   * cost a permission: the request is spoken and answerable either way.
   */
  notify?(notice: VoicePermissionNotice): void
}

export interface VoiceAttentionBridgeOptions {
  cwd: string
  /**
   * Speech ownership relative to a screen reader. `athena voice` is itself an explicit
   * request for spoken output, so callers pass `supplemental` rather than the `off`
   * default of `accessibility.directSpeech`, which describes the TUI.
   */
  ownership?: SpeechOwnership
  screenReaderActive?: boolean
  /** Resolved permission IDs remembered so a repeat answer reads as stale, not unknown. */
  maxRemembered?: number
  /** Semantic-plane text buffered before the session attaches its speaker. */
  maxQueued?: number
  /**
   * Permission wait/resolution counters. The bridge is the only place that sees a wait
   * BEGIN — the daemon only ever sees the answer — so the seam has to be here.
   */
  telemetry?: VoiceTelemetryRecorder
}

interface PendingRecord {
  id: string
  request: AccessiblePermissionRequest
  spoken: string
  /** Voice turn in flight when this was announced; a same-turn answer is refused. */
  announcedAtTurn: number
  /** Recorder time the harness started waiting, for the resolution latency meter. */
  waitingSince: number
  resolve: (answer: PermissionAnswer) => void
}

const REFUSALS: Record<VoicePermissionRefusal, string> = {
  'none-pending': 'Nothing is waiting for a permission decision, so nothing was changed.',
  stale: 'That permission was already decided, so nothing was changed.',
  unknown: 'I do not have a pending permission with that identity, so nothing was changed.',
  ambiguous: 'More than one permission is waiting. Tell me which one. Nothing was changed.',
  'same-turn': 'I have only just asked for that permission. ' +
    'Say allow or deny again so I know you heard it. Nothing was changed.',
}

/**
 * The seam between the harness attention plane (canonical permission records and
 * `Announcement`s) and the spoken voice session.
 *
 * It exists as a separate object because of a construction order problem: the controller
 * needs `askUser` before it is created, and the speaker only exists once the voice
 * session is running. The bridge is created first, handed to both, and buffers anything
 * the semantic plane produces in between.
 *
 * It is also the single place that decides whether a spoken word authorizes anything.
 * Model-produced text never reaches it; only a locally validated control call does.
 */
export class VoiceAttentionBridge {
  private readonly cwd: string
  private readonly ownership: SpeechOwnership
  private readonly screenReaderActive: boolean
  private readonly maxRemembered: number
  private readonly maxQueued: number
  private readonly pending = new Map<string, PendingRecord>()
  private readonly resolved: string[] = []
  private readonly queued: Array<{ text: string; spoken: boolean }> = []
  private readonly meter: VoiceTelemetryRecorder
  private speaker: VoiceAttentionSpeaker | null = null
  private closed = false

  constructor(options: VoiceAttentionBridgeOptions) {
    this.cwd = options.cwd
    this.ownership = options.ownership ?? 'supplemental'
    this.screenReaderActive = options.screenReaderActive ?? false
    this.maxRemembered = Math.max(1, options.maxRemembered ?? 64)
    this.maxQueued = Math.max(1, options.maxQueued ?? 16)
    this.meter = options.telemetry ?? NULL_VOICE_TELEMETRY
  }

  /**
   * The `AskUserFn` handed to `HarnessSessionController`. Bound as a field so it can be
   * passed by value into the engine composition.
   */
  readonly askUser: AskUserFn = (request) => new Promise<PermissionAnswer>((resolve) => {
    if (this.closed) {
      resolve('deny')
      return
    }
    const diff = permissionDiff(request, this.cwd)
    const accessible = createAccessiblePermissionRequest({
      ...request,
      ...(diff ? { diff: permissionDiffStats(diff) } : {}),
    })
    const spoken = formatSpokenPermission(accessible)
    this.pending.set(accessible.id, {
      id: accessible.id,
      request: accessible,
      spoken,
      announcedAtTurn: this.speaker?.currentTurn() ?? 0,
      waitingSince: this.meter.now(),
      resolve,
    })
    // The identity only; the tool, the target, and the diff stay in the trace where the
    // real evidence lives. A counter that carried the summary would be a transcript.
    this.meter.record({ event: 'permission.wait', permissionId: accessible.id })
    // Spoken straight from the canonical record: routing a blocker through a model round
    // trip both delays it and lets a paraphrase change what the user thinks they allowed.
    // It is blocking, so it survives routine suppression; only an explicit `exclusive`
    // ownership hands it to the screen reader, which still gets it as stable text.
    this.emit(
      spoken,
      speechOwnershipReason('blocking', this.ownership, this.screenReaderActive)
        === 'direct-speech-owner',
    )
    // Said out loud above; told to the model here. Without this the session has no idea a
    // decision is outstanding, so a user answering "allow" reaches a model whose only
    // truthful reply is that it cannot approve anything — which is what it then says.
    this.notify({
      kind: 'pending',
      id: accessible.id,
      summary: plainBounded(accessible.summary, 256),
    })
  })

  /** The controller's `onAnnouncement` sink. */
  announce(announcement: Announcement): void {
    // The permission itself is spoken from its canonical record above; the plane's short
    // "Permission: ..." line would be the same blocker said twice, less usefully.
    if (announcement.category === 'permission') return
    const decision = speechDecision(announcement, this.ownership, this.screenReaderActive)
    const text = plainBounded(announcement.text, 1_024)
    if (!text) return
    // Marin already narrates the result of every turn. Speaking polite chatter on top of
    // that is noise rather than access, so it stays stable text for Braille and review.
    this.emit(text, decision.speak && announcement.priority !== 'polite')
  }

  attach(speaker: VoiceAttentionSpeaker): void {
    this.speaker = speaker
    for (const item of this.queued.splice(0)) speaker.present(item)
    // Notices are re-derived from live state rather than queued like text. A queue could
    // replay a decision that has since been made; the pending map cannot be stale.
    for (const record of this.pending.values()) {
      this.notify({
        kind: 'pending',
        id: record.id,
        summary: plainBounded(record.request.summary, 256),
      })
    }
  }

  detach(): void {
    this.speaker = null
  }

  /**
   * Shutdown denies every outstanding request. Leaving one unresolved parks the engine
   * on a decision nobody is left to give, and a silent hang is worse than a clean refusal.
   */
  close(): void {
    this.closed = true
    for (const record of [...this.pending.values()]) {
      this.pending.delete(record.id)
      this.remember(record.id)
      // Labelled `shutdown`, not `deny`: a decision nobody was left to give reads very
      // differently from one the user actually made.
      this.meter.record({
        event: 'permission.resolved',
        label: 'shutdown',
        permissionId: record.id,
        ms: this.meter.now() - record.waitingSince,
      })
      this.notify({ kind: 'shutdown', id: record.id })
      record.resolve('deny')
    }
    this.speaker = null
  }

  pendingIds(): string[] {
    return [...this.pending.keys()]
  }

  pendingPermissions(): PendingVoicePermission[] {
    return [...this.pending.values()].map((record) => ({
      id: record.id,
      summary: plainBounded(record.request.summary, 512),
    }))
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  /** The exact text last announced for a request, for a deterministic repeat. */
  spokenFor(id: string): string | undefined {
    return this.pending.get(id)?.spoken
  }

  /**
   * The only path from a spoken or typed answer to a harness permission answer.
   * `answeringTurn` is the voice turn the answer arrived on; anything announced on that
   * same turn is refused, because the user cannot have heard it before answering.
   */
  resolve(
    action: VoicePermissionAction,
    permissionId: string | undefined,
    answeringTurn: number,
  ): VoicePermissionResolution {
    const pendingIds = this.pendingIds()
    if (permissionId !== undefined) {
      const record = this.pending.get(permissionId)
      if (!record) {
        return this.refuse(this.resolved.includes(permissionId) ? 'stale' : 'unknown', pendingIds)
      }
      return this.settle(record, action, answeringTurn, pendingIds)
    }
    if (pendingIds.length === 0) return this.refuse('none-pending', pendingIds)
    if (pendingIds.length > 1) return this.refuse('ambiguous', pendingIds)
    return this.settle(this.pending.get(pendingIds[0]!)!, action, answeringTurn, pendingIds)
  }

  private settle(
    record: PendingRecord,
    action: VoicePermissionAction,
    answeringTurn: number,
    pendingIds: string[],
  ): VoicePermissionResolution {
    if (record.announcedAtTurn >= answeringTurn) return this.refuse('same-turn', pendingIds)
    // Voice grants exactly one action. `allow-always` widens the session gate for every
    // later tool call, and nothing in this contract distinguishes "yes to this" from "yes
    // to all of these", so voice never reaches it; the keyboard path still can.
    const answer: PermissionAnswer = action === 'allow' ? 'allow-once' : 'deny'
    this.pending.delete(record.id)
    this.remember(record.id)
    this.meter.record({
      event: 'permission.resolved',
      label: action,
      permissionId: record.id,
      ms: this.meter.now() - record.waitingSince,
    })
    this.notify({ kind: 'resolved', id: record.id, action })
    record.resolve(answer)
    return { ok: true, id: record.id, action, answer }
  }

  private refuse(reason: VoicePermissionRefusal, pendingIds: string[]): VoicePermissionResolution {
    // The refusal reason is already a closed union, so it is a counter label as it stands;
    // the clarification sentence it maps to is never persisted.
    this.meter.record({ event: 'permission.refused', label: reason })
    this.notify({ kind: 'refused', reason })
    return { ok: false, reason, clarification: REFUSALS[reason], pendingIds }
  }

  private remember(id: string): void {
    this.resolved.push(id)
    while (this.resolved.length > this.maxRemembered) this.resolved.shift()
  }

  /**
   * Never fatal, by construction. A notice is the least essential thing the bridge does:
   * the request has already been spoken from its canonical record, and the answer path does
   * not run through here, so a speaker that throws must cost a turn nothing.
   */
  private notify(notice: VoicePermissionNotice): void {
    try {
      this.speaker?.notify?.(notice)
    } catch {
      // Deliberately silent: the caller of askUser is a harness turn waiting on a decision,
      // and there is nothing it could usefully do about a model that missed a hint.
    }
  }

  private emit(text: string, spoken: boolean): void {
    const item = { text, spoken }
    if (this.speaker) {
      this.speaker.present(item)
      return
    }
    this.queued.push(item)
    while (this.queued.length > this.maxQueued) this.queued.shift()
  }
}

/**
 * Keyboard parity for a permission answer, without a model in the path (FR-006).
 *
 * A bare `allow` is only taken as an answer when something is actually waiting: with an
 * empty queue it is far more likely to be the first word of an ordinary request, and
 * letting it fall through costs nothing because the model path authorizes nothing either.
 */
export function parseVoicePermissionCommand(
  text: string,
  pendingIds: readonly string[],
): { action: VoicePermissionAction; permissionId?: string } | null {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const action = tokens[0]
  if (action !== 'allow' && action !== 'deny') return null
  if (tokens.length === 1) return pendingIds.length > 0 ? { action } : null
  if (tokens.length !== 2) return null
  const match = pendingIds.find((pending) => pending.toLowerCase() === tokens[1])
  return match ? { action, permissionId: match } : null
}
