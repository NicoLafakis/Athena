import { z } from 'zod'
import type { VoiceRouteResult, VoiceSession } from './types.js'

const SessionSchema = z.object({
  id: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
  lastActiveAt: z.string().datetime(),
}).strict()

export interface VoiceRouteRequest {
  explicitSessionId?: string
  foregroundHint?: { sessionId: string; proven: boolean }
}

export class VoiceSessionRouter {
  private readonly sessions: VoiceSession[]

  constructor(sessions: readonly VoiceSession[], private readonly ambiguityWindowMs = 5_000) {
    this.sessions = sessions.map((session) => SessionSchema.parse(session))
  }

  resolve(request: VoiceRouteRequest): VoiceRouteResult {
    if (this.sessions.length === 0) return { kind: 'unavailable', reason: 'no-sessions' }
    if (request.explicitSessionId) {
      if (this.sessions.some((session) => session.id === request.explicitSessionId)) {
        return { kind: 'selected', sessionId: request.explicitSessionId, reason: 'explicit' }
      }
      return {
        kind: 'clarification',
        candidates: this.byRecency().map((session) => session.id),
        reason: 'unknown-explicit',
      }
    }
    const hint = request.foregroundHint
    if (hint?.proven && this.sessions.some((session) => session.id === hint.sessionId)) {
      return { kind: 'selected', sessionId: hint.sessionId, reason: 'foreground' }
    }
    const sorted = this.byRecency()
    if (sorted.length === 1) return { kind: 'selected', sessionId: sorted[0]!.id, reason: 'recent' }
    const newest = Date.parse(sorted[0]!.lastActiveAt)
    const next = Date.parse(sorted[1]!.lastActiveAt)
    if (newest - next <= Math.max(0, this.ambiguityWindowMs)) {
      return { kind: 'clarification', candidates: sorted.map((session) => session.id), reason: 'ambiguous' }
    }
    return { kind: 'selected', sessionId: sorted[0]!.id, reason: 'recent' }
  }

  private byRecency(): VoiceSession[] {
    return this.sessions.slice().sort((left, right) =>
      Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt)
        || left.id.localeCompare(right.id),
    )
  }
}
