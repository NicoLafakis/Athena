import { describe, expect, it } from 'vitest'
import { alignWords, AlignmentInputSchema, sampleIntervalToMs } from '../../src/voice/attribution-alignment.js'

const word = { wordId: 'word-1', text: 'Hello', startMs: 0, endMs: 1000 }
const activity = (speakerId = 'spk-1', startMs = 0, endMs = 1000, source = 'diarization') => ({ speakerId, startMs, endMs, source })
const batch = (intervals: unknown[] = [activity()]) => ({ captureSessionId: 'cap-1', streamEpoch: 1, words: [word], activity: intervals })

describe('source-clock word alignment', () => {
  it('resampling preserves time without using packet arrival timestamps', () => {
    expect(sampleIntervalToMs(24_000, 24_000, 24_000)).toEqual(sampleIntervalToMs(16_000, 16_000, 16_000))
    expect(sampleIntervalToMs(48_000, 48_000, 48_000)).toEqual({ startMs: 1000, endMs: 2000 })
    expect(() => sampleIntervalToMs(Number.MAX_SAFE_INTEGER, 1, 16000)).toThrow()
  })

  it('attributes complete single-speaker coverage and returns unknown for silence', () => {
    expect(alignWords(batch())[0]).toMatchObject({ speakers: [{ speakerId: 'spk-1' }], reason: 'attributed', overlap: false })
    expect(alignWords(batch([]))[0]).toMatchObject({ speakers: [], reason: 'no-activity' })
  })

  it('abstains on insufficient coverage; threshold is explicit and configurable', () => {
    expect(alignWords(batch([activity('spk-1', 0, 799)]))[0]!.reason).toBe('insufficient-coverage')
    expect(alignWords(batch([activity('spk-1', 0, 800)]))[0]!.reason).toBe('attributed')
    expect(alignWords(batch([activity('spk-1', 0, 800)]), { minimumCoverage: 0.9 })[0]!.reason).toBe('insufficient-coverage')
  })

  it('does not inflate coverage from duplicate or intersecting same-speaker intervals', () => {
    expect(alignWords(batch([activity('spk-1', 0, 400), activity('spk-1', 0, 400)]))[0]!.reason).toBe('insufficient-coverage')
    expect(alignWords(batch([activity('spk-1', 0, 600), activity('spk-1', 400, 1000)]))[0]!.reason).toBe('attributed')
  })

  it('distinguishes simultaneous overlap from a sequential word boundary', () => {
    expect(alignWords(batch([activity('a', 0, 500), activity('b', 500, 1000)]))[0]).toMatchObject({ speakers: [], overlap: false, reason: 'speaker-boundary' })
    expect(alignWords(batch([activity('a', 0, 600), activity('b', 500, 1000)]))[0]).toMatchObject({
      speakers: [{ speakerId: 'a' }, { speakerId: 'b' }], overlap: true, reason: 'overlap',
    })
  })

  it('prefers intersecting track metadata, preserving account provenance', () => {
    expect(alignWords(batch([activity('bio'), activity('track-account', 0, 1000, 'track-metadata')]))[0]!.speakers)
      .toEqual([{ speakerId: 'track-account', source: 'track-metadata' }])
    expect(alignWords(batch([activity('bio'), activity('track-account', 0, 100, 'track-metadata')]))[0]!.reason)
      .toBe('insufficient-coverage')
  })

  it.each([
    { words: [{ ...word, endMs: 0 }] }, { words: [word, word] },
    { words: [word, { ...word, wordId: 'word-2', startMs: 900 }] },
    { activity: [activity('bad', NaN)] }, { permissionId: 'permission-1' },
    { activity: Array.from({ length: 9 }, (_, i) => activity(`spk-${i}`)) },
    { words: Array.from({ length: 257 }, (_, i) => ({ ...word, wordId: `word-${i}`, startMs: i * 1000, endMs: (i + 1) * 1000 })) },
  ])('rejects invalid or unbounded batch %j', patch => {
    expect(AlignmentInputSchema.safeParse({ ...batch(), ...patch }).success).toBe(false)
  })
})
