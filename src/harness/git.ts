import { execFileSync, execSync, spawnSync } from 'node:child_process'

export interface RunGitOptions {
  input?: string
  trim?: boolean
  maxBuffer?: number
}

export interface RunGitBufferOptions {
  input?: string
  maxBuffer?: number
  timeout?: number
  noOptionalLocks?: boolean
}

/** Current Git branch name for `cwd`, or null outside a Git worktree / when git is unavailable. */
export function gitBranch(cwd: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5_000,
    })
      .toString('utf8')
      .trim()
    return branch || null
  } catch {
    return null
  }
}

/** Execute a git subcommand directly (no shell interpolation) and return UTF-8 stdout. */
export function runGit(cwd: string, args: readonly string[], options: RunGitOptions = {}): string {
  const result = spawnSync('git', [...args], {
    cwd,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  const stdout = result.stdout ?? ''
  return options.trim === false ? stdout : stdout.trim()
}

/** Execute a read-only/binary-safe git subcommand returning raw Buffer stdout. */
export function runGitBuffer(
  cwd: string,
  args: readonly string[],
  options: RunGitBufferOptions = {},
): Buffer {
  const fullArgs = [
    ...(options.noOptionalLocks ? ['--no-optional-locks'] : []),
    '-C',
    cwd,
    ...args,
  ]
  return execFileSync('git', fullArgs, {
    input: options.input,
    maxBuffer: options.maxBuffer ?? 1_000_000,
    timeout: options.timeout ?? 10_000,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
