import { AnnouncementStore, type AnnouncementStoreOptions } from './announcement-store.js'
import { announcementFor, type InteractionVerbosity } from './announcements.js'
import { formatAnnouncementDetails, formatInteractionStatus } from './format.js'
import { createInteractionSnapshot, InteractionStateStore } from './state.js'
import type {
  Announcement,
  InteractionDiagnostic,
  InteractionEventEnvelope,
  InteractionSnapshot,
} from './types.js'

export interface InteractionServiceOptions {
  verbosity?: InteractionVerbosity
  announcementStore?: AnnouncementStoreOptions
  tracePath?: (runId: string) => string | undefined
  onAnnouncement?: (announcement: Announcement) => void
  onDiagnostic?: (diagnostic: InteractionDiagnostic) => void
}

export interface InteractionServiceResult {
  accepted: boolean
  snapshot: InteractionSnapshot
  diagnostic?: InteractionDiagnostic
  announcement?: Announcement
  coalesced?: boolean
  occurrences?: number
}

export class InteractionService {
  private verbosity: InteractionVerbosity
  private readonly state: InteractionStateStore
  private readonly announcements: AnnouncementStore
  private readonly attentionAnnouncements = new Map<string, string>()

  constructor(private readonly options: InteractionServiceOptions = {}) {
    this.verbosity = options.verbosity ?? 'balanced'
    this.state = new InteractionStateStore(options.onDiagnostic)
    this.announcements = new AnnouncementStore(options.announcementStore)
  }

  accept(event: InteractionEventEnvelope): InteractionServiceResult {
    const previous = this.state.get(event.runId) ?? createInteractionSnapshot(event.runId, event.timestamp)
    const reduction = this.state.accept(event)
    if (!reduction.accepted) return reduction

    if (event.kind === 'attention-resolved') {
      const key = `${event.runId}:${event.payload.attentionId}`
      const announcementId = this.attentionAnnouncements.get(key)
      if (announcementId) this.announcements.resolve(announcementId, event.timestamp)
      this.attentionAnnouncements.delete(key)
    }

    const announcement = announcementFor(event, previous, reduction.snapshot, {
      verbosity: this.verbosity,
    })
    if (!announcement) return reduction

    const stored = this.announcements.add(announcement)
    if (event.kind === 'attention-added') {
      this.attentionAnnouncements.set(
        `${event.runId}:${event.payload.attention.id}`,
        stored.record.announcement.id,
      )
    }
    if (!stored.coalesced) this.options.onAnnouncement?.(announcement)
    return {
      ...reduction,
      announcement,
      coalesced: stored.coalesced,
      occurrences: stored.record.occurrences,
    }
  }

  setVerbosity(verbosity: InteractionVerbosity): void {
    this.verbosity = verbosity
  }

  snapshot(runId: string): InteractionSnapshot | undefined {
    return this.state.get(runId)
  }

  status(runId: string): string {
    const snapshot = this.state.get(runId)
    return snapshot
      ? formatInteractionStatus(snapshot)
      : 'Status: no semantic state is available for this run.'
  }

  repeat(runId: string): string {
    return this.announcements.latest(runId)?.text ?? 'No material announcement is available. Use /status.'
  }

  /** The record behind `repeat`, for presenters that need its priority or provenance. */
  latestAnnouncement(runId: string): Announcement | undefined {
    return this.announcements.latest(runId)
  }

  details(runId: string): string {
    const announcement = this.announcements.latest(runId)
    return announcement
      ? formatAnnouncementDetails(announcement, this.options.tracePath?.(runId))
      : 'No material detail is available. Use /status.'
  }

  unresolvedBlocking(runId: string): readonly Announcement[] {
    return this.announcements.unresolvedBlocking(runId).map((record) => record.announcement)
  }

  acknowledge(announcementId: string, timestamp?: string): boolean {
    return this.announcements.acknowledge(announcementId, timestamp)
  }
}
