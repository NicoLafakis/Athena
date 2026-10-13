import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realPathForAccess, ResourcePolicyError } from './resource-policy.js'

export function memoryReadOnly(input: unknown): boolean {
  const op = (input as { op?: unknown } | null)?.op
  return op === 'read' || op === 'list'
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** One coordinate system for the permission gate and Memory implementation.
 * Only this dedicated root is granted; its surrounding brain is never a sandbox root. */
export function resolveMemoryAccess(memoryRoot: string, input: unknown) {
  const value = (input ?? {}) as { op?: unknown; path?: unknown }
  if (!['list', 'read', 'write', 'delete'].includes(String(value.op))) {
    throw new ResourcePolicyError('Invalid Memory operation')
  }
  const root = join(realPathForAccess(dirname(memoryRoot), dirname(memoryRoot)), basename(memoryRoot))
  const canonical = (path: string): string => {
    const lexical = resolve(root, path)
    // existsSync follows links and reports false for a dangling one. Reject such
    // components before the nearest-existing-parent resolver can mistake them for
    // ordinary not-yet-created paths (a write would otherwise follow the link).
    let component = lexical
    while (within(root, component)) {
      try {
        if (lstatSync(component).isSymbolicLink() && !existsSync(component)) {
          throw new ResourcePolicyError(`Dangling link in memory path: ${path}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (component === root) break
      component = dirname(component)
    }
    const actual = realPathForAccess(lexical, root)
    if (!within(root, lexical) || !within(root, actual)) {
      throw new ResourcePolicyError(`Path escapes memory dir: ${path}`)
    }
    return actual
  }
  canonical('.') // A replaced root must not grant authority to its link destination.
  const readOnly = memoryReadOnly(input)
  const files: string[] = []
  if (value.op === 'list') {
    const visited = new Set<string>()
    const walk = (directory: string): void => {
      const current = canonical(directory)
      if (visited.has(current) || !existsSync(current)) return
      visited.add(current)
      for (const name of readdirSync(current)) {
        const target = canonical(join(current, name))
        if (statSync(target).isDirectory()) walk(target)
        else files.push(target)
      }
    }
    walk(root)
    return { root, readOnly, target: root, index: null, targets: [root, ...files], files }
  }
  if (typeof value.path !== 'string' || !value.path) {
    throw new ResourcePolicyError(`op ${value.op} requires path`)
  }
  const target = canonical(value.path)
  const rel = relative(root, target).replaceAll('\\', '/').toLowerCase()
  if (!readOnly && (rel === 'memory.md' || rel.split('/')[0] === 'journal')) {
    throw new ResourcePolicyError('MEMORY.md and memory/journal are reserved generated data')
  }
  const index = readOnly ? null : canonical('MEMORY.md')
  if (index && relative(root, index).toLowerCase() !== 'memory.md') {
    throw new ResourcePolicyError('Memory index must not redirect to another file')
  }
  if (index && existsSync(index) && !statSync(index).isFile()) {
    throw new ResourcePolicyError('Memory index must be a regular file')
  }
  return { root, readOnly, target, index, targets: index ? [target, index] : [target], files }
}
