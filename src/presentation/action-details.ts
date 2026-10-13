import { stripVTControlCharacters } from 'node:util'
import { realPathForAccess } from '../harness/resource-policy.js'
import { sessionGrantRule } from '../harness/permission-rule.js'
import { redactSessionValue } from '../harness/redaction.js'
import { permissionDiff } from './permission-diff.js'
import { diffLines } from './diff-lines.js'

/** Preserve decision-relevant whitespace and length, but never execute terminal controls. */
export function safeDetailText(value: string): string {
  return stripVTControlCharacters(String(redactSessionValue(value)))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    // Accept quoted JSON keys, quoted values containing spaces, and the escaped
    // JSON text carried inside tool arguments. Keep markers idempotent because
    // the reader/export boundaries intentionally sanitize a second time.
    .replace(/((?:\\?["'])?\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|token)\b(?:\\?["'])?\s*[=:]\s*)(?:Bearer\s+\[REDACTED\]|\[REDACTED\]|\\"(?:[^\\]|\\(?!"))*\\"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1[REDACTED]')
}


export function actionDetails(request: {
  id?: string; toolName: string; input: unknown; reason: string; cwd?: string; grantRule?: string; targets?: string[]
}): string {
  const cwd = request.cwd ?? process.cwd()
  const input = request.input as Record<string, unknown> | null
  const requestedPath = typeof input?.['file_path'] === 'string'
    ? input['file_path'] : typeof input?.['path'] === 'string' ? input['path'] : null
  let target = 'See effective arguments below'
  if (requestedPath !== null) {
    try { target = realPathForAccess(requestedPath, cwd) }
    catch { target = `Cannot resolve target (unreadable): ${requestedPath}` }
  }
  const diff = permissionDiff(request, cwd)
  return safeDetailText([
    `Request: ${request.id ?? 'current'}`,
    `Tool: ${request.toolName}`,
    `Working directory: ${cwd}`,
    `Target: ${target}`,
    ...(request.targets ?? []).filter(path => path !== target).map(path => `Additional target: ${path}`),
    `Reason: ${request.reason}`,
    `Session grant: ${request.grantRule ?? sessionGrantRule(request.toolName, request.input, cwd)}`,
    'The session grant covers every matching action until this session ends.',
    'Effective arguments (credential redactions are marked [REDACTED]):',
    JSON.stringify(redactSessionValue(request.input), null, 2),
    ...(diff ? ['Available change:', ...diffLines(diff.oldText, diff.newText).map(l => `${l.tag} ${l.line}`)] : []),
  ].join('\n'))
}
