import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * An unconditional write fence over operating-system directories.
 *
 * This is a PATH fence, not a capability restriction. Nothing here removes
 * Athena's ability to delete, move, or overwrite; it only names a small set of
 * directories where mutation is refused. Everywhere else — the whole user
 * profile, every project root, every scratch directory — is untouched.
 *
 * Two properties are load-bearing:
 *
 * 1. **Writes only.** Reads inside a protected directory stay legal. Reading
 *    `C:\Windows\System32\drivers\etc\hosts` is harmless and occasionally
 *    necessary; refusing it would be over-fencing, not safety.
 * 2. **Unconditional.** The fence sits above permission modes, sandbox modes,
 *    allow rules, and session grants. `trusted` mode and an `unrestricted`
 *    sandbox do not reach past it, so the guarantee does not depend on any mode
 *    being configured correctly.
 *
 * Matching is on whole path SEGMENTS, never a raw string prefix: a
 * `C:\Windows` root blocks `C:\Windows\System32` and refuses `C:\WindowsApps`.
 */

export interface ProtectedPathsOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/** What a shell scan found, when it found something. */
export interface ShellFenceHit {
  /** The protected root the token resolved into. */
  root: string
  /** The token as it appeared in the command, before resolution. */
  token: string
  /** Why the token was treated as a mutation rather than a read. */
  reason: 'redirect' | 'mutating-command'
}

/**
 * Commands whose arguments are treated as mutation targets by the shell scan.
 *
 * Explicitly a heuristic. See `scanCommand` for the honest limits — this list
 * is a speed bump on an accident, not a boundary against a determined command
 * string.
 */
const MUTATING_COMMANDS = new Set([
  // POSIX / Git Bash
  'rm', 'rmdir', 'unlink', 'mv', 'cp', 'install', 'dd', 'truncate', 'shred',
  'ln', 'chmod', 'chown', 'chgrp', 'chattr', 'touch', 'mkdir', 'tee', 'sed',
  'patch', 'rsync', 'tar', 'unzip',
  // cmd.exe
  'del', 'erase', 'rd', 'move', 'copy', 'xcopy', 'robocopy', 'attrib',
  'takeown', 'icacls', 'cacls', 'fsutil', 'mklink', 'md',
  // PowerShell
  'new-item', 'set-content', 'add-content', 'clear-content', 'out-file',
  'remove-item', 'move-item', 'copy-item', 'rename-item', 'set-itemproperty',
  'new-itemproperty', 'remove-itemproperty', 'set-acl', 'unblock-file',
  'compress-archive', 'expand-archive', 'new-itemproperty',
])

/** Characters that end a command segment, so the next segment gets its own verb.
 *  Braces are deliberately absent: `${env:ProgramFiles}` is one token, and
 *  breaking on `{` would shred the variable reference before it can expand. */
const SEGMENT_BREAKS = new Set([';', '|', '&', '\n', '(', ')', '`'])

/**
 * Default protected roots, derived from the environment rather than hardcoded.
 *
 * The system drive is not guaranteed to be `C:`, and a fence that assumes it
 * protects nothing on a machine where it is not. Everything here comes from
 * `%SystemRoot%` / `%ProgramFiles%` / `%ProgramData%` / `%SystemDrive%`, with a
 * `C:` fallback only when the environment says nothing at all.
 *
 * Deliberately NOT included: the user profile, `~/.athena`, `AppData`,
 * `%TEMP%`, or any ordinary work directory. Fencing those would break the
 * everyday workflow this exists to keep safe, which is a failure, not a
 * conservative default.
 */
export function defaultProtectedRoots(options: ProtectedPathsOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== 'win32') {
    // Kernel and firmware surfaces only. `/usr`, `/opt`, and `/usr/local` are
    // deliberately absent: Homebrew, nvm, and pnpm live there, and fencing them
    // would break ordinary development for no OS-integrity gain.
    return platform === 'darwin' ? ['/System'] : ['/boot', '/proc', '/sys']
  }
  const roots: string[] = []
  const push = (value: string | undefined): void => {
    const trimmed = (value ?? '').trim()
    if (trimmed !== '') roots.push(trimmed.replace(/[\\/]+$/, ''))
  }
  push(env['SystemRoot'] ?? env['windir'])
  push(env['ProgramFiles'])
  push(env['ProgramFiles(x86)'])
  // The true 64-bit Program Files as seen from a 32-bit process, where
  // %ProgramFiles% is redirected to the (x86) tree.
  push(env['ProgramW6432'])
  push(env['ProgramData'])
  const systemDrive =
    (env['SystemDrive'] ?? '').trim() ||
    (/^([A-Za-z]:)/.exec(env['SystemRoot'] ?? env['windir'] ?? '')?.[1] ?? '') ||
    'C:'
  const drive = systemDrive.replace(/[\\/]+$/, '')
  for (const dir of ['System Volume Information', 'Recovery', 'Boot', 'EFI']) {
    roots.push(`${drive}\\${dir}`)
  }
  return [...new Set(roots)]
}

/** Strip surrounding quotes a shell token may still be wearing. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]!
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Remove Win32 device / extended-length prefixes so `\\?\C:\Windows` compares
 * as `C:\Windows`. Looped because prefixes can be stacked in a crafted string.
 */
function stripDevicePrefix(value: string): string {
  let out = value
  for (let i = 0; i < 4; i++) {
    const unc = /^(?:\\\\[?.]|\\\?\?)\\UNC\\/i.exec(out)
    if (unc) {
      out = `\\\\${out.slice(unc[0].length)}`
      continue
    }
    const device = /^(?:\\\\[?.]|\\\?\?)\\/i.exec(out)
    if (device) {
      out = out.slice(device[0].length)
      continue
    }
    break
  }
  return out
}

function driveOf(value: string): string | null {
  const match = /^([A-Za-z]):/.exec(value)
  return match ? `${match[1]!.toUpperCase()}:` : null
}

/**
 * Windows strips trailing dots and spaces from path components, so
 * `C:\Windows. \System32` and `C:\Windows\System32` name the same directory.
 * Pure dot segments (`.`, `..`) are left alone for the normalizer to fold.
 */
function cleanSegment(segment: string): string {
  const trimmed = segment.trim()
  if (/^\.+$/.test(trimmed)) return trimmed
  const stripped = segment.replace(/[ .]+$/u, '')
  return stripped === '' ? segment : stripped
}

/** Absolute, dot-folded, device-prefix-free Win32 form of `value`. */
function absoluteWin32(value: string, cwd: string): string {
  const folded = stripDevicePrefix(value.replaceAll('/', '\\'))
  const base = stripDevicePrefix(cwd.replaceAll('/', '\\'))
  let absolute: string
  if (folded.startsWith('\\\\')) {
    absolute = folded
  } else {
    const drive = driveOf(folded)
    if (drive !== null) {
      const rest = folded.slice(2)
      // `C:\foo` is rooted; `C:foo` is drive-relative and anchors at the cwd
      // when the cwd sits on that drive, at the drive root otherwise.
      absolute = rest.startsWith('\\')
        ? drive + rest
        : win32.join(driveOf(base) === drive ? base : `${drive}\\`, rest)
    } else if (folded.startsWith('\\')) {
      absolute = `${driveOf(base) ?? 'C:'}${folded}`
    } else {
      absolute = win32.join(base, folded)
    }
  }
  const normalized = win32.normalize(absolute)
  const uncPrefix = normalized.startsWith('\\\\') ? '\\\\' : ''
  return (
    uncPrefix +
    normalized
      .slice(uncPrefix.length)
      .split('\\')
      .map(cleanSegment)
      .join('\\')
  )
}

/**
 * Comparison segments for a Win32 path. `\\host\C$\Windows` — the administrative
 * share — folds to `C:\Windows` so the fence is not sidestepped by addressing a
 * drive through its share name.
 */
function segmentsWin32(absolute: string): string[] {
  const parts = absolute.split('\\').filter((part) => part !== '')
  if (absolute.startsWith('\\\\') && parts.length >= 2) {
    const share = /^([A-Za-z])\$$/.exec(parts[1]!)
    if (share) return [`${share[1]!.toUpperCase()}:`, ...parts.slice(2)].map((p) => p.toLowerCase())
  }
  return parts.map((part) => part.toLowerCase())
}

/**
 * True when `candidate` is the 8.3 short name of `root`.
 *
 * `C:\PROGRA~1\...` must not walk past a `C:\Program Files` fence. Short names
 * are generated from the first six characters of the long name with spaces and
 * extra dots removed, so `Program Files` yields `PROGRA~1` and
 * `System Volume Information` yields `SYSTEM~1`.
 *
 * This is a syntactic fallback only. In the live path the candidate has already
 * been through `realpathSync.native`, which expands a real short name to its
 * long form, so a `~N` segment reaching here means the path does not resolve on
 * disk at all — and denying an unresolvable path inside the fence is harmless.
 */
function isShortNameOf(candidate: string, root: string): boolean {
  const short = /^(.{1,6})~(\d{1,3})$/.exec(candidate)
  if (!short) return false
  const compact = root.replaceAll(' ', '').replaceAll('.', '')
  // Names that already fit 8.3 never get a short name generated for them.
  if (compact.length <= 8 && compact === root) return false
  return compact.startsWith(short[1]!)
}

export class ProtectedPaths {
  private static cached: ProtectedPaths | null = null

  readonly roots: readonly string[]
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly rootEntries: readonly { label: string; segments: string[] }[]

  constructor(roots: readonly string[], options: ProtectedPathsOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    const cleaned = roots.map((root) => root.trim()).filter((root) => root !== '')
    this.roots = cleaned
    this.rootEntries = cleaned.flatMap((root) => {
      const entries = [{ label: root, segments: this.segmentsFor(root, root) }]
      const absolute = this.platform === 'win32' ? win32.isAbsolute(root) : posix.isAbsolute(root)
      if (!absolute) return entries
      try {
        const canonical = realpathSync.native(root)
        const segments = this.segmentsFor(canonical, canonical)
        if (!entries.some((entry) => entry.segments.length === segments.length &&
          entry.segments.every((segment, index) => segment === segments[index]))) {
          entries.push({ label: root, segments })
        }
        return entries
      } catch {
        // Synthetic/platform-specific paths and unavailable roots retain the
        // existing lexical fence. Canonicalize only roots the host can verify.
        return entries
      }
    })
  }

  /** Environment-derived defaults for this process. Memoized; the environment
   *  does not change under a running session. */
  static defaults(): ProtectedPaths {
    ProtectedPaths.cached ??= new ProtectedPaths(defaultProtectedRoots())
    return ProtectedPaths.cached
  }

  /** Defaults plus any directories the user added in settings. Additive only —
   *  settings can extend the fence, never shrink it. */
  static from(extra: readonly string[] = [], options: ProtectedPathsOptions = {}): ProtectedPaths {
    return new ProtectedPaths([...defaultProtectedRoots(options), ...extra], options)
  }

  /** The protected root `target` falls inside, or null when it is unfenced. */
  deniedRoot(target: string, cwd: string): string | null {
    if (this.roots.length === 0) return null
    const raw = unquote(target)
    if (raw === '') return null
    let candidate: string[]
    try {
      candidate = this.segmentsFor(raw, cwd)
    } catch {
      return null
    }
    for (const entry of this.rootEntries) {
      const root = entry.segments
      if (root.length === 0 || candidate.length < root.length) continue
      if (root.every((segment, index) => this.segmentEquals(segment, candidate[index]!))) {
        return entry.label
      }
    }
    return null
  }

  /**
   * Best-effort scan of a shell command string for a mutation aimed inside the
   * fence.
   *
   * **This is not a guarantee, and must not be described as one.** A shell
   * command carries its target inside an opaque string, so the scan is
   * pattern-matching, not enforcement. It is defeated by, at minimum:
   * variables resolved at runtime, `cd` followed by a relative path, an
   * interpreter given inline source (`node -e`, `python -c`), base64/encoded
   * commands, a script file whose contents are never seen here, a mutating
   * program not in `MUTATING_COMMANDS`, and any wrapper that renames a binary.
   *
   * The real defense for `C:\Windows\System32` against a non-elevated process
   * is the Windows ACL: System32 and `C:\Program Files` are owned by
   * `NT SERVICE\TrustedInstaller`, and an unelevated token — including an
   * administrator's filtered token, where the Administrators SID is marked
   * deny-only — cannot write there at all. This scan is defense in depth on top
   * of that, not a substitute for it.
   */
  scanCommand(command: string, cwd: string): ShellFenceHit | null {
    if (this.roots.length === 0 || command.trim() === '') return null
    // Tokenize BEFORE expanding: `${env:ProgramFiles}\App` is one shell token,
    // and expanding first would split it on the space inside "Program Files".
    const tokens = this.tokenize(command)
    let verbIsMutating = false
    let expectingVerb = true
    let previousWasRedirect = false
    for (const token of tokens) {
      if (SEGMENT_BREAKS.has(token)) {
        verbIsMutating = false
        expectingVerb = true
        previousWasRedirect = false
        continue
      }
      if (token === '>') {
        previousWasRedirect = true
        continue
      }
      if (expectingVerb) {
        // Skip leading `sudo`/`doas` and `NAME=value` environment assignments.
        if (token === 'sudo' || token === 'doas') continue
        if (/^[A-Za-z_][\w]*=/.test(token) && !this.looksLikePath(token)) continue
        verbIsMutating = MUTATING_COMMANDS.has(this.verbOf(token))
        expectingVerb = false
        previousWasRedirect = false
        continue
      }
      const isRedirectTarget = previousWasRedirect
      previousWasRedirect = false
      if (!verbIsMutating && !isRedirectTarget) continue
      const value = this.pathValueOf(token)
      if (value === null) continue
      const root = this.deniedRoot(value, cwd)
      if (root !== null) {
        return { root, token, reason: isRedirectTarget ? 'redirect' : 'mutating-command' }
      }
    }
    return null
  }

  private segmentEquals(rootSegment: string, candidate: string): boolean {
    if (rootSegment === candidate) return true
    if (this.platform !== 'win32') return false
    return isShortNameOf(candidate, rootSegment)
  }

  private segmentsFor(target: string, cwd: string): string[] {
    if (this.platform === 'win32') return segmentsWin32(absoluteWin32(target, cwd))
    const base = posix.isAbsolute(cwd) ? cwd : posix.resolve(cwd)
    return posix.resolve(base, target).split('/').filter((part) => part !== '')
  }

  /** `%VAR%`, `$env:VAR`, `${env:VAR}`, `$VAR`, `${VAR}` — unknown names are
   *  left verbatim so an unexpanded variable never silently becomes a match. */
  private expandEnv(command: string): string {
    const lookup = (name: string): string | null => {
      const direct = this.env[name]
      if (direct !== undefined) return direct
      const key = Object.keys(this.env).find((k) => k.toLowerCase() === name.toLowerCase())
      return key === undefined ? null : (this.env[key] ?? null)
    }
    return command
      .replace(/%([A-Za-z_][\w()]*)%/g, (all, name: string) => lookup(name) ?? all)
      .replace(/\$\{?env:([A-Za-z_][\w()]*)\}?/gi, (all, name: string) => lookup(name) ?? all)
      .replace(/\$\{([A-Za-z_]\w*)\}/g, (all, name: string) => lookup(name) ?? all)
      .replace(/\$([A-Za-z_]\w*)/g, (all, name: string) => lookup(name) ?? all)
  }

  /** Quote-aware split that also emits segment breaks and `>` as own tokens. */
  private tokenize(command: string): string[] {
    const tokens: string[] = []
    let current = ''
    let quote: string | null = null
    const flush = (): void => {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
    }
    for (const char of command) {
      if (quote !== null) {
        if (char === quote) quote = null
        else current += char
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        continue
      }
      if (char === '>') {
        flush()
        tokens.push('>')
        continue
      }
      if (SEGMENT_BREAKS.has(char)) {
        flush()
        tokens.push(char)
        continue
      }
      if (/\s/.test(char)) {
        flush()
        continue
      }
      current += char
    }
    flush()
    return tokens
  }

  private verbOf(token: string): string {
    const base = token.split(/[\\/]/).pop() ?? token
    return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '')
  }

  private looksLikePath(token: string): boolean {
    return token.includes('/') || token.includes('\\') || /^[A-Za-z]:/.test(token)
  }

  /** The path-looking part of an argument, or null when it is not one.
   *  Handles `-Path=C:\x` and `--dest=C:\x` argument shapes, and expands
   *  environment references so `%SystemRoot%\System32` is seen for what it is. */
  private pathValueOf(token: string): string | null {
    const raw = token.startsWith('-') && token.includes('=')
      ? token.slice(token.indexOf('=') + 1)
      : token
    if (raw === '' || raw.startsWith('-')) return null
    const value = this.expandEnv(raw)
    return this.looksLikePath(value) ? value : null
  }
}
