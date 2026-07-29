import { createHash } from 'node:crypto'
import { plainBounded } from './format.js'
import type {
  Announcement,
  AnnouncementPriority,
  InteractionEventEnvelope,
  InteractionSnapshot,
  Provenance,
  RuntimePhase,
} from './types.js'

export type InteractionVerbosity = 'quiet' | 'balanced' | 'verbose'

export interface AnnouncementPolicyOptions {
  verbosity?: InteractionVerbosity
}

interface DraftAnnouncement {
  priority: AnnouncementPriority
  category: string
  text: string
  detail?: string
  target: string
  condition: string
  requiresAcknowledgement?: boolean
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

function phaseDraft(phase: RuntimePhase, verbose: boolean): DraftAnnouncement | null {
  const terminal: Partial<Record<RuntimePhase, Omit<DraftAnnouncement, 'target' | 'condition'>>> = {
    completed: { priority: 'polite', category: 'phase', text: 'Completed: Work completed.' },
    failed: { priority: 'assertive', category: 'phase', text: 'Failed: Work failed.' },
    aborted: { priority: 'assertive', category: 'phase', text: 'Attention: Work was canceled.' },
    limited: { priority: 'assertive', category: 'phase', text: 'Attention: Run limit reached.' },
    blocked: {
      priority: 'blocking',
      category: 'phase',
      text: 'Attention: Work is blocked and needs you.',
      requiresAcknowledgement: true,
    },
    'waiting-permission': {
      priority: 'blocking',
      category: 'permission',
      text: 'Permission: A decision is required.',
      requiresAcknowledgement: true,
    },
    'waiting-user': {
      priority: 'blocking',
      category: 'decision',
      text: 'Attention: Your input is required.',
      requiresAcknowledgement: true,
    },
  }
  const fixed = terminal[phase]
  if (fixed) return { ...fixed, target: phase, condition: phase }
  if (!verbose || (phase !== 'thinking' && phase !== 'acting')) return null
  return {
    priority: 'polite',
    category: 'phase',
    text: `Status: ${phase === 'thinking' ? 'Thinking' : 'Acting'}.`,
    target: phase,
    condition: phase,
  }
}

function draftFor(event: InteractionEventEnvelope, previous: InteractionSnapshot): DraftAnnouncement | null {
  switch (event.kind) {
    case 'phase-changed':
      if (previous.phase.value === event.payload.phase) return null
      return phaseDraft(event.payload.phase, false)
    case 'attention-added': {
      const item = event.payload.attention
      const prefix = item.category === 'permission' ? 'Permission' : 'Attention'
      return {
        priority: item.priority,
        category: item.category,
        text: `${prefix}: ${plainBounded(item.summary, 992)}`,
        ...(item.action ? { detail: plainBounded(item.action, 4_096) } : {}),
        target: item.id,
        condition: item.summary,
        requiresAcknowledgement: item.priority === 'blocking',
      }
    }
    case 'attention-resolved':
      return {
        priority: 'polite',
        category: 'attention-resolved',
        text: 'Status: Required attention was resolved.',
        target: event.payload.attentionId,
        condition: 'resolved',
      }
    default:
      return null
  }
}

function fingerprint(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function announcementFor(
  event: InteractionEventEnvelope,
  previous: InteractionSnapshot,
  _next: InteractionSnapshot,
  options: AnnouncementPolicyOptions = {},
): Announcement | null {
  const verbosity = options.verbosity ?? 'balanced'
  let draft = draftFor(event, previous)
  if (!draft && verbosity === 'verbose' && event.kind === 'phase-changed') {
    draft = phaseDraft(event.payload.phase, true)
  }
  if (!draft || draft.priority === 'silent') return null
  if (verbosity === 'quiet' && draft.priority !== 'blocking') return null

  const text = plainBounded(draft.text, 1_024)
  const detail = draft.detail ? plainBounded(draft.detail, 4_096) : undefined
  const dedupeHash = fingerprint([
    event.runId,
    draft.category,
    draft.target,
    draft.condition,
    draft.priority,
    String(draft.requiresAcknowledgement === true),
    detail ?? '',
  ])
  return {
    schemaVersion: 1,
    id: plainBounded(`announcement:${event.id}`, 256),
    runId: event.runId,
    priority: draft.priority,
    category: plainBounded(draft.category, 256),
    text,
    ...(detail ? { detail } : {}),
    dedupeKey: `${event.runId}:${draft.category}:${dedupeHash}`.slice(0, 512),
    requiresAcknowledgement: draft.requiresAcknowledgement === true,
    provenance: [provenanceOf(event)],
    createdAt: event.timestamp,
  }
}
