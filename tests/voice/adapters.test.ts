import { describe, expect, it, vi } from 'vitest'
import type { Announcement } from '../../src/interaction/types.js'
import {
  VoiceConfirmationGate,
  VoiceInputAdapter,
  resolveVoiceFunctionCall,
} from '../../src/voice/input.js'
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

describe('voice input safety', () => {
  it('turns recognized text into normal prompts/commands and recognition failure into no-op fallback', () => {
    const input = new VoiceInputAdapter()
    expect(input.accept({ ok: true, text: 'run the tests' })).toEqual({ kind: 'prompt', text: 'run the tests' })
    expect(input.accept({ ok: true, text: '/status' })).toEqual({ kind: 'command', text: '/status' })
    expect(input.accept({ ok: false })).toEqual({
      kind: 'fallback',
      message: 'Voice recognition failed. Continue by keyboard.',
    })
  })

  it('requires exact IDs and explicit confirmation for consequential voice calls', () => {
    expect(resolveVoiceFunctionCall(
      { name: 'approve', arguments: { permissionId: 'permission-1', confirmed: true } },
      { sessionIds: ['session-1'], pendingPermissionIds: ['permission-1'] },
    )).toEqual({ kind: 'rejected', reason: 'malformed-call' })
    const pending = resolveVoiceFunctionCall(
      { name: 'approve', arguments: { permissionId: 'permission-1' } },
      { sessionIds: ['session-1'], pendingPermissionIds: ['permission-1'] },
    )
    expect(pending).toMatchObject({ kind: 'confirmation-required', targetId: 'permission-1' })
    const gate = new VoiceConfirmationGate(() => 'confirmation-1')
    if (pending.kind !== 'confirmation-required') throw new Error('expected pending confirmation')
    const confirmation = gate.begin(pending)
    expect(confirmation).toMatchObject({
      id: 'confirmation-1',
      action: 'approve',
      targetId: 'permission-1',
    })
    expect(gate.confirm('confirmation-1', 'anything else')).toEqual({
      kind: 'rejected', reason: 'confirmation-declined',
    })
    const second = gate.begin(pending)
    expect(gate.confirm(second.id, 'confirm')).toEqual({
      kind: 'execute', action: 'approve', targetId: 'permission-1',
    })
    expect(gate.confirm(second.id, 'confirm')).toEqual({
      kind: 'rejected', reason: 'unknown-confirmation',
    })
    expect(resolveVoiceFunctionCall(
      { name: 'cancel', arguments: { sessionId: 'missing' } },
      { sessionIds: ['session-1'], pendingPermissionIds: [] },
    )).toMatchObject({ kind: 'rejected', reason: 'unknown-session' })
  })
})
