import { plainBounded } from '../interaction/format.js'
import type { AccessiblePermissionRequest, PermissionDiffStats } from './types.js'

export interface PermissionPresentationInput {
  id: string
  toolName: string
  input: unknown
  summary: string
  reason: string
  diff?: PermissionDiffStats
}

function safe(value: unknown, max: number, fallback: string): string {
  return plainBounded(String(value ?? ''), max) || fallback
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function targetFor(toolName: string, input: unknown): string {
  const record = recordOf(input)
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read' || toolName === 'NotebookEdit') {
    return safe(record['file_path'] ?? record['path'], 512, 'workspace file')
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'workspace shell'
  if (toolName.startsWith('mcp__')) return 'configured external tool'
  return 'current workspace operation'
}

function consequenceFor(toolName: string): string {
  if (toolName === 'Write') return 'Replace or create file content.'
  if (toolName === 'Edit' || toolName === 'ApplyPatch' || toolName === 'NotebookEdit') {
    return 'Modify workspace content.'
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'Run a command in the workspace.'
  return 'Allow the requested tool operation.'
}

export function createAccessiblePermissionRequest(
  input: PermissionPresentationInput,
): AccessiblePermissionRequest {
  const id = safe(input.id, 256, 'permission')
  const toolName = safe(input.toolName, 256, 'Tool')
  return {
    id,
    toolName,
    target: targetFor(toolName, input.input),
    consequence: consequenceFor(toolName),
    summary: safe(input.summary, 1_024, `${toolName} requests permission.`),
    reason: safe(input.reason, 1_024, 'This operation requires user approval.'),
    detailsCommand: `/details permission ${id}`,
    ...(input.diff ? {
      diff: {
        addedLines: Math.max(0, Math.floor(input.diff.addedLines)),
        removedLines: Math.max(0, Math.floor(input.diff.removedLines)),
      },
    } : {}),
  }
}

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`
}

/**
 * Spoken sibling of `formatAccessiblePermission`, from the same canonical record.
 * A heard decision cannot use the screen affordances: `/details permission <id>` and the
 * `[y] [a] [n]` legend are unreachable by voice and read as noise, so the spoken line
 * carries the target, the consequence, and the two words that answer it. It names
 * "allow once" deliberately — the voice contract never reaches `allow-always`.
 */
export function formatSpokenPermission(request: AccessiblePermissionRequest): string {
  const parts = [
    `Permission needed: ${safe(request.toolName, 256, 'a tool')}` +
    ` on ${safe(request.target, 512, 'the current workspace operation')}.`,
    safe(request.consequence, 1_024, 'Allow the requested operation.'),
  ]
  if (request.diff) {
    parts.push(
      `${count(request.diff.addedLines, 'added line')}, ` +
      `${count(request.diff.removedLines, 'removed line')}.`,
    )
  }
  parts.push('Say Athena allow to permit this one action, or Athena deny to refuse it.')
  return plainBounded(parts.join(' '), 1_024)
}

export function formatAccessiblePermission(request: AccessiblePermissionRequest): string {
  const lines = [
    `Permission: ${safe(request.toolName, 256, 'Tool')} requires a decision.`,
    `Target: ${safe(request.target, 512, 'current workspace operation')}`,
    `Consequence: ${safe(request.consequence, 1_024, 'Allow the requested operation.')}`,
    `Reason: ${safe(request.reason, 1_024, 'This operation requires user approval.')}`,
  ]
  if (request.diff) {
    lines.push(`Changes: ${count(request.diff.addedLines, 'added line')}, ${count(request.diff.removedLines, 'removed line')}.`)
  }
  lines.push(
    `Details: ${safe(request.detailsCommand, 512, `/details permission ${request.id}`)}`,
    'Choices: [y] allow once; [a] always allow; [n] deny',
  )
  return lines.join('\n').slice(0, 4_095)
}
