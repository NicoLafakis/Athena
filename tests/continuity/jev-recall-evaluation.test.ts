import { describe, expect, it, vi } from 'vitest'
import { JEV_MEMORY_SPEECH_ACTS, type RecallIntentRouter, type RecallRoute, type RecallRouteDecision } from '../../src/decision/jev.js'
import {
  evaluateJevRecallCorpus,
  formatJevRecallEvaluation,
  type RecallEvaluationCorpus,
} from '../../bench/jev-recall-evaluation.js'

const labels: RecallRoute[] = [
  'none',
  'continue-current',
  'temporal-recall',
  'topic-recall',
  'preference-or-fact',
  'historical-decision',
  'similar-work',
]

function probabilities(route: RecallRoute): Record<RecallRoute, number> {
  return Object.fromEntries(labels.map((label) => [label, label === route ? 1 : 0])) as Record<RecallRoute, number>
}

const speechActProbabilities = Object.fromEntries(
  JEV_MEMORY_SPEECH_ACTS.map((act) => [act, act === 'none' ? 1 : 0]),
) as RecallRouteDecision['speechAct']['probabilities']

describe('Jev recall evaluation', () => {
  it('reports decision quality, fallback coverage, latency, tokens, and estimated cost', async () => {
    const corpus: RecallEvaluationCorpus = {
      schemaVersion: 1,
      asOf: '2026-09-23T12:00:00.000Z',
      cases: [
        { id: 'ordinary', intent: 'none', text: 'Write a new README.' },
        { id: 'memory', intent: 'none', text: 'What did we decide last week?' },
        { id: 'temporal', intent: 'temporal-recall', text: 'What happened yesterday?' },
      ],
    }
    const classify = vi.fn(async (text: string) => {
      if (text === 'Write a new README.') {
        return {
          status: 'fallback',
          reason: 'invalid-response',
          usage: { inputTokens: 4, outputTokens: 1 },
        } as const
      }
      const route: RecallRoute = text === 'What did we decide last week?' ? 'temporal-recall' : 'temporal-recall'
      return {
        status: 'decision',
        value: {
          route,
          confidence: text === 'What did we decide last week?' ? 0.9 : 0.84,
          probabilities: probabilities(route),
          speechAct: { act: 'none', confidence: 1, probabilities: speechActProbabilities },
        },
        usage: { inputTokens: 11, outputTokens: 0 },
      } as const
    })
    const router: RecallIntentRouter = { classify }

    const report = await evaluateJevRecallCorpus(corpus, router)

    expect(classify).toHaveBeenCalledTimes(3)
    expect(report).toMatchObject({
      total: 3,
      completed: 2,
      fallbackCount: 1,
      correct: 1,
      accuracy: 0.5,
      coverage: 2 / 3,
      actionConfidenceThreshold: 0.85,
      actionableDecisions: 1,
      actionableCorrect: 0,
      actionableCoverage: 1 / 3,
      actionableNoRecallFalsePositives: 1,
      actionableNoRecallDecided: 1,
      noRecallFalsePositives: 1,
      noRecallDecided: 1,
      misclassifications: [{
        id: 'memory',
        expected: 'none',
        predicted: 'temporal-recall',
        confidence: 0.9,
      }],
      actionablePerRoute: {
        'temporal-recall': { precision: 0, predictions: 1, correct: 0 },
      },
      inputTokens: 26,
      outputTokens: 1,
    })
    expect(report.estimatedInputCostUsd).toBeCloseTo(0.000001092, 15)
    expect(report.medianLatencyMs).toBeGreaterThanOrEqual(0)
    expect(report.multiclassBrierScore).toBeGreaterThanOrEqual(0)
    expect(formatJevRecallEvaluation(report)).toContain('Actionable no-recall false positives: 1/1 (100.0%)')
    expect(formatJevRecallEvaluation(report)).toContain('memory: none -> temporal-recall (0.90)')
    expect(formatJevRecallEvaluation(report)).toContain('| temporal-recall | 1 | 50.0% | 100.0% | 66.7% | 0.0% | 0/1 |')
  })
})
