import { describe, expect, it } from 'vitest'
import { AttributionFrameSchema, AttributionSession, type SessionNotice } from '../../src/voice/attribution-session.js'
import { VoiceTurnLedger } from '../../src/voice/turns.js'

const yes = { capture: true, cloudTransfer: false, transcriptPersistence: false, profileMatching: false }
const envelope = (epoch: number, seq = 0) => ({
  schemaVersion: 1, eventId: `evt-${seq}`, eventSeq: seq, captureSessionId: 'cap-1',
  harnessSessionId: 'harness-1', streamEpoch: epoch, emittedAt: '2026-10-06T12:00:00Z',
  modelRevision: 'synthetic', policyVersion: 'v1',
})
const segment = (epoch: number, patch = {}) => ({
  ...envelope(epoch, 1), type: 'transcript.segment', segmentId: 'seg-1', revision: 1,
  startMs: 0, endMs: 1000, text: 'Inspect the tests.', state: 'final',
  speakers: [{ speakerId: 'spk-1', source: 'diarization' }], overlap: false,
  identity: { status: 'unknown', reason: 'not-enrolled' }, ...patch,
})
const frame = (epoch: number, patch = {}) => ({
  captureSessionId: 'cap-1', streamEpoch: epoch, frameSeq: 0, sampleStart: 0,
  sampleCount: 160, sampleRate: 16_000, channels: 1, format: 'pcm16le',
  pcm: new Uint8Array(320).fill(4), ...patch,
})
function setup(maxFrames = 8, notice: (code: SessionNotice) => void = () => {}) {
  const ledger = new VoiceTurnLedger()
  const session = new AttributionSession('cap-1', 'harness-1', ledger, {}, notice, maxFrames)
  session.disclose(['person-1'])
  session.setConsent('person-1', yes)
  expect(session.start()).toBe(true)
  const epoch = session.status().epoch
  expect(session.receive({ ...envelope(epoch), type: 'worker.ready' })).toBe('ready')
  return { session, ledger, epoch }
}
function restart(session: AttributionSession) {
  session.setConsent('person-1', yes)
  expect(session.start()).toBe(true)
  return session.receive({ ...envelope(session.status().epoch), type: 'worker.ready' })
}

describe('bounded synthetic frames', () => {
  it.each([
    { pcm: new Uint8Array(1) }, { pcm: new Uint8Array(96_001) }, { channels: 2 },
    { sampleCount: 16001, pcm: new Uint8Array(32002) }, { format: 'float32' },
    { sampleStart: Number.MAX_SAFE_INTEGER }, { path: 'secret.wav' }, { sampleRate: 8000 },
  ])('rejects malformed frame %j', patch => {
    expect(AttributionFrameSchema.safeParse(frame(1, patch)).success).toBe(false)
  })

  it('copies buffers, drains FIFO and rejects duplicate frames', () => {
    const { session, epoch } = setup()
    const input = frame(epoch)
    expect(session.pushFrame(input)).toBe('queued')
    input.pcm.fill(7)
    expect(session.pushFrame(input)).toBe('stale')
    expect(session.takeFrame()!.pcm[0]).toBe(4)
    expect(session.takeFrame()).toBeUndefined()
    expect(session.pushFrame(frame(epoch, { frameSeq: 1, sampleStart: 160 }))).toBe('queued')
  })

  it.each([
    { frameSeq: 2, sampleStart: 160 }, { frameSeq: 1, sampleStart: 161 },
    { frameSeq: 1, sampleStart: 160, sampleRate: 24000 },
  ])('resets on discontinuity %j', patch => {
    const { session, epoch } = setup()
    session.pushFrame(frame(epoch))
    session.receive(segment(epoch))
    expect(session.pushFrame(frame(epoch, patch))).toBe('gap')
    expect(session.status()).toMatchObject({ epoch: epoch + 1, active: false, queuedFrames: 0 })
    expect(session.snapshot()).toEqual([])
    expect(session.receive({ ...envelope(epoch, 2), type: 'worker.ready' })).toBe('stale')
    expect(session.receive({ ...envelope(epoch + 1), type: 'worker.ready' })).toBe('ready')
  })

  it('resets at queue capacity rather than retaining unbounded audio', () => {
    const notices: SessionNotice[] = []
    const { session, epoch } = setup(1, code => notices.push(code))
    expect(session.pushFrame(frame(epoch))).toBe('queued')
    expect(session.pushFrame(frame(epoch, { frameSeq: 1, sampleStart: 160 }))).toBe('overload')
    expect(session.status().queuedFrames).toBe(0)
    expect(notices).toContain('overload')
  })
})

describe('synthetic owning lifecycle and admission', () => {
  it('requires consent and actual adapter readiness before accepting events/frames', () => {
    const session = new AttributionSession('cap-1', 'harness-1', new VoiceTurnLedger())
    expect(session.start()).toBe(false)
    session.disclose(['person-1'])
    expect(session.receive({ ...envelope(1), type: 'worker.ready' })).toBe('inactive')
    session.setConsent('person-1', yes)
    session.start()
    expect(session.pushFrame(frame(1))).toBe('inactive')
    expect(session.receive(segment(1))).toBe('inactive')
    expect(session.receive({ ...envelope(1), type: 'worker.ready', available: true })).toBe('invalid')
  })

  it('withdrawal clears preview/queue, aborts work and discards late results across restart', async () => {
    const { session, epoch } = setup()
    session.pushFrame(frame(epoch))
    session.receive(segment(epoch))
    let finish!: (value: unknown) => void
    let signal!: AbortSignal
    const pending = session.runJob(s => { signal = s; return new Promise(resolve => { finish = resolve }) })
    session.withdraw('person-1')
    expect(signal.aborted).toBe(true)
    expect(session.snapshot()).toEqual([])
    expect(session.status()).toMatchObject({ active: false, queuedFrames: 0, pendingJobs: 1 })
    expect(restart(session)).toBe('ready')
    finish(segment(epoch, { eventSeq: 2, revision: 2 }))
    expect(await pending).toBe('cancelled')
    expect(session.snapshot()).toEqual([])
    expect(session.status().pendingJobs).toBe(0)
  })

  it('keeps noncooperative cancelled jobs counted against capacity', async () => {
    const { session } = setup(1)
    let finish!: (value: unknown) => void
    const pending = session.runJob(() => new Promise(resolve => { finish = resolve }))
    session.withdraw('person-1')
    restart(session)
    let launched = false
    expect(await session.runJob(async () => { launched = true; return null })).toBe('overload')
    expect(launched).toBe(false)
    finish(null)
    expect(await pending).toBe('cancelled')
  })

  it('pauses and resets on new arrivals and optional consent loss', () => {
    const { session, epoch } = setup()
    session.receive(segment(epoch))
    session.join('person-2')
    expect(session.snapshot()).toEqual([])
    expect(session.start()).toBe(false)
    session.setConsent('person-2', yes)
    restart(session)
    session.setConsent('person-1', { ...yes, capture: false })
    expect(session.status().active).toBe(false)
  })

  it('isolates session, epoch and monotonic sequence; resets on worker failure', () => {
    const { session, epoch } = setup()
    expect(session.receive(segment(epoch, { harnessSessionId: 'another' }))).toBe('wrong-session')
    expect(session.receive(segment(epoch))).toBe('applied')
    expect(session.receive(segment(epoch))).toBe('stale')
    expect(session.receive({ ...envelope(epoch, 2), type: 'worker.error', reason: 'unavailable' })).toBe('reset')
    expect(session.status()).toMatchObject({ active: false, epoch: epoch + 1 })
    expect(session.snapshot()).toEqual([])
  })

  it('admits only current explicit final segments through the existing ledger once', () => {
    const { session, ledger, epoch } = setup()
    session.receive(segment(epoch))
    expect(session.admit('seg-1', 1, 1, false)).toEqual({ ok: false, reason: 'not-explicit' })
    expect(session.admit('seg-1', 0, 1, true)).toEqual({ ok: false, reason: 'stale-segment' })
    const first = session.admit('seg-1', 1, 1, true)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('Expected admission')
    expect(first.record).toMatchObject({ text: 'Inspect the tests.', source: 'audio' })
    expect(first.record).not.toHaveProperty('profileId')
    ledger.settle(first.record.id, 'completed', 'harness-1')
    session.receive(segment(epoch, { eventSeq: 2, revision: 2, text: 'Changed text.' }))
    expect(session.admit('seg-1', 2, 2, true)).toEqual({ ok: false, reason: 'already-admitted' })
    session.receive(segment(epoch, { eventSeq: 3, segmentId: 'seg-2' }))
    expect(session.admit('seg-2', 1, 2, true).ok).toBe(true)
  })

  it.each([{ state: 'partial' }, { speakers: [] }, { overlap: true }])('refuses unsafe command attribution %j', patch => {
    const { session, epoch } = setup()
    session.receive(segment(epoch, patch))
    expect(session.admit('seg-1', 1, 1, true)).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('stop and presentation failure cannot preserve active capture state', () => {
    const { session, epoch } = setup(8, () => { throw new Error('Broken display') })
    session.pushFrame(frame(epoch))
    session.receive(segment(epoch))
    session.stop()
    expect(session.status()).toMatchObject({ active: false, queuedFrames: 0 })
    expect(session.snapshot()).toEqual([])
    expect(session.admit('seg-1', 1, 1, true)).toEqual({ ok: false, reason: 'inactive' })
    expect(() => session.disclose(['person-1'])).toThrow()
  })

  it('bounds preview and resets it at capacity', () => {
    const { session, epoch } = setup()
    for (let i = 1; i <= 128; i++) {
      expect(session.receive(segment(epoch, { eventSeq: i, segmentId: `seg-${i}` }))).toBe('applied')
    }
    expect(session.receive(segment(epoch, { eventSeq: 129, segmentId: 'overflow' }))).toBe('overload')
    expect(session.snapshot()).toEqual([])
  })

  it('does not enable storage, cloud transfer or profiles before their adapters exist', () => {
    expect(() => new AttributionSession('cap-1', 'harness-1', new VoiceTurnLedger(), { processing: 'cloud' })).toThrow()
    expect(() => new AttributionSession('cap-1', 'harness-1', new VoiceTurnLedger(), { persistTranscript: true, transcriptRetentionDays: 7 })).toThrow()
    const { session, epoch } = setup()
    expect(session.receive(segment(epoch, { identity: { status: 'suggested', profileId: 'p',
      scoreType: 'cosine-similarity', score: 1, calibrationVersion: 'v' } }))).toBe('profile-matching-disabled')
    expect(session.snapshot()).toEqual([])
  })
})
