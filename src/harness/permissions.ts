import type { PermissionDecision, PermissionGate, PermissionMode, PermissionRequest } from '../engine/types.js'

export interface ParsedRule { tool: string; pattern: string | null }

export function parseRule(rule: string): ParsedRule {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) throw new Error(`Malformed permission rule: ${rule}`)
  return { tool: m[1]!, pattern: m[2] ?? null }
}

/** Glob-ish matcher: ** crosses path separators, * does not, ? is one char. */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 1 } else { re += '[^/\\\\]*' }
    } else if (c === '?') {
      re += '.'
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
    }
  }
  return new RegExp(`^${re}$`)
}

/** The string a rule pattern is matched against, per tool. */
export function matchTarget(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash' || toolName === 'PowerShell') return String(obj['command'] ?? '')
  if (typeof obj['file_path'] === 'string') return (obj['file_path'] as string).replaceAll('\\', '/')
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
    const prefix = rule.pattern.endsWith(':*') ? rule.pattern.slice(0, -2) : rule.pattern
    return target === prefix || target.startsWith(prefix + ' ')
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
