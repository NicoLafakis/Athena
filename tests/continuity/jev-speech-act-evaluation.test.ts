import { describe, expect, it, vi } from 'vitest'
import {
  JEV_MEMORY_SPEECH_ACTS,
  RECALL_ROUTES,
  type JevMemorySpeechAct,
  type RecallIntentRouter,
  type RecallRouteDecision,
} from '../../src/decision/jev.js'
import type { DecisionResult } from '../../src/decision/client.js'
import {
  evaluateJevSpeechActCorpus,
  formatJevSpeechActEvaluation,
} from '../../bench/jev-speech-act-evaluation.js'
import {
  loadJevSpeechActCorpus,
  loadJevSpeechActHoldoutCorpus,
  loadJevSpeechActIndependentHoldoutCorpus,
  type JevSpeechActCorpus,
} from '../../bench/jev-speech-act-corpus.js'

function decision(act: JevMemorySpeechAct, confidence: number): DecisionResult<RecallRouteDecision> {
  const speechActProbabilities = Object.fromEntries(JEV_MEMORY_SPEECH_ACTS.map((label) => [
    label, label === act ? confidence : (1 - confidence) / (JEV_MEMORY_SPEECH_ACTS.length - 1),
  ])) as RecallRouteDecision['speechAct']['probabilities']
  const routeProbabilities = Object.fromEntries(RECALL_ROUTES.map((route) => [route, route === 'none' ? 1 : 0])) as RecallRouteDecision['probabilities']
  return {
    status: 'decision',
    value: {
      route: 'none', confidence: 1, probabilities: routeProbabilities,
      speechAct: { act, confidence, probabilities: speechActProbabilities },
    },
  }
}

describe('Jev speech-act evaluation', () => {
  it('loads a balanced, synthetic corpus covering each typed label', () => {
    const corpus = loadJevSpeechActCorpus()
    const counts = Object.fromEntries(JEV_MEMORY_SPEECH_ACTS.map((act) => [act, 0])) as Record<JevMemorySpeechAct, number>
    for (const item of corpus.cases) counts[item.speechAct]++

    expect(corpus.cases).toHaveLength(72)
    expect(Object.values(counts)).toEqual(Array(JEV_MEMORY_SPEECH_ACTS.length).fill(8))
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(corpus.cases.length)
  })

  it('loads a balanced phrasing regression set with three cases for each label', () => {
    const corpus = loadJevSpeechActHoldoutCorpus()
    const counts = Object.fromEntries(JEV_MEMORY_SPEECH_ACTS.map((act) => [act, 0])) as Record<JevMemorySpeechAct, number>
    for (const item of corpus.cases) counts[item.speechAct]++

    expect(corpus.cases).toHaveLength(27)
    expect(Object.values(counts)).toEqual(Array(JEV_MEMORY_SPEECH_ACTS.length).fill(3))
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(corpus.cases.length)
  })

  it('keeps a new independent balanced holdout separate from calibration and tuning phrases', () => {
    const corpus = loadJevSpeechActIndependentHoldoutCorpus()
    const calibration = loadJevSpeechActCorpus()
    const tuningHoldout = loadJevSpeechActHoldoutCorpus()
    const counts = Object.fromEntries(JEV_MEMORY_SPEECH_ACTS.map((act) => [act, 0])) as Record<JevMemorySpeechAct, number>
    for (const item of corpus.cases) counts[item.speechAct]++

    expect(corpus.cases).toHaveLength(27)
    expect(Object.values(counts)).toEqual(Array(JEV_MEMORY_SPEECH_ACTS.length).fill(3))
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(27)
    expect(new Set(corpus.cases.map((item) => item.text)).size).toBe(27)
    const earlier = [...calibration.cases, ...tuningHoldout.cases]
    expect(corpus.cases.some((item) => earlier.some((known) => known.id === item.id || known.text === item.text))).toBe(false)
  })

  it('measures classification quality and the high-confidence persistence gate', async () => {
    const corpus: JevSpeechActCorpus = {
      schemaVersion: 1,
      cases: [
        { id: 'preferred', speechAct: 'preferred', text: 'I would like concise paragraphs.' },
        { id: 'false-memory', speechAct: 'none', text: 'Write a new README.' },
        { id: 'asked-low-confidence', speechAct: 'asked', text: 'Which memory layers can Athena search?' },
        { id: 'fallback', speechAct: 'considered', text: 'Maybe we could add a weekly review.' },
      ],
    }
    const classify = vi.fn(async (text: string): Promise<DecisionResult<RecallRouteDecision>> => {
      if (text === 'I would like concise paragraphs.') return decision('preferred', 0.99)
      if (text === 'Write a new README.') return decision('promised', 0.92)
      if (text.startsWith('Which memory')) return decision('asked', 0.6)
      return { status: 'fallback', reason: 'unavailable' }
    })
    const router: RecallIntentRouter = { classify }

    const report = await evaluateJevSpeechActCorpus(corpus, router)

    expect(classify).toHaveBeenCalledTimes(4)
    expect(report).toMatchObject({
      total: 4,
      completed: 3,
      fallbackCount: 1,
      correct: 2,
      accuracy: 2 / 3,
      coverage: 0.75,
      persistedEligible: 1,
      persistedCorrect: 1,
      persistedActPrecision: 1,
      persistedActCoverage: 0.25,
      errors: [{ id: 'false-memory', expected: 'none', predicted: 'promised', confidence: 0.92 }],
      fallbackReasons: { unavailable: 1 },
      confidenceFrontier: {
        '0.85': { selected: 2, correct: 1, precision: 0.5, coverage: 0.5 },
        '0.9': { selected: 2, correct: 1, precision: 0.5, coverage: 0.5 },
        '0.95': { selected: 1, correct: 1, precision: 1, coverage: 0.25 },
        '0.98': { selected: 1, correct: 1, precision: 1, coverage: 0.25 },
      },
    })
    expect(formatJevSpeechActEvaluation(report)).toContain('High-confidence persisted-label precision: 100.0% (1/1)')
    expect(formatJevSpeechActEvaluation(report)).toContain('All-label confidence >= 0.95: exact precision 100.0% (1/1); coverage: 25.0%')
    expect(formatJevSpeechActEvaluation(report)).toContain('Misclassified synthetic IDs: false-memory(none->promised,0.92)')
  })
})
