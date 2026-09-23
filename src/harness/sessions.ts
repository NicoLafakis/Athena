import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { canonicalProjectPath } from './trust.js'
import { redactSessionValue } from './redaction.js'

export { redactSessionValue } from './redaction.js'

const SESSION_SCHEMA_VERSION = 3
const STALE_LOCK_MS = 30_000

export function projectSlug(projectPath: string): string {
  const canonical = canonicalProjectPath(projectPath)
  const readable = (basename(canonical) || 'root').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}

export interface SessionLine {
  version?: number
  kind: string
  id?: string
  ts: string
  timeZone?: string
  data: unknown
}

export interface SessionLineRecord {
  lineNumber: number
  rawLine: string
  line: SessionLine
}

export interface SessionLineReadResult {
  records: SessionLineRecord[]
  malformedLineNumbers: number[]
}

function isSessionLine(value: unknown): value is SessionLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const line = value as Record<string, unknown>
  return (
    typeof line.kind === 'string' &&
    line.kind.length > 0 &&
    typeof line.ts === 'string' &&
    Object.hasOwn(line, 'data') &&
    (line.version === undefined || typeof line.version === 'number') &&
    (line.id === undefined || typeof line.id === 'string') &&
    (line.timeZone === undefined || typeof line.timeZone === 'string')
  )
}

/** Stable identity for a persisted line, including sessions written before IDs existed. */
export function stableSessionLineId(record: SessionLineRecord): string {
  if (typeof record.line.id === 'string' && record.line.id.length > 0) return record.line.id
  const digest = createHash('sha256').update(record.rawLine, 'utf8').digest('hex')
  return `legacy:${record.lineNumber}:${digest}`
}

interface CheckpointData {
  checkpointId: string
  label: string
  messages: MessageParam[]
}

interface MetadataData {
  title?: string
}

export interface SessionCheckpoint {
  id: string
  label: string
  timestamp: Date
  messageCount: number
}

export interface SessionInfo {
  id: string
  file: string
  startedAt: Date
  updatedAt: Date
  title: string
}

export function parseSessionLineRecords(content: string): SessionLineReadResult {
  const records: SessionLineRecord[] = []
  const malformedLineNumbers: number[] = []
  const rawLines = content.split('\n')
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]!
    if (!raw.trim()) continue
    try {
      const value: unknown = JSON.parse(raw)
      if (!isSessionLine(value)) {
        malformedLineNumbers.push(index + 1)
        continue
      }
      records.push({ lineNumber: index + 1, rawLine: raw, line: value })
    } catch {
      // The session reader preserves valid neighbors and reports gaps to callers that
      // need to avoid claiming a complete continuity episode across malformed lines.
      malformedLineNumbers.push(index + 1)
    }
  }
  return { records, malformedLineNumbers }
}

export function readSessionLineRecordsDetailed(file: string): SessionLineReadResult {
  return parseSessionLineRecords(readFileSync(file, 'utf8'))
}

export function readSessionLineRecords(file: string): SessionLineRecord[] {
  return readSessionLineRecordsDetailed(file).records
}

function parseFile(file: string): SessionLine[] {
  return readSessionLineRecords(file).map((record) => record.line)
}

function messagesAt(lines: SessionLine[], checkpointId?: string): MessageParam[] {
  let messages: MessageParam[] = []
  for (const line of lines) {
    if (line.kind === 'message') messages.push(line.data as MessageParam)
    if (line.kind === 'checkpoint' || line.kind === 'rewind') {
      const checkpoint = line.data as CheckpointData
      messages = structuredClone(checkpoint.messages)
      if (checkpointId && checkpoint.checkpointId === checkpointId) return messages
    }
  }
  if (checkpointId) throw new Error(`No checkpoint ${checkpointId}`)
  return messages
}

function withFileLock<T>(file: string, action: () => T): T {
  const lock = `${file}.lock`
  let handle: number
  try {
    handle = openSync(lock, 'wx', 0o600)
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === 'EEXIST' &&
      existsSync(lock) &&
      Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS
    ) {
      unlinkSync(lock)
      handle = openSync(lock, 'wx', 0o600)
    } else {
      throw new Error(`Session is locked by another writer: ${file}`)
    }
  }
  try {
    return action()
  } finally {
    closeSync(handle)
    try {
      unlinkSync(lock)
    } catch {
      // best effort
    }
  }
}

export class Session {
  private lastLength: number

  constructor(
    readonly id: string,
    readonly file: string,
    initialMessageCount = 0,
  ) {
    this.lastLength = initialMessageCount
  }

  private appendLine(kind: string, data: unknown): void {
    const line: SessionLine = {
      version: SESSION_SCHEMA_VERSION,
      kind,
      id: randomUUID(),
      ts: new Date().toISOString(),
      timeZone: sourceTimeZone(),
      data: redactSessionValue(data),
    }
    withFileLock(this.file, () => appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8'))
  }

  appendMessage(message: MessageParam): void {
    this.appendLine('message', message)
    this.lastLength++
  }

  appendEvent(event: object): void {
    this.appendLine('event', event)
  }

  checkpoint(messages: MessageParam[], label = 'checkpoint'): string {
    const checkpointId = randomUUID()
    this.appendLine('checkpoint', {
      checkpointId,
      label,
      messages: structuredClone(messages),
    } satisfies CheckpointData)
    this.lastLength = messages.length
    return checkpointId
  }

  /** Compatibility name used by compaction. This no longer destroys history:
   * it appends a state checkpoint that becomes the new reconstruction base. */
  rewrite(messages: MessageParam[]): void {
    this.checkpoint(messages, 'context compaction')
  }

  rewriteOrAppend(messages: MessageParam[]): void {
    if (messages.length === this.lastLength + 1) {
      this.appendMessage(messages[messages.length - 1]!)
    } else {
      this.checkpoint(messages, 'state transition')
    }
    this.lastLength = messages.length
  }

  rewind(messages: MessageParam[], checkpointId: string, label: string): void {
    this.appendLine('rewind', {
      checkpointId,
      label,
      messages: structuredClone(messages),
    } satisfies CheckpointData)
    this.lastLength = messages.length
  }

  setTitle(title: string): void {
    this.appendLine('metadata', { title } satisfies MetadataData)
  }
}

function sourceTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!timeZone) return undefined
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return timeZone
  } catch {
    return undefined
  }
}

export class SessionStore {
  private readonly dir: string
  readonly projectId: string

  constructor(sessionsRoot: string, projectPath: string) {
    this.projectId = projectSlug(projectPath)
    this.dir = join(sessionsRoot, this.projectId)
  }

  create(): Session {
    mkdirSync(this.dir, { recursive: true })
    const id = `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}-${randomUUID().slice(0, 8)}`
    return new Session(id, join(this.dir, `${id}.jsonl`))
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((name) => {
        const file = join(this.dir, name)
        const stat = statSync(file)
        const lines = parseFile(file)
        const messages = messagesAt(lines)
        const firstUser = messages.find(
          (message) => message.role === 'user' && typeof message.content === 'string',
        )
        const metadata = [...lines]
          .reverse()
          .find((line) => line.kind === 'metadata')?.data as MetadataData | undefined
        return {
          id: name.replace(/\.jsonl$/, ''),
          file,
          startedAt: stat.birthtime,
          updatedAt: stat.mtime,
          title:
            metadata?.title ??
            (firstUser && typeof firstUser.content === 'string'
              ? firstUser.content.slice(0, 80)
              : '(no prompt)'),
        }
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  resume(id: string): MessageParam[] {
    const file = this.fileFor(id)
    return messagesAt(parseFile(file))
  }

  checkpoints(id: string): SessionCheckpoint[] {
    return parseFile(this.fileFor(id))
      .filter((line) => line.kind === 'checkpoint')
      .map((line) => {
        const data = line.data as CheckpointData
        return {
          id: data.checkpointId,
          label: data.label,
          timestamp: new Date(line.ts),
          messageCount: data.messages.length,
        }
      })
  }

  rewind(id: string, checkpointId: string): MessageParam[] {
    const file = this.fileFor(id)
    const lines = parseFile(file)
    const checkpoint = lines.find(
      (line) =>
        line.kind === 'checkpoint' &&
        (line.data as CheckpointData).checkpointId === checkpointId,
    )
    if (!checkpoint) throw new Error(`No checkpoint ${checkpointId} in session ${id}`)
    const data = checkpoint.data as CheckpointData
    const session = new Session(id, file, messagesAt(lines).length)
    session.rewind(data.messages, checkpointId, `rewind to ${data.label}`)
    return structuredClone(data.messages)
  }

  fork(id: string, checkpointId?: string): Session {
    const sourceFile = this.fileFor(id)
    const lines = parseFile(sourceFile)
    const sourceRecords = readSessionLineRecords(sourceFile)
    const messages = checkpointId ? messagesAt(lines, checkpointId) : messagesAt(lines)
    const boundary = checkpointId
      ? sourceRecords.find(
          ({ line }) =>
            line.kind === 'checkpoint' &&
            (line.data as CheckpointData).checkpointId === checkpointId,
        )
      : sourceRecords.at(-1)
    const fork = this.create()
    fork.checkpoint(messages, `forked from ${id}${checkpointId ? ` at ${checkpointId}` : ''}`)
    fork.appendEvent({
      type: 'session-fork',
      sourceProjectId: this.projectId,
      sourceSessionId: id,
      sourceLineId: boundary ? stableSessionLineId(boundary) : null,
      checkpointId: checkpointId ?? null,
    })
    return fork
  }

  rename(id: string, title: string): void {
    const trimmed = title.trim()
    if (!trimmed) throw new Error('Session title cannot be empty')
    const messages = this.resume(id)
    new Session(id, this.fileFor(id), messages.length).setTitle(trimmed.slice(0, 200))
  }

  search(query: string): SessionInfo[] {
    const needle = query.toLowerCase()
    return this.list().filter((info) => {
      if (info.title.toLowerCase().includes(needle)) return true
      return JSON.stringify(this.resume(info.id)).toLowerCase().includes(needle)
    })
  }

  delete(id: string): string {
    const file = this.fileFor(id)
    const trash = join(this.dir, '.trash')
    mkdirSync(trash, { recursive: true })
    const destination = join(
      trash,
      `${id}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.jsonl`,
    )
    renameSync(file, destination)
    return destination
  }

  continueLatest(): { id: string; messages: MessageParam[] } | null {
    const latest = this.list()[0]
    return latest ? { id: latest.id, messages: this.resume(latest.id) } : null
  }

  private fileFor(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`)
    const file = join(this.dir, `${id}.jsonl`)
    if (!existsSync(file)) throw new Error(`No session ${id} in ${this.dir}`)
    return file
  }
}
