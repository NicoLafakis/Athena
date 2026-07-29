import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { plainBounded } from '../interaction/format.js'
import { diffLines } from './diff-lines.js'
import type { PermissionDiffStats } from './types.js'

export interface PermissionDiff {
  oldText: string
  newText: string
}

export function permissionDiff(
  request: { toolName: string; input: unknown },
  cwd: string,
): PermissionDiff | null {
  if (typeof request.input !== 'object' || request.input === null) return null
  const input = request.input as Record<string, unknown>
  if (request.toolName === 'Edit') {
    return { oldText: String(input['old_string'] ?? ''), newText: String(input['new_string'] ?? '') }
  }
  if (request.toolName !== 'Write' || typeof input['file_path'] !== 'string') return null
  let oldText = ''
  try {
    const absolute = resolve(cwd, input['file_path'])
    if (existsSync(absolute)) oldText = readFileSync(absolute, 'utf8')
  } catch {
    // An unreadable current file is represented as an all-additions preview.
  }
  return { oldText, newText: String(input['content'] ?? '') }
}

export function permissionDiffStats(diff: PermissionDiff): PermissionDiffStats {
  const lines = diffLines(diff.oldText, diff.newText)
  return {
    addedLines: lines.filter((line) => line.tag === '+').length,
    removedLines: lines.filter((line) => line.tag === '-').length,
  }
}

export function formatPermissionDiffDetail(diff: PermissionDiff, maxLines = 200): string {
  const lines = diffLines(diff.oldText, diff.newText)
  const shown = lines.slice(0, maxLines).map((item) => `${item.tag} ${plainBounded(item.line, 1_024)}`)
  if (lines.length > shown.length) shown.push(`Status: ${lines.length - shown.length} more diff lines omitted.`)
  return shown.join('\n').slice(0, 64_000)
}
