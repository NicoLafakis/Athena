import { createHash } from 'node:crypto'
import type { EngineEvent } from '../../engine/types.js'

export interface RepeatedFailureAdvisory {
  id: string
  toolName: string
  summary: string
  action: string
}

export interface RepeatedFailureDetectorOptions {
  maxPending?: number
  maxTools?: number
}

interface PendingCall {
  toolName: string
  fingerprint: string
}

interface FailureSequence {
  fingerprint: string
  count: number
  announced: boolean
}

const MAX_DEPTH = 12
const MAX_COLLECTION_ITEMS = 256
const MAX_STRING_CHARS = 4_096

function canonical(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return '[DEPTH-LIMIT]'
  if (typeof value === 'string') return value.slice(0, MAX_STRING_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => canonical(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_COLLECTION_ITEMS)
        .map(([key, item]) => [key.slice(0, 256), canonical(item, depth + 1)]),
    )
  }
  return String(value).slice(0, MAX_STRING_CHARS)
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function trimOldest<K, V>(values: Map<K, V>, max: number): void {
  while (values.size > max) {
    const oldest = values.keys().next().value as K | undefined
    if (oldest === undefined) return
    values.delete(oldest)
  }
}

/** Run-local, deterministic detector. It retains hashes only, never tool input or output. */
export class RepeatedFailureDetector {
  private readonly pending = new Map<string, PendingCall>()
  private readonly failures = new Map<string, FailureSequence>()
  private readonly maxPending: number
  private readonly maxTools: number

  constructor(options: RepeatedFailureDetectorOptions = {}) {
    this.maxPending = Math.max(1, options.maxPending ?? 256)
    this.maxTools = Math.max(1, options.maxTools ?? 128)
  }

  accept(event: EngineEvent): RepeatedFailureAdvisory | null {
    if (event.type === 'tool-request') {
      this.pending.set(event.id, {
        toolName: event.name,
        fingerprint: fingerprint(event.input),
      })
      trimOldest(this.pending, this.maxPending)
      return null
    }
    if (event.type !== 'tool-result') return null

    const call = this.pending.get(event.id)
    this.pending.delete(event.id)
    if (!event.isError) {
      this.failures.delete(event.name)
      return null
    }
    if (!call || call.toolName !== event.name) return null

    const previous = this.failures.get(call.toolName)
    const next: FailureSequence = previous?.fingerprint === call.fingerprint
      ? { ...previous, count: previous.count + 1 }
      : { fingerprint: call.fingerprint, count: 1, announced: false }
    this.failures.delete(call.toolName)
    this.failures.set(call.toolName, next)
    trimOldest(this.failures, this.maxTools)
    if (next.count !== 2 || next.announced) return null

    next.announced = true
    return {
      id: `repeated-failure:${call.toolName.slice(0, 128)}:${call.fingerprint.slice(0, 16)}`,
      toolName: call.toolName.slice(0, 256),
      summary: `${call.toolName.slice(0, 960)} failed twice with unchanged input.`,
      action: 'Review the failure before retrying unchanged input.',
    }
  }

  stats(): { pending: number; tools: number } {
    return { pending: this.pending.size, tools: this.failures.size }
  }
}
