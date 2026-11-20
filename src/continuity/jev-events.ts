import { JevSpeechActEventSchema, type SpeechAct } from './schemas.js'
import { sessionLineDigest, stableSessionLineId } from '../harness/sessions.js'
import type { SessionLineRecord } from '../harness/sessions.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUserMessage(record: SessionLineRecord): boolean {
  if (record.line.kind !== 'message' || !isRecord(record.line.data)) return false
  const message = record.line.data
  if (message.role !== 'user') return false
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return Array.isArray(message.content) && message.content.length > 0 &&
    message.content.every((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ) && message.content.some((block) => isRecord(block) && typeof block.text === 'string' && block.text.trim().length > 0)
}

/** Resolve only persisted Jev labels whose event and exact user-message source are present. */
export function jevSpeechActsByUserMessage(
  records: SessionLineRecord[],
  projectId: string,
  sessionId: string,
): Map<string, SpeechAct> {
  const messages = new Map<string, SessionLineRecord>(
    records.filter(isUserMessage).map((record) => [stableSessionLineId(record), record] as const),
  )
  const acts = new Map<string, SpeechAct>()
  const conflicts = new Set<string>()

  for (const record of records) {
    if (record.line.kind !== 'event') continue
    const parsed = JevSpeechActEventSchema.safeParse(record.line.data)
    if (!parsed.success) continue
    const { sourceRef, speechAct } = parsed.data
    if (sourceRef.projectId !== projectId || sourceRef.sessionId !== sessionId) continue
    const message = messages.get(sourceRef.recordId)
    if (
      !message ||
      sourceRef.timestamp !== message.line.ts ||
      sourceRef.lineDigest !== sessionLineDigest(message)
    ) continue
    if (conflicts.has(sourceRef.recordId)) continue
    const previous = acts.get(sourceRef.recordId)
    if (previous && previous !== speechAct) {
      acts.delete(sourceRef.recordId)
      conflicts.add(sourceRef.recordId)
      continue
    }
    acts.set(sourceRef.recordId, speechAct)
  }

  return acts
}
