import type { Announcement } from './types.js'

export interface AnnouncementRecord {
  announcement: Announcement
  occurrences: number
  lastSeenAt: string
  acknowledgedAt?: string
  resolvedAt?: string
}

export interface AnnouncementStoreOptions {
  maxCount?: number
  maxCharacters?: number
  dedupeWindowMs?: number
}

export class AnnouncementStore {
  private readonly items: AnnouncementRecord[] = []
  private readonly maxCount: number
  private readonly maxCharacters: number
  private readonly dedupeWindowMs: number

  constructor(options: AnnouncementStoreOptions = {}) {
    this.maxCount = options.maxCount ?? 50
    this.maxCharacters = options.maxCharacters ?? 32_768
    this.dedupeWindowMs = options.dedupeWindowMs ?? 30_000
  }

  add(announcement: Announcement): { record: AnnouncementRecord; coalesced: boolean } {
    const prior = [...this.items].reverse().find((record) =>
      record.announcement.dedupeKey === announcement.dedupeKey &&
      !record.acknowledgedAt &&
      !record.resolvedAt &&
      Math.abs(Date.parse(announcement.createdAt) - Date.parse(record.lastSeenAt)) <= this.dedupeWindowMs,
    )
    if (prior) {
      prior.occurrences += 1
      prior.lastSeenAt = announcement.createdAt
      return { record: prior, coalesced: true }
    }

    const record: AnnouncementRecord = {
      announcement,
      occurrences: 1,
      lastSeenAt: announcement.createdAt,
    }
    this.items.push(record)
    this.enforceBounds()
    return { record, coalesced: false }
  }

  acknowledge(id: string, timestamp = new Date().toISOString()): boolean {
    const record = this.items.find((item) => item.announcement.id === id)
    if (!record) return false
    record.acknowledgedAt = timestamp
    return true
  }

  resolve(id: string, timestamp = new Date().toISOString()): boolean {
    const record = this.items.find((item) => item.announcement.id === id)
    if (!record) return false
    record.resolvedAt = timestamp
    return true
  }

  latest(runId?: string): Announcement | undefined {
    if (!runId) return this.items.at(-1)?.announcement
    return [...this.items].reverse().find((record) => record.announcement.runId === runId)?.announcement
  }

  records(): readonly AnnouncementRecord[] {
    return this.items
  }

  unresolvedBlocking(runId?: string): readonly AnnouncementRecord[] {
    return this.items.filter((record) =>
      this.isUnresolvedBlocking(record) && (!runId || record.announcement.runId === runId),
    )
  }

  private isUnresolvedBlocking(record: AnnouncementRecord): boolean {
    return record.announcement.priority === 'blocking' &&
      record.announcement.requiresAcknowledgement &&
      !record.acknowledgedAt &&
      !record.resolvedAt
  }

  private characterCount(): number {
    return this.items.reduce((total, record) =>
      total + record.announcement.text.length + (record.announcement.detail?.length ?? 0), 0)
  }

  private enforceBounds(): void {
    while (this.items.length > this.maxCount || this.characterCount() > this.maxCharacters) {
      const evictable = this.items.findIndex((record) => !this.isUnresolvedBlocking(record))
      if (evictable < 0) return
      this.items.splice(evictable, 1)
    }
  }
}
