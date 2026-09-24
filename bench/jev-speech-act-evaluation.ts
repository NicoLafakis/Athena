import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createJevRecallRouter,
  JEV_MEMORY_SPEECH_ACTS,
  JEV_MODEL,
  type JevMemorySpeechAct,
  type RecallIntentRouter,
  type RecallRouteDecision,
} from '../src/decision/jev.js'
import type { DecisionFallbackReason, DecisionResult } from '../src/decision/client.js'
import { JEV_SPEECH_ACT_PERSISTENCE_CONFIDENCE } from '../src/continuity/schemas.js'
import {
  loadJevSpeechActCorpus,
  loadJevSpeechActHoldoutCorpus,
  type JevSpeechActCorpus,
} from './jev-speech-act-corpus.js'

const PERSISTED_ACTS: ReadonlySet<JevMemorySpeechAct> = new Set([
  'preferred', 'decided', 'promised', 'corrected', 'retracted',
])

export interface JevSpeechActEvaluationReport {
  total: number
  completed: number
  fallbackCount: number
  correct: number
  accuracy: number
  coverage: number
  confusion: Record<JevMemorySpeechAct, Record<JevMemorySpeechAct, number>>
  errors: Array<{ id: string; expected: JevMemorySpeechAct; predicted: JevMemorySpeechAct; confidence: number }>
  fallbackReasons: Partial<Record<DecisionFallbackReason, number>>
  perAct: Record<JevMemorySpeechAct, { precision: number; recall: number; f1: number; support: number }>
  confidenceFrontier: Record<'0.85' | '0.9' | '0.95' | '0.98', { selected: number; correct: number; precision: number; coverage: number }>
  persistedEligible: number
  persistedCorrect: number
  persistedActPrecision: number
  persistedActCoverage: number
  macroF1: number
  multiclassBrierScore: number
  medianLatencyMs: number
  inputTokens: number
  outputTokens: number
}

function isDecision<Output>(result: DecisionResult<Output>): result is Extract<DecisionResult<Output>, { status: 'decision' }> {
  return result.status === 'decision'
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!
}

export async function evaluateJevSpeechActCorpus(
  corpus: JevSpeechActCorpus,
  router: RecallIntentRouter,
): Promise<JevSpeechActEvaluationReport> {
  const labels = JEV_MEMORY_SPEECH_ACTS
  const confusion = Object.fromEntries(labels.map((expected) => [
    expected,
    Object.fromEntries(labels.map((predicted) => [predicted, 0])),
  ])) as Record<JevMemorySpeechAct, Record<JevMemorySpeechAct, number>>
  const latencies: number[] = []
  const errors: JevSpeechActEvaluationReport['errors'] = []
  const fallbackReasons: Partial<Record<DecisionFallbackReason, number>> = {}
  const thresholds = [0.85, 0.9, 0.95, 0.98] as const
  const frontier = Object.fromEntries(thresholds.map((threshold) => [String(threshold), { selected: 0, correct: 0 }])) as Record<'0.85' | '0.9' | '0.95' | '0.98', { selected: number; correct: number }>
  let completed = 0
  let correct = 0
  let fallbackCount = 0
  let persistedEligible = 0
  let persistedCorrect = 0
  let inputTokens = 0
  let outputTokens = 0
  let brierTotal = 0

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
      fallbackCount++
      fallbackReasons[result.reason] = (fallbackReasons[result.reason] ?? 0) + 1
      continue
    }

    completed++
    const predicted = result.value.speechAct.act
    confusion[item.speechAct][predicted]++
    if (predicted === item.speechAct) {
      correct++
    } else {
      errors.push({ id: item.id, expected: item.speechAct, predicted, confidence: result.value.speechAct.confidence })
    }
    for (const threshold of thresholds) {
      if (result.value.speechAct.confidence >= threshold) {
        const entry = frontier[String(threshold) as keyof typeof frontier]
        entry.selected++
        if (predicted === item.speechAct) entry.correct++
      }
    }
    if (result.value.speechAct.confidence >= JEV_SPEECH_ACT_PERSISTENCE_CONFIDENCE && PERSISTED_ACTS.has(predicted)) {
      persistedEligible++
      if (predicted === item.speechAct) persistedCorrect++
    }
    brierTotal += labels.reduce((sum, act) => {
      const observed = item.speechAct === act ? 1 : 0
      return sum + (result.value.speechAct.probabilities[act] - observed) ** 2
    }, 0)
  }

  const perAct = Object.fromEntries(labels.map((act) => {
    const truePositive = confusion[act][act]
    const predictedCount = labels.reduce((sum, expected) => sum + confusion[expected][act], 0)
    const support = labels.reduce((sum, predicted) => sum + confusion[act][predicted], 0)
    const precision = predictedCount === 0 ? 0 : truePositive / predictedCount
    const recall = support === 0 ? 0 : truePositive / support
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    return [act, { precision, recall, f1, support }]
  })) as JevSpeechActEvaluationReport['perAct']
  const confidenceFrontier = Object.fromEntries(thresholds.map((threshold) => {
    const key = String(threshold) as keyof typeof frontier
    const { selected, correct: thresholdCorrect } = frontier[key]
    return [key, {
      selected,
      correct: thresholdCorrect,
      precision: selected === 0 ? 0 : thresholdCorrect / selected,
      coverage: corpus.cases.length === 0 ? 0 : selected / corpus.cases.length,
    }]
  })) as JevSpeechActEvaluationReport['confidenceFrontier']

  return {
    total: corpus.cases.length,
    completed,
    fallbackCount,
    correct,
    accuracy: completed === 0 ? 0 : correct / completed,
    coverage: corpus.cases.length === 0 ? 0 : completed / corpus.cases.length,
    confusion,
    errors,
    fallbackReasons,
    perAct,
    confidenceFrontier,
    persistedEligible,
    persistedCorrect,
    persistedActPrecision: persistedEligible === 0 ? 0 : persistedCorrect / persistedEligible,
    persistedActCoverage: corpus.cases.length === 0 ? 0 : persistedEligible / corpus.cases.length,
    macroF1: labels.reduce((sum, act) => sum + perAct[act].f1, 0) / labels.length,
    multiclassBrierScore: completed === 0 ? 0 : brierTotal / (completed * labels.length),
    medianLatencyMs: median(latencies),
    inputTokens,
    outputTokens,
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function formatJevSpeechActEvaluation(report: JevSpeechActEvaluationReport): string {
  const labels = JEV_MEMORY_SPEECH_ACTS
  const rows = labels.map((act) => {
    const metric = report.perAct[act]
    return `| ${act} | ${metric.support} | ${percent(metric.precision)} | ${percent(metric.recall)} | ${percent(metric.f1)} |`
  })
  const confusionRows = labels.map((expected) =>
    `| ${expected} | ${labels.map((predicted) => report.confusion[expected][predicted]).join(' | ')} |`,
  )
  return [
    `Model: ${JEV_MODEL}`,
    `Cases: ${report.total}; decisions: ${report.completed}; fallbacks: ${report.fallbackCount}; coverage: ${percent(report.coverage)}`,
    `Accuracy: ${percent(report.accuracy)} (${report.correct}/${report.completed}); macro F1: ${percent(report.macroF1)}; Brier score: ${report.multiclassBrierScore.toFixed(4)}`,
    `High-confidence persisted-label precision: ${percent(report.persistedActPrecision)} (${report.persistedCorrect}/${report.persistedEligible}); coverage: ${percent(report.persistedActCoverage)}`,
    ...Object.entries(report.confidenceFrontier).map(([threshold, metric]) =>
      `All-label confidence >= ${threshold}: exact precision ${percent(metric.precision)} (${metric.correct}/${metric.selected}); coverage: ${percent(metric.coverage)}`),
    `Fallbacks by reason: ${JSON.stringify(report.fallbackReasons)}`,
    `Misclassified synthetic IDs: ${report.errors.length === 0 ? 'none' : report.errors.map(({ id, expected, predicted, confidence }) => `${id}(${expected}->${predicted},${confidence.toFixed(2)})`).join(', ')}`,
    `Median latency: ${report.medianLatencyMs.toFixed(1)} ms; input tokens: ${report.inputTokens}; output tokens: ${report.outputTokens}`,
    '',
    '| Speech act | Support | Precision | Recall | F1 |',
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
    console.error('Set TYPESAFE_API_KEY to run the synthetic Jev speech-act evaluation; no requests were sent.')
    process.exitCode = 2
    return
  }
  const router = createJevRecallRouter({ apiKey })
  for (const [name, corpus] of [
    ['Calibration', loadJevSpeechActCorpus()],
    ['Holdout', loadJevSpeechActHoldoutCorpus()],
  ] as const) {
    const report = await evaluateJevSpeechActCorpus(corpus, router)
    console.log(`${name} corpus`)
    console.log(formatJevSpeechActEvaluation(report))
    console.log('')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
