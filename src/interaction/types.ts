export const INTERACTION_SCHEMA_VERSION = 1 as const
export const INTERACTION_REDUCER_VERSION = 1 as const

export type InteractionSource = 'runtime' | 'user' | 'agent'

export type RuntimePhase =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'waiting-permission'
  | 'waiting-user'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'limited'

export type InteractionEventKind =
  | 'objective-set'
  | 'phase-changed'
  | 'activity-changed'
  | 'attention-added'
  | 'attention-resolved'
  | 'outcome-recorded'
  | 'next-expected-set'

export interface Provenance {
  source: InteractionSource
  runId: string
  sequence: number
  sourceEventType: string
  sourceEventId?: string
}

export interface Sourced<T> {
  value: T
  provenance: Provenance | null
}

export interface Activity {
  type: 'tool' | 'background' | 'child' | 'system'
  label: string
  status: 'active' | 'succeeded' | 'failed'
  target?: string
}

export interface AttentionItem {
  id: string
  category: 'permission' | 'error' | 'blocked' | 'decision' | 'limit'
  priority: 'polite' | 'assertive' | 'blocking'
  summary: string
  action?: string
  provenance: Provenance
}

export interface Outcome {
  status: 'succeeded' | 'failed' | 'limited' | 'aborted'
  summary: string
  verified: boolean
  operation?: string
}

export interface InteractionEventPayloadMap {
  'objective-set': { objective: string }
  'phase-changed': { phase: RuntimePhase }
  'activity-changed': { activity: Activity | null }
  'attention-added': { attention: Omit<AttentionItem, 'provenance'> }
  'attention-resolved': { attentionId: string }
  'outcome-recorded': { outcome: Outcome }
  'next-expected-set': { nextExpected: string | null }
}

export type InteractionEventPayload<K extends InteractionEventKind = InteractionEventKind> =
  InteractionEventPayloadMap[K]

interface InteractionEventEnvelopeBase {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION
  id: string
  runId: string
  sequence: number
  timestamp: string
  source: InteractionSource
  sourceRef?: string
}

export type InteractionEventEnvelope = {
  [K in InteractionEventKind]: InteractionEventEnvelopeBase & {
    kind: K
    payload: InteractionEventPayloadMap[K]
  }
}[InteractionEventKind]

export interface InteractionSnapshot {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION
  reducerVersion: typeof INTERACTION_REDUCER_VERSION
  runId: string
  lastSequence: number
  objective: Sourced<string | null>
  phase: Sourced<RuntimePhase>
  activity: Sourced<Activity | null>
  attention: AttentionItem[]
  lastVerifiedOutcome: Sourced<Outcome | null>
  nextExpected: Sourced<string | null>
  updatedAt: string
}

export type AnnouncementPriority = 'silent' | 'polite' | 'assertive' | 'blocking'

export interface Announcement {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION
  id: string
  runId: string
  priority: AnnouncementPriority
  category: string
  text: string
  detail?: string
  dedupeKey: string
  requiresAcknowledgement: boolean
  provenance: Provenance[]
  createdAt: string
}

export type InteractionDiagnosticCode =
  | 'malformed-envelope'
  | 'run-mismatch'
  | 'sequence-gap'
  | 'sequence-rejected'
  | 'source-not-authorized'

export interface InteractionDiagnostic {
  code: InteractionDiagnosticCode
  message: string
  envelopeId?: string
}

export interface InteractionReductionResult {
  accepted: boolean
  snapshot: InteractionSnapshot
  diagnostic?: InteractionDiagnostic
}
