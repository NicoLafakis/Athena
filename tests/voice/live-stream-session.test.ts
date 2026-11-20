import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { runLiveVoiceSession, type DuplexAudioTransport } from '../../src/voice/live-stream-session.js'

class FakeSocket extends EventEmitter {
  readyState = 1
  readonly sent: Array<Record<string, unknown>> = []
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
  terminate(): void {
    this.close()
  }
  serverSend(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(event)))
  }
}

class FakeDuplexAudio implements DuplexAudioTransport {
  readonly played: Buffer[] = []
  closed = false
  private onFrameCb: ((pcm: Buffer, level: number) => void) | null = null
  private onReadyCb: ((backend: string) => void) | null = null

  start(handlers: {
    onReady: (backend: string) => void
    onFrame: (pcm: Buffer, level: number) => void
    onWarn: (message: string) => void
  }): void {
    this.onReadyCb = handlers.onReady
    this.onFrameCb = handlers.onFrame
    this.onReadyCb('winmm-24khz-duplex')
  }

  emitMicFrame(pcm: Buffer, level: number): void {
    this.onFrameCb?.(pcm, level)
  }

  playChunk(pcm: Buffer): void {
    this.played.push(pcm)
  }

  flushPlayback(): void {}

  close(): void {
    this.closed = true
  }
}

function makeTonePcm(ms: number, amplitude: number): Buffer {
  const samples = Math.floor((24_000 * ms) / 1_000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * amplitude), i * 2)
  }
  return buf
}

describe('Full-duplex runLiveVoiceSession (gpt-live-1.1)', () => {
  it('streams mic frames continuously and plays output audio chunks immediately without turn-buffering', async () => {
    const fakeWs = new FakeSocket()
    const fakeAudio = new FakeDuplexAudio()
    const userFeed: string[] = []
    const athenaFeed: string[] = []
    const athenaLevels: number[] = []
    const abort = new AbortController()

    const sessionPromise = runLiveVoiceSession({
      apiKey: 'sk-test',
      model: 'gpt-live-1.1',
      duplex: fakeAudio,
      signal: abort.signal,
      webSocketFactory: () => fakeWs as unknown as WebSocket,
      onUserTranscript: (t) => userFeed.push(t),
      onAthenaTranscript: (t) => athenaFeed.push(t),
      onAthenaLevel: (l) => athenaLevels.push(l),
    })

    // 1. Socket opens -> sends session.start (no tools)
    fakeWs.emit('open')
    expect(fakeWs.sent[0]).toMatchObject({
      type: 'session.start',
      session: { model: 'gpt-live-1.1', delegation: { type: 'client' } },
    })
    fakeWs.serverSend({ type: 'session.started', session: { id: 'live_duplex_1' } })
    await new Promise((r) => setImmediate(r))

    // 2. Continuous mic frame streams straight to session.input_audio.append immediately
    const micFrame = makeTonePcm(60, 4_000)
    fakeAudio.emitMicFrame(micFrame, 42)
    expect(fakeWs.sent.some((m) => m['type'] === 'session.input_audio.append')).toBe(true)

    // 3. Incoming non-zero output audio delta plays IMMEDIATELY (before any silence tail!)
    const speechOut = makeTonePcm(100, 9_000)
    fakeWs.serverSend({ type: 'session.input_transcript.delta', delta: 'Hey Athena' })
    fakeWs.serverSend({ type: 'session.output_transcript.delta', delta: 'Hey! ' })
    fakeWs.serverSend({ type: 'session.output_audio.delta', delta: speechOut.toString('base64') })

    // Played on the very first chunk — zero turn-end buffering!
    expect(fakeAudio.played).toHaveLength(1)
    expect(athenaLevels.some((l) => l > 0)).toBe(true)

    // 4. Transcripts flush cleanly when output finishes (silence frames)
    fakeWs.serverSend({ type: 'session.output_transcript.delta', delta: 'I am listening.' })
    const silenceOut = Buffer.alloc(4_800)
    for (let i = 0; i < 6; i++) {
      fakeWs.serverSend({ type: 'session.output_audio.delta', delta: silenceOut.toString('base64') })
    }
    expect(userFeed).toEqual(['Hey Athena'])
    expect(athenaFeed).toEqual(['Hey! I am listening.'])

    abort.abort()
    await sessionPromise
    expect(fakeAudio.closed).toBe(true)
  })
})
