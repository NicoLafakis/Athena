import { lstatSync } from 'node:fs'
import type { SemanticMemoryRecord } from './schemas.js'
import { ContinuityStore } from './store.js'
import { listAllProjectSessions, readSessionLineRecords, sessionLineDigest, stableSessionLineId } from './session-catalog.js'

/** Confirm that every session-backed semantic citation still names its exact local source. */
export function semanticSourcesAvailable(
  memory: Pick<SemanticMemoryRecord, 'sourceRefs'>,
  sessionsRoot: string,
  continuityRoot: string,
): 'available' | 'unavailable' | 'tombstone-corrupt' {
  const hasSessionSources = memory.sourceRefs.some(
    (source) => source.kind === 'session-message' || source.kind === 'session-event',
  )
  const suppression = hasSessionSources
    ? new ContinuityStore(continuityRoot).sessionSuppressionSnapshot()
    : null
  if (suppression?.state === 'corrupt') return 'tombstone-corrupt'

  let sessions: Map<string, ReturnType<typeof listAllProjectSessions>[number]>
  try {
    sessions = new Map(listAllProjectSessions(sessionsRoot)
      .map((source) => [`${source.projectId}\0${source.sessionId}`, source]))
  } catch {
    return 'unavailable'
  }
  const checkedSessions = new Map<string, ReturnType<typeof readSessionLineRecords> | null>()
  for (const sourceRef of memory.sourceRefs) {
    if (sourceRef.kind !== 'session-message' && sourceRef.kind !== 'session-event') continue
    if (!sourceRef.projectId || !sourceRef.sessionId) return 'unavailable'
    const key = `${sourceRef.projectId}\0${sourceRef.sessionId}`
    if (suppression?.sessionKeys.has(key)) return 'unavailable'
    const source = sessions.get(key)
    if (!source) return 'unavailable'
    if (!checkedSessions.has(key)) {
      try {
        const metadata = lstatSync(source.file)
        checkedSessions.set(key, metadata.isFile() && !metadata.isSymbolicLink()
          ? readSessionLineRecords(source.file)
          : null)
      } catch {
        checkedSessions.set(key, null)
      }
    }
    const records = checkedSessions.get(key)
    const record = records?.find((item) => stableSessionLineId(item) === sourceRef.recordId)
    if (!record || record.line.ts !== sourceRef.timestamp) return 'unavailable'
    if (sourceRef.lineDigest) {
      if (sessionLineDigest(record) !== sourceRef.lineDigest) return 'unavailable'
    } else if (typeof record.line.id === 'string' && record.line.id.length > 0) {
      // UUID-backed legacy refs cannot prove the line's content. ID-less legacy
      // refs already embed the raw-line digest in stableSessionLineId().
      return 'unavailable'
    }
    if (sourceRef.kind === 'session-event' && record.line.kind !== 'event') return 'unavailable'
    if (sourceRef.kind === 'session-message') {
      if (record.line.kind !== 'message' || typeof record.line.data !== 'object' || record.line.data === null) return 'unavailable'
      const message = record.line.data as { role?: unknown; content?: unknown }
      if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.trim()) return 'unavailable'
    }
  }
  return 'available'
}
