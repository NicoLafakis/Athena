import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunResult } from '../engine/types.js'
import type { EngineEventBus } from '../engine/events.js'
import { projectId } from './trust.js'
import { redactSessionValue } from './sessions.js'

export const RUN_TRACE_SCHEMA_VERSION = 1

export interface RunTraceEnvelope {
  schemaVersion: typeof RUN_TRACE_SCHEMA_VERSION
  runId: string
  parentRunId: string | null
  sequence: number
  timestamp: string
  type: string
  payload: unknown
  previousHash: string | null
  hash: string
}

export interface RunTraceMetadata {
  cwd: string
  provider: string
  model: string
  mode: string
  sandbox: string
  parentRunId?: string
  runId?: string
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class RunTraceWriter {
  readonly runId: string
  readonly file: string
  private sequence = 0
  private previousHash: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private detach: (() => void) | null = null
  private closed = false

  private constructor(
    file: string,
    runId: string,
    private readonly parentRunId: string | null,
  ) {
    this.file = file
    this.runId = runId
  }

  static async create(root: string, metadata: RunTraceMetadata): Promise<RunTraceWriter> {
    const runId = metadata.runId ?? randomUUID()
    const projectDir = join(root, projectId(metadata.cwd))
    await mkdir(projectDir, { recursive: true })
    const file = join(projectDir, `${runId}.jsonl`)
    await writeFile(file, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const writer = new RunTraceWriter(file, runId, metadata.parentRunId ?? null)
    writer.append('run-start', metadata)
    return writer
  }

  attach(bus: EngineEventBus): void {
    this.detach?.()
    this.detach = bus.on((event) => this.append('engine-event', event))
  }

  append(type: string, payload: unknown): void {
    if (this.closed) throw new Error(`Run trace ${this.runId} is already closed`)
    const base = {
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
      runId: this.runId,
      parentRunId: this.parentRunId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      payload: redactSessionValue(payload),
      previousHash: this.previousHash,
    } as const
    const hash = digest(base)
    const envelope: RunTraceEnvelope = { ...base, hash }
    this.previousHash = hash
    const line = JSON.stringify(envelope) + '\n'
    this.queue = this.queue.then(() => appendFile(this.file, line, 'utf8'))
  }

  recordPrompt(prompt: string): void {
    this.append('user-prompt', { prompt })
  }

  async close(result: RunResult): Promise<void> {
    if (this.closed) {
      await this.queue
      return
    }
    this.append('run-finish', result)
    this.closed = true
    this.detach?.()
    this.detach = null
    await this.queue
  }
}

export async function readRunTrace(file: string): Promise<RunTraceEnvelope[]> {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunTraceEnvelope)
}

export async function verifyRunTrace(file: string): Promise<{
  valid: boolean
  events: number
  error?: string
}> {
  const events = await readRunTrace(file)
  let previousHash: string | null = null
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    if (event.schemaVersion !== RUN_TRACE_SCHEMA_VERSION) {
      return { valid: false, events: events.length, error: `unsupported schema at event ${index + 1}` }
    }
    if (event.sequence !== index + 1) {
      return { valid: false, events: events.length, error: `sequence mismatch at event ${index + 1}` }
    }
    if (event.previousHash !== previousHash) {
      return { valid: false, events: events.length, error: `hash-chain mismatch at event ${index + 1}` }
    }
    const { hash, ...base } = event
    if (digest(base) !== hash) {
      return { valid: false, events: events.length, error: `invalid hash at event ${index + 1}` }
    }
    previousHash = hash
  }
  return { valid: true, events: events.length }
}
