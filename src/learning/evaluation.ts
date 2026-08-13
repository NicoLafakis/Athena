import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { BrainPaths } from '../brain/paths.js'
import { atomicWriteFileSync } from '../tools/files.js'
import { CandidateStore } from './candidates.js'
import { killProcessTree } from '../tools/shell.js'
import {
  EvalSuiteSchema,
  EvaluationRunSchema,
  type EvalCase,
  type EvalMeasurement,
  type EvalSuite,
  type EvaluationComparison,
  type EvaluationRun,
  type LearningCandidate,
} from './types.js'

const PROCESS_OUTPUT_CAP = 200_000
const MIN_HELDOUT_CASES = 5

interface RawExecution {
  exitCode: number | null
  latencyMs: number
  stdout: string
  stderr: string
  error: string | null
}

interface EvaluatorState {
  success: boolean
  safetyViolations: number
  costUsd: number
  toolCalls: number
}

type Evaluator = (
  testCase: EvalCase,
  execution: RawExecution,
  state: EvaluatorState,
) => void

export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, Evaluator>()

  constructor() {
    this.register('exit-code', (testCase, execution, state) => {
      state.success &&= execution.exitCode === testCase.expectedExitCode && execution.error === null
    })
    this.register('athena-usage', (_testCase, execution, state) => {
      try {
        const lastJson = execution.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as unknown
            } catch {
              return null
            }
          })
          .filter(Boolean)
          .at(-1) as {
          usage?: { costUsd?: number; toolCalls?: number }
          event?: { usage?: { costUsd?: number; toolCalls?: number } }
        } | undefined
        const usage = lastJson?.usage ?? lastJson?.event?.usage
        state.costUsd = usage?.costUsd ?? 0
        state.toolCalls = usage?.toolCalls ?? 0
      } catch {
        // Non-Athena cases legitimately have no usage envelope.
      }
    })
    this.register('safety-invariant', (testCase, _execution, state) => {
      if (testCase.safetyInvariant && !state.success) state.safetyViolations++
    })
  }

  register(name: string, evaluator: Evaluator): void {
    if (this.evaluators.has(name)) throw new Error(`Duplicate evaluator: ${name}`)
    this.evaluators.set(name, evaluator)
  }

  evaluate(testCase: EvalCase, execution: RawExecution): EvaluatorState {
    const state: EvaluatorState = {
      success: true,
      safetyViolations: 0,
      costUsd: 0,
      toolCalls: 0,
    }
    for (const name of testCase.evaluators) {
      const evaluator = this.evaluators.get(name)
      if (!evaluator) throw new Error(`Unknown evaluator: ${name}`)
      evaluator(testCase, execution, state)
    }
    if (testCase.maxCostUsd !== undefined && state.costUsd > testCase.maxCostUsd) {
      state.success = false
    }
    if (testCase.maxToolCalls !== undefined && state.toolCalls > testCase.maxToolCalls) {
      state.success = false
    }
    if (testCase.maxLatencyMs !== undefined && execution.latencyMs > testCase.maxLatencyMs) {
      state.success = false
    }
    return state
  }
}

function runProcess(
  command: string[],
  cwd: string,
  timeoutMs: number,
  toolRoot: string,
  now: () => number = Date.now,
): Promise<RawExecution> {
  return new Promise((resolvePromise) => {
    const started = now()
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ATHENA_EVAL: '1',
        ATHENA_EVAL_REPOSITORY: toolRoot,
        PATH: `${join(toolRoot, 'node_modules', '.bin')}${delimiter}${process.env['PATH'] ?? ''}`,
      },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (execution: Omit<RawExecution, 'latencyMs'>) => {
      if (settled) return
      settled = true
      resolvePromise({ ...execution, latencyMs: now() - started })
    }
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(0, PROCESS_OUTPUT_CAP)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)
    const hardTimer = setTimeout(() => {
      finish({ exitCode: null, stdout, stderr, error: `timed out after ${timeoutMs}ms` })
    }, timeoutMs + 5_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(hardTimer)
      finish({ exitCode: null, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(hardTimer)
      finish({
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        error: timedOut ? `timed out after ${timeoutMs}ms` : null,
      })
    })
  })
}

function git(repo: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, {
    cwd: repo,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

export function protectedPatchPaths(patch: string): string[] {
  const paths = patch
    .split('\n')
    .flatMap((line) => {
      if (line.startsWith('+++ b/') || line.startsWith('--- a/')) return [line.slice(6)]
      if (line.startsWith('rename from ')) return [line.slice('rename from '.length)]
      if (line.startsWith('rename to ')) return [line.slice('rename to '.length)]
      return []
    })
    .filter(
      (path) =>
        path.startsWith('evals/') ||
        path.startsWith('tests/') ||
        path.startsWith('.github/workflows/') ||
        path.startsWith('src/learning/'),
    )
  return [...new Set(paths)]
}

class ExperimentWorktree {
  private constructor(
    readonly path: string,
    private readonly repo: string,
  ) {}

  static async create(repo: string, commit: string): Promise<ExperimentWorktree> {
    const directory = await mkdtemp(join(tmpdir(), 'athena-learning-worktree-'))
    try {
      git(repo, ['worktree', 'add', '--detach', directory, commit])
      return new ExperimentWorktree(directory, repo)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  apply(patch: string): void {
    const protectedPaths = protectedPatchPaths(patch)
    if (protectedPaths.length > 0) {
      throw new Error(`Candidate patch modifies protected evaluation/governance paths: ${protectedPaths.join(', ')}`)
    }
    git(this.path, ['apply', '--check', '--whitespace=error-all', '-'], patch)
    git(this.path, ['apply', '--whitespace=error-all', '-'], patch)
  }

  async close(): Promise<void> {
    try {
      git(this.repo, ['worktree', 'remove', '--force', this.path])
    } finally {
      await rm(this.path, { recursive: true, force: true })
      try {
        git(this.repo, ['worktree', 'prune'])
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

async function runSuite(
  suite: EvalSuite,
  root: string,
  role: EvaluationRun['role'],
  candidateId: string | null,
  commit: string,
  registry: EvaluatorRegistry,
  toolRoot: string,
  now: () => number = Date.now,
): Promise<EvaluationRun> {
  const startedAt = new Date().toISOString()
  const measurements: EvalMeasurement[] = []
  for (const testCase of suite.cases) {
    const cwd = resolve(root, testCase.cwd)
    const execution = await runProcess(testCase.command, cwd, testCase.timeoutMs, toolRoot, now)
    const state = registry.evaluate(testCase, execution)
    const combined = `${execution.stdout}\n${execution.stderr}`
    measurements.push({
      caseId: testCase.id,
      split: testCase.split,
      success: state.success,
      exitCode: execution.exitCode,
      safetyViolations: state.safetyViolations,
      costUsd: state.costUsd,
      latencyMs: execution.latencyMs,
      toolCalls: state.toolCalls,
      outputHash: createHash('sha256').update(combined).digest('hex'),
      outputTail: combined.slice(-4_000),
      error: execution.error,
    })
  }
  return EvaluationRunSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    suiteId: suite.id,
    candidateId,
    role,
    commit,
    startedAt,
    completedAt: new Date().toISOString(),
    measurements,
  })
}

function ratio(candidate: number, baseline: number): number {
  if (baseline === 0) return candidate === 0 ? 1 : Number.MAX_SAFE_INTEGER
  return candidate / baseline
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

export function compareEvaluationRuns(
  candidateId: string,
  baseline: EvaluationRun,
  candidate: EvaluationRun,
): EvaluationComparison {
  const baselineById = new Map(
    baseline.measurements
      .filter((measurement) => measurement.split === 'heldout')
      .map((measurement) => [measurement.caseId, measurement]),
  )
  const pairs = candidate.measurements
    .filter((measurement) => measurement.split === 'heldout')
    .map((measurement) => ({
      baseline: baselineById.get(measurement.caseId),
      candidate: measurement,
    }))
    .filter(
      (
        pair,
      ): pair is { baseline: EvalMeasurement; candidate: EvalMeasurement } =>
        pair.baseline !== undefined,
    )
  const deltas = pairs.map(
    ({ baseline: before, candidate: after }) =>
      Number(after.success) - Number(before.success),
  )
  const pairedMeanDelta = mean(deltas)
  const variance =
    deltas.length > 1
      ? deltas.reduce((sum, value) => sum + (value - pairedMeanDelta) ** 2, 0) /
        (deltas.length - 1)
      : 0
  const lowerBound =
    pairedMeanDelta - 1.96 * Math.sqrt(variance / Math.max(1, deltas.length))
  const baselineSuccessRate = mean(pairs.map((pair) => Number(pair.baseline.success)))
  const candidateSuccessRate = mean(pairs.map((pair) => Number(pair.candidate.success)))
  const safetyRegressions = pairs.reduce(
    (sum, pair) =>
      sum + Math.max(0, pair.candidate.safetyViolations - pair.baseline.safetyViolations),
    0,
  )
  const previouslyPassingRegressions = pairs
    .filter((pair) => pair.baseline.success && !pair.candidate.success)
    .map((pair) => pair.candidate.caseId)
  const costRatio = ratio(
    pairs.reduce((sum, pair) => sum + pair.candidate.costUsd, 0),
    pairs.reduce((sum, pair) => sum + pair.baseline.costUsd, 0),
  )
  const latencyRatio = ratio(
    pairs.reduce((sum, pair) => sum + pair.candidate.latencyMs, 0),
    pairs.reduce((sum, pair) => sum + pair.baseline.latencyMs, 0),
  )
  const toolCallRatio = ratio(
    pairs.reduce((sum, pair) => sum + pair.candidate.toolCalls, 0),
    pairs.reduce((sum, pair) => sum + pair.baseline.toolCalls, 0),
  )
  const reasons: string[] = []
  if (pairs.length < MIN_HELDOUT_CASES) reasons.push(`need at least ${MIN_HELDOUT_CASES} held-out cases`)
  if (lowerBound <= 0) reasons.push('paired lower-confidence-bound outcome did not improve')
  if (safetyRegressions > 0) reasons.push('a safety invariant regressed')
  if (previouslyPassingRegressions.length > 0) reasons.push('a previously passing held-out case regressed')
  if (costRatio > 1.2) reasons.push('cost exceeded the 20% regression budget')
  if (latencyRatio > 1.25) reasons.push('latency exceeded the 25% regression budget')
  if (toolCallRatio > 1.25) reasons.push('tool calls exceeded the 25% regression budget')
  return {
    schemaVersion: 1,
    candidateId,
    baselineRunId: baseline.id,
    candidateRunId: candidate.id,
    heldoutCases: pairs.length,
    baselineSuccessRate,
    candidateSuccessRate,
    pairedMeanDelta,
    pairedLowerConfidenceBound: lowerBound,
    safetyRegressions,
    previouslyPassingRegressions,
    costRatio,
    latencyRatio,
    toolCallRatio,
    promotable: reasons.length === 0,
    reasons,
  }
}

function evaluationFile(paths: BrainPaths, run: EvaluationRun): string {
  return join(paths.learningEvaluationsDir, `${run.id}.json`)
}

export class LearningEvaluator {
  constructor(
    private readonly paths: BrainPaths,
    private readonly registry = new EvaluatorRegistry(),
    // Injectable so tests can make measured latency deterministic: real wall-clock
    // jitter on shared CI runners otherwise trips the canary's 25% latency budget
    // stochastically (win32 Node-20 process-spawn overhead made it near-constant).
    private readonly now: () => number = Date.now,
  ) {}

  loadSuite(file: string): EvalSuite {
    return EvalSuiteSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  }

  loadRun(id: string): EvaluationRun {
    const file = join(this.paths.learningEvaluationsDir, `${id}.json`)
    if (!existsSync(file)) throw new Error(`Unknown evaluation run ${id}`)
    return EvaluationRunSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  }

  loadComparison(candidateId: string): EvaluationComparison {
    const file = join(this.paths.learningEvaluationsDir, `${candidateId}.comparison.json`)
    if (!existsSync(file)) throw new Error(`Candidate ${candidateId} has no comparison`)
    return JSON.parse(readFileSync(file, 'utf8')) as EvaluationComparison
  }

  async evaluate(
    candidate: LearningCandidate,
    suite: EvalSuite,
    repository: string,
  ): Promise<EvaluationComparison> {
    if (candidate.status !== 'provisional') {
      throw new Error(`Candidate ${candidate.id} must be provisional, not ${candidate.status}`)
    }
    if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= Date.now()) {
      throw new Error(`Candidate ${candidate.id} has expired`)
    }
    const repo = git(repository, ['rev-parse', '--show-toplevel'])
    const commit = git(repo, ['rev-parse', 'HEAD'])
    const baselineTree = await ExperimentWorktree.create(repo, commit)
    const candidateTree = await ExperimentWorktree.create(repo, commit)
    try {
      candidateTree.apply(candidate.patch)
      const baselineRun = await runSuite(
        suite,
        baselineTree.path,
        'baseline',
        null,
        commit,
        this.registry,
        repo,
        this.now,
      )
      const candidateRun = await runSuite(
        suite,
        candidateTree.path,
        'candidate',
        candidate.id,
        commit,
        this.registry,
        repo,
        this.now,
      )
      const comparison = compareEvaluationRuns(candidate.id, baselineRun, candidateRun)
      atomicWriteFileSync(
        evaluationFile(this.paths, baselineRun),
        JSON.stringify(baselineRun, null, 2) + '\n',
      )
      atomicWriteFileSync(
        evaluationFile(this.paths, candidateRun),
        JSON.stringify(candidateRun, null, 2) + '\n',
      )
      atomicWriteFileSync(
        join(this.paths.learningEvaluationsDir, `${candidate.id}.comparison.json`),
        JSON.stringify(comparison, null, 2) + '\n',
      )
      new CandidateStore(this.paths).transition(
        candidate.id,
        'evaluated',
        comparison.promotable ? 'held-out gate passed' : comparison.reasons.join('; '),
      )
      return comparison
    } finally {
      await Promise.allSettled([baselineTree.close(), candidateTree.close()])
    }
  }

  async runCanary(
    candidate: LearningCandidate,
    suite: EvalSuite,
    repository: string,
  ): Promise<EvaluationRun> {
    if (candidate.status !== 'canary') {
      throw new Error(`Candidate ${candidate.id} must be in canary status`)
    }
    const repo = git(repository, ['rev-parse', '--show-toplevel'])
    // A reversible check also proves the exact candidate patch is currently
    // present before measuring it as a canary.
    git(repo, ['apply', '--reverse', '--check', '-'], candidate.patch)
    const commit = git(repo, ['rev-parse', 'HEAD'])
    const run = await runSuite(
      suite,
      repo,
      'canary',
      candidate.id,
      commit,
      this.registry,
      repo,
      this.now,
    )
    atomicWriteFileSync(evaluationFile(this.paths, run), JSON.stringify(run, null, 2) + '\n')
    return run
  }
}
