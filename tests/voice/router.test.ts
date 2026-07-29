import { describe, expect, it } from 'vitest'
import { VoiceSessionRouter } from '../../src/voice/session-router.js'

const sessions = [
  { id: 'older', lastActiveAt: '2026-07-29T11:00:00.000Z' },
  { id: 'newer', lastActiveAt: '2026-07-29T12:00:00.000Z' },
]

describe('VoiceSessionRouter', () => {
  it('uses explicit selection, then proven foreground hint, then unambiguous recency', () => {
    const router = new VoiceSessionRouter(sessions)
    expect(router.resolve({ explicitSessionId: 'older' })).toEqual({ kind: 'selected', sessionId: 'older', reason: 'explicit' })
    expect(router.resolve({ foregroundHint: { sessionId: 'older', proven: true } })).toEqual({
      kind: 'selected', sessionId: 'older', reason: 'foreground',
    })
    expect(router.resolve({})).toEqual({ kind: 'selected', sessionId: 'newer', reason: 'recent' })
  })

  it('requests audible clarification rather than guessing across ambiguous or invalid sessions', () => {
    const router = new VoiceSessionRouter([
      { id: 'one', lastActiveAt: '2026-07-29T12:00:00.000Z' },
      { id: 'two', lastActiveAt: '2026-07-29T12:00:03.000Z' },
    ])
    expect(router.resolve({})).toMatchObject({ kind: 'clarification', candidates: ['two', 'one'] })
    expect(router.resolve({ explicitSessionId: 'missing' })).toMatchObject({ kind: 'clarification' })
    expect(new VoiceSessionRouter([]).resolve({})).toEqual({ kind: 'unavailable', reason: 'no-sessions' })
  })
})
