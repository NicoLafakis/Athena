import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { rankContinuityLayers, type RecallIntent } from '../src/continuity/ranking.js'
import { resolveTemporalWindow } from '../src/continuity/time.js'

export const RecallRouteSchema = z.enum([
  'none',
  'continue-current',
  'temporal-recall',
  'topic-recall',
  'preference-or-fact',
  'historical-decision',
  'similar-work',
])

const RecallCaseSchema = z.object({
  id: z.string().min(1),
  intent: RecallRouteSchema,
  text: z.string().min(1),
})

const RecallCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  asOf: z.string().datetime({ offset: true }),
  cases: z.array(RecallCaseSchema).min(1),
})

export type RecallRoute = z.infer<typeof RecallRouteSchema>
export type RecallCase = z.infer<typeof RecallCaseSchema>
export type RecallCorpus = z.infer<typeof RecallCorpusSchema>

export interface RecallBaselineReport {
  total: number
  correct: number
  accuracy: number
  noRecallFalsePositives: number
  noRecallCases: number
  noRecallFalsePositiveRate: number
  confusion: Record<RecallRoute, Record<RecallRoute, number>>
  perIntent: Record<RecallRoute, { precision: number; recall: number; f1: number; support: number }>
  macroF1: number
}

const labels = RecallRouteSchema.options

export function loadRecallCorpus(source?: string | URL): RecallCorpus {
  const path = source
    ? (source instanceof URL ? fileURLToPath(source) : source)
    : fileURLToPath(new URL('../tests/fixtures/continuity/jev-recall-intent.v1.json', import.meta.url))
  return RecallCorpusSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

function localIntentRoute(intent: RecallIntent, hasResolvedTime: boolean): RecallRoute {
  switch (intent) {
    case 'continuation': return 'continue-current'
    case 'temporal': return 'temporal-recall'
    case 'summary': return hasResolvedTime ? 'temporal-recall' : 'topic-recall'
    case 'decision': return 'historical-decision'
    case 'preference':
    case 'fact': return 'preference-or-fact'
    case 'topic': return 'topic-recall'
  }
}

export function classifyWithCurrentLocalIntent(query: string, now: Date): RecallRoute {
  const time = resolveTemporalWindow(query, { now, configuredTimeZone: 'UTC' })
  const ranking = rankContinuityLayers({
    query,
    ...(time.status === 'resolved' ? { window: time.window } : {}),
    now,
  })
  return localIntentRoute(ranking.intent, time.status === 'resolved')
}

export function evaluateRecallBaseline(corpus: RecallCorpus): RecallBaselineReport {
  const now = new Date(corpus.asOf)
  const confusion = Object.fromEntries(labels.map((actual) => [
    actual,
    Object.fromEntries(labels.map((predicted) => [predicted, 0])),
  ])) as Record<RecallRoute, Record<RecallRoute, number>>

  for (const item of corpus.cases) {
    const predicted = classifyWithCurrentLocalIntent(item.text, now)
    confusion[item.intent][predicted] += 1
  }

  const total = corpus.cases.length
  const correct = labels.reduce((sum, intent) => sum + confusion[intent][intent], 0)
  const noRecallCases = corpus.cases.filter((item) => item.intent === 'none').length
  const noRecallFalsePositives = noRecallCases - confusion.none.none
  const perIntent = Object.fromEntries(labels.map((intent) => {
    const truePositive = confusion[intent][intent]
    const predictedCount = labels.reduce((sum, actual) => sum + confusion[actual][intent], 0)
    const support = labels.reduce((sum, predicted) => sum + confusion[intent][predicted], 0)
    const precision = predictedCount === 0 ? 0 : truePositive / predictedCount
    const recall = support === 0 ? 0 : truePositive / support
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    return [intent, { precision, recall, f1, support }]
  })) as RecallBaselineReport['perIntent']

  return {
    total,
    correct,
    accuracy: total === 0 ? 0 : correct / total,
    noRecallFalsePositives,
    noRecallCases,
    noRecallFalsePositiveRate: noRecallCases === 0 ? 0 : noRecallFalsePositives / noRecallCases,
    confusion,
    perIntent,
    macroF1: labels.reduce((sum, intent) => sum + perIntent[intent].f1, 0) / labels.length,
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function formatRecallBaselineReport(report: RecallBaselineReport): string {
  const rows = labels.map((intent) => {
    const metric = report.perIntent[intent]
    return `| ${intent} | ${metric.support} | ${formatPercent(metric.precision)} | ${formatPercent(metric.recall)} | ${formatPercent(metric.f1)} |`
  })
  const confusionRows = labels.map((actual) =>
    `| ${actual} | ${labels.map((predicted) => report.confusion[actual][predicted]).join(' | ')} |`,
  )
  return [
    `Corpus cases: ${report.total}`,
    `Intent accuracy: ${formatPercent(report.accuracy)} (${report.correct}/${report.total})`,
    `No-recall false positives: ${report.noRecallFalsePositives}/${report.noRecallCases} (${formatPercent(report.noRecallFalsePositiveRate)})`,
    `Macro F1: ${formatPercent(report.macroF1)}`,
    '',
    '| Intent | Support | Precision | Recall | F1 |',
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const corpus = loadRecallCorpus()
  console.log(formatRecallBaselineReport(evaluateRecallBaseline(corpus)))
}
