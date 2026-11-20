import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { parseFrontmatter } from './loader.js'
import { runGit } from '../harness/git.js'
import { sha256Text } from '../harness/hash.js'
import { atomicWriteFileSync } from '../tools/files.js'

export type FreeTextMemoryStatus = 'active' | 'flagged' | 'superseded' | 'tombstoned'

export interface CitationRecord {
  kind: 'file-line' | 'file' | 'flag' | 'cmd'
  raw: string
  path?: string
  line?: number
  endLine?: number
  contentHash?: string
  flag?: string
  command?: string
}

export interface FreeTextHygieneMetadata {
  status: FreeTextMemoryStatus
  citations: CitationRecord[]
  verifiedAt?: string
  lastFlaggedAt?: string
  flagReason?: string
  supersedes?: string
  supersededBy?: string
  reviewedAt?: string
}

export interface CitationVerificationResult {
  checked: number
  relocated: number
  flagged: Array<{ path: string; reason: string }>
}

export interface VerifyCitationsOptions {
  touchedFiles?: readonly string[]
  validFlags?: ReadonlySet<string>
  validCommands?: ReadonlySet<string>
  now?: () => Date
}

export interface SameCitationContradiction {
  citation: string
  files: string[]
}

const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'yml', 'yaml',
  'py', 'sh', 'ps1', 'css', 'html', 'sql', 'toml', 'rs', 'go', 'java', 'c', 'h', 'cpp',
])

const FILE_LINE_RE =
  /(?<![A-Za-z0-9_:/.-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.([A-Za-z0-9]+)):(\d+)(?:-(\d+))?/g
const BARE_FILE_RE =
  /(?<![A-Za-z0-9_:/.-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.([A-Za-z0-9]+))(?![:\w/.-])/g
const BACKTICK_FLAG_RE = /`(--[a-z0-9][a-z0-9-]*)`/g
const EXPLICIT_FLAG_RE = /\bflag:(--[a-z0-9][a-z0-9-]*)/g
const BACKTICK_CMD_RE = /`(athena\s+[a-z0-9-]+(?:\s+[a-z0-9-]+)?)`/g

const HYGIENE_STATE_FILE = '.hygiene-state.json'
const HygieneStateSchema = z.object({
  writesSinceConsolidation: z.number().int().nonnegative(),
  lastConsolidatedAt: z.string().optional(),
})

function normalizeLineForHash(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function hashLine(line: string): string {
  return sha256Text(normalizeLineForHash(line)).slice(0, 16)
}

function safeResolveMemoryFile(memoryDir: string, relPath: string): string {
  const abs = resolve(memoryDir, relPath)
  const root = resolve(memoryDir)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`Path escapes memory dir: ${relPath}`)
  }
  return abs
}

function isFreeTextMemoryFile(memoryDir: string, absPath: string): boolean {
  const rel = relative(memoryDir, absPath).replaceAll('\\', '/')
  const lower = rel.toLowerCase()
  if (!lower.endsWith('.md')) return false
  if (lower === 'memory.md' || lower === 'learned.md') return false
  if (lower.startsWith('journal/') || lower.startsWith('semantic/')) return false
  return true
}

function listFreeTextFiles(memoryDir: string): string[] {
  if (!existsSync(memoryDir)) return []
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        const lower = entry.toLowerCase()
        if (lower === 'journal' || lower === 'semantic' || lower.startsWith('.')) continue
        visit(full)
      } else if (isFreeTextMemoryFile(memoryDir, full)) {
        out.push(full)
      }
    }
  }
  visit(memoryDir)
  return out.sort()
}

export function extractCitations(body: string): CitationRecord[] {
  const seen = new Set<string>()
  const out: CitationRecord[] = []
  const push = (record: CitationRecord): void => {
    if (seen.has(record.raw)) return
    seen.add(record.raw)
    out.push(record)
  }

  for (const match of body.matchAll(FILE_LINE_RE)) {
    const filePath = match[1]!
    const ext = match[2]!.toLowerCase()
    if (!KNOWN_EXTENSIONS.has(ext)) continue
    const line = Number(match[3])
    const endLine = match[4] ? Number(match[4]) : undefined
    if (!Number.isInteger(line) || line <= 0) continue
    const raw = endLine ? `${filePath}:${line}-${endLine}` : `${filePath}:${line}`
    push({ kind: 'file-line', raw, path: filePath, line, ...(endLine ? { endLine } : {}) })
  }

  for (const match of body.matchAll(BARE_FILE_RE)) {
    const filePath = match[1]!
    const ext = match[2]!.toLowerCase()
    if (!KNOWN_EXTENSIONS.has(ext)) continue
    push({ kind: 'file', raw: filePath, path: filePath })
  }

  for (const re of [BACKTICK_FLAG_RE, EXPLICIT_FLAG_RE]) {
    for (const match of body.matchAll(re)) {
      const flag = match[1]!
      push({ kind: 'flag', raw: `flag:${flag}`, flag })
    }
  }

  for (const match of body.matchAll(BACKTICK_CMD_RE)) {
    const command = match[1]!.trim()
    push({ kind: 'cmd', raw: `cmd:${command}`, command })
  }

  return out
}

export function parseFreeTextHygiene(raw: string): {
  meta: FreeTextHygieneMetadata
  extraAttrs: Record<string, string>
  body: string
} {
  const { attrs, body } = parseFrontmatter(raw)
  const rawStatus = attrs['status']
  const status: FreeTextMemoryStatus =
    rawStatus === 'flagged' || rawStatus === 'superseded' || rawStatus === 'tombstoned'
      ? rawStatus
      : 'active'

  let citations: CitationRecord[] = []
  if (attrs['citations']) {
    try {
      const parsed = JSON.parse(attrs['citations'])
      if (Array.isArray(parsed)) {
        citations = parsed.filter(
          (item): item is CitationRecord =>
            typeof item === 'object' && item !== null && typeof (item as { raw?: unknown }).raw === 'string',
        )
      }
    } catch {
      citations = []
    }
  }

  const managedKeys = new Set([
    'status', 'citations', 'verifiedat', 'lastflaggedat', 'flagreason',
    'supersedes', 'supersededby', 'reviewedat',
  ])
  const extraAttrs: Record<string, string> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (!managedKeys.has(key)) extraAttrs[key] = value
  }

  return {
    meta: {
      status,
      citations,
      ...(attrs['verifiedat'] ? { verifiedAt: attrs['verifiedat'] } : {}),
      ...(attrs['lastflaggedat'] ? { lastFlaggedAt: attrs['lastflaggedat'] } : {}),
      ...(attrs['flagreason'] ? { flagReason: attrs['flagreason'] } : {}),
      ...(attrs['supersedes'] ? { supersedes: attrs['supersedes'] } : {}),
      ...(attrs['supersededby'] ? { supersededBy: attrs['supersededby'] } : {}),
      ...(attrs['reviewedat'] ? { reviewedAt: attrs['reviewedat'] } : {}),
    },
    extraAttrs,
    body,
  }
}

function serializeFreeTextHygiene(
  meta: FreeTextHygieneMetadata,
  extraAttrs: Record<string, string>,
  body: string,
): string {
  const lines: string[] = ['---', `status: ${meta.status}`]
  if (meta.citations.length > 0) lines.push(`citations: ${JSON.stringify(meta.citations)}`)
  if (meta.verifiedAt) lines.push(`verifiedAt: ${meta.verifiedAt}`)
  if (meta.lastFlaggedAt) lines.push(`lastFlaggedAt: ${meta.lastFlaggedAt}`)
  if (meta.flagReason) lines.push(`flagReason: ${meta.flagReason.replace(/\r?\n/g, ' ')}`)
  if (meta.supersedes) lines.push(`supersedes: ${meta.supersedes}`)
  if (meta.supersededBy) lines.push(`supersededBy: ${meta.supersededBy}`)
  if (meta.reviewedAt) lines.push(`reviewedAt: ${meta.reviewedAt}`)
  for (const [key, value] of Object.entries(extraAttrs)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${body}`
}

function writePatchedMemory(
  absPath: string,
  meta: FreeTextHygieneMetadata,
  extraAttrs: Record<string, string>,
  body: string,
): void {
  const serialized = serializeFreeTextHygiene(meta, extraAttrs, body)
  atomicWriteFileSync(absPath, serialized, (readBack) => {
    if (readBack !== serialized) throw new Error(`Memory hygiene write verification failed: ${absPath}`)
  })
}

function findGitRenameTarget(cwd: string, relPath: string): string | null {
  try {
    const out = runGit(cwd, ['log', '--follow', '--diff-filter=R', '--name-status', '--format=', '--', relPath])
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split('\t')
      if (parts.length >= 3 && parts[0]?.startsWith('R') && parts[2]) {
        const candidate = parts[2].replaceAll('\\', '/')
        if (existsSync(resolve(cwd, candidate))) return candidate
      }
    }
    // Fallback: inspect recent renames across the repo matching the old path.
    const recent = runGit(cwd, ['log', '-n', '50', '--diff-filter=R', '--name-status', '--format='])
    const normalizedOld = relPath.replaceAll('\\', '/')
    for (const line of recent.split(/\r?\n/)) {
      const parts = line.trim().split('\t')
      if (parts.length >= 3 && parts[0]?.startsWith('R') && parts[1]?.replaceAll('\\', '/') === normalizedOld) {
        const candidate = parts[2]!.replaceAll('\\', '/')
        if (existsSync(resolve(cwd, candidate))) return candidate
      }
    }
  } catch {
    // Not a git repo or git unavailable — fall through cleanly.
  }
  return null
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i)
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]!
    dp[0] = j
    for (let i = 1; i <= a.length; i++) {
      const temp = dp[i]!
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i]!, dp[i - 1]!)
      prev = temp
    }
  }
  return dp[a.length]!
}

function findNearMatch(target: string, candidates: ReadonlySet<string>): string | null {
  let best: string | null = null
  let bestDist = 3
  for (const candidate of candidates) {
    const dist = editDistance(target, candidate)
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}

function mergeExtractedCitations(
  existing: CitationRecord[],
  extracted: CitationRecord[],
): CitationRecord[] {
  const byRaw = new Map(existing.map((c) => [c.raw, c]))
  const byKey = new Map(existing.map((c) => [`${c.kind}:${c.path ?? c.flag ?? c.command ?? c.raw}`, c]))
  return extracted.map((fresh) => {
    const exact = byRaw.get(fresh.raw)
    if (exact) return exact
    const keyMatch = byKey.get(`${fresh.kind}:${fresh.path ?? fresh.flag ?? fresh.command ?? fresh.raw}`)
    if (keyMatch && fresh.kind === 'file-line' && keyMatch.contentHash) {
      return { ...fresh, contentHash: keyMatch.contentHash }
    }
    return fresh
  })
}

export function verifyCitations(
  memoryDir: string,
  cwd: string,
  options: VerifyCitationsOptions = {},
): CitationVerificationResult {
  const nowIso = (options.now ?? (() => new Date()))().toISOString()
  const touched = options.touchedFiles
    ? new Set(options.touchedFiles.map((p) => p.replaceAll('\\', '/').replace(/^\.\//, '')))
    : null
  const files = listFreeTextFiles(memoryDir)
  let checked = 0
  let relocated = 0
  const flagged: Array<{ path: string; reason: string }> = []
  let anyChanged = false

  for (const absPath of files) {
    const relPath = relative(memoryDir, absPath).replaceAll('\\', '/')
    const raw = readFileSync(absPath, 'utf8')
    const { meta, extraAttrs, body } = parseFreeTextHygiene(raw)
    if (meta.status === 'superseded' || meta.status === 'tombstoned') continue

    const extracted = extractCitations(body)
    const citations = mergeExtractedCitations(meta.citations, extracted)
    if (citations.length === 0) continue

    if (touched) {
      const relevant = citations.some((c) => c.path && touched.has(c.path.replaceAll('\\', '/')))
      if (!relevant) continue
    }

    checked++
    let dirty = citations.length !== meta.citations.length
    let flagReason: string | null = null
    const updatedCitations: CitationRecord[] = []

    for (const citation of citations) {
      const next = { ...citation }
      if ((citation.kind === 'file-line' || citation.kind === 'file') && citation.path) {
        let targetPath = citation.path.replaceAll('\\', '/')
        let absTarget = resolve(cwd, targetPath)
        if (!existsSync(absTarget)) {
          const renamed = findGitRenameTarget(cwd, targetPath)
          if (renamed) {
            targetPath = renamed
            absTarget = resolve(cwd, renamed)
            next.path = renamed
            next.raw = citation.kind === 'file-line' && citation.line
              ? `${renamed}:${citation.line}${citation.endLine ? `-${citation.endLine}` : ''}`
              : renamed
            relocated++
            dirty = true
          } else {
            flagReason = `citation ${citation.raw} file not found`
            updatedCitations.push(next)
            continue
          }
        }
        if (citation.kind === 'file-line' && citation.line) {
          const lines = readFileSync(absTarget, 'utf8').split(/\r?\n/)
          const idx = citation.line - 1
          const currentLine = lines[idx]
          if (!citation.contentHash) {
            if (currentLine === undefined) {
              flagReason = `citation ${citation.raw} line out of range`
            } else {
              next.contentHash = hashLine(currentLine)
              dirty = true
            }
          } else {
            const currentHash = currentLine !== undefined ? hashLine(currentLine) : null
            if (currentHash !== citation.contentHash) {
              const start = Math.max(0, idx - 10)
              const end = Math.min(lines.length - 1, idx + 10)
              let foundLine: number | null = null
              for (let i = start; i <= end; i++) {
                if (hashLine(lines[i]!) === citation.contentHash) {
                  foundLine = i + 1
                  break
                }
              }
              if (foundLine !== null) {
                next.line = foundLine
                next.raw = `${targetPath}:${foundLine}`
                relocated++
                dirty = true
              } else {
                flagReason = `citation ${citation.raw} line moved or was edited beyond a rename`
              }
            }
          }
        }
      } else if (citation.kind === 'flag' && citation.flag && options.validFlags) {
        if (!options.validFlags.has(citation.flag)) {
          const near = findNearMatch(citation.flag, options.validFlags)
          if (near) {
            next.flag = near
            next.raw = `flag:${near}`
            relocated++
            dirty = true
          } else {
            flagReason = `citation ${citation.raw} flag not found`
          }
        }
      } else if (citation.kind === 'cmd' && citation.command && options.validCommands) {
        if (!options.validCommands.has(citation.command)) {
          const near = findNearMatch(citation.command, options.validCommands)
          if (near) {
            next.command = near
            next.raw = `cmd:${near}`
            relocated++
            dirty = true
          } else {
            flagReason = `citation ${citation.raw} command not found`
          }
        }
      }
      updatedCitations.push(next)
    }

    if (flagReason) {
      const nextMeta: FreeTextHygieneMetadata = {
        ...meta,
        status: 'flagged',
        citations: updatedCitations,
        verifiedAt: nowIso,
        lastFlaggedAt: nowIso,
        flagReason,
      }
      writePatchedMemory(absPath, nextMeta, extraAttrs, body)
      flagged.push({ path: relPath, reason: flagReason })
      anyChanged = true
    } else if (dirty || !meta.verifiedAt) {
      const nextMeta: FreeTextHygieneMetadata = {
        ...meta,
        citations: updatedCitations,
        verifiedAt: nowIso,
      }
      writePatchedMemory(absPath, nextMeta, extraAttrs, body)
      anyChanged = true
    }
  }

  if (anyChanged) rebuildFreeTextMemoryIndex(memoryDir)
  return { checked, relocated, flagged }
}

export function flagFreeTextMemory(
  memoryDir: string,
  relPath: string,
  reason: string,
  now: () => Date = () => new Date(),
): void {
  const abs = safeResolveMemoryFile(memoryDir, relPath)
  if (!existsSync(abs)) throw new Error(`No memory at ${relPath}`)
  const { meta, extraAttrs, body } = parseFreeTextHygiene(readFileSync(abs, 'utf8'))
  if (meta.status === 'superseded' || meta.status === 'tombstoned') {
    throw new Error(`Memory ${relPath} is terminal (${meta.status}) and cannot be flagged`)
  }
  const ts = now().toISOString()
  writePatchedMemory(
    abs,
    { ...meta, status: 'flagged', lastFlaggedAt: ts, flagReason: reason.trim() || 'flagged for review' },
    extraAttrs,
    body,
  )
  rebuildFreeTextMemoryIndex(memoryDir)
}

export function restoreFreeTextMemory(
  memoryDir: string,
  relPath: string,
  now: () => Date = () => new Date(),
): void {
  const abs = safeResolveMemoryFile(memoryDir, relPath)
  if (!existsSync(abs)) throw new Error(`No memory at ${relPath}`)
  const { meta, extraAttrs, body } = parseFreeTextHygiene(readFileSync(abs, 'utf8'))
  if (meta.status === 'superseded' || meta.status === 'tombstoned') {
    throw new Error(`Memory ${relPath} is terminal (${meta.status}) and cannot be restored`)
  }
  const { flagReason: _r, lastFlaggedAt: _f, ...rest } = meta
  void _r
  void _f
  writePatchedMemory(
    abs,
    { ...rest, status: 'active', reviewedAt: now().toISOString() },
    extraAttrs,
    body,
  )
  rebuildFreeTextMemoryIndex(memoryDir)
}

export function supersedeFreeTextMemory(
  memoryDir: string,
  oldRelPath: string,
  newRelPath: string,
  now: () => Date = () => new Date(),
): void {
  const oldAbs = safeResolveMemoryFile(memoryDir, oldRelPath)
  const newAbs = safeResolveMemoryFile(memoryDir, newRelPath)
  if (!existsSync(oldAbs)) throw new Error(`No memory at ${oldRelPath}`)
  if (!existsSync(newAbs)) throw new Error(`Replacement memory must exist first: ${newRelPath}`)
  const oldParsed = parseFreeTextHygiene(readFileSync(oldAbs, 'utf8'))
  const newParsed = parseFreeTextHygiene(readFileSync(newAbs, 'utf8'))
  if (oldParsed.meta.status === 'superseded' || oldParsed.meta.status === 'tombstoned') {
    throw new Error(`Memory ${oldRelPath} is already terminal (${oldParsed.meta.status})`)
  }
  const ts = now().toISOString()
  const oldPosix = oldRelPath.replaceAll('\\', '/')
  const newPosix = newRelPath.replaceAll('\\', '/')
  writePatchedMemory(
    newAbs,
    { ...newParsed.meta, supersedes: oldPosix, reviewedAt: ts },
    newParsed.extraAttrs,
    newParsed.body,
  )
  writePatchedMemory(
    oldAbs,
    { ...oldParsed.meta, status: 'superseded', supersededBy: newPosix, reviewedAt: ts },
    oldParsed.extraAttrs,
    oldParsed.body,
  )
  rebuildFreeTextMemoryIndex(memoryDir)
}

export function tombstoneFreeTextMemory(
  memoryDir: string,
  relPath: string,
  reason: string,
  now: () => Date = () => new Date(),
): void {
  const abs = safeResolveMemoryFile(memoryDir, relPath)
  if (!existsSync(abs)) throw new Error(`No memory at ${relPath}`)
  const { meta, extraAttrs, body } = parseFreeTextHygiene(readFileSync(abs, 'utf8'))
  if (meta.status === 'tombstoned') return
  const ts = now().toISOString()
  writePatchedMemory(
    abs,
    { ...meta, status: 'tombstoned', flagReason: reason.trim() || 'tombstoned', reviewedAt: ts },
    extraAttrs,
    body,
  )
  rebuildFreeTextMemoryIndex(memoryDir)
}

export function detectSameCitationContradictions(memoryDir: string): SameCitationContradiction[] {
  const byCitation = new Map<string, string[]>()
  for (const absPath of listFreeTextFiles(memoryDir)) {
    const relPath = relative(memoryDir, absPath).replaceAll('\\', '/')
    const { meta, body } = parseFreeTextHygiene(readFileSync(absPath, 'utf8'))
    if (meta.status !== 'active') continue
    const citations = meta.citations.length > 0 ? meta.citations : extractCitations(body)
    for (const citation of citations) {
      const list = byCitation.get(citation.raw) ?? []
      if (!list.includes(relPath)) list.push(relPath)
      byCitation.set(citation.raw, list)
    }
  }
  return [...byCitation.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([citation, files]) => ({ citation, files: files.sort() }))
    .sort((a, b) => a.citation.localeCompare(b.citation))
}

export function formatFreeTextReadBanner(raw: string): string {
  const { meta, body } = parseFreeTextHygiene(raw)
  if (meta.status === 'flagged') {
    const since = meta.lastFlaggedAt ? ` since ${meta.lastFlaggedAt.slice(0, 10)}` : ''
    const reason = meta.flagReason ?? 'needs review'
    return `[WARNING: This memory is FLAGGED (${reason}${since}). Treat with reduced confidence.]\n\n${body}`
  }
  if (meta.status === 'superseded') {
    return `[WARNING: SUPERSEDED by ${meta.supersededBy ?? 'a newer memory'} — read that instead.]\n\n${body}`
  }
  if (meta.status === 'tombstoned') {
    return `[WARNING: TOMBSTONED (${meta.flagReason ?? 'retired'}). Kept for audit only.]\n\n${body}`
  }
  return raw
}

export function rebuildFreeTextMemoryIndex(
  memoryDir: string,
  descriptions?: ReadonlyMap<string, string>,
): void {
  const idxPath = join(memoryDir, 'MEMORY.md')
  const existingDescriptions = new Map<string, string>()
  if (existsSync(idxPath)) {
    for (const line of readFileSync(idxPath, 'utf8').split(/\r?\n/)) {
      const m = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+—\s+(.*)$/.exec(line)
      if (m?.[2] && m[3]) {
        const cleaned = m[3]
          .replace(/^FLAGGED\s*\([^)]*\):\s*/i, '')
          .replace(/^superseded by [^—]+—\s*/i, '')
          .replace(/^TOMBSTONED(?:\s*\([^)]*\))?:\s*/i, '')
        existingDescriptions.set(m[2], cleaned)
      }
    }
  }
  if (descriptions) {
    for (const [key, value] of descriptions.entries()) existingDescriptions.set(key, value)
  }

  interface Entry {
    rel: string
    status: FreeTextMemoryStatus
    lastFlaggedAt: string
    line: string
  }
  const entries: Entry[] = []
  for (const absPath of listFreeTextFiles(memoryDir)) {
    const rel = relative(memoryDir, absPath).replaceAll('\\', '/')
    const { meta, body } = parseFreeTextHygiene(readFileSync(absPath, 'utf8'))
    const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? rel
    const desc = existingDescriptions.get(rel) ?? firstLine
    let rendered = desc
    if (meta.status === 'flagged') {
      rendered = `FLAGGED (${meta.flagReason ?? 'citation missing'}): ${desc}`
    } else if (meta.status === 'superseded') {
      rendered = `superseded by ${meta.supersededBy ?? 'newer memory'} — ${desc}`
    } else if (meta.status === 'tombstoned') {
      rendered = `TOMBSTONED (${meta.flagReason ?? 'retired'}): ${desc}`
    }
    entries.push({
      rel,
      status: meta.status,
      lastFlaggedAt: meta.lastFlaggedAt ?? '',
      line: `- [${rel}](${rel}) — ${rendered}`,
    })
  }

  const active = entries.filter((e) => e.status === 'active').sort((a, b) => a.rel.localeCompare(b.rel))
  const flagged = entries
    .filter((e) => e.status === 'flagged')
    .sort((a, b) => b.lastFlaggedAt.localeCompare(a.lastFlaggedAt) || a.rel.localeCompare(b.rel))
  const superseded = entries
    .filter((e) => e.status === 'superseded')
    .sort((a, b) => a.rel.localeCompare(b.rel))
  const tombstoned = entries
    .filter((e) => e.status === 'tombstoned')
    .sort((a, b) => a.rel.localeCompare(b.rel))

  const ordered = [...active, ...flagged, ...superseded, ...tombstoned]
  mkdirSync(dirname(idxPath), { recursive: true })
  const content = ['# Memory Index', '', ...ordered.map((e) => e.line)].join('\n').trimEnd() + '\n'
  atomicWriteFileSync(idxPath, content)
}

export function formatFreeTextReviewList(memoryDir: string): string {
  const flagged: string[] = []
  for (const absPath of listFreeTextFiles(memoryDir)) {
    const rel = relative(memoryDir, absPath).replaceAll('\\', '/')
    const { meta } = parseFreeTextHygiene(readFileSync(absPath, 'utf8'))
    if (meta.status === 'flagged') {
      flagged.push(`- ${rel} — ${meta.flagReason ?? 'flagged for review'}`)
    }
  }
  const contradictions = detectSameCitationContradictions(memoryDir).map(
    (c) => `- Same citation ${c.citation}: ${c.files.join(', ')}`,
  )
  if (flagged.length === 0 && contradictions.length === 0) {
    return 'No flagged free-text memories or citation contradiction hints.'
  }
  const sections: string[] = []
  if (flagged.length > 0) sections.push('Flagged memories:\n' + flagged.join('\n'))
  if (contradictions.length > 0) sections.push('Same-citation hints:\n' + contradictions.join('\n'))
  return sections.join('\n\n')
}

function readHygieneState(memoryDir: string): z.infer<typeof HygieneStateSchema> {
  const file = join(memoryDir, HYGIENE_STATE_FILE)
  if (!existsSync(file)) return { writesSinceConsolidation: 0 }
  try {
    return HygieneStateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { writesSinceConsolidation: 0 }
  }
}

export function recordMemoryWriteForHygiene(memoryDir: string): number {
  const current = readHygieneState(memoryDir)
  const next = { ...current, writesSinceConsolidation: current.writesSinceConsolidation + 1 }
  mkdirSync(memoryDir, { recursive: true })
  atomicWriteFileSync(join(memoryDir, HYGIENE_STATE_FILE), JSON.stringify(next, null, 2) + '\n')
  return next.writesSinceConsolidation
}

export function consolidationDue(memoryDir: string, threshold = 15): boolean {
  return readHygieneState(memoryDir).writesSinceConsolidation >= threshold
}

export function markConsolidated(memoryDir: string, now: () => Date = () => new Date()): void {
  mkdirSync(memoryDir, { recursive: true })
  const next = { writesSinceConsolidation: 0, lastConsolidatedAt: now().toISOString() }
  atomicWriteFileSync(join(memoryDir, HYGIENE_STATE_FILE), JSON.stringify(next, null, 2) + '\n')
}

export const CORRECTION_PROMPT_RE =
  /\b(that'?s wrong|no longer|actually it'?s|outdated|changed from|we switched from|stop doing that)\b/i
