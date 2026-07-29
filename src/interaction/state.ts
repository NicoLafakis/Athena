import { InteractionEventEnvelopeSchema } from './schemas.js'
import {
  INTERACTION_REDUCER_VERSION,
  INTERACTION_SCHEMA_VERSION,
  type InteractionDiagnostic,
  type InteractionEventEnvelope,
  type InteractionReductionResult,
  type InteractionSnapshot,
  type InteractionSource,
  type Provenance,
  type Sourced,
} from './types.js'

const DIAGNOSTIC_MAX = 240

export function createInteractionSnapshot(runId: string, timestamp = new Date().toISOString()): InteractionSnapshot {
  return {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    reducerVersion: INTERACTION_REDUCER_VERSION,
    runId,
    lastSequence: 0,
    objective: { value: null, provenance: null },
    phase: { value: 'idle', provenance: null },
    activity: { value: null, provenance: null },
    attention: [],
    lastVerifiedOutcome: { value: null, provenance: null },
    nextExpected: { value: null, provenance: null },
    updatedAt: timestamp,
  }
}

function diagnostic(
  snapshot: InteractionSnapshot,
  code: InteractionDiagnostic['code'],
  message: string,
  envelopeId?: string,
): InteractionReductionResult {
  return {
    accepted: false,
    snapshot,
    diagnostic: {
      code,
      message: message.slice(0, DIAGNOSTIC_MAX),
      ...(envelopeId ? { envelopeId: envelopeId.slice(0, 256) } : {}),
    },
  }
}

function provenanceOf(event: InteractionEventEnvelope): Provenance {
  return {
    source: event.source,
    runId: event.runId,
    sequence: event.sequence,
    sourceEventType: event.kind,
    ...(event.sourceRef ? { sourceEventId: event.sourceRef } : {}),
  }
}

function sourceRank(source: InteractionSource): number {
  if (source === 'runtime') return 3
  if (source === 'user') return 2
  return 1
}

function replaceByPrecedence<T>(current: Sourced<T>, value: T, provenance: Provenance): Sourced<T> {
  if (current.provenance && sourceRank(current.provenance.source) > sourceRank(provenance.source)) {
    return current
  }
  return { value, provenance }
}

function authorized(event: InteractionEventEnvelope): boolean {
  if (event.kind === 'objective-set' || event.kind === 'next-expected-set') return true
  return event.source === 'runtime'
}

export function applyInteractionEnvelope(
  snapshot: InteractionSnapshot,
  input: unknown,
): InteractionReductionResult {
  const parsed = InteractionEventEnvelopeSchema.safeParse(input)
  if (!parsed.success) {
    const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : null
    const id = typeof candidate?.['id'] === 'string' ? candidate['id'] : undefined
    return diagnostic(snapshot, 'malformed-envelope', `Rejected malformed interaction envelope${id ? ` ${id}` : ''}.`, id)
  }

  const event = parsed.data as InteractionEventEnvelope
  if (event.runId !== snapshot.runId) {
    return diagnostic(snapshot, 'run-mismatch', `Envelope ${event.id} belongs to run ${event.runId}, not ${snapshot.runId}.`, event.id)
  }
  if (event.sequence <= snapshot.lastSequence) {
    return diagnostic(snapshot, 'sequence-rejected', `Envelope ${event.id} repeats or precedes sequence ${snapshot.lastSequence}.`, event.id)
  }
  if (event.sequence !== snapshot.lastSequence + 1) {
    return diagnostic(snapshot, 'sequence-gap', `Envelope ${event.id} skipped expected sequence ${snapshot.lastSequence + 1}.`, event.id)
  }
  if (!authorized(event)) {
    return diagnostic(snapshot, 'source-not-authorized', `${event.source} cannot author ${event.kind}.`, event.id)
  }

  const provenance = provenanceOf(event)
  let next: InteractionSnapshot = {
    ...snapshot,
    lastSequence: event.sequence,
    updatedAt: event.timestamp,
  }

  switch (event.kind) {
    case 'objective-set':
      next = { ...next, objective: replaceByPrecedence(snapshot.objective, event.payload.objective, provenance) }
      break
    case 'phase-changed':
      next = { ...next, phase: replaceByPrecedence(snapshot.phase, event.payload.phase, provenance) }
      break
    case 'activity-changed':
      next = { ...next, activity: replaceByPrecedence(snapshot.activity, event.payload.activity, provenance) }
      break
    case 'attention-added': {
      const attention = { ...event.payload.attention, provenance }
      const retained = snapshot.attention.filter((item) => item.id !== attention.id)
      next = { ...next, attention: [...retained, attention] }
      break
    }
    case 'attention-resolved':
      next = { ...next, attention: snapshot.attention.filter((item) => item.id !== event.payload.attentionId) }
      break
    case 'outcome-recorded':
      next = {
        ...next,
        lastVerifiedOutcome: replaceByPrecedence(snapshot.lastVerifiedOutcome, event.payload.outcome, provenance),
      }
      break
    case 'next-expected-set':
      next = { ...next, nextExpected: replaceByPrecedence(snapshot.nextExpected, event.payload.nextExpected, provenance) }
      break
    case 'guidance-qualified':
      // Metadata-only evidence seam. Presentation policy receives the paired generic
      // advisory attention event; retrieved prose remains in the experience store.
      break
  }

  return { accepted: true, snapshot: next }
}

export class InteractionStateStore {
  private readonly snapshots = new Map<string, InteractionSnapshot>()

  constructor(private readonly onDiagnostic?: (diagnostic: InteractionDiagnostic) => void) {}

  accept(event: InteractionEventEnvelope): InteractionReductionResult {
    const current = this.snapshots.get(event.runId) ?? createInteractionSnapshot(event.runId, event.timestamp)
    const result = applyInteractionEnvelope(current, event)
    if (result.accepted) this.snapshots.set(event.runId, result.snapshot)
    else if (result.diagnostic) this.onDiagnostic?.(result.diagnostic)
    return result
  }

  get(runId: string): InteractionSnapshot | undefined {
    return this.snapshots.get(runId)
  }
}
