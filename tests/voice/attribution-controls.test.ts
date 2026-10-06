import { describe, expect, it } from 'vitest'
import { AttributionLocalControls, formatAttributionNotice } from '../../src/voice/attribution-controls.js'
import { AttributionSession } from '../../src/voice/attribution-session.js'
import { VoiceTurnLedger } from '../../src/voice/turns.js'

function setup() {
  const session = new AttributionSession('cap-1', 'harness-1', new VoiceTurnLedger())
  const controls = new AttributionLocalControls(session)
  controls.handle({ action: 'disclose', participantIds: ['person-1'] })
  controls.handle({ action: 'consent', participantId: 'person-1', consent: {
    capture: true, cloudTransfer: false, transcriptPersistence: false, profileMatching: false,
  } })
  controls.handle({ action: 'start' })
  const epoch = session.status().epoch
  const envelope = { schemaVersion: 1, eventId: 'evt-1', eventSeq: 0, captureSessionId: 'cap-1',
    harnessSessionId: 'harness-1', streamEpoch: epoch, emittedAt: '2026-10-06T12:00:00Z', modelRevision: 'synthetic', policyVersion: 'v1' }
  session.receive({ ...envelope, type: 'worker.ready' })
  const event = { ...envelope, eventSeq: 1, type: 'transcript.segment', segmentId: 'seg-1', revision: 1,
    startMs: 0, endMs: 1000, text: 'Inspect the tests.', state: 'final',
    speakers: [{ speakerId: 'spk-1', source: 'diarization' }], overlap: false,
    identity: { status: 'unknown', reason: 'not-enrolled' } }
  return { controls, session, event }
}

describe('accessible local attribution controls', () => {
  it('returns stable text usable for speech/Braille without visual-only state', () => {
    expect(formatAttributionNotice('consent-paused')).toContain('Queued audio and preview were cleared')
    const { controls } = setup()
    expect(controls.handle({ action: 'status' }).lines[0]).toContain('Attribution active')
    expect(controls.handle({ action: 'review' }).lines).toEqual(['No attributed transcript is available.'])
  })

  it('pause clears preview, preserves consent and requires explicit restart plus fresh readiness', () => {
    const { controls, session, event } = setup()
    session.receive(event)
    expect(controls.handle({ action: 'pause' }).lines[0]).toContain('Restart is explicit')
    expect(session.snapshot()).toEqual([])
    expect(session.status().active).toBe(false)
    expect(controls.handle({ action: 'start' }).lines[0]).toContain('waiting for its worker')
    expect(session.status().active).toBe(false)
    expect(controls.handle({ action: 'stop' }).lines[0]).toContain('Attribution stopped')
    expect(controls.handle({ action: 'start' }).lines[0]).toContain('cannot start')
  })

  it('unknown and overlapping attribution remain explicit in text review', () => {
    const { controls, session, event } = setup()
    session.receive({ ...event, speakers: [] })
    expect(controls.handle({ action: 'review' }).lines[0]).toContain('Unknown speaker')
    session.receive({ ...event, eventSeq: 2, revision: 2, overlap: true,
      speakers: [{ speakerId: 'a', source: 'diarization' }, { speakerId: 'b', source: 'diarization' }] })
    expect(controls.handle({ action: 'review' }).lines[0]).toContain('Overlapping speakers a, b')
  })

  it('strips terminal controls and secrets from display', () => {
    const { controls, session, event } = setup()
    session.receive({ ...event, text: '\u001b[31mHello\u001b[0m\nworld' })
    const line = controls.handle({ action: 'review' }).lines[0]!
    expect(line).toContain('Hello world')
    expect(line).not.toContain('\u001b')
  })

  it('local explicit submission is the only control producing ledger admission', () => {
    const { controls, session, event } = setup()
    session.receive(event)
    expect(controls.handle({ action: 'review' })).not.toHaveProperty('admission')
    const response = controls.handle({ action: 'submit', segmentId: 'seg-1', revision: 1, utterance: 1 })
    expect(response.admission?.ok).toBe(true)
    expect(response.lines[0]).toContain('Harness execution is the host')
    expect(controls.handle({ action: 'submit', segmentId: 'seg-1', revision: 1, utterance: 2 }).admission)
      .toEqual({ ok: false, reason: 'already-admitted' })
  })

  it.each([
    { action: 'allow', permissionId: 'permission-1' },
    { action: 'consent', participantId: 'person-1', consent: { capture: true } },
    { action: 'stop', permissionId: 'permission-1' },
    { action: 'submit', segmentId: 'seg-1', revision: 1, utterance: 1, profileId: 'p' },
  ])('rejects malformed/authority-bearing controls %j without state change', input => {
    const { controls, session } = setup()
    const before = session.status()
    expect(controls.handle(input).lines).toEqual(['Invalid attribution control. Nothing changed.'])
    expect(session.status()).toEqual(before)
  })

  it('refuses unknown participant consent without echoing untrusted exception text', () => {
    const { controls } = setup()
    const response = controls.handle({ action: 'withdraw', participantId: 'untrusted-participant' })
    expect(response.lines[0]).toBe('Attribution control refused. Check participant disclosure and session state.')
  })
})
