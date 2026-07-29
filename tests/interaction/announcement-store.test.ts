import { describe, expect, it } from 'vitest'
import { AnnouncementStore } from '../../src/interaction/announcement-store.js'
import type { Announcement } from '../../src/interaction/types.js'

function announcement(
  id: string,
  priority: Announcement['priority'],
  dedupeKey = id,
  text = `Message ${id}`,
): Announcement {
  return {
    schemaVersion: 1,
    id,
    runId: 'run-1',
    priority,
    category: 'test',
    text,
    dedupeKey,
    requiresAcknowledgement: priority === 'blocking',
    provenance: [{
      source: 'runtime',
      runId: 'run-1',
      sequence: Number(id.replace(/\D/g, '')) || 1,
      sourceEventType: 'test',
    }],
    createdAt: `2026-07-29T12:00:0${Number(id.replace(/\D/g, '')) || 0}.000Z`,
  }
}

describe('AnnouncementStore', () => {
  it('coalesces equivalent announcements inside the window while retaining the changed count', () => {
    const store = new AnnouncementStore({ dedupeWindowMs: 30_000 })
    expect(store.add(announcement('a1', 'assertive', 'same')).coalesced).toBe(false)
    const second = store.add({
      ...announcement('a2', 'assertive', 'same'),
      createdAt: '2026-07-29T12:00:10.000Z',
    })

    expect(second.coalesced).toBe(true)
    expect(second.record.occurrences).toBe(2)
    expect(store.records()).toHaveLength(1)
    expect(store.latest()?.id).toBe('a1')
  })

  it('does not coalesce after the window', () => {
    const store = new AnnouncementStore({ dedupeWindowMs: 1_000 })
    store.add(announcement('a1', 'polite', 'same'))
    store.add({ ...announcement('a2', 'polite', 'same'), createdAt: '2026-07-29T12:00:03.000Z' })
    expect(store.records()).toHaveLength(2)
  })

  it('never evicts unresolved blocking announcements to satisfy ordinary bounds', () => {
    const store = new AnnouncementStore({ maxCount: 2, maxCharacters: 1_000 })
    store.add(announcement('b1', 'blocking'))
    store.add(announcement('p2', 'polite'))
    store.add(announcement('p3', 'polite'))

    expect(store.records().map((record) => record.announcement.id)).toEqual(['b1', 'p3'])
    expect(store.unresolvedBlocking().map((record) => record.announcement.id)).toEqual(['b1'])
  })

  it('allows acknowledged blocking announcements to age out', () => {
    const store = new AnnouncementStore({ maxCount: 1, maxCharacters: 1_000 })
    store.add(announcement('b1', 'blocking'))
    expect(store.acknowledge('b1', '2026-07-29T12:00:01.000Z')).toBe(true)
    store.add(announcement('p2', 'polite'))
    expect(store.records().map((record) => record.announcement.id)).toEqual(['p2'])
  })

  it('retains multiple unresolved blockers even when they exceed the soft count limit', () => {
    const store = new AnnouncementStore({ maxCount: 1, maxCharacters: 1 })
    store.add(announcement('b1', 'blocking'))
    store.add(announcement('b2', 'blocking'))
    expect(store.records()).toHaveLength(2)
  })

  it('enforces the character budget for nonblocking history', () => {
    const store = new AnnouncementStore({ maxCount: 10, maxCharacters: 20 })
    store.add(announcement('p1', 'polite', 'p1', '123456789012345'))
    store.add(announcement('p2', 'polite', 'p2', 'abcdefghijklmno'))
    expect(store.records().map((record) => record.announcement.id)).toEqual(['p2'])
  })
})
