// src/harness/staleness.ts — mechanical detection of environment drift.
//
// This repo is worked on from more than one machine, by more than one agent harness. The
// recurring failure is silent: source is pulled but `dist/` is not rebuilt, or package.json
// changes land without a reinstall, and the next run exercises yesterday's binary against
// today's source — after which a correct fix reads as "didn't work". Nothing here is a
// safety mechanism; it exists purely so freshness is observed instead of remembered.
//
// Every check is individually wrapped and degrades to 'unknown'. This is optional hardening
// and optional hardening must never be a boot precondition: a machine with no git, no
// upstream, no build and no node_modules must still start normally and silently.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { VAULT_SPAWN_TIMEOUT_MS } from '../brain/credential-vault.js'

export type StalenessName = 'stale-build' | 'stale-deps' | 'branch-behind' | 'uncommitted-work'

/** 'stale' is the only actionable state. 'not-applicable' means the environment simply does
 *  not have the thing being compared (fresh clone, no upstream, published-package layout) —
 *  it is a normal state, never a problem. 'unknown' means a probe failed or timed out. */
export type StalenessState = 'fresh' | 'stale' | 'not-applicable' | 'unknown'

export interface StalenessSignal {
  name: StalenessName
  state: StalenessState
  detail: string
  /** One concise line for stderr at startup. Only ever set for the two signals that are
   *  actionable in the moment (build, deps); 'branch-behind' and 'uncommitted-work' are
   *  doctor-only, because boot noise erodes attention for the warnings that matter. */
  bootWarning?: string
}

export interface GitResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type GitRunner = (args: string[], cwd: string) => GitResult

export interface StalenessOptions {
  /** Package root (the directory holding package.json, src/, dist/). Defaults to the real
   *  one, resolved the same way src/version.ts does it: both dist/ and src/ sit exactly one
   *  level below the root, so '..' is correct whether this module runs bundled or via tsx. */
  packageRoot?: string
  /** Subset of checks to run. Boot passes BOOT_STALENESS_CHECKS so it spawns no subprocess. */
  only?: readonly StalenessName[]
  /** Test seam. */
  runGit?: GitRunner
}

/** Boot surfaces only the two filesystem checks: they are free, and they are the ones whose
 *  fix ("rebuild", "reinstall") is actionable right now. */
export const BOOT_STALENESS_CHECKS: readonly StalenessName[] = ['stale-build', 'stale-deps']

/** Same rationale as the credential vault's timeout, applied to git: these calls are
 *  synchronous, so a hung git (a stale index.lock, a filesystem stall, a credential helper
 *  prompting into the void) would block the process with no way out. */
const GIT_SPAWN_TIMEOUT_MS = VAULT_SPAWN_TIMEOUT_MS

/** Hard ceiling on the src/ walk so a pathological tree can never turn a boot-time freshness
 *  check into a directory crawl. src/ is ~100 files; this is three orders of magnitude of
 *  headroom and still bounded. */
const MAX_WALK_ENTRIES = 20_000

/** `pnpm install` writes node_modules/.modules.yaml and pnpm-lock.yaml within the same run,
 *  in an order that is not guaranteed, so a strict comparison reports a just-completed
 *  install as stale (observed: both stamps in the same second, lockfile ahead by a fraction
 *  of a millisecond). Real drift — a pull, or an edited dependency — is minutes to days
 *  wide, so a minute of slack removes the false positive and nothing else. */
const DEPS_TOLERANCE_MS = 60_000

function defaultPackageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url))
}

/** Deterministic, locale-independent, and short enough to fit a one-line warning. */
function stamp(mtimeMs: number): string {
  return `${new Date(mtimeMs).toISOString().replace('T', ' ').slice(0, 19)}Z`
}

const runGitSync: GitRunner = (args, cwd) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: GIT_SPAWN_TIMEOUT_MS,
  })
  // spawnSync leaves stdout/stderr NULL (not '') on timeout and on ENOENT, so every read
  // is defaulted here; the un-defaulted form has already produced a TypeError in this repo.
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: (result.error as { code?: string } | undefined)?.code === 'ETIMEDOUT',
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Basename-level subset of gitignore syntax — directory patterns (`dist/`), plain names,
 *  `**​/`-prefixed names and simple `*.ext` globs. That is everything the root .gitignore can
 *  express about content under src/; path-scoped and negated patterns are deliberately
 *  dropped rather than half-implemented, since dropping one only means walking one extra
 *  file. */
function ignoredNameMatchers(packageRoot: string): RegExp[] {
  let raw: string
  try {
    raw = readFileSync(join(packageRoot, '.gitignore'), 'utf8')
  } catch {
    return []
  }
  const matchers: RegExp[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const pattern = trimmed.replace(/^\.\//, '').replace(/^\*\*\//, '').replace(/\/$/, '')
    if (!pattern || pattern.includes('/')) continue
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
    matchers.push(new RegExp(`^${source}$`))
  }
  return matchers
}

interface NewestFile {
  relative: string
  mtimeMs: number
}

/** Newest mtime under src/, walked directly (never node_modules, never dist) and bounded. */
function newestSourceFile(srcDir: string, ignored: RegExp[]): NewestFile | null {
  let newest: NewestFile | null = null
  let visited = 0
  const stack: Array<{ dir: string; prefix: string }> = [{ dir: srcDir, prefix: 'src' }]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > MAX_WALK_ENTRIES) return newest
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (ignored.some((matcher) => matcher.test(entry.name))) continue
      const full = join(current.dir, entry.name)
      const relative = `${current.prefix}/${entry.name}`
      if (entry.isDirectory()) {
        stack.push({ dir: full, prefix: relative })
        continue
      }
      if (!entry.isFile()) continue
      const mtimeMs = mtimeOf(full)
      if (mtimeMs === null) continue
      if (!newest || mtimeMs > newest.mtimeMs) newest = { relative, mtimeMs }
    }
  }
  return newest
}

function checkStaleBuild(packageRoot: string): StalenessSignal {
  const name = 'stale-build'
  const distEntry = join(packageRoot, 'dist', 'cli.js')
  const srcDir = join(packageRoot, 'src')
  const builtAt = mtimeOf(distEntry)
  if (builtAt === null) {
    // A fresh clone that has never been built is not a problem to report; bin/athena.js
    // already tells the user to run `pnpm build` at the point where it actually matters.
    return {
      name,
      state: 'not-applicable',
      detail: 'No dist/cli.js has been built yet, so there is no build to be stale.',
    }
  }
  if (!existsSync(srcDir)) {
    return {
      name,
      state: 'not-applicable',
      detail: 'No src/ directory beside the build; build freshness cannot be compared.',
    }
  }
  const newest = newestSourceFile(srcDir, ignoredNameMatchers(packageRoot))
  if (!newest) {
    return { name, state: 'not-applicable', detail: 'No readable files under src/ to compare against.' }
  }
  if (newest.mtimeMs <= builtAt) {
    return {
      name,
      state: 'fresh',
      detail: `dist/cli.js (${stamp(builtAt)}) is newer than the newest source file ${newest.relative} (${stamp(newest.mtimeMs)}).`,
    }
  }
  return {
    name,
    state: 'stale',
    detail:
      `dist/cli.js was built ${stamp(builtAt)} but ${newest.relative} changed ${stamp(newest.mtimeMs)}. ` +
      'The athena binary is running older source than this checkout contains. Run `pnpm build`.',
    bootWarning: `Stale build: dist/cli.js (${stamp(builtAt)}) is older than ${newest.relative} (${stamp(newest.mtimeMs)}). Run \`pnpm build\`.`,
  }
}

function checkStaleDeps(packageRoot: string): StalenessSignal {
  const name = 'stale-deps'
  const lockfile = join(packageRoot, 'pnpm-lock.yaml')
  const lockedAt = mtimeOf(lockfile)
  if (lockedAt === null) {
    return {
      name,
      state: 'not-applicable',
      detail: 'No pnpm-lock.yaml beside the build; dependency freshness is not tracked here.',
    }
  }
  const modulesDir = join(packageRoot, 'node_modules')
  // pnpm rewrites .modules.yaml on every install, whereas the directory mtime can be
  // touched by unrelated writes; prefer the marker and fall back to the directory.
  const installedAt = mtimeOf(join(modulesDir, '.modules.yaml')) ?? mtimeOf(modulesDir)
  if (installedAt === null) {
    return {
      name,
      state: 'stale',
      detail: 'pnpm-lock.yaml exists but node_modules does not. Run `pnpm install`.',
      bootWarning: 'Dependencies are not installed (no node_modules). Run `pnpm install`.',
    }
  }
  if (lockedAt <= installedAt + DEPS_TOLERANCE_MS) {
    return {
      name,
      state: 'fresh',
      detail: `node_modules (${stamp(installedAt)}) is current with pnpm-lock.yaml (${stamp(lockedAt)}).`,
    }
  }
  return {
    name,
    state: 'stale',
    detail:
      `pnpm-lock.yaml changed ${stamp(lockedAt)} but node_modules was last installed ${stamp(installedAt)}. ` +
      'Run `pnpm install`.',
    bootWarning: `Stale dependencies: node_modules (${stamp(installedAt)}) is older than pnpm-lock.yaml (${stamp(lockedAt)}). Run \`pnpm install\`.`,
  }
}

function notARepository(result: GitResult): boolean {
  return /not a git repository/i.test(result.stderr)
}

function gitUnknown(name: StalenessName, what: string, result: GitResult): StalenessSignal {
  return {
    name,
    state: 'unknown',
    detail: result.timedOut
      ? `git did not answer within ${GIT_SPAWN_TIMEOUT_MS}ms, so ${what} is unknown.`
      : `git could not report ${what}: ${result.stderr.split(/\r?\n/, 1)[0]?.trim() || 'no output'}`,
  }
}

function checkBranchBehind(packageRoot: string, runGit: GitRunner): StalenessSignal {
  const name = 'branch-behind'
  const upstream = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], packageRoot)
  if (upstream.status !== 0) {
    if (upstream.timedOut) return gitUnknown(name, 'branch position', upstream)
    if (notARepository(upstream)) {
      return { name, state: 'not-applicable', detail: 'Not a git repository; branch freshness does not apply.' }
    }
    // Every other failure here is the no-upstream family (detached HEAD, a local-only
    // branch, a brand-new branch that has never been pushed). None is a problem.
    return {
      name,
      state: 'not-applicable',
      detail: 'No upstream is configured for the current branch; there is nothing to compare against.',
    }
  }
  const upstreamRef = upstream.stdout.trim()
  const behind = runGit(['rev-list', '--count', `HEAD..${upstreamRef}`], packageRoot)
  if (behind.status !== 0) return gitUnknown(name, 'branch position', behind)
  const count = Number.parseInt(behind.stdout.trim(), 10)
  if (!Number.isFinite(count)) return gitUnknown(name, 'branch position', behind)
  if (count === 0) {
    return { name, state: 'fresh', detail: `Up to date with ${upstreamRef} as of the last fetch.` }
  }
  return {
    name,
    state: 'stale',
    // Deliberately honest: no fetch is performed here (network I/O on every boot is not
    // acceptable), so this reflects the last fetch, not live remote state.
    detail:
      `Behind ${upstreamRef} by ${count} commit${count === 1 ? '' : 's'} as of the last fetch. ` +
      'No fetch was performed, so the remote may be further ahead. Run `git pull`.',
  }
}

function checkUncommittedWork(packageRoot: string, runGit: GitRunner): StalenessSignal {
  const name = 'uncommitted-work'
  const status = runGit(['status', '--porcelain'], packageRoot)
  if (status.status !== 0) {
    if (status.timedOut) return gitUnknown(name, 'working tree state', status)
    if (notARepository(status)) {
      return { name, state: 'not-applicable', detail: 'Not a git repository; working tree state does not apply.' }
    }
    return gitUnknown(name, 'working tree state', status)
  }
  const changed = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length
  if (changed === 0) return { name, state: 'fresh', detail: 'Working tree is clean.' }
  return {
    name,
    state: 'stale',
    // Count, not list: on a two-machine workflow the useful signal is "there is work here",
    // and a file list in a diagnostic report is noise.
    detail: `${changed} file${changed === 1 ? '' : 's'} have uncommitted changes; work may be stranded on this machine.`,
  }
}

/** Runs the requested checks. Each one is individually wrapped: a check that throws for any
 *  reason degrades to 'unknown' and can never propagate into the boot path. */
export function collectStaleness(options: StalenessOptions = {}): StalenessSignal[] {
  const packageRoot = options.packageRoot ?? defaultPackageRoot()
  const runGit = options.runGit ?? runGitSync
  const requested = options.only ?? (['stale-build', 'stale-deps', 'branch-behind', 'uncommitted-work'] as const)
  const signals: StalenessSignal[] = []
  for (const name of requested) {
    try {
      switch (name) {
        case 'stale-build':
          signals.push(checkStaleBuild(packageRoot))
          break
        case 'stale-deps':
          signals.push(checkStaleDeps(packageRoot))
          break
        case 'branch-behind':
          signals.push(checkBranchBehind(packageRoot, runGit))
          break
        case 'uncommitted-work':
          signals.push(checkUncommittedWork(packageRoot, runGit))
          break
      }
    } catch (error) {
      signals.push({
        name,
        state: 'unknown',
        detail: `Check could not be completed: ${(error as Error).message}`,
      })
    }
  }
  return signals
}

/** Lines to emit on stderr before the TUI mounts. Empty when everything is fresh — silence
 *  is the success state, and nothing here ever blocks or delays boot. */
export function stalenessBootWarnings(options: StalenessOptions = {}): string[] {
  try {
    return collectStaleness({ ...options, only: options.only ?? BOOT_STALENESS_CHECKS })
      .map((signal) => signal.bootWarning)
      .filter((warning): warning is string => Boolean(warning))
  } catch {
    return []
  }
}
