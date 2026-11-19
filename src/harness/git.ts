import { execSync } from 'node:child_process'

/** Current Git branch name for `cwd`, or null outside a Git worktree / when git is unavailable. */
export function gitBranch(cwd: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim()
    return branch || null
  } catch {
    return null
  }
}
