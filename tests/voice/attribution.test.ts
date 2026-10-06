import { describe, expect, it } from 'vitest'
import { AttributionEventSchema, AttributionPreview } from '../../src/voice/attribution.js'
import { AttributionConsent, AttributionPolicySchema, attributedTurn } from '../../src/voice/attribution-consent.js'

const fixture = (overrides = {}) => ({
  schemaVersion: 1, type: 'transcript.segment', eventId: 'evt-1', eventSeq: 1,
  captureSessionId: 'cap-1', harnessSessionId: 'session-1', streamEpoch: 0,
  emittedAt: '2026-10-06T12:00:00Z', modelRevision: 'synthetic', policyVersion: 'v1',
  segmentId: 'seg-1', revision: 1, startMs: 0, endMs: 1000, text: 'Inspect the tests.',
  state: 'final', speakers: [{ speakerId: 'spk-1', source: 'diarization' }],
  overlap: false, identity: { status: 'unknown', reason: 'not-enrolled' }, ...overrides,
})
const yes = { capture: true, cloudTransfer: true, transcriptPersistence: true, profileMatching: true }
function active(policy = {}) {
  const consent = new AttributionConsent(policy)
  consent.disclose(['person-1'])
  consent.consent('person-1', yes)
  expect(consent.start()).toBe(true)
  return consent
}

describe('synthetic attribution contracts', () => {
  it.each([
    { permissionId: 'permission-1' }, { text: 'x'.repeat(4097) }, { endMs: 0 },
    { startMs: Infinity }, { eventSeq: -1 }, { streamEpoch: 0.5 },
    { identity: { status: 'suggested', profileId: 'p', scoreType: 'probability', score: 1, calibrationVersion: 'v' } },
    { speakers: Array.from({ length: 9 }, (_, i) => ({ speakerId: `spk-${i}`, source: 'diarization' })) },
  ])('rejects malformed or authority-bearing input %j', patch => {
    expect(AttributionEventSchema.safeParse(fixture(patch)).success).toBe(false)
  })

  it('preserves unknown and overlap instead of assigning a clean identity', () => {
    expect(AttributionEventSchema.parse(fixture({ speakers: [] }))).toMatchObject({ speakers: [] })
    const speakers = [{ speakerId: 'a', source: 'diarization' }, { speakerId: 'b', source: 'diarization' }]
    expect(AttributionEventSchema.safeParse(fixture({ speakers })).success).toBe(false)
    expect(AttributionEventSchema.safeParse(fixture({ speakers, overlap: true })).success).toBe(true)
    expect(AttributionEventSchema.safeParse(fixture({ speakers, overlap: true,
      identity: { status: 'suggested', profileId: 'p', scoreType: 'cosine-similarity', score: 0.99, calibrationVersion: 'v' },
    })).success).toBe(false)
  })

  it('rejects duplicate labels', () => {
    const speaker = { speakerId: 'a', source: 'diarization' }
    expect(AttributionEventSchema.safeParse(fixture({ speakers: [speaker, speaker], overlap: true })).success).toBe(false)
  })

  it('applies revisions once, rejects stale or cross-session events, and protects snapshots', () => {
    const preview = new AttributionPreview('cap-1', 'session-1')
    expect(preview.apply(fixture({ state: 'partial' }))).toBe('applied')
    expect(preview.apply(fixture())).toBe('stale')
    expect(preview.apply(fixture({ eventSeq: 2, revision: 2 }))).toBe('applied')
    expect(preview.apply(fixture({ eventSeq: 3, revision: 3, state: 'partial' }))).toBe('stale')
    expect(preview.apply(fixture({ captureSessionId: 'another' }))).toBe('wrong-session')
    const view = preview.snapshot()
    view[0]!.text = 'Mutated'
    expect(preview.snapshot()[0]!.text).toBe('Inspect the tests.')
  })

  it('requires explicit gaps for resets and rejects old epoch replay', () => {
    const preview = new AttributionPreview('cap-1', 'session-1')
    preview.apply(fixture())
    expect(preview.apply(fixture({ eventSeq: 2, streamEpoch: 1 }))).toBe('epoch-gap-required')
    const envelope = { schemaVersion: 1, eventId: 'gap-1', captureSessionId: 'cap-1',
      harnessSessionId: 'session-1', emittedAt: '2026-10-06T12:00:00Z',
      modelRevision: 'synthetic', policyVersion: 'v1' }
    expect(preview.apply({ ...envelope, type: 'capture.gap', eventSeq: 2, streamEpoch: 1, reason: 'worker-restart' })).toBe('applied')
    expect(preview.snapshot()).toEqual([])
    expect(preview.apply(fixture({ eventSeq: 3 }))).toBe('stale')
    expect(preview.apply(fixture({ eventSeq: 3, streamEpoch: 1 }))).toBe('applied')
  })

  it('bounds preview growth and permits revisions at capacity', () => {
    const preview = new AttributionPreview('cap-1', 'session-1', 1)
    preview.apply(fixture())
    expect(preview.apply(fixture({ eventSeq: 2, segmentId: 'seg-2' }))).toBe('capacity')
    expect(preview.apply(fixture({ eventSeq: 3, revision: 2 }))).toBe('applied')
    expect(preview.snapshot()).toHaveLength(1)
    preview.clear()
    expect(preview.snapshot()).toEqual([])
  })
})

describe('consent and explicit admission', () => {
  it('uses provisional nonpersistent local defaults and rejects unspecified retention', () => {
    expect(new AttributionConsent().policy).toMatchObject({ mode: 'observation', processing: 'local',
      persistTranscript: false, matchProfiles: false, transcriptRetentionDays: null, profileExpiryDays: null })
    expect(AttributionPolicySchema.safeParse({ persistTranscript: true }).success).toBe(false)
    expect(AttributionPolicySchema.safeParse({ matchProfiles: true }).success).toBe(false)
  })

  it('needs affirmative consent from every disclosed participant', () => {
    const consent = new AttributionConsent()
    expect(consent.start()).toBe(false)
    consent.disclose(['a', 'b'])
    consent.consent('a', yes)
    expect(consent.start()).toBe(false)
    consent.consent('b', { ...yes, capture: false })
    expect(consent.start()).toBe(false)
    consent.consent('b', yes)
    expect(consent.start()).toBe(true)
  })

  it.each([
    [{ processing: 'cloud' }, 'cloudTransfer'],
    [{ persistTranscript: true, transcriptRetentionDays: 7 }, 'transcriptPersistence'],
    [{ matchProfiles: true, profileExpiryDays: 7 }, 'profileMatching'],
  ])('does not reuse capture consent for %j', (policy, purpose) => {
    const consent = new AttributionConsent(policy)
    consent.disclose(['a'])
    consent.consent('a', { ...yes, [purpose as string]: false })
    expect(consent.start()).toBe(false)
  })

  it('pauses immediately on joining/withdrawal and requires explicit restart', () => {
    const consent = active()
    consent.join('person-2')
    expect(consent.canProcess()).toBe(false)
    consent.consent('person-2', yes)
    expect(consent.canProcess()).toBe(false)
    expect(consent.start()).toBe(true)
    consent.withdraw('person-1')
    expect(consent.canProcess()).toBe(false)
    expect(consent.start()).toBe(false)
    consent.consent('person-1', yes)
    expect(consent.start()).toBe(true)
    consent.stop()
    expect(consent.start()).toBe(false)
    expect(() => consent.consent('person-1', yes)).toThrow()
  })

  it('revoking optional purpose also pauses active processing', () => {
    const consent = active({ processing: 'cloud' })
    consent.consent('person-1', { ...yes, cloudTransfer: false })
    expect(consent.status()).toBe('paused')
  })

  it('names never admit work automatically or reach submit_turn permission fields', () => {
    const consent = active()
    const named = fixture({ identity: { status: 'suggested', profileId: 'p', scoreType: 'cosine-similarity',
      score: 1, calibrationVersion: 'v' } })
    expect(attributedTurn(named, consent, false)).toBeNull()
    expect(attributedTurn(named, consent, true)).toEqual({ text: 'Inspect the tests.' })
    expect(attributedTurn(fixture({ state: 'partial' }), consent, true)).toBeNull()
    expect(attributedTurn(fixture({ overlap: true }), consent, true)).toBeNull()
    expect(attributedTurn(fixture({ speakers: [] }), consent, true)).toBeNull()
    consent.withdraw('person-1')
    expect(attributedTurn(named, consent, true)).toBeNull()
  })
})
