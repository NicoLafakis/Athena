import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { realPathForAccess } from './resource-policy.js'

/** Binds an interactive file approval to the revision available for inspection.
 * Rechecked immediately before admission; it is not a filesystem transaction. */
export function permissionRevision(name: string, input: unknown, cwd: string): string | null {
  if (!['Write', 'Edit', 'NotebookEdit'].includes(name)) return 'not-a-file-edit'
  const value = input as { file_path?: unknown; path?: unknown } | null
  const path = value?.file_path ?? value?.path
  if (typeof path !== 'string') return null
  try {
    const canonical = realPathForAccess(path, cwd)
    let hash: string
    try { hash = createHash('sha256').update(readFileSync(canonical)).digest('hex') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      hash = 'missing'
    }
    return `${canonical}:${hash}`
  } catch { return null }
}
