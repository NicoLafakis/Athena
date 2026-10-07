import { describe, expect, it, vi } from 'vitest'
import { AttributionSession } from '../../src/voice/attribution-session.js'
import { AttributionWorkerSupervisor, type AttributionProcess } from '../../src/voice/attribution-supervisor.js'
import { AttributionLocalHost } from '../../src/voice/attribution-host.js'
import { workerWordToSegment } from '../../src/voice/attribution-worker-messages.js'
import { VoiceTurnLedger } from '../../src/voice/turns.js'
import { ScreenReaderPresentation } from '../../src/presentation/screen-reader.js'

function fakeProcess(kill: () => Promise<void> = async () => {}) {
  let data: (chunk: Uint8Array) => void = () => {}
  let exit: () => void = () => {}
  const writes: Uint8Array[] = []
  const process: AttributionProcess = {
    port: { write(bytes, done) { writes.push(new Uint8Array(bytes)); done(); return true }, close: vi.fn() },
    onData(callback) { data = callback; return vi.fn() },
    onExit(callback) { exit = callback; return vi.fn() }, kill: vi.fn(kill),
  }
  return { process, writes, data: (input: unknown) => data(Buffer.from(`${JSON.stringify(input)}\n`)),
    bytes: (chunk: Uint8Array) => data(chunk), exit: () => exit() }
}
const yes = { capture: true, cloudTransfer: false, transcriptPersistence: false, profileMatching: false }
const envelope = (epoch: number, seq = 0) => ({ schemaVersion: 1, eventId: `e-${seq}`, eventSeq: seq,
  captureSessionId: 'cap', harnessSessionId: 'harness', streamEpoch: epoch,
  emittedAt: '2026-10-06T12:00:00Z', modelRevision: 'fake', policyVersion: 'v1' })
function setup(consented = true, kill?: () => Promise<void>) {
  const session = new AttributionSession('cap', 'harness', new VoiceTurnLedger())
  session.disclose(['p1'])
  if (consented) session.setConsent('p1', yes)
  const workers: ReturnType<typeof fakeProcess>[] = []
  const factory = vi.fn(() => { const fake = fakeProcess(kill); workers.push(fake); return fake.process })
  let time = 0
  const supervisor = new AttributionWorkerSupervisor(session, factory, () => time, 100, 200)
  return { session, supervisor, workers, factory, advance: (ms: number) => { time += ms },
    ready: () => workers.at(-1)!.data({ ...envelope(session.status().epoch), type: 'worker.ready' }) }
}
function word(epoch = 1, patch = {}) {
  return { ...envelope(epoch, 1), type: 'worker.word', segmentId: 'seg', revision: 1, state: 'final',
    alignment: { captureSessionId: 'cap', streamEpoch: epoch,
      words: [{ wordId: 'w1', text: 'hello', startMs: 10, endMs: 100 }],
      activity: [{ speakerId: 'spk1', source: 'diarization', startMs: 0, endMs: 150 }] }, ...patch }
}

describe('strict ASR/activity word messages', () => {
  it('aligns source times into a revisable preview event without identity', () => {
    expect(workerWordToSegment(word())).toMatchObject({ type: 'transcript.segment', text: 'hello',
      startMs: 10, endMs: 100, speakers: [{ speakerId: 'spk1', source: 'diarization' }],
      identity: { status: 'unknown', reason: 'attributed' } })
  })
  it('preserves unknown silence and simultaneous overlap', () => {
    const silence = word(); silence.alignment.activity = []
    expect(workerWordToSegment(silence)).toMatchObject({ speakers: [], overlap: false })
    const overlap = word(); overlap.alignment.activity.push({ speakerId: 'spk2', source: 'diarization', startMs: 0, endMs: 150 })
    expect(workerWordToSegment(overlap)).toMatchObject({ overlap: true })
  })
  it('rejects multiple words, mismatched scope and worker claims of participant tracks', () => {
    const multiple = word(); multiple.alignment.words.push({ wordId: 'w2', text: 'later', startMs: 101, endMs: 120 })
    expect(() => workerWordToSegment(multiple)).toThrow()
    const wrong = word(); wrong.alignment.streamEpoch++
    expect(() => workerWordToSegment(wrong)).toThrow()
    const track = word(); track.alignment.activity[0]!.source = 'track-metadata'
    expect(() => workerWordToSegment(track)).toThrow()
    expect(() => workerWordToSegment(word(1, { action: 'consent' }))).toThrow()
  })
})

describe('fake-process worker supervision', () => {
  it('never launches a worker without participant consent', () => {
    const { supervisor, factory } = setup(false)
    expect(supervisor.start()).toBe(false)
    expect(factory).not.toHaveBeenCalled()
  })
  it('receives words through real NDJSON and keeps one active worker', () => {
    const { supervisor, ready, workers, session, factory } = setup()
    expect(supervisor.start()).toBe(true); ready()
    workers[0]!.data(word(session.status().epoch))
    expect(session.snapshot()[0]).toMatchObject({ text: 'hello' })
    expect(supervisor.start()).toBe(true)
    expect(factory).toHaveBeenCalledOnce()
    expect(supervisor.status().diagnostic).toBe('connected')
  })
  it('pumps a synthetic source frame but admits an observation only on explicit operator request', () => {
    const { supervisor, ready, workers, session } = setup()
    supervisor.start(); ready()
    const epoch = session.status().epoch
    expect(session.pushFrame({ captureSessionId: 'cap', streamEpoch: epoch, frameSeq: 0,
      sampleStart: 0, sampleCount: 160, sampleRate: 16_000, channels: 1,
      format: 'pcm16le', pcm: new Uint8Array(320) })).toBe('queued')
    expect(supervisor.pump()).toBe('sent')
    expect(JSON.parse(Buffer.from(workers[0]!.writes[0]!).toString())).toMatchObject({ sampleStart: 0, sampleCount: 160 })
    workers[0]!.data(word(epoch))
    expect(session.admit('seg', 1, 1, false, { captureSessionId: 'cap', streamEpoch: epoch }))
      .toEqual({ ok: false, reason: 'not-explicit' })
    expect(session.admit('seg', 1, 1, true, { captureSessionId: 'cap', streamEpoch: epoch }).ok).toBe(true)
  })
  it.each(['startup', 'idle'])('expires %s deadline without automatic restart', mode => {
    const { supervisor, ready, advance, workers, session, factory } = setup()
    supervisor.start()
    if (mode === 'idle') ready()
    advance(mode === 'idle' ? 200 : 100); supervisor.tick()
    expect(supervisor.status().diagnostic).toBe(`${mode}-timeout`)
    expect(workers[0]!.process.kill).toHaveBeenCalledOnce()
    expect(session.status().active).toBe(false)
    expect(factory).toHaveBeenCalledOnce()
  })
  it('does not let stale/wrong-session output extend the idle lease', () => {
    const { supervisor, ready, advance, workers, session } = setup()
    supervisor.start(); ready(); advance(100)
    workers[0]!.data({ ...envelope(session.status().epoch, 1), captureSessionId: 'other', type: 'worker.ready' })
    advance(100); supervisor.tick()
    expect(supervisor.status().diagnostic).toBe('idle-timeout')
  })
  it('accepts scoped monotonic heartbeats during silence without altering preview', () => {
    const { supervisor, ready, advance, workers, session } = setup()
    supervisor.start(); ready(); advance(150)
    workers[0]!.data({ ...envelope(session.status().epoch, 1), type: 'worker.heartbeat' })
    advance(100); supervisor.tick()
    expect(supervisor.status().diagnostic).toBe('connected')
    expect(session.snapshot()).toEqual([])
    workers[0]!.data({ ...envelope(session.status().epoch, 1), type: 'worker.heartbeat' })
    advance(100); supervisor.tick()
    expect(supervisor.status().diagnostic).toBe('idle-timeout')
  })
  it('requires confirmed old-process exit before explicit restart and fences late callbacks', async () => {
    let release!: () => void
    const { supervisor, ready, workers, factory, session } = setup(true, () => new Promise<void>(resolve => { release = resolve }))
    supervisor.start(); ready(); const oldEpoch = session.status().epoch
    supervisor.revoke()
    expect(supervisor.start()).toBe(false)
    expect(factory).toHaveBeenCalledOnce()
    release(); await Promise.resolve()
    expect(supervisor.start()).toBe(true); ready()
    workers[0]!.data(word(oldEpoch)); workers[0]!.exit()
    expect(supervisor.status().diagnostic).toBe('connected')
    expect(session.snapshot()).toEqual([])
  })
  it('failed process cleanup blocks replacement workers', async () => {
    const { supervisor, ready, factory } = setup(true, async () => { throw new Error('secret') })
    supervisor.start(); ready(); supervisor.revoke(); await Promise.resolve()
    expect(supervisor.status()).toMatchObject({ diagnostic: 'cleanup-failed', retiring: true })
    expect(supervisor.start()).toBe(false)
    expect(factory).toHaveBeenCalledOnce()
  })
  it('optional backend launch failure never throws through the host', () => {
    const { session } = setup()
    const supervisor = new AttributionWorkerSupervisor(session, () => { throw new Error('secret') })
    expect(supervisor.start()).toBe(false)
    expect(supervisor.status().diagnostic).toBe('unavailable')
    expect(session.status().active).toBe(false)
  })
  it('process exit and malformed output pause owner and clear preview', () => {
    for (const mode of ['exit', 'malformed']) {
      const { supervisor, ready, workers, session } = setup()
      supervisor.start(); ready(); workers[0]!.data(word(session.status().epoch))
      if (mode === 'exit') workers[0]!.exit()
      else workers[0]!.bytes(Buffer.from('bad\n'))
      expect(supervisor.status().running).toBe(false)
      expect(session.snapshot()).toEqual([])
    }
  })
})

describe('trusted local host consent presentation', () => {
  it('discloses through one presentation and requires participant-specific exact assent', async () => {
    const { supervisor, session, factory } = setup(false)
    const showDetails = vi.fn()
    const prompt = vi.fn(async () => 'I CONSENT p1')
    const host = new AttributionLocalHost(session, supervisor, { showDetails, prompt })
    expect(await host.requestCaptureConsent('p1')).toBe(true)
    const disclosure = showDetails.mock.calls.map(call => call[0].text).join(' ')
    expect(disclosure).toContain('held in memory for this session')
    expect(disclosure).toContain('cleared on pause, withdrawal or stop')
    expect(disclosure).toContain('persists no transcript or voice profile')
    expect(factory).not.toHaveBeenCalled()
    host.operator({ action: 'start' })
    expect(factory).toHaveBeenCalledOnce()
  })
  it.each(['yes', 'I CONSENT other', '', ' I CONSENT p1', 'I CONSENT p1 ', 'I CONSENT p1\n'])('declines non-exact participant answer %s', async answer => {
    const { supervisor, session, factory } = setup(false)
    const host = new AttributionLocalHost(session, supervisor, { showDetails() {}, prompt: async () => answer })
    expect(await host.requestCaptureConsent('p1')).toBe(false)
    host.operator({ action: 'start' })
    expect(factory).not.toHaveBeenCalled()
  })
  it('rejects delayed consent after participant/session state changed', async () => {
    const { supervisor, session, factory } = setup(false)
    let answer!: (text: string) => void
    const host = new AttributionLocalHost(session, supervisor, { showDetails() {},
      prompt: () => new Promise<string>(resolve => { answer = resolve }) })
    const pending = host.requestCaptureConsent('p1')
    expect(await host.requestCaptureConsent('p1')).toBe(false)
    host.operator({ action: 'join', participantId: 'p2' })
    answer('I CONSENT p1')
    expect(await pending).toBe(false)
    host.operator({ action: 'start' })
    expect(factory).not.toHaveBeenCalled()
  })
  it('refuses direct consent actions and prompt/display failures without fallback', async () => {
    const { supervisor, session, factory } = setup(false)
    const host = new AttributionLocalHost(session, supervisor, { showDetails() { throw new Error('secret') },
      prompt: async () => 'I CONSENT p1' })
    expect(host.operator({ action: 'consent', participantId: 'p1', consent: yes }).lines[0]).toContain('requires')
    expect(await host.requestCaptureConsent('p1')).toBe(false)
    expect(factory).not.toHaveBeenCalled()
  })
  it('clears previous assent before a cancelled renewal prompt', async () => {
    const { supervisor, session, factory } = setup()
    const host = new AttributionLocalHost(session, supervisor, { showDetails() {},
      prompt: async () => { throw new Error('cancelled') } })
    expect(await host.requestCaptureConsent('p1')).toBe(false)
    host.operator({ action: 'start' })
    expect(factory).not.toHaveBeenCalled()
  })
  it('integrates with the existing stable screen-reader presentation without a speech sink', async () => {
    const { supervisor, session, factory } = setup(false)
    const output: string[] = []
    const presentation = new ScreenReaderPresentation({ write: text => output.push(text),
      input: { readLine: async () => 'I CONSENT p1', close() {} } })
    const host = new AttributionLocalHost(session, supervisor, presentation)
    expect(await host.requestCaptureConsent('p1')).toBe(true)
    expect(output.join('')).toContain('opt in only for yourself')
    expect(factory).not.toHaveBeenCalled()
  })
  it('withdrawal immediately supervises cleanup even if presentation fails', () => {
    const { supervisor, session, ready, workers } = setup()
    supervisor.start(); ready()
    const host = new AttributionLocalHost(session, supervisor, { showDetails() { throw new Error('secret') }, prompt: async () => '' })
    host.operator({ action: 'withdraw', participantId: 'p1' })
    expect(session.status().active).toBe(false)
    expect(workers[0]!.process.kill).toHaveBeenCalledOnce()
  })
  it('announces asynchronous failures through the same trusted presentation owner', () => {
    const { supervisor, session, workers } = setup()
    const texts: string[] = []
    const host = new AttributionLocalHost(session, supervisor, {
      showDetails: item => { texts.push(item.text) }, prompt: async () => '' })
    host.operator({ action: 'start' }); workers[0]!.exit()
    expect(texts.join(' ')).toContain('worker-exited')
    expect(() => supervisor.onDiagnostic(() => {})).toThrow('already attached')
    host.close()
    expect(() => supervisor.onDiagnostic(() => {})).not.toThrow()
  })
})
