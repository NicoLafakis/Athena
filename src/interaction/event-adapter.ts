import type { EngineEventBus } from '../engine/events.js'
import type { EngineEvent, RunResult } from '../engine/types.js'
import { plainBounded } from './format.js'
import { RepeatedFailureDetector } from './detectors/repeated-failure.js'
import { VerificationInvalidationDetector } from './detectors/verification.js'
import { BudgetThresholdDetector } from './detectors/budget.js'
import { WorkAggregationDetector } from './detectors/work-aggregation.js'
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
  private readonly repeatedFailures = new Map<string, RepeatedFailureDetector>()
  private readonly verificationInvalidation = new Map<string, VerificationInvalidationDetector>()
  private readonly budgetThresholds = new BudgetThresholdDetector()
  private readonly workAggregation = new WorkAggregationDetector()
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
        this.repeatedFailureDetector(this.options.runId).accept(event)
        this.verificationDetector(this.options.runId).accept(event)
        this.emit(this.options.runId, 'runtime', 'activity-changed', {
          activity: { type: 'tool', label: boundedPlain(event.name, 256), status: 'active' },
        }, event.id)
        this.emit(this.options.runId, 'runtime', 'phase-changed', { phase: 'acting' }, event.id)
        return
      case 'tool-result': {
        const repeatedFailure = this.repeatedFailureDetector(this.options.runId).accept(event)
        const invalidatedVerification = this.verificationDetector(this.options.runId).accept(event)
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
        if (repeatedFailure) {
          this.emit(this.options.runId, 'runtime', 'attention-added', {
            attention: {
              id: boundedPlain(repeatedFailure.id, 256),
              category: 'advisory',
              priority: 'assertive',
              summary: boundedPlain(repeatedFailure.summary, 1_024),
              action: boundedPlain(repeatedFailure.action, 1_024),
            },
          }, event.id)
        }
        if (invalidatedVerification) {
          this.emit(this.options.runId, 'runtime', 'attention-added', {
            attention: {
              id: boundedPlain(invalidatedVerification.id, 256),
              category: 'advisory',
              priority: 'assertive',
              summary: boundedPlain(invalidatedVerification.summary, 1_024),
              action: boundedPlain(invalidatedVerification.action, 1_024),
            },
          }, event.id)
        }
        this.emit(this.options.runId, 'runtime', 'phase-changed', { phase: 'thinking' }, event.id)
        return
      }
      case 'permission-requested':
        this.emit(this.options.runId, 'runtime', 'phase-changed', {
          phase: 'waiting-permission',
        }, event.requestId)
        this.emit(this.options.runId, 'runtime', 'attention-added', {
          attention: {
            id: boundedPlain(event.requestId, 256),
            category: 'permission',
            priority: 'blocking',
            summary: boundedPlain(event.summary, 1_024),
            action: 'Choose allow once, allow for this session, or deny.',
          },
        }, event.requestId)
        return
      case 'permission-resolved':
        this.emit(this.options.runId, 'runtime', 'attention-resolved', {
          attentionId: boundedPlain(event.requestId, 256),
        }, event.requestId)
        this.emit(this.options.runId, 'runtime', 'phase-changed', { phase: 'acting' }, event.requestId)
        return
      case 'background-status': {
        const taskId = boundedPlain(event.taskId, 256)
        const activityStatus = event.status === 'running'
          ? 'active'
          : event.status === 'completed'
            ? 'succeeded'
            : 'failed'
        this.emit(this.options.runId, 'runtime', 'activity-changed', {
          activity: {
            type: 'background',
            label: 'Background task',
            status: activityStatus,
            target: taskId,
          },
        }, taskId)
        if (event.status === 'completed' && event.awaited) {
          this.emit(this.options.runId, 'runtime', 'outcome-recorded', {
            outcome: {
              status: 'succeeded',
              summary: 'Background task completed.',
              verified: true,
              operation: boundedPlain(`background:${taskId}:awaited`, 256),
            },
          }, taskId)
        } else if (event.status === 'failed' || event.status === 'aborted') {
          this.emit(this.options.runId, 'runtime', 'attention-added', {
            attention: {
              id: boundedPlain(`background:${taskId}`, 256),
              category: 'error',
              priority: 'assertive',
              summary: `Background task ${event.status}.`,
              action: 'Inspect the redacted trace or poll the task for details.',
            },
          }, taskId)
        }
        this.emitWorkAggregate(event, taskId)
        return
      }
      case 'budget-status':
        for (const signal of this.budgetThresholds.accept(event.usage, event.limits)) {
          this.emit(this.options.runId, 'runtime', 'attention-added', {
            attention: {
              id: `budget:${signal.threshold}`,
              category: 'advisory',
              priority: signal.priority,
              summary: signal.summary,
              action: signal.action,
            },
          }, `budget:${signal.threshold}`)
        }
        return
      case 'agent-status-update':
        {
          const runId = event.runId ?? this.options.runId
        if (event.objective !== undefined) {
          this.emit(runId, 'agent', 'objective-set', {
            objective: boundedPlain(event.objective, 4_096),
          }, event.sourceRef)
        }
        if (event.nextExpected !== undefined) {
          this.emit(runId, 'agent', 'next-expected-set', {
            nextExpected: boundedPlain(event.nextExpected, 1_024),
          }, event.sourceRef)
        }
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
        this.emitWorkAggregate(event, `child:${event.runId}`)
        this.emitChildStatus(event)
        return
      case 'child-tool-request': {
        const request: Extract<EngineEvent, { type: 'tool-request' }> = {
          type: 'tool-request',
          id: event.id,
          name: event.name,
          input: event.input,
        }
        this.repeatedFailureDetector(event.runId).accept(request)
        this.verificationDetector(event.runId).accept(request)
        this.emit(event.runId, 'runtime', 'activity-changed', {
          activity: { type: 'tool', label: boundedPlain(event.name, 256), status: 'active' },
        }, event.id)
        this.emit(event.runId, 'runtime', 'phase-changed', { phase: 'acting' }, event.id)
        return
      }
      case 'child-tool-result': {
        const result: Extract<EngineEvent, { type: 'tool-result' }> = {
          type: 'tool-result',
          id: event.id,
          name: event.name,
          output: event.output,
          isError: event.isError,
        }
        const repeated = this.repeatedFailureDetector(event.runId).accept(result)
        const invalidated = this.verificationDetector(event.runId).accept(result)
        const toolName = boundedPlain(event.name, 256)
        this.emit(event.runId, 'runtime', 'activity-changed', {
          activity: { type: 'tool', label: toolName, status: event.isError ? 'failed' : 'succeeded' },
        }, event.id)
        this.emit(event.runId, 'runtime', 'outcome-recorded', {
          outcome: {
            status: event.isError ? 'failed' : 'succeeded',
            summary: `${toolName} ${event.isError ? 'failed' : 'completed'}.`,
            verified: true,
            operation: toolName,
          },
        }, event.id)
        if (event.isError) {
          this.emit(event.runId, 'runtime', 'attention-added', {
            attention: {
              id: boundedPlain(`tool-error:${event.id}`, 256),
              category: 'error',
              priority: 'polite',
              summary: `${toolName} failed.`,
              action: 'Inspect the redacted child trace for details.',
            },
          }, event.id)
        }
        this.emitDetectorAdvisory(event.runId, repeated, event.id)
        this.emitDetectorAdvisory(event.runId, invalidated, event.id)
        this.emit(event.runId, 'runtime', 'phase-changed', { phase: 'thinking' }, event.id)
        return
      }
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

  private repeatedFailureDetector(runId: string): RepeatedFailureDetector {
    const current = this.repeatedFailures.get(runId)
    if (current) return current
    const created = new RepeatedFailureDetector()
    this.repeatedFailures.set(runId, created)
    this.trimDetectorRuns(this.repeatedFailures)
    return created
  }

  private verificationDetector(runId: string): VerificationInvalidationDetector {
    const current = this.verificationInvalidation.get(runId)
    if (current) return current
    const created = new VerificationInvalidationDetector()
    this.verificationInvalidation.set(runId, created)
    this.trimDetectorRuns(this.verificationInvalidation)
    return created
  }

  private trimDetectorRuns<T>(detectors: Map<string, T>): void {
    while (detectors.size > 256) {
      const oldest = detectors.keys().next().value as string | undefined
      if (oldest === undefined) return
      detectors.delete(oldest)
    }
  }

  private emitDetectorAdvisory(
    runId: string,
    advisory: { id: string; summary: string; action: string } | null,
    sourceRef: string,
  ): void {
    if (!advisory) return
    this.emit(runId, 'runtime', 'attention-added', {
      attention: {
        id: boundedPlain(advisory.id, 256),
        category: 'advisory',
        priority: 'assertive',
        summary: boundedPlain(advisory.summary, 1_024),
        action: boundedPlain(advisory.action, 1_024),
      },
    }, sourceRef)
  }

  private emitWorkAggregate(
    event: Extract<EngineEvent, { type: 'child-status' | 'background-status' }>,
    sourceRef: string,
  ): void {
    const aggregate = this.workAggregation.accept(event)
    if (!aggregate) return
    this.emit(this.options.runId, 'runtime', 'activity-changed', {
      activity: {
        type: 'system',
        label: aggregate.label,
        status: aggregate.total > 0 ? 'active' : 'succeeded',
        target: 'work-aggregate',
      },
    }, sourceRef)
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
