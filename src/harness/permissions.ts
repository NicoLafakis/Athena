import { posix } from 'node:path'
import type { PermissionDecision, PermissionGate, PermissionMode, PermissionRequest } from '../engine/types.js'

export interface ParsedRule { tool: string; pattern: string | null }

export function parseRule(rule: string): ParsedRule {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) throw new Error(`Malformed permission rule: ${rule}`)
  return { tool: m[1]!, pattern: m[2] ?? null }
}

// Glob-ish matcher: `**` crosses path separators (a `**` followed by a slash
// matches zero or more whole segments), `*` does not cross separators, `?` is
// one char. `caseInsensitive` is used for file-path targets on win32.
export function globToRegExp(pattern: string, caseInsensitive = false): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" matches zero or more whole segments, so "**/secret/**" also
        // covers a top-level "secret/x". A bare "**" matches anything.
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else { re += '[^/\\\\]*' }
    } else if (c === '?') {
      re += '.'
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '')
}

/** Normalize a file-path target before rule matching: backslashes become
 *  forward slashes and `.`/`..` segments are resolved, so `a/../secret/x`
 *  cannot slip past a deny rule written as `secret/**`. */
export function normalizePathTarget(p: string): string {
  return posix.normalize(p.replaceAll('\\', '/'))
}

/** The string a rule pattern is matched against, per tool. */
export function matchTarget(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash' || toolName === 'PowerShell') return String(obj['command'] ?? '')
  if (typeof obj['file_path'] === 'string') return normalizePathTarget(obj['file_path'] as string)
  if (typeof obj['pattern'] === 'string') return obj['pattern'] as string
  if (typeof obj['url'] === 'string') return obj['url'] as string
  return JSON.stringify(input)
}

export function matchesRule(rule: ParsedRule, toolName: string, input: unknown): boolean {
  if (rule.tool !== toolName) return false
  if (rule.pattern === null) return true
  const target = matchTarget(toolName, input)
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    // Command-prefix semantics: "git:*" matches "git" or "git <anything>", never "gitk".
    // NOTE: this prefix filter is ADVISORY only. Shell commands are not paths —
    // they are never normalized — and metacharacters, subshells, `env` tricks,
    // or absolute interpreter paths can trivially evade a string prefix. Real
    // enforcement is the permission ask (deny-by-default for mutating tools)
    // plus PreToolUse hooks; deny rules here are a convenience guardrail.
    const prefix = rule.pattern.endsWith(':*') ? rule.pattern.slice(0, -2) : rule.pattern
    return target === prefix || target.startsWith(prefix + ' ')
  }
  // File-path targets: the target is already normalized by matchTarget; also
  // normalize backslashes in the rule pattern and compare case-insensitively
  // on win32, where the filesystem is case-insensitive.
  const isPathTarget = typeof ((input ?? {}) as Record<string, unknown>)['file_path'] === 'string'
  if (isPathTarget) {
    const pattern = rule.pattern.replaceAll('\\', '/')
    return globToRegExp(pattern, process.platform === 'win32').test(target)
  }
  return globToRegExp(rule.pattern).test(target)
}

const EDIT_TOOLS = new Set(['Write', 'Edit'])

export interface PermissionEngineOptions { mode: PermissionMode; allow: string[]; deny: string[] }

export class PermissionEngine implements PermissionGate {
  private mode: PermissionMode
  private readonly allowRules: ParsedRule[]
  private readonly denyRules: ParsedRule[]
  private readonly sessionGrants: ParsedRule[] = []

  constructor(opts: PermissionEngineOptions) {
    this.mode = opts.mode
    this.allowRules = opts.allow.map(parseRule)
    this.denyRules = opts.deny.map(parseRule)
  }

  setMode(mode: PermissionMode): void { this.mode = mode }
  getMode(): PermissionMode { return this.mode }

  grantSession(rule: string): void { this.sessionGrants.push(parseRule(rule)) }

  check(req: PermissionRequest): PermissionDecision {
    // 1. Hard deny — no mode bypasses it.
    for (const rule of this.denyRules) {
      if (matchesRule(rule, req.toolName, req.input)) {
        return { decision: 'deny', reason: `Denied by rule ${rule.tool}(${rule.pattern ?? ''})` }
      }
    }
    // 2. Plan mode: read-only tools only; mutating tools are denied, not asked.
    if (this.mode === 'plan') {
      return req.readOnly
        ? { decision: 'allow', reason: 'Read-only tool in plan mode' }
        : { decision: 'deny', reason: 'Plan mode: mutating tools are disabled' }
    }
    // 3. Read-only tools never prompt.
    if (req.readOnly) return { decision: 'allow', reason: 'Read-only tool' }
    // 4. Explicit allow rules + session grants.
    for (const rule of [...this.allowRules, ...this.sessionGrants]) {
      if (matchesRule(rule, req.toolName, req.input)) {
        return { decision: 'allow', reason: `Allowed by rule ${rule.tool}(${rule.pattern ?? ''})` }
      }
    }
    // 5. Mode defaults.
    if (this.mode === 'trusted') return { decision: 'allow', reason: 'Trusted mode' }
    if (this.mode === 'acceptEdits' && EDIT_TOOLS.has(req.toolName)) {
      return { decision: 'allow', reason: 'acceptEdits mode auto-approves file edits' }
    }
    return { decision: 'ask', reason: `${req.toolName} is mutating; no rule matched in ${this.mode} mode` }
  }
}
