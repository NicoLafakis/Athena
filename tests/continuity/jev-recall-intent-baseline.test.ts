import { describe, expect, it } from 'vitest'
import {
  evaluateRecallBaseline,
  loadRecallCorpus,
  RecallRouteSchema,
} from '../../bench/jev-recall-intent-baseline.js'

describe('Jev recall-intent evaluation baseline', () => {
  const corpus = loadRecallCorpus()

  it('keeps the synthetic corpus balanced across all seven proposed routes', () => {
    expect(corpus.cases).toHaveLength(49)
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(49)

    for (const route of RecallRouteSchema.options) {
      expect(corpus.cases.filter((item) => item.intent === route)).toHaveLength(7)
    }
  })

  it('records the current local ranking-intent behavior without presenting it as a router', () => {
    const report = evaluateRecallBaseline(corpus)

    expect(report).toMatchObject({
      total: 49,
      correct: 25,
      accuracy: 25 / 49,
      noRecallFalsePositives: 7,
      noRecallCases: 7,
      noRecallFalsePositiveRate: 1,
    })
    expect(report.confusion).toMatchObject({
      none: { none: 0, 'topic-recall': 6, 'historical-decision': 1 },
      'continue-current': { 'continue-current': 3, 'topic-recall': 4 },
      'temporal-recall': { 'temporal-recall': 6, 'historical-decision': 1 },
      'topic-recall': { 'topic-recall': 7 },
      'preference-or-fact': { 'topic-recall': 2, 'preference-or-fact': 5 },
      'historical-decision': { 'topic-recall': 3, 'historical-decision': 4 },
      'similar-work': { 'topic-recall': 5, 'preference-or-fact': 2 },
    })
    expect(report.perIntent['similar-work'].recall).toBe(0)
    expect(report.macroF1).toBeCloseTo(0.466, 3)
  })
})
