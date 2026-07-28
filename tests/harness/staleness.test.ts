import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectStaleness,
  stalenessBootWarnings,
  type GitResult,
  type GitRunner,
  type StalenessName,
  type StalenessSignal,
} from '../../src/harness/staleness.js'

let root: string

const OLD = new Date('2026-07-01T00:00:00Z')
const NEW = new Date('2026-07-20T00:00:00Z')

function touch(path: string, when: Date): void {
  utimesSync(path, when, when)
}

function write(relative: string, when: Date, contents = 'x'): string {
  const full = join(root, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
  touch(full, when)
  return full
}

function signal(signals: StalenessSignal[], name: StalenessName): StalenessSignal {
  const found = signals.find((s) => s.name === name)
  if (!found) throw new Error(`missing signal ${name}`)
  return found
}

function gitOk(stdout: string): GitResult {
  return { status: 0, stdout, stderr: '', timedOut: false }
}

/** Mirrors the real spawnSync timeout shape, including the NULL stdout/stderr that has
 *  already produced a TypeError in this repo when read without a default. */
const timingOutGit: GitRunner = () => ({
  status: null,
  stdout: null as unknown as string,
  stderr: null as unknown as string,
  timedOut: true,
})

const notARepoGit: GitRunner = () => ({
  status: 128,
  stdout: '',
  stderr: 'fatal: not a git repository (or any of the parent directories): .git',
  timedOut: false,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-staleness-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('staleness: build freshness', () => {
  it('detects a build older than the newest source file and names both sides', () => {
    write('dist/cli.js', OLD)
    write('src/harness/staleness.ts', NEW)
    const build = signal(collectStaleness({ packageRoot: root, only: ['stale-build'] }), 'stale-build')
    expect(build.state).toBe('stale')
    expect(build.detail).toContain('src/harness/staleness.ts')
    expect(build.bootWarning).toContain('pnpm build')
    expect(build.bootWarning).toContain('2026-07-01')
    expect(build.bootWarning).toContain('2026-07-20')
  })

  it('stays silent when the build is newer than every source file', () => {
    write('src/cli.ts', OLD)
    write('src/harness/staleness.ts', OLD)
    write('dist/cli.js', NEW)
    const build = signal(collectStaleness({ packageRoot: root, only: ['stale-build'] }), 'stale-build')
    expect(build.state).toBe('fresh')
    expect(build.bootWarning).toBeUndefined()
    expect(stalenessBootWarnings({ packageRoot: root, only: ['stale-build'] })).toEqual([])
  })

  it('treats a never-built checkout as not-applicable rather than stale', () => {
    write('src/cli.ts', NEW)
    const build = signal(collectStaleness({ packageRoot: root, only: ['stale-build'] }), 'stale-build')
    expect(build.state).toBe('not-applicable')
    expect(build.bootWarning).toBeUndefined()
  })

  it('ignores gitignored files under src/ when picking the newest source file', () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n*.log\n')
    write('dist/cli.js', OLD)
    write('src/cli.ts', new Date('2026-06-01T00:00:00Z'))
    write('src/debug.log', NEW)
    const build = signal(collectStaleness({ packageRoot: root, only: ['stale-build'] }), 'stale-build')
    expect(build.state).toBe('fresh')
  })
})

describe('staleness: dependency freshness', () => {
  it('detects node_modules older than the lockfile', () => {
    write('pnpm-lock.yaml', NEW)
    write('node_modules/.modules.yaml', OLD)
    const deps = signal(collectStaleness({ packageRoot: root, only: ['stale-deps'] }), 'stale-deps')
    expect(deps.state).toBe('stale')
    expect(deps.bootWarning).toContain('pnpm install')
  })

  it('reports a lockfile with no node_modules as needing an install', () => {
    write('pnpm-lock.yaml', NEW)
    const deps = signal(collectStaleness({ packageRoot: root, only: ['stale-deps'] }), 'stale-deps')
    expect(deps.state).toBe('stale')
    expect(deps.bootWarning).toContain('no node_modules')
  })

  it('is not-applicable without a lockfile', () => {
    const deps = signal(collectStaleness({ packageRoot: root, only: ['stale-deps'] }), 'stale-deps')
    expect(deps.state).toBe('not-applicable')
    expect(deps.bootWarning).toBeUndefined()
  })

  it('does not flag a just-completed install whose lockfile write landed a moment later', () => {
    write('node_modules/.modules.yaml', NEW)
    write('pnpm-lock.yaml', new Date(NEW.getTime() + 800))
    expect(signal(collectStaleness({ packageRoot: root, only: ['stale-deps'] }), 'stale-deps').state).toBe(
      'fresh',
    )
  })

  it('is fresh when node_modules was installed after the lockfile changed', () => {
    write('pnpm-lock.yaml', OLD)
    write('node_modules/.modules.yaml', NEW)
    expect(signal(collectStaleness({ packageRoot: root, only: ['stale-deps'] }), 'stale-deps').state).toBe(
      'fresh',
    )
  })
})

describe('staleness: git checks', () => {
  it('degrades cleanly outside a git repository', () => {
    const signals = collectStaleness({
      packageRoot: root,
      only: ['branch-behind', 'uncommitted-work'],
      runGit: notARepoGit,
    })
    expect(signal(signals, 'branch-behind').state).toBe('not-applicable')
    expect(signal(signals, 'uncommitted-work').state).toBe('not-applicable')
    expect(signal(signals, 'branch-behind').detail).toContain('Not a git repository')
  })

  it('degrades cleanly when the branch has no upstream', () => {
    const runGit: GitRunner = (args) =>
      args[0] === 'rev-parse'
        ? { status: 128, stdout: '', stderr: "fatal: no upstream configured for branch 'work'", timedOut: false }
        : gitOk('')
    const branch = signal(collectStaleness({ packageRoot: root, only: ['branch-behind'], runGit }), 'branch-behind')
    expect(branch.state).toBe('not-applicable')
    expect(branch.detail).toContain('No upstream')
  })

  it('reports how far behind the upstream is and that it reflects the last fetch', () => {
    const runGit: GitRunner = (args) => (args[0] === 'rev-parse' ? gitOk('origin/main\n') : gitOk('3\n'))
    const branch = signal(collectStaleness({ packageRoot: root, only: ['branch-behind'], runGit }), 'branch-behind')
    expect(branch.state).toBe('stale')
    expect(branch.detail).toContain('Behind origin/main by 3 commits as of the last fetch')
    expect(branch.detail).toContain('No fetch was performed')
    expect(branch.bootWarning).toBeUndefined()
  })

  it('counts uncommitted files without listing them', () => {
    const runGit: GitRunner = () => gitOk(' M src/cli.ts\n?? notes.md\n')
    const work = signal(collectStaleness({ packageRoot: root, only: ['uncommitted-work'], runGit }), 'uncommitted-work')
    expect(work.state).toBe('stale')
    expect(work.detail).toContain('2 files have uncommitted changes')
    expect(work.detail).not.toContain('src/cli.ts')
    expect(work.bootWarning).toBeUndefined()
  })

  it('degrades a timed-out git to unknown without throwing on null stdout/stderr', () => {
    const signals = collectStaleness({
      packageRoot: root,
      only: ['branch-behind', 'uncommitted-work'],
      runGit: timingOutGit,
    })
    expect(signal(signals, 'branch-behind').state).toBe('unknown')
    expect(signal(signals, 'uncommitted-work').state).toBe('unknown')
    expect(signal(signals, 'branch-behind').detail).toContain('did not answer within')
  })
})

describe('staleness: boot path', () => {
  it('produces no warnings and never throws when every check fails at once', () => {
    const exploding: GitRunner = () => {
      throw new Error('git exploded')
    }
    const options = { packageRoot: join(root, 'does-not-exist'), runGit: exploding }
    expect(() => stalenessBootWarnings(options)).not.toThrow()
    expect(stalenessBootWarnings(options)).toEqual([])
    const signals = collectStaleness(options)
    expect(signals).toHaveLength(4)
    expect(signals.every((s) => s.state === 'unknown' || s.state === 'not-applicable')).toBe(true)
  })

  it('surfaces only build and dependency warnings at boot', () => {
    write('dist/cli.js', OLD)
    write('src/cli.ts', NEW)
    write('pnpm-lock.yaml', NEW)
    write('node_modules/.modules.yaml', OLD)
    const runGit: GitRunner = (args) => (args[0] === 'rev-parse' ? gitOk('origin/main\n') : gitOk('9\n'))
    const warnings = stalenessBootWarnings({ packageRoot: root, runGit })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('Stale build')
    expect(warnings[1]).toContain('Stale dependencies')
    expect(warnings.join('\n')).not.toContain('Behind origin/main')
  })
})
