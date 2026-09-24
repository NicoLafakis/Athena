import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJevRecallRouter, JEV_MODEL, RECALL_ROUTES, type RecallIntentRouter, type RecallRoute, type RecallRouteDecision } from '../src/decision/jev.js'
import { ANSWER_RECALL_MIN_CONFIDENCE } from '../src/continuity/answer-recall.js'
import type { DecisionResult } from '../src/decision/client.js'
import { loadRecallCorpus, type RecallCorpus } from './jev-recall-intent-baseline.js'

export type RecallEvaluationCorpus = RecallCorpus

/** Checked against TypeSafe's published model page on 2026-09-23; refresh before
 * interpreting later runs because provider pricing can change independently. */
const INPUT_USD_PER_MILLION_TOKENS = 0.042

export interface RecallEvaluationReport {
  total: number
  completed: number
  fallbackCount: number
  correct: number
  accuracy: number
  coverage: number
  actionConfidenceThreshold: number
  actionableDecisions: number
  actionableCorrect: number
  actionableAccuracy: number
  actionableCoverage: number
  noRecallFalsePositives: number
  noRecallDecided: number
  noRecallFalsePositiveRate: number
  actionableNoRecallFalsePositives: number
  actionableNoRecallDecided: number
  actionableNoRecallFalsePositiveRate: number
  confusion: Record<RecallRoute, Record<RecallRoute, number>>
  perRoute: Record<RecallRoute, { precision: number; recall: number; f1: number; support: number }>
  macroF1: number
  multiclassBrierScore: number
  medianLatencyMs: number
  inputTokens: number
  outputTokens: number
  estimatedInputCostUsd: number
}

const labels = RECALL_ROUTES

function isDecision<Output>(result: DecisionResult<Output>): result is Extract<DecisionResult<Output>, { status: 'decision' }> {
  return result.status === 'decision'
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!
}

export async function evaluateJevRecallCorpus(
  corpus: RecallEvaluationCorpus,
  router: RecallIntentRouter,
): Promise<RecallEvaluationReport> {
  const confusion = Object.fromEntries(labels.map((actual) => [
    actual,
    Object.fromEntries(labels.map((predicted) => [predicted, 0])),
  ])) as Record<RecallRoute, Record<RecallRoute, number>>
  const latencies: number[] = []
  let completed = 0
  let correct = 0
  let fallbackCount = 0
  let inputTokens = 0
  let outputTokens = 0
  let brierTotal = 0
  let actionableDecisions = 0
  let actionableCorrect = 0
  let actionableNoRecallFalsePositives = 0
  let actionableNoRecallDecided = 0

  for (const item of corpus.cases) {
    const started = performance.now()
    let result: DecisionResult<RecallRouteDecision>
    try {
      result = await router.classify(item.text)
    } catch {
      result = { status: 'fallback', reason: 'provider-error' }
    }
    latencies.push(Math.max(0, performance.now() - started))
    inputTokens += result.usage?.inputTokens ?? 0
    outputTokens += result.usage?.outputTokens ?? 0
    if (!isDecision(result)) {
      fallbackCount += 1
      continue
    }

    completed += 1
    const predicted = result.value.route
    confusion[item.intent][predicted] += 1
    if (predicted === item.intent) correct += 1
    if (result.value.confidence >= ANSWER_RECALL_MIN_CONFIDENCE) {
      actionableDecisions += 1
      if (predicted === item.intent) actionableCorrect += 1
      if (item.intent === 'none') {
        actionableNoRecallDecided += 1
        if (predicted !== 'none') actionableNoRecallFalsePositives += 1
      }
    }
    brierTotal += labels.reduce((sum, route) => {
      const observed = item.intent === route ? 1 : 0
      return sum + (result.value.probabilities[route] - observed) ** 2
    }, 0)
  }

  // Count only completed decisions in the no-recall denominator; a provider fallback
  // is not evidence that Jev correctly or incorrectly abstained.
  const noRecallDecided = labels.reduce((sum, actual) => sum + confusion.none[actual], 0)
  const noRecallFalsePositives = noRecallDecided - confusion.none.none
  const perRoute = Object.fromEntries(labels.map((route) => {
    const truePositive = confusion[route][route]
    const predictedCount = labels.reduce((sum, actual) => sum + confusion[actual][route], 0)
    const support = labels.reduce((sum, predicted) => sum + confusion[route][predicted], 0)
    const precision = predictedCount === 0 ? 0 : truePositive / predictedCount
    const recall = support === 0 ? 0 : truePositive / support
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    return [route, { precision, recall, f1, support }]
  })) as RecallEvaluationReport['perRoute']

  return {
    total: corpus.cases.length,
    completed,
    fallbackCount,
    correct,
    accuracy: completed === 0 ? 0 : correct / completed,
    coverage: corpus.cases.length === 0 ? 0 : completed / corpus.cases.length,
    actionConfidenceThreshold: ANSWER_RECALL_MIN_CONFIDENCE,
    actionableDecisions,
    actionableCorrect,
    actionableAccuracy: actionableDecisions === 0 ? 0 : actionableCorrect / actionableDecisions,
    actionableCoverage: corpus.cases.length === 0 ? 0 : actionableDecisions / corpus.cases.length,
    noRecallFalsePositives,
    noRecallDecided,
    noRecallFalsePositiveRate: noRecallDecided === 0 ? 0 : noRecallFalsePositives / noRecallDecided,
    actionableNoRecallFalsePositives,
    actionableNoRecallDecided,
    actionableNoRecallFalsePositiveRate: actionableNoRecallDecided === 0
      ? 0
      : actionableNoRecallFalsePositives / actionableNoRecallDecided,
    confusion,
    perRoute,
    macroF1: labels.reduce((sum, route) => sum + perRoute[route].f1, 0) / labels.length,
    multiclassBrierScore: completed === 0 ? 0 : brierTotal / (completed * labels.length),
    medianLatencyMs: median(latencies),
    inputTokens,
    outputTokens,
    estimatedInputCostUsd: inputTokens * INPUT_USD_PER_MILLION_TOKENS / 1_000_000,
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function formatJevRecallEvaluation(report: RecallEvaluationReport): string {
  const rows = labels.map((route) => {
    const metric = report.perRoute[route]
    return `| ${route} | ${metric.support} | ${formatPercent(metric.precision)} | ${formatPercent(metric.recall)} | ${formatPercent(metric.f1)} |`
  })
  const confusionRows = labels.map((actual) =>
    `| ${actual} | ${labels.map((predicted) => report.confusion[actual][predicted]).join(' | ')} |`,
  )
  return [
    `Actionable at confidence >= ${report.actionConfidenceThreshold}: ${report.actionableDecisions}/${report.total} (${formatPercent(report.actionableCoverage)}); accuracy ${formatPercent(report.actionableAccuracy)} (${report.actionableCorrect}/${report.actionableDecisions})`,
    `Actionable no-recall false positives: ${report.actionableNoRecallFalsePositives}/${report.actionableNoRecallDecided} (${formatPercent(report.actionableNoRecallFalsePositiveRate)})`,
    `Model: ${JEV_MODEL}`,
    `Cases: ${report.total}; decisions: ${report.completed}; fallbacks: ${report.fallbackCount}; coverage: ${formatPercent(report.coverage)}`,
    `Accuracy on decisions: ${formatPercent(report.accuracy)} (${report.correct}/${report.completed})`,
    `No-recall false positives: ${report.noRecallFalsePositives}/${report.noRecallDecided} (${formatPercent(report.noRecallFalsePositiveRate)})`,
    `Macro F1: ${formatPercent(report.macroF1)}; multiclass Brier score: ${report.multiclassBrierScore.toFixed(4)}`,
    `Median latency: ${report.medianLatencyMs.toFixed(1)} ms; input tokens: ${report.inputTokens}; output tokens: ${report.outputTokens}`,
    `Estimated input cost: $${report.estimatedInputCostUsd.toFixed(8)} at $${INPUT_USD_PER_MILLION_TOKENS}/million input tokens (price checked 2026-09-23)`,
    '',
    '| Route | Support | Precision | Recall | F1 |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    '',
    `Confusion matrix (rows: expected; columns: predicted in order ${labels.join(', ')}):`,
    '',
    `| Expected | ${labels.join(' | ')} |`,
    `|---|${labels.map(() => '---:').join('|')}|`,
    ...confusionRows,
  ].join('\n')
}

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim()
  if (!apiKey) {
    console.error('Set TYPESAFE_API_KEY to run the synthetic Jev evaluation; no requests were sent.')
    process.exitCode = 2
    return
  }
  const router = createJevRecallRouter({ apiKey })
  const report = await evaluateJevRecallCorpus(loadRecallCorpus(), router)
  console.log(formatJevRecallEvaluation(report))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
