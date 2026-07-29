import type { EngineEventBus } from '../engine/events.js'
import type { EngineEvent, RunResult } from '../engine/types.js'
import { plainBounded } from './format.js'
import {
  INTERACTION_SCHEMA_VERSION,
  type InteractionEventEnvelope,
  type InteractionEventKind,
  type InteractionEventPayload,
  type InteractionSource,
  type RuntimePhase,
} from './types.js'

export interface InteractionEventAdapterOptions {
  runId: string
  onEnvelope: (event: InteractionEventEnvelope) => void
  now?: () => string
}

function boundedPlain(value: string, max: number): string {
  return plainBounded(value, max) || 'Unknown'
}

export class InteractionEventAdapter {
  private readonly sequences = new Map<string, number>()
  private unsubscribe: (() => void) | null = null
  private readonly now: () => string

  constructor(private readonly options: InteractionEventAdapterOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  attach(bus: EngineEventBus): void {
    this.detach()
    this.unsubscribe = bus.on((event) => this.acceptEngineEvent(event))
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  recordUserObjective(objective: string, sourceRef?: string): void {
    this.emit(this.options.runId, 'user', 'objective-set', {
      objective: boundedPlain(objective, 4_096),
    }, sourceRef)
  }

  private acceptEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'turn-start':
        this.emit(this.options.runId, 'runtime', 'phase-changed', { phase: 'thinking' }, `turn:${event.turn}`)
        return
      case 'tool-request':
        this.emit(this.options.runId, 'runtime', 'activity-changed', {
          activity: { type: 'tool', label: boundedPlain(event.name, 256), status: 'active' },
        }, event.id)
        this.emit(this.options.runId, 'runtime', 'phase-changed', { phase: 'acting' }, event.id)
        return
      case 'tool-result': {
        const status = event.isError ? 'failed' : 'succeeded'
        const toolName = boundedPlain(event.name, 256)
        this.emit(this.options.runId, 'runtime', 'activity-changed', {
          activity: { type: 'tool', label: toolName, status },
        }, event.id)
        this.emit(this.options.runId, 'runtime', 'outcome-recorded', {
          outcome: {
            status: event.isError ? 'failed' : 'succeeded',
            summary: `${toolName} ${event.isError ? 'failed' : 'completed'}.`,
            verified: true,
            operation: toolName,
          },
        }, event.id)
        if (event.isError) {
          this.emit(this.options.runId, 'runtime', 'attention-added', {
            attention: {
              id: boundedPlain(`tool-error:${event.id}`, 256),
              category: 'error',
              priority: 'polite',
              summary: `${toolName} failed.`,
              action: 'Inspect the redacted trace for details.',
            },
          }, event.id)
        }
        this.emit(this.options.runId, 'runtime', 'phase-changed', { phase: 'thinking' }, event.id)
        return
      }
      case 'run-limit':
        this.emitTerminalResult(this.options.runId, {
          status: 'limit',
          reason: event.limit,
          usage: event.usage,
        }, `limit:${event.limit}`)
        return
      case 'error':
        if (event.fatal) {
          this.emit(this.options.runId, 'runtime', 'phase-changed', { phase: 'failed' }, 'fatal-error')
        }
        this.emitRuntimeError(event)
        return
      case 'turn-done':
        if (event.result) this.emitTerminalResult(this.options.runId, event.result, 'turn-done')
        return
      case 'child-status':
        this.emitChildStatus(event)
        return
      default:
        return
    }
  }

  private emitRuntimeError(event: Extract<EngineEvent, { type: 'error' }>): void {
    const attentionSequence = this.nextSequence(this.options.runId)
    this.emit(this.options.runId, 'runtime', 'attention-added', {
      attention: {
        id: `error:${attentionSequence}`,
        category: event.fatal ? 'blocked' : 'error',
        priority: event.fatal ? 'blocking' : 'assertive',
        summary: event.fatal
          ? 'Athena encountered a fatal error.'
          : 'Athena encountered a recoverable error.',
        action: 'Inspect the redacted trace for details.',
      },
    }, event.fatal ? 'fatal-error' : 'runtime-error')
  }

  private emitChildStatus(event: Extract<EngineEvent, { type: 'child-status' }>): void {
    if (event.status === 'running') {
      this.emit(event.runId, 'runtime', 'activity-changed', {
        activity: { type: 'child', label: boundedPlain(event.agent, 256), status: 'active' },
      }, `child:${event.runId}`)
      this.emit(event.runId, 'runtime', 'phase-changed', { phase: 'acting' }, `child:${event.runId}`)
      return
    }

    const phase: RuntimePhase = event.status === 'completed'
      ? 'completed'
      : event.status === 'aborted'
        ? 'aborted'
        : event.status === 'limit'
          ? 'limited'
          : 'failed'
    this.emit(event.runId, 'runtime', 'phase-changed', { phase }, `child:${event.runId}`)
    if (event.status !== 'completed') {
      this.emit(event.runId, 'runtime', 'attention-added', {
        attention: {
          id: `child:${event.runId}:${event.status}`,
          category: event.status === 'limit' ? 'limit' : 'error',
          priority: 'assertive',
          summary: `${boundedPlain(event.agent, 256)} ${event.status}.`,
          action: 'Review the child run evidence before continuing.',
        },
      }, `child:${event.runId}`)
    }
  }

  private emitTerminalResult(runId: string, result: RunResult, sourceRef: string): void {
    const phase: RuntimePhase = result.status === 'completed'
      ? 'completed'
      : result.status === 'limit'
        ? 'limited'
        : result.status === 'aborted'
          ? 'aborted'
          : 'failed'
    const status = result.status === 'completed'
      ? 'succeeded'
      : result.status === 'limit'
        ? 'limited'
        : result.status === 'aborted'
          ? 'aborted'
          : 'failed'
    this.emit(runId, 'runtime', 'phase-changed', { phase }, sourceRef)
    this.emit(runId, 'runtime', 'outcome-recorded', {
      outcome: {
        status,
        summary: result.status === 'completed' ? 'Turn completed.' : `Turn ${status}.`,
        verified: true,
        operation: 'turn',
      },
    }, sourceRef)
  }

  private nextSequence(runId: string): number {
    return (this.sequences.get(runId) ?? 0) + 1
  }

  private emit<K extends InteractionEventKind>(
    runId: string,
    source: InteractionSource,
    kind: K,
    payload: InteractionEventPayload<K>,
    sourceRef?: string,
  ): void {
    const sequence = this.nextSequence(runId)
    this.sequences.set(runId, sequence)
    this.options.onEnvelope({
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      id: `${runId}:${sequence}`,
      runId,
      sequence,
      timestamp: this.now(),
      source,
      kind,
      payload,
      ...(sourceRef ? { sourceRef } : {}),
    } as InteractionEventEnvelope)
  }
}
