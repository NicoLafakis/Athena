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

const SESSION_SCHEMA_VERSION = 2
const STALE_LOCK_MS = 30_000

export function projectSlug(projectPath: string): string {
  const canonical = canonicalProjectPath(projectPath)
  const readable = (basename(canonical) || 'root').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}

interface SessionLine {
  version?: number
  kind: string
  id?: string
  ts: string
  data: unknown
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

function parseFile(file: string): SessionLine[] {
  const lines: SessionLine[] = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue
    try {
      lines.push(JSON.parse(raw) as SessionLine)
    } catch {
      // A torn final append is ignored; earlier immutable records remain valid.
    }
  }
  return lines
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

export class SessionStore {
  private readonly dir: string

  constructor(sessionsRoot: string, projectPath: string) {
    this.dir = join(sessionsRoot, projectSlug(projectPath))
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
    const messages = checkpointId ? messagesAt(lines, checkpointId) : messagesAt(lines)
    const fork = this.create()
    fork.checkpoint(messages, `forked from ${id}${checkpointId ? ` at ${checkpointId}` : ''}`)
    fork.appendEvent({ type: 'session-fork', sourceSessionId: id, checkpointId: checkpointId ?? null })
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
