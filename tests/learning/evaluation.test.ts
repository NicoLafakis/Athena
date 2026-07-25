import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { CandidateStore } from '../../src/learning/candidates.js'
import { LearningEvaluator } from '../../src/learning/evaluation.js'
import { PromotionManager } from '../../src/learning/promotion.js'
import {
  EvalSuiteSchema,
  LearningCandidateSchema,
} from '../../src/learning/types.js'

let root: string
let repo: string
let home: string

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-learning-'))
  repo = join(root, 'repo')
  home = join(root, 'home')
  execFileSync('git', ['init', repo], { windowsHide: true })
  git(['config', 'user.email', 'athena@example.invalid'])
  git(['config', 'user.name', 'Athena Test'])
  writeFileSync(join(repo, 'behavior.txt'), 'bad\n')
  git(['add', 'behavior.txt'])
  git(['commit', '-m', 'baseline'])
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('governed learning evaluation and promotion', () => {
  it('requires held-out LCB improvement, applies a canary, signs lineage, and rolls back', async () => {
    const paths = resolveBrainPaths({ cwd: repo, homeOverride: home })
    const id = randomUUID()
    const candidate = LearningCandidateSchema.parse({
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      sourceRunIds: ['source-run'],
      hypothesis: 'Changing the behavior marker from bad to good should make every held-out case pass.',
      target: 'code',
      patch:
        'diff --git a/behavior.txt b/behavior.txt\n' +
        '--- a/behavior.txt\n' +
        '+++ b/behavior.txt\n' +
        '@@ -1 +1 @@\n' +
        '-bad\n' +
        '+good\n',
      expectedMetricDelta: { taskSuccessRate: 1 },
      applicability: ['behavior marker fixture'],
      counterexamples: ['repositories without behavior.txt'],
      confidence: 0.8,
      provenance: {
        traceHashes: ['a'.repeat(64)],
        generator: 'test',
        generatorVersion: '1',
      },
      status: 'provisional',
    })
    new CandidateStore(paths).save(candidate)
    const command = [
      process.execPath,
      '-e',
      "process.exit(require('fs').readFileSync('behavior.txt','utf8').trim()==='good'?0:1)",
    ]
    const suite = EvalSuiteSchema.parse({
      schemaVersion: 1,
      id: 'heldout-fixture',
      cases: Array.from({ length: 5 }, (_, index) => ({
        id: `heldout-${index + 1}`,
        split: 'heldout',
        command,
        safetyInvariant: index === 0,
      })),
    })
    const evaluator = new LearningEvaluator(paths)
    const comparison = await evaluator.evaluate(candidate, suite, repo)
    expect(comparison.promotable).toBe(true)
    expect(comparison.pairedLowerConfidenceBound).toBe(1)
    expect(new CandidateStore(paths).load(id).status).toBe('evaluated')
    expect(readFileSync(join(repo, 'behavior.txt'), 'utf8')).toBe('bad\n')

    const promotions = new PromotionManager(paths)
    expect(() => promotions.promoteCanary(id, repo, false)).toThrow(/human approval/i)
    promotions.promoteCanary(id, repo, true)
    expect(readFileSync(join(repo, 'behavior.txt'), 'utf8').trim()).toBe('good')
    expect(new CandidateStore(paths).load(id).status).toBe('canary')
    expect(promotions.verifyLineage()).toMatchObject({ valid: true, records: 1 })

    const canary = await evaluator.runCanary(new CandidateStore(paths).load(id), suite, repo)
    promotions.finalize(id, canary.id, repo)
    expect(new CandidateStore(paths).load(id).status).toBe('promoted')
    promotions.rollback(id, repo)
    expect(readFileSync(join(repo, 'behavior.txt'), 'utf8').trim()).toBe('bad')
    expect(new CandidateStore(paths).load(id).status).toBe('rolled-back')
    expect(promotions.verifyLineage()).toMatchObject({ valid: true, records: 3 })

    const candidateFile = join(paths.learningCandidatesDir, `${id}.json`)
    const tampered = JSON.parse(readFileSync(candidateFile, 'utf8')) as Record<string, unknown>
    tampered['patch'] = `${String(tampered['patch'])}\n# tampered`
    writeFileSync(candidateFile, JSON.stringify(tampered))
    expect(promotions.verifyLineage()).toMatchObject({
      valid: false,
      error: expect.stringContaining('patch mismatch'),
    })
  }, 60_000)
})
