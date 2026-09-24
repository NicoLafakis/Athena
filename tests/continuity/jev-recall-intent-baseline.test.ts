import { describe, expect, it } from 'vitest'
import {
  evaluateRecallBaseline,
  loadRecallCorpus,
  RecallRouteSchema,
} from '../../bench/jev-recall-intent-baseline.js'

describe('Jev recall-intent evaluation baseline', () => {
  const corpus = loadRecallCorpus()

  it('keeps the synthetic corpus balanced across all seven implemented route labels', () => {
    expect(corpus.cases).toHaveLength(56)
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(56)

    for (const route of RecallRouteSchema.options) {
      expect(corpus.cases.filter((item) => item.intent === route)).toHaveLength(8)
    }
  })

  it('treats a time period as scope when the request targets a specific decision', () => {
    expect(corpus.cases.find((item) => item.id === 'time-last-quarter')?.intent).toBe('historical-decision')
  })

  it('keeps the expanded phrasing regression corpus balanced and disjoint from calibration', () => {
    const holdout = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-holdout.v1.json', import.meta.url))
    expect(holdout.cases).toHaveLength(21)
    expect(new Set(holdout.cases.map((item) => item.id)).size).toBe(21)
    expect(holdout.cases.some((item) => corpus.cases.some((calibration) => calibration.id === item.id))).toBe(false)
    expect(holdout.cases.some((item) => corpus.cases.some((calibration) => calibration.text === item.text))).toBe(false)

    for (const route of RecallRouteSchema.options) {
      expect(holdout.cases.filter((item) => item.intent === route)).toHaveLength(3)
    }
  })

  it('keeps a new independent balanced holdout separate from every tuning corpus', () => {
    const independent = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-independent-holdout.v1.json', import.meta.url))
    const priorHoldout = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-holdout.v1.json', import.meta.url))
    const boundaryCalibration = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-boundary-calibration.v1.json', import.meta.url))
    const boundaryDevelopment = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-boundary-development.v1.json', import.meta.url))
    const boundaryValidation = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-boundary-validation.v1.json', import.meta.url))
    const audit = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-audit.v1.json', import.meta.url))
    const tuningCases = [...corpus.cases, ...priorHoldout.cases, ...boundaryCalibration.cases, ...boundaryDevelopment.cases, ...boundaryValidation.cases, ...audit.cases]

    expect(independent.cases).toHaveLength(21)
    expect(new Set(independent.cases.map((item) => item.id)).size).toBe(21)
    expect(new Set(independent.cases.map((item) => item.text)).size).toBe(21)
    expect(independent.cases.some((item) => tuningCases.some((known) => known.id === item.id || known.text === item.text))).toBe(false)
    for (const route of RecallRouteSchema.options) {
      expect(independent.cases.filter((item) => item.intent === route)).toHaveLength(3)
    }
  })

  it('keeps all boundary development sets balanced and pairwise disjoint', () => {
    const holdout = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-holdout.v1.json', import.meta.url))
    const boundaryCalibration = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-boundary-calibration.v1.json', import.meta.url))
    const boundaryDevelopment = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-boundary-development.v1.json', import.meta.url))
    const boundaryValidation = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-boundary-validation.v1.json', import.meta.url))
    const audit = loadRecallCorpus(new URL('../fixtures/continuity/jev-recall-intent-audit.v1.json', import.meta.url))
    const allCases = [...corpus.cases, ...holdout.cases, ...boundaryCalibration.cases, ...boundaryDevelopment.cases, ...boundaryValidation.cases, ...audit.cases]

    expect(boundaryCalibration.cases).toHaveLength(42)
    expect(boundaryDevelopment.cases).toHaveLength(42)
    expect(boundaryValidation.cases).toHaveLength(42)
    expect(audit.cases).toHaveLength(42)
    expect(new Set(allCases.map((item) => item.id)).size).toBe(allCases.length)
    expect(new Set(allCases.map((item) => item.text)).size).toBe(allCases.length)

    for (const route of RecallRouteSchema.options) {
      expect(boundaryCalibration.cases.filter((item) => item.intent === route)).toHaveLength(6)
      expect(boundaryDevelopment.cases.filter((item) => item.intent === route)).toHaveLength(6)
      expect(boundaryValidation.cases.filter((item) => item.intent === route)).toHaveLength(6)
      expect(audit.cases.filter((item) => item.intent === route)).toHaveLength(6)
    }
  })

  it('records the current local ranking-intent behavior without presenting it as a router', () => {
    const report = evaluateRecallBaseline(corpus)

    expect(report).toMatchObject({
      total: 56,
      correct: 31,
      accuracy: 31 / 56,
      noRecallFalsePositives: 8,
      noRecallCases: 8,
      noRecallFalsePositiveRate: 1,
    })
    expect(report.confusion).toMatchObject({
      none: { none: 0, 'temporal-recall': 1, 'topic-recall': 6, 'historical-decision': 1 },
      'continue-current': { 'continue-current': 4, 'topic-recall': 4 },
      'temporal-recall': { 'temporal-recall': 8 },
      'topic-recall': { 'topic-recall': 8 },
      'preference-or-fact': { 'topic-recall': 2, 'preference-or-fact': 6 },
      'historical-decision': { 'topic-recall': 3, 'historical-decision': 5 },
      'similar-work': { 'topic-recall': 6, 'preference-or-fact': 2 },
    })
    expect(report.perIntent['similar-work'].recall).toBe(0)
    expect(report.macroF1).toBeCloseTo(0.501, 3)
  })
})
