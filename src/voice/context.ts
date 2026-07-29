import { plainBounded } from '../interaction/format.js'
import type { Announcement, InteractionSnapshot } from '../interaction/types.js'
import { VoiceContextSchema } from './schemas.js'
import type { VoiceContext } from './types.js'

export function buildVoiceContext(
  snapshot: InteractionSnapshot,
  latestAnnouncement?: Announcement,
): VoiceContext {
  const objective = snapshot.objective.value
    ? plainBounded(snapshot.objective.value, 1_024)
    : ''
  const outcome = snapshot.lastVerifiedOutcome.value
  return VoiceContextSchema.parse({
    schemaVersion: 1,
    runId: snapshot.runId,
    ...(objective ? { objective } : {}),
    phase: snapshot.phase.value,
    pendingAttention: snapshot.attention.slice(0, 8).map((item) => ({
      id: plainBounded(item.id, 256),
      priority: item.priority,
      summary: plainBounded(item.summary, 512),
    })),
    ...(outcome ? {
      lastVerifiedOutcome: {
        status: outcome.status,
        summary: plainBounded(outcome.summary, 512),
      },
    } : {}),
    ...(latestAnnouncement ? {
      latestAnnouncement: {
        id: plainBounded(latestAnnouncement.id, 256),
        priority: latestAnnouncement.priority,
        text: plainBounded(latestAnnouncement.text, 1_024),
      },
    } : {}),
  })
}
