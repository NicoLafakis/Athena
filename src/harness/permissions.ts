import { posix, resolve } from 'node:path'
import type {
  PermissionDecision,
  PermissionGate,
  PermissionMode,
  PermissionRequest,
  SandboxMode,
} from '../engine/types.js'
import { ProtectedPaths } from './protected-paths.js'
import { realPathForAccess, type ResourcePolicy } from './resource-policy.js'

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

/** True for `/abs`, `C:/abs`, or `C:\abs` shapes (after backslash folding). */
function isAbsoluteLike(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
}

/** Canonical-absolute form of a file path: resolved against the session cwd
 *  (the same base the tools resolve against), forward slashes, dot segments
 *  folded — so rules and targets are compared in the SAME coordinate system. */
export function canonicalizePath(p: string, cwd: string): string {
  return resolve(cwd, p).replaceAll('\\', '/')
}

/** Canonical-absolute form of a rule pattern: relative patterns (e.g. `src/**`)
 *  are anchored at the session cwd; absolute ones only get slash/dot folding.
 *  Glob metacharacters pass through untouched. */
export function canonicalizePattern(pattern: string, cwd: string): string {
  const slashed = pattern.replaceAll('\\', '/')
  const base = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  return posix.normalize(isAbsoluteLike(slashed) ? slashed : `${base}/${slashed}`)
}

/** The string a rule pattern is matched against, per tool. File paths are
 *  canonicalized against `cwd` — the same resolution the file tools apply. */
export function matchTarget(toolName: string, input: unknown, cwd?: string): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash' || toolName === 'PowerShell') return String(obj['command'] ?? '')
  if (typeof obj['file_path'] === 'string') {
    return cwd === undefined
      ? normalizePathTarget(obj['file_path'] as string)
      : canonicalizePath(obj['file_path'] as string, cwd)
  }
  if (typeof obj['path'] === 'string') {
    return cwd === undefined
      ? normalizePathTarget(obj['path'] as string)
      : canonicalizePath(obj['path'] as string, cwd)
  }
  if (typeof obj['pattern'] === 'string') return obj['pattern'] as string
  if (typeof obj['url'] === 'string') return obj['url'] as string
  return JSON.stringify(input)
}

export function matchesRule(
  rule: ParsedRule,
  toolName: string,
  input: unknown,
  cwd: string = process.cwd(),
): boolean {
  if (rule.tool !== toolName) return false
  if (rule.pattern === null) return true
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    // Command-prefix semantics: "git:*" matches "git" or "git <anything>", never "gitk".
    // NOTE: this prefix filter is ADVISORY only. Shell commands are not paths —
    // they are never normalized — and metacharacters, subshells, `env` tricks,
    // or absolute interpreter paths can trivially evade a string prefix. Real
    // enforcement is the permission ask (deny-by-default for mutating tools)
    // plus PreToolUse hooks; deny rules here are a convenience guardrail.
    const target = matchTarget(toolName, input)
    const prefix = rule.pattern.endsWith(':*') ? rule.pattern.slice(0, -2) : rule.pattern
    return target === prefix || target.startsWith(prefix + ' ')
  }
  // File-path targets: BOTH sides are canonicalized to absolute paths against
  // the session cwd (the coordinate system the tools actually resolve in), and
  // compared case-insensitively on win32, where the filesystem is
  // case-insensitive. This closes the `../` escape (a relative target slipping
  // past an absolute deny rule) and lets relative allow rules match absolute
  // targets.
  const obj = (input ?? {}) as Record<string, unknown>
  const isPathTarget = typeof obj['file_path'] === 'string' || typeof obj['path'] === 'string'
  if (isPathTarget) {
    const pattern = canonicalizePattern(rule.pattern, cwd)
    const target = matchTarget(toolName, input, cwd)
    return globToRegExp(pattern, process.platform === 'win32').test(target)
  }
  return globToRegExp(rule.pattern).test(matchTarget(toolName, input))
}

const EDIT_TOOLS = new Set(['Write', 'Edit'])

export interface PermissionEngineOptions {
  mode: PermissionMode
  allow: string[]
  deny: string[]
  /** Session cwd file-path rules and targets are resolved against — must match
   *  the ToolContext cwd the tools resolve with. Defaults to process.cwd(). */
  cwd?: string
  sandboxMode?: SandboxMode
  resourcePolicy?: ResourcePolicy
  /** Unconditional OS write fence. Defaults to the environment-derived roots so
   *  a caller that omits it is still fenced. */
  protectedPaths?: ProtectedPaths
}

export class PermissionEngine implements PermissionGate {
  private mode: PermissionMode
  private readonly allowRules: ParsedRule[]
  private readonly denyRules: ParsedRule[]
  private readonly sessionGrants: ParsedRule[] = []
  private readonly cwd: string
  private readonly sandboxMode: SandboxMode
  private readonly resourcePolicy?: ResourcePolicy
  private readonly protectedPaths: ProtectedPaths

  constructor(opts: PermissionEngineOptions) {
    this.mode = opts.mode
    this.allowRules = opts.allow.map(parseRule)
    this.denyRules = opts.deny.map(parseRule)
    this.cwd = opts.cwd ?? process.cwd()
    this.sandboxMode = opts.sandboxMode ?? 'unrestricted'
    this.resourcePolicy = opts.resourcePolicy
    this.protectedPaths = opts.protectedPaths ?? ProtectedPaths.defaults()
  }

  setMode(mode: PermissionMode): void { this.mode = mode }
  getMode(): PermissionMode { return this.mode }

  grantSession(rule: string): void { this.sessionGrants.push(parseRule(rule)) }

  /** Expand symlinks, junctions, and 8.3 short names before fencing, so a link
   *  aimed into a protected directory is judged by where it lands. Falls back to
   *  the raw path when the filesystem cannot answer — the fence's own syntactic
   *  normalization still applies. */
  private realPath(path: string): string {
    try {
      return realPathForAccess(path, this.cwd)
    } catch {
      return path
    }
  }

  check(req: PermissionRequest): PermissionDecision {
    const input = (req.input ?? {}) as Record<string, unknown>
    const path =
      typeof input['file_path'] === 'string'
        ? input['file_path']
        : typeof input['path'] === 'string'
          ? input['path']
          : null
    // 0. Protected OS directories. Unconditional and above everything else: no
    //    permission mode, sandbox mode, allow rule, or session grant reaches
    //    past it. Writes only — reads inside the fence fall through untouched.
    if (!req.readOnly) {
      if (path !== null) {
        const fenced = this.protectedPaths.deniedRoot(this.realPath(path), this.cwd)
        if (fenced !== null) {
          return {
            decision: 'deny',
            reason: `Protected system directory: ${fenced} is write-fenced (reads are still allowed)`,
          }
        }
      }
      if (req.toolName === 'Bash' || req.toolName === 'PowerShell') {
        // Best effort only — a shell command carries its target inside an opaque
        // string. See ProtectedPaths.scanCommand for what this cannot catch.
        const hit = this.protectedPaths.scanCommand(String(input['command'] ?? ''), this.cwd)
        if (hit !== null) {
          return {
            decision: 'deny',
            reason:
              `Protected system directory: '${hit.token}' targets ${hit.root}, which is ` +
              'write-fenced (reads are still allowed)',
          }
        }
      }
    }
    if (path !== null && this.resourcePolicy) {
      const access = req.readOnly ? 'read' : 'write'
      if (!this.resourcePolicy.contains(path, access)) {
        return {
          decision: 'deny',
          reason: `${access === 'read' ? 'Read' : 'Write'} target is outside the ${this.sandboxMode} sandbox`,
        }
      }
    }
    if (this.sandboxMode === 'read-only' && !req.readOnly) {
      return { decision: 'deny', reason: 'Read-only sandbox: mutating tools are disabled' }
    }
    // 1. Hard deny — no mode bypasses it.
    for (const rule of this.denyRules) {
      if (matchesRule(rule, req.toolName, req.input, this.cwd)) {
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
      if (matchesRule(rule, req.toolName, req.input, this.cwd)) {
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

export interface TrustBootstrapInput {
  permissionMode: PermissionMode
  sandboxMode: SandboxMode
  /** True only from an explicit record in the user's trust registry — never from the
   *  defaulted `trust=true` a project without `.athena/` gets at boot. */
  explicitlyTrusted: boolean
  platform?: NodeJS.Platform
}

export interface TrustBootstrap {
  permissionMode: PermissionMode
  sandboxMode: SandboxMode
  /** One sentence naming the effective values; undefined when nothing changed. */
  notice?: string
}

/**
 * The owner's explicit project-trust decision selects the effective permission
 * bootstrap: a trusted project starts in 'trusted' mode (the mode that auto-approves
 * mutating tools, shell included), and on Windows — where Athena has no OS-backed
 * sandbox backend and the shell tool otherwise fails closed — the default
 * 'workspace-write' sandbox resolves to 'unrestricted' so trusted mode can actually
 * execute. One-way by design: only the user's stored trust record raises the mode
 * here, and project files can never select trusted mode or an unrestricted sandbox
 * (loadSettings strips both). An explicit non-'normal' mode or non-default sandbox in
 * the user's own settings is respected as-is. Hard deny rules, resource-policy
 * checks, and PermissionRequest hooks keep precedence inside the engine at every mode.
 */
export function resolveTrustBootstrap(input: TrustBootstrapInput): TrustBootstrap {
  if (!input.explicitlyTrusted || input.permissionMode !== 'normal') {
    return { permissionMode: input.permissionMode, sandboxMode: input.sandboxMode }
  }
  const liftWindowsSandbox =
    (input.platform ?? process.platform) === 'win32' && input.sandboxMode === 'workspace-write'
  return {
    permissionMode: 'trusted',
    sandboxMode: liftWindowsSandbox ? 'unrestricted' : input.sandboxMode,
    notice: liftWindowsSandbox
      ? 'Trusted project: permission mode is trusted; the shell runs unrestricted (Athena has no Windows sandbox backend). Deny rules and hooks still apply.'
      : 'Trusted project: permission mode is trusted. Deny rules and hooks still apply.',
  }
}
