import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { EngineEvent } from '../engine/types.js'

export function projectSlug(projectPath: string): string {
  return projectPath
    .replaceAll('\\', '/')
    .replace(/\//g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
}

interface SessionLine {
  kind: 'message' | 'event'
  ts: string
  data: unknown
}

export interface SessionInfo {
  id: string
  file: string
  startedAt: Date
  updatedAt: Date
  title: string
}

export class Session {
  constructor(
    readonly id: string,
    readonly file: string,
  ) {}

  private appendLine(line: SessionLine): void {
    appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8')
  }

  appendMessage(message: MessageParam): void {
    this.appendLine({ kind: 'message', ts: new Date().toISOString(), data: message })
  }

  appendEvent(event: EngineEvent): void {
    this.appendLine({ kind: 'event', ts: new Date().toISOString(), data: event })
  }

  /** Truncate and re-append the full history (used after compaction rewrites messages). */
  rewrite(messages: MessageParam[]): void {
    writeFileSync(this.file, '', 'utf8')
    for (const message of messages) this.appendMessage(message)
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

  private parseFile(file: string): SessionLine[] {
    const lines: SessionLine[] = []
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue
      try {
        lines.push(JSON.parse(raw) as SessionLine)
      } catch {
        /* torn trailing write from a crash — skip */
      }
    }
    return lines
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = join(this.dir, f)
        const stat = statSync(file)
        const firstUser = this.parseFile(file).find(
          (l) =>
            l.kind === 'message' &&
            (l.data as MessageParam).role === 'user' &&
            typeof (l.data as MessageParam).content === 'string',
        )
        return {
          id: f.replace(/\.jsonl$/, ''),
          file,
          startedAt: stat.birthtime,
          updatedAt: stat.mtime,
          title: firstUser ? String((firstUser.data as MessageParam).content).slice(0, 80) : '(no prompt)',
        }
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  resume(id: string): MessageParam[] {
    const file = join(this.dir, `${id}.jsonl`)
    if (!existsSync(file)) throw new Error(`No session ${id} in ${this.dir}`)
    return this.parseFile(file)
      .filter((l) => l.kind === 'message')
      .map((l) => l.data as MessageParam)
  }

  /** Most recently updated session, or null. */
  continueLatest(): { id: string; messages: MessageParam[] } | null {
    const latest = this.list()[0]
    return latest ? { id: latest.id, messages: this.resume(latest.id) } : null
  }
}
