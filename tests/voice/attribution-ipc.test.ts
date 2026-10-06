import { describe, expect, it, vi } from 'vitest'
import { AttributionWorkerChannel, type AttributionWorkerPort } from '../../src/voice/attribution-ipc.js'
import { AttributionSession } from '../../src/voice/attribution-session.js'
import { VoiceTurnLedger } from '../../src/voice/turns.js'

const envelope = (epoch: number, seq = 0) => ({ schemaVersion: 1, eventId: `e-${seq}`,
  eventSeq: seq, captureSessionId: 'cap', harnessSessionId: 'harness', streamEpoch: epoch,
  emittedAt: '2026-10-06T12:00:00Z', modelRevision: 'synthetic', policyVersion: 'v1' })
const line = (input: unknown) => Buffer.from(`${JSON.stringify(input)}\n`)
function setup(writable = true) {
  const session = new AttributionSession('cap', 'harness', new VoiceTurnLedger())
  session.disclose(['person'])
  session.setConsent('person', { capture: true, cloudTransfer: false,
    transcriptPersistence: false, profileMatching: false })
  session.start()
  let time = 0
  const writes: Uint8Array[] = []
  const callbacks: ((error?: Error) => void)[] = []
  const close = vi.fn()
  const port: AttributionWorkerPort = { close, write(bytes, complete) {
    writes.push(bytes); callbacks.push(complete); return writable
  } }
  const channel = new AttributionWorkerChannel(session, port, () => time, 1_024, 100)
  const epoch = session.status().epoch
  const ready = { ...envelope(epoch), type: 'worker.ready' }
  const queue = (seq = 0) => session.pushFrame({ captureSessionId: 'cap', streamEpoch: epoch,
    frameSeq: seq, sampleStart: seq * 160, sampleCount: 160, sampleRate: 16_000,
    channels: 1, format: 'pcm16le', pcm: new Uint8Array(320).fill(9) })
  return { session, channel, epoch, ready, queue, writes, callbacks, close,
    tick: () => { time = 100 } }
}

describe('dormant worker NDJSON transport', () => {
  it('decodes split UTF8 and multiple messages without using packet arrival time', () => {
    const { channel, ready, epoch, session } = setup()
    const segment = { ...envelope(epoch, 1), type: 'transcript.segment', segmentId: 'seg',
      revision: 1, startMs: 120, endMs: 800, text: 'café', state: 'final', speakers: [],
      overlap: false, identity: { status: 'unknown', reason: 'no-activity' } }
    const bytes = Buffer.concat([line(ready), line(segment)])
    const split = bytes.indexOf(Buffer.from('é')) + 1
    expect(channel.receive(bytes.subarray(0, split))).toEqual(['ready'])
    expect(channel.receive(bytes.subarray(split))).toEqual(['applied'])
    expect(session.snapshot()[0]).toMatchObject({ text: 'café', startMs: 120 })
    expect(channel.status().bufferedBytes).toBe(0)
  })

  it.each([Buffer.from('not-json\n'), Buffer.from('{}\n'), Buffer.from([255, 10]),
    Buffer.from('\n'), Buffer.alloc(65_537)])('fails closed on malformed bytes %j', bytes => {
    const { channel, session, close } = setup()
    expect(channel.receive(bytes)).toContain('invalid')
    expect(channel.status()).toMatchObject({ diagnostic: 'invalid-output', bufferedBytes: 0 })
    expect(session.status().active).toBe(false)
    expect(close).toHaveBeenCalledOnce()
  })

  it('bounds an unterminated line across callbacks and clears it on failure', () => {
    const { channel } = setup()
    channel.receive(Buffer.alloc(1_024, 32))
    expect(channel.receive(Buffer.from('x'))).toEqual(['invalid'])
    expect(channel.status().bufferedBytes).toBe(0)
  })

  it('never invokes worker-supplied consent or command actions', () => {
    const { channel, session } = setup()
    expect(channel.receive(line({ action: 'consent', capture: true }))).toEqual(['invalid'])
    expect(session.snapshot()).toEqual([])
  })

  it('refuses cross-session output and never reports connected', () => {
    const { channel, ready } = setup()
    expect(channel.receive(line({ ...ready, captureSessionId: 'other' }))).toEqual(['wrong-session'])
    expect(channel.status().diagnostic).toBe('waiting-worker')
  })

  it('sends one canonical base64 frame and clears owned bytes after completion', () => {
    const { channel, ready, queue, writes, callbacks } = setup()
    expect(channel.sendNext()).toBe('inactive')
    channel.receive(line(ready)); queue()
    expect(channel.sendNext()).toBe('sent')
    const wire = JSON.parse(Buffer.from(writes[0]!).toString())
    expect(Buffer.from(wire.pcm, 'base64')).toEqual(Buffer.alloc(320, 9))
    expect(channel.sendNext()).toBe('backpressure')
    callbacks[0]!()
    expect(writes[0]!.every(b => b === 0)).toBe(true)
    expect(channel.sendNext()).toBe('empty')
  })

  it('write(false) is accepted once and requires both completion and drain', () => {
    const { channel, ready, queue, writes, callbacks } = setup(false)
    channel.receive(line(ready)); queue(); queue(1)
    expect(channel.sendNext()).toBe('sent')
    callbacks[0]!()
    expect(channel.sendNext()).toBe('backpressure')
    expect(writes).toHaveLength(1)
    channel.drain()
    expect(channel.sendNext()).toBe('sent')
    expect(writes).toHaveLength(2)
  })

  it('deadline pauses the owner and releases bytes even if a port ignores cancellation', () => {
    const { channel, ready, queue, writes, callbacks, tick, session, close } = setup()
    channel.receive(line(ready)); queue(); channel.sendNext(); tick(); channel.checkDeadline()
    expect(channel.status().diagnostic).toBe('deadline')
    expect(writes[0]!.every(b => b === 0)).toBe(true)
    expect(session.status().active).toBe(false)
    callbacks[0]!()
    expect(close).toHaveBeenCalledOnce()
  })

  it('epoch revocation closes the old channel and rejects late readiness', () => {
    const { channel, session, ready, queue, writes } = setup()
    channel.receive(line(ready)); queue(); channel.sendNext()
    session.withdraw('person')
    expect(channel.receive(line(ready))).toEqual(['closed'])
    expect(channel.status().diagnostic).toBe('epoch-changed')
    expect(writes[0]!.every(b => b === 0)).toBe(true)
    expect(session.status().active).toBe(false)
  })

  it('fresh channel requires explicit restart and new-epoch readiness', () => {
    const { channel, session, ready } = setup()
    channel.receive(line(ready)); channel.close()
    const fresh = new AttributionWorkerChannel(session, { write: () => true, close: () => {} })
    const nextReady = { ...ready, streamEpoch: session.status().epoch }
    expect(fresh.receive(line(nextReady))).toEqual(['inactive'])
    expect(session.start()).toBe(true)
    expect(fresh.receive(line(ready))).toEqual(['stale'])
    expect(fresh.receive(line(nextReady))).toEqual(['ready'])
  })

  it('write failures and throwing close adapters cannot bypass pause', () => {
    const { session, ready, queue } = setup()
    const channel = new AttributionWorkerChannel(session, { write() { throw new Error('secret') },
      close() { throw new Error('secret') } })
    channel.receive(line(ready)); queue()
    expect(channel.sendNext()).toBe('closed')
    expect(channel.status().diagnostic).toBe('write-error')
    expect(session.status().active).toBe(false)
  })

  it('handles synchronous completion without retaining a completed write', () => {
    const { session, ready, queue } = setup()
    const channel = new AttributionWorkerChannel(session, { write(_bytes, done) { done(); return true }, close() {} })
    channel.receive(line(ready)); queue()
    expect(channel.sendNext()).toBe('sent')
    expect(channel.status().pendingWrite).toBe(false)
  })

  it('asynchronous write failure clears the frame and owner state', () => {
    const { channel, ready, queue, writes, callbacks, session } = setup()
    channel.receive(line(ready)); queue(); channel.sendNext()
    callbacks[0]!(new Error('untrusted diagnostics'))
    expect(channel.status().diagnostic).toBe('write-error')
    expect(writes[0]!.every(b => b === 0)).toBe(true)
    expect(session.status().active).toBe(false)
  })

  it('worker errors fence subsequent output in the same callback', () => {
    const { channel, ready, epoch, session } = setup()
    channel.receive(line(ready))
    const error = { ...envelope(epoch, 1), type: 'worker.error', reason: 'unavailable' }
    expect(channel.receive(Buffer.concat([line(error), line({ ...ready, eventSeq: 2 })]))).toEqual(['reset'])
    expect(session.status().active).toBe(false)
    expect(channel.status().diagnostic).toBe('epoch-changed')
  })
})
