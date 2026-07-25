import {
  existsSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export type SandboxMode = 'read-only' | 'workspace-write' | 'unrestricted'
export type PathAccess = 'read' | 'write'

export class ResourcePolicyError extends Error {
  readonly code = 'ATHENA_RESOURCE_DENIED'
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Resolves existing path components through symlinks. For a not-yet-created
 * target, the nearest existing parent is real-pathed and the remaining suffix is
 * reattached. This closes both direct symlink escapes and parent-directory
 * escapes before a write creates the final entry. */
export function realPathForAccess(input: string, cwd: string): string {
  const absolute = resolve(cwd, input)
  if (existsSync(absolute)) return realpathSync.native(absolute)
  const suffix: string[] = []
  let parent = absolute
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) break
    suffix.unshift(parent.slice(next.length).replace(/^[/\\]+/, ''))
    parent = next
  }
  const realParent = existsSync(parent) ? realpathSync.native(parent) : parent
  return resolve(realParent, ...suffix)
}

export class ResourcePolicy {
  readonly workspaceRoot: string

  constructor(
    cwd: string,
    readonly mode: SandboxMode = 'workspace-write',
    private readonly extraReadRoots: readonly string[] = [],
  ) {
    this.workspaceRoot = realPathForAccess('.', cwd)
  }

  resolvePath(input: string, access: PathAccess): string {
    const candidate = realPathForAccess(input, this.workspaceRoot)
    if (this.mode === 'unrestricted') return candidate
    if (access === 'write' && this.mode === 'read-only') {
      throw new ResourcePolicyError('Sandbox is read-only; writes are disabled')
    }
    const roots =
      access === 'read'
        ? [this.workspaceRoot, ...this.extraReadRoots.map((root) => realPathForAccess(root, this.workspaceRoot))]
        : [this.workspaceRoot]
    if (!roots.some((root) => isWithin(root, candidate))) {
      throw new ResourcePolicyError(
        `${access === 'write' ? 'Write' : 'Read'} outside sandbox roots denied: ${candidate}`,
      )
    }
    return candidate
  }

  contains(input: string, access: PathAccess): boolean {
    try {
      this.resolvePath(input, access)
      return true
    } catch {
      return false
    }
  }
}
