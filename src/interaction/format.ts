import { redactSessionValue } from '../harness/redaction.js'
import type { Announcement, InteractionSnapshot, Provenance } from './types.js'

const CONTROL_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g

export function plainBounded(value: string, maxCharacters: number): string {
  const redacted = redactSessionValue(value)
  const safe = typeof redacted === 'string' ? redacted : ''
  return safe
    .replace(CONTROL_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxCharacters)
}

function sourceLabel(provenance: Provenance | null): string {
  if (!provenance) return 'unknown source'
  if (provenance.source === 'runtime') return 'runtime'
  if (provenance.source === 'user') return 'user'
  return 'agent assertion'
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`
}

export function formatInteractionStatus(snapshot: InteractionSnapshot): string {
  const objective = snapshot.objective.value
    ? `${plainBounded(snapshot.objective.value, 1_024)}`
    : 'unknown'
  const activity = snapshot.activity.value
    ? `${plainBounded(snapshot.activity.value.label, 256)} (${snapshot.activity.value.status})`
    : 'none'
  const attention = snapshot.attention.length === 0
    ? 'none'
    : snapshot.attention
      .map((item) => plainBounded(item.summary, 512))
      .join('; ')
      .slice(0, 1_024)
  const outcome = snapshot.lastVerifiedOutcome.value
    ? plainBounded(snapshot.lastVerifiedOutcome.value.summary, 1_024)
    : 'none'
  const next = snapshot.nextExpected.value
    ? plainBounded(snapshot.nextExpected.value, 1_024)
    : 'unknown'

  return [
    `Status: ${snapshot.phase.value}.`,
    `Objective (${sourceLabel(snapshot.objective.provenance)}): ${sentence(objective)}`,
    `Activity: ${sentence(activity)}`,
    `Attention: ${sentence(attention)}`,
    `Verified outcome (${sourceLabel(snapshot.lastVerifiedOutcome.provenance)}): ${sentence(outcome)}`,
    `Next: ${sentence(next)}`,
  ].join('\n').slice(0, 4_096)
}

export function formatAnnouncementDetails(announcement: Announcement, tracePath?: string): string {
  const primary = plainBounded(announcement.text, 768)
  const detail = announcement.detail ? plainBounded(announcement.detail, 2_048) : 'No additional detail.'
  const evidence = announcement.provenance
    .map((item) => {
      const sourceId = item.sourceEventId ? ` ${plainBounded(item.sourceEventId, 256)}` : ''
      return `${item.source} ${plainBounded(item.sourceEventType, 256)}${sourceId}, sequence ${item.sequence}`
    })
    .join('; ')
    .slice(0, 512)
  const lines = [primary, detail, `Evidence: ${evidence}.`]
  if (tracePath) lines.push(`Full trace: ${plainBounded(tracePath, 512)}`)
  return lines.join('\n').slice(0, 4_096)
}
