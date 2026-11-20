import { describe, expect, it } from 'vitest'
import {
  computePcmEnvelope,
  createInitialVoiceHudState,
  pushSample,
  reduceVoiceHudState,
  renderWaveformBars,
} from '../../src/voice/visualizer.js'
import { parseWakeListenerLine } from '../../src/voice/windows-speech.js'

describe('voice visualizer math', () => {
  it('computes 0..100 RMS amplitude frames from 24kHz PCM16LE audio', () => {
    // 120ms of silence at 24kHz = 2880 samples = 5760 bytes -> 2 frames at 60ms each.
    const silence = Buffer.alloc(24_000 * 2 * 0.12)
    expect(computePcmEnvelope(silence, 24_000, 60)).toEqual([0, 0])

    // 120ms of loud 440Hz sine wave at ~80% amplitude.
    const samples = Math.floor(24_000 * 0.12)
    const loud = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 26_000)
      loud.writeInt16LE(v, i * 2)
    }
    const env = computePcmEnvelope(loud, 24_000, 60)
    expect(env).toHaveLength(2)
    expect(env[0]!).toBeGreaterThan(50)
    expect(env[0]!).toBeLessThanOrEqual(100)
  })

  it('renders bounded Unicode bar waveforms with exact width and rolling history', () => {
    const history = pushSample(pushSample([], 0, 8), 100, 8)
    expect(history).toEqual([0, 100])
    const rendered = renderWaveformBars([0, 15, 35, 60, 85, 100], 6)
    expect([...rendered]).toHaveLength(6)
    expect(rendered[0]).toBe('▁')
    expect(rendered.at(-1)).toBe('█')
  })

  it('reduces VoiceHudState cleanly across standby, hearing, working, and speaking phases', () => {
    let state = createInitialVoiceHudState({ model: 'gpt-realtime-2.1-mini', projectName: 'Athena' })
    state = reduceVoiceHudState(state, { type: 'phase', phase: 'standby' })
    state = reduceVoiceHudState(state, { type: 'mic-level', level: 48 })
    state = reduceVoiceHudState(state, { type: 'hypothesis', text: 'Athena check status' })
    expect(state.phase).toBe('hearing')
    expect(state.micLevel).toBe(48)
    expect(state.liveHypothesis).toBe('Athena check status')

    state = reduceVoiceHudState(state, { type: 'phase', phase: 'speaking' })
    state = reduceVoiceHudState(state, { type: 'athena-level', level: 72 })
    expect(state.athenaLevel).toBe(72)
    expect(state.athenaHistory.at(-1)).toBe(72)

    state = reduceVoiceHudState(state, { type: 'feed', role: 'athena', text: 'All tests are green.' })
    expect(state.feed.at(-1)?.text).toBe('All tests are green.')
  })
})

describe('parseWakeListenerLine live telemetry events', () => {
  it('parses level, speech-detected, hypothesis, and rejected JSONL lines', () => {
    expect(parseWakeListenerLine('{"level":42}')).toEqual({ kind: 'level', level: 42 })
    expect(parseWakeListenerLine('{"speech":"detected"}')).toEqual({ kind: 'speech-detected' })
    expect(parseWakeListenerLine('{"hypothesis":"Athena check"}')).toEqual({
      kind: 'hypothesis',
      text: 'Athena check',
    })
    expect(parseWakeListenerLine('{"rejected":true,"text":"mumble","confidence":0.2}')).toEqual({
      kind: 'rejected',
      text: 'mumble',
      confidence: 0.2,
    })
  })

  it('keeps long feed entries unwrapped up to 2000 chars for full conversational visibility', () => {
    const longReply = 'This is a long Athena response. '.repeat(20)
    const state = reduceVoiceHudState(
      createInitialVoiceHudState({ model: 'gpt-realtime-2.1-mini', projectName: 'Athena' }),
      { type: 'feed', role: 'athena', text: longReply },
    )
    expect(state.feed[0]!.text).toBe(longReply)
  })
})
