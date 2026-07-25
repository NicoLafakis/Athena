import { opendir } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  readRunTrace,
  verifyRunTrace,
  type RunTraceEnvelope,
} from '../harness/traces.js'
import type { RunResult } from '../engine/types.js'

export interface TraceRecord {
  runId: string
  file: string
  parentRunId: string | null
  startedAt: string
  finishedAt: string | null
  finalHash: string
  integrity: 'valid' | 'invalid'
  status: RunResult['status'] | 'incomplete'
  usage: RunResult['usage'] | null
  toolCalls: number
  toolErrors: number
  safetyDenials: number
  fatalErrors: number
}

async function traceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let handle
    try {
      handle = await opendir(directory)
    } catch {
      return
    }
    for await (const entry of handle) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await visit(root)
  return files
}

function summarize(file: string, events: RunTraceEnvelope[], valid: boolean): TraceRecord {
  const start = events.find((event) => event.type === 'run-start')
  const finish = [...events].reverse().find((event) => event.type === 'run-finish')
  const result = finish?.payload as RunResult | undefined
  const engineEvents = events
    .filter((event) => event.type === 'engine-event')
    .map((event) => event.payload as { type?: string; isError?: boolean; output?: string; fatal?: boolean })
  return {
    runId: events[0]?.runId ?? basename(file, '.jsonl'),
    file,
    parentRunId: events[0]?.parentRunId ?? null,
    startedAt: start?.timestamp ?? events[0]?.timestamp ?? new Date(0).toISOString(),
    finishedAt: finish?.timestamp ?? null,
    finalHash: events.at(-1)?.hash ?? '0'.repeat(64),
    integrity: valid ? 'valid' : 'invalid',
    status: result?.status ?? 'incomplete',
    usage: result?.usage ?? null,
    toolCalls: engineEvents.filter((event) => event.type === 'tool-request').length,
    toolErrors: engineEvents.filter((event) => event.type === 'tool-result' && event.isError).length,
    safetyDenials: engineEvents.filter(
      (event) =>
        event.type === 'tool-result' &&
        event.isError &&
        /permission denied|blocked by .*hook/i.test(event.output ?? ''),
    ).length,
    fatalErrors: engineEvents.filter((event) => event.type === 'error' && event.fatal).length,
  }
}

/** Immutable trace warehouse view. Invalid hash chains remain visible but may
 * never be used as learning provenance. */
export class TraceWarehouse {
  constructor(private readonly runsRoot: string) {}

  async list(): Promise<TraceRecord[]> {
    const records: TraceRecord[] = []
    for (const file of await traceFiles(this.runsRoot)) {
      try {
        const [events, integrity] = await Promise.all([
          readRunTrace(file),
          verifyRunTrace(file),
        ])
        records.push(summarize(file, events, integrity.valid))
      } catch {
        records.push({
          runId: basename(file, '.jsonl'),
          file,
          parentRunId: null,
          startedAt: new Date(0).toISOString(),
          finishedAt: null,
          finalHash: '0'.repeat(64),
          integrity: 'invalid',
          status: 'incomplete',
          usage: null,
          toolCalls: 0,
          toolErrors: 0,
          safetyDenials: 0,
          fatalErrors: 0,
        })
      }
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async get(runId: string): Promise<TraceRecord> {
    const record = (await this.list()).find((item) => item.runId === runId)
    if (!record) throw new Error(`Unknown run ${runId}`)
    return record
  }

  async requireEvidence(runIds: string[]): Promise<TraceRecord[]> {
    const records = await Promise.all(runIds.map((runId) => this.get(runId)))
    const invalid = records.find((record) => record.integrity !== 'valid')
    if (invalid) throw new Error(`Run ${invalid.runId} has an invalid trace and cannot be evidence`)
    return records
  }
}
