import { z } from 'zod'

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const Time = z.number().finite().nonnegative()
const Interval = z.object({ startMs: Time, endMs: Time })
const Word = Interval.extend({ wordId: Id, text: z.string().min(1).max(256) }).strict()
const Activity = Interval.extend({
  speakerId: Id, source: z.enum(['diarization', 'track-metadata']),
}).strict()

export const AlignmentInputSchema = z.object({
  captureSessionId: Id, streamEpoch: z.number().int().nonnegative().safe(),
  words: z.array(Word).min(1).max(256), activity: z.array(Activity).max(2_048),
}).strict().superRefine((input, ctx) => {
  if (input.words.map(w => w.text).join(' ').length > 4_096) {
    ctx.addIssue({ code: 'custom', message: 'Word batch exceeds transcript bound' })
  }
  if (new Set(input.words.map(w => w.wordId)).size !== input.words.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate word IDs' })
  }
  if (new Set(input.activity.map(a => a.speakerId)).size > 8) {
    ctx.addIssue({ code: 'custom', message: 'Speaker capacity exceeded' })
  }
  for (const interval of [...input.words, ...input.activity]) {
    if (interval.endMs <= interval.startMs) ctx.addIssue({ code: 'custom', message: 'Invalid interval' })
  }
  for (let i = 1; i < input.words.length; i++) {
    if (input.words[i]!.startMs < input.words[i - 1]!.endMs) {
      ctx.addIssue({ code: 'custom', message: 'ASR words must be ordered and nonoverlapping' })
    }
  }
})

const AlignmentPolicySchema = z.object({
  // Coverage is a timing heuristic, not confidence or calibrated identity probability.
  minimumCoverage: z.number().finite().gt(0).max(1).default(0.8),
}).strict()
export interface AlignedWord {
  wordId: string; text: string; startMs: number; endMs: number
  speakers: { speakerId: string; source: 'diarization' | 'track-metadata' }[]
  overlap: boolean
  reason: 'attributed' | 'no-activity' | 'insufficient-coverage' | 'speaker-boundary' | 'overlap'
}

/** Absolute source sample indices, never packet arrival/wall-clock times. */
export function sampleIntervalToMs(sampleStart: number, sampleCount: number, sampleRate: number): { startMs: number; endMs: number } {
  z.number().int().nonnegative().safe().parse(sampleStart)
  z.number().int().positive().safe().parse(sampleCount)
  z.number().int().positive().max(192_000).parse(sampleRate)
  z.number().int().safe().parse(sampleStart + sampleCount)
  return { startMs: sampleStart * 1_000 / sampleRate, endMs: (sampleStart + sampleCount) * 1_000 / sampleRate }
}

function unionDuration(intervals: { startMs: number; endMs: number }[]): number {
  const ordered = [...intervals].sort((a, b) => a.startMs - b.startMs)
  let end = -Infinity
  let total = 0
  for (const interval of ordered) {
    total += Math.max(0, interval.endMs - Math.max(interval.startMs, end))
    end = Math.max(end, interval.endMs)
  }
  return total
}

/** Conservative word attribution. Sequential boundary ambiguity is not simultaneous overlap. */
export function alignWords(input: unknown, policy: unknown = {}): AlignedWord[] {
  const batch = AlignmentInputSchema.parse(input)
  const { minimumCoverage } = AlignmentPolicySchema.parse(policy)
  return batch.words.map(word => {
    const intersecting = batch.activity.filter(a => a.startMs < word.endMs && a.endMs > word.startMs)
    const tracks = intersecting.filter(a => a.source === 'track-metadata')
    const selected = (tracks.length ? tracks : intersecting).map(a => ({ ...a,
      startMs: Math.max(a.startMs, word.startMs), endMs: Math.min(a.endMs, word.endMs),
    }))
    const labels = [...new Map(selected.map(a => [a.speakerId, { speakerId: a.speakerId, source: a.source }])).values()]
    const overlap = selected.some((a, i) => selected.slice(i + 1).some(b => a.speakerId !== b.speakerId
      && a.startMs < b.endMs && b.startMs < a.endMs))
    if (overlap) return { ...word, speakers: labels, overlap: true, reason: 'overlap' as const }
    if (labels.length > 1) return { ...word, speakers: [], overlap: false, reason: 'speaker-boundary' as const }
    if (labels.length === 0) return { ...word, speakers: [], overlap: false, reason: 'no-activity' as const }
    const coverage = unionDuration(selected) / (word.endMs - word.startMs)
    if (coverage < minimumCoverage) return { ...word, speakers: [], overlap: false, reason: 'insufficient-coverage' as const }
    return { ...word, speakers: labels, overlap: false, reason: 'attributed' as const }
  })
}
