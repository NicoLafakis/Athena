import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { parseArgs } from '../../src/cli/args.js'
import { PcmVadSegmenter } from '../../src/voice/windows-pcm-capture.js'
import { LiveVoiceClient } from '../../src/voice/live-client.js'
import { RealtimeVoiceClient } from '../../src/voice/realtime.js'

function makeTonePcm(ms: number, amplitude: number, sampleRate = 24_000): Buffer {
  const samples = Math.floor((sampleRate * ms) / 1_000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude)
    buf.writeInt16LE(v, i * 2)
  }
  return buf
}

class FakeSocket extends EventEmitter {
  readonly sent: Array<Record<string, unknown>> = []
  closed = false
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.closed = true
    this.emit('close')
  }
  terminate(): void {
    this.close()
  }
  serverSend(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(event)))
  }
}

describe('PcmVadSegmenter', () => {
  it('captures pre-roll + speech and flushes clean 24kHz PCM after silence tail', () => {
    const utterances: Buffer[] = []
    const vad = new PcmVadSegmenter({
      speechThreshold: 12,
      silenceTailMs: 180,
      minSpeechMs: 120,
      preRollFrames: 2,
      frameMs: 60,
      onUtterance: (pcm) => utterances.push(pcm),
    })

    const quiet = makeTonePcm(60, 0)
    const loud = makeTonePcm(60, 12_000)

    // Pre-roll frames before speech
    vad.pushFrame(quiet, 1)
    vad.pushFrame(quiet, 2)
    // 3 speech frames (180ms >= 120ms min)
    vad.pushFrame(loud, 45)
    vad.pushFrame(loud, 55)
    vad.pushFrame(loud, 50)
    expect(utterances).toHaveLength(0)

    // 3 quiet frames (180ms silence tail) -> flushes utterance including pre-roll!
    vad.pushFrame(quiet, 2)
    vad.pushFrame(quiet, 1)
    vad.pushFrame(quiet, 1)
    expect(utterances).toHaveLength(1)
    // 2 pre-roll + 3 speech + 3 tail = 8 frames * 60ms = 480ms of 24kHz PCM16LE
    expect(utterances[0]!.length).toBe(8 * quiet.length)
  })

  it('drops short clicks below minSpeechMs and ignores frames while muted', () => {
    const utterances: Buffer[] = []
    const vad = new PcmVadSegmenter({
      speechThreshold: 12,
      silenceTailMs: 120,
      minSpeechMs: 240,
      frameMs: 60,
      onUtterance: (pcm) => utterances.push(pcm),
    })
    const quiet = makeTonePcm(60, 0)
    const click = makeTonePcm(60, 20_000)

    // Single 60ms click -> dropped
    vad.pushFrame(click, 60)
    vad.pushFrame(quiet, 0)
    vad.pushFrame(quiet, 0)
    expect(utterances).toHaveLength(0)

    // Muted during playback -> ignored completely
    vad.setMuted(true)
    for (let i = 0; i < 6; i++) vad.pushFrame(click, 60)
    vad.setMuted(false)
    vad.pushFrame(quiet, 0)
    vad.pushFrame(quiet, 0)
    expect(utterances).toHaveLength(0)
  })
})

describe('LiveVoiceClient (gpt-live-1.1) and RealtimeVoiceClient transcription', () => {
  it('parses --model gpt-live-1.1 and --model gpt-live-1 CLI flags', () => {
    expect(parseArgs(['voice', '--model', 'gpt-live-1.1'])).toMatchObject({
      command: 'voice',
      model: 'gpt-live-1.1',
    })
    expect(parseArgs(['voice', '--model', 'gpt-live-1'])).toMatchObject({
      command: 'voice',
      model: 'gpt-live-1',
    })
  })

  it('LiveVoiceClient initializes wss://api.openai.com/v1/live/sessions with session.start and returns userTranscript + transcript', async () => {
    const fake = new FakeSocket()
    let connectedUrl = ''
    const client = new LiveVoiceClient({
      apiKey: 'sk-test',
      model: 'gpt-live-1.1',
      webSocketFactory: (url) => {
        connectedUrl = url
        return fake as unknown as WebSocket
      },
    })

    const connectPromise = client.connect()
    fake.emit('open')
    expect(connectedUrl).toBe('wss://api.openai.com/v1/live/sessions')
    expect(fake.sent[0]).toMatchObject({
      type: 'session.start',
      session: {
        model: 'gpt-live-1.1',
        delegation: { type: 'client' },
      },
    })
    fake.serverSend({ type: 'session.started', session: { id: 'live_1', model: 'gpt-live-1.1' } })
    await connectPromise

    const turnPromise = client.askAudio(makeTonePcm(120, 10_000), async () => ({}))
    fake.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Check the git status please.',
    })
    fake.serverSend({
      type: 'response.output_audio_transcript.delta',
      delta: 'Checking git status now.',
    })
    fake.serverSend({
      type: 'response.output_audio.delta',
      delta: Buffer.from([1, 2, 3, 4]).toString('base64'),
    })
    fake.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [], usage: { total_tokens: 42 } },
    })

    const turn = await turnPromise
    expect(turn.userTranscript).toBe('Check the git status please.')
    expect(turn.transcript).toBe('Checking git status now.')
    expect(turn.audio).toEqual(Buffer.from([1, 2, 3, 4]))
    client.close()
  })

  it('RealtimeVoiceClient enables gpt-live-transcribe and captures userTranscript', async () => {
    const fake = new FakeSocket()
    const client = new RealtimeVoiceClient({
      apiKey: 'sk-test',
      model: 'gpt-realtime-2.1',
      webSocketFactory: () => fake as unknown as WebSocket,
    })

    const connectPromise = client.connect()
    fake.emit('open')
    const update = fake.sent[0] as { session?: { audio?: { input?: { transcription?: { model?: string } } } } }
    expect(update.session?.audio?.input?.transcription?.model).toBe('gpt-live-transcribe')
    fake.serverSend({ type: 'session.updated', session: {} })
    await connectPromise

    const turnPromise = client.askAudio(makeTonePcm(120, 10_000), async () => ({}))
    await new Promise<void>((resolve) => setImmediate(resolve))
    fake.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Run the test suite.',
    })
    fake.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'Running tests.' })
    fake.serverSend({ type: 'response.done', response: { status: 'completed', output: [] } })

    const turn = await turnPromise
    expect(turn.userTranscript).toBe('Run the test suite.')
    expect(turn.transcript).toBe('Running tests.')
    client.close()
  })
})
