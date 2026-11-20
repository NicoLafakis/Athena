import { describe, expect, it, vi } from 'vitest'
import type { Announcement } from '../../src/interaction/types.js'
import { VoiceSpeechOutput, speechDecision } from '../../src/voice/speech.js'

function announcement(priority: Announcement['priority']): Announcement {
  return {
    schemaVersion: 1,
    id: `announcement-${priority}`,
    runId: 'run-1',
    priority,
    category: 'test',
    text: `${priority}: material update`,
    dedupeKey: priority,
    requiresAcknowledgement: priority === 'blocking',
    provenance: [{ source: 'runtime', runId: 'run-1', sequence: 1, sourceEventType: 'test' }],
    createdAt: '2026-07-29T12:00:00.000Z',
  }
}

describe('voice speech ownership', () => {
  it('avoids routine double speech and keeps direct output removable', () => {
    expect(speechDecision(announcement('polite'), 'off', false).speak).toBe(false)
    expect(speechDecision(announcement('assertive'), 'exclusive', true).speak).toBe(false)
    expect(speechDecision(announcement('polite'), 'supplemental', true).speak).toBe(false)
    expect(speechDecision(announcement('blocking'), 'supplemental', true).speak).toBe(true)
    expect(speechDecision(announcement('polite'), 'exclusive', false).speak).toBe(true)

    const speak = vi.fn()
    const output = new VoiceSpeechOutput({ ownership: 'off', screenReaderActive: false, speak })
    output.announce(announcement('blocking'))
    expect(speak).not.toHaveBeenCalled()
  })
})
