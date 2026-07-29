import { createHash } from 'node:crypto'
import type { RunResult } from '../engine/types.js'
import { readRunTrace, verifyRunTrace, type RunTraceEnvelope } from '../harness/traces.js'
import { projectId } from '../harness/trust.js'
import { redactSessionValue } from '../harness/redaction.js'
import { ExperienceRecordSchema, GuidanceRecordSchema } from './schemas.js'
import type { ExperienceRecord, GuidanceRecord } from './types.js'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function plain(value: unknown, max: number): string {
  return String(redactSessionValue(value))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function payloadOf<T>(event: RunTraceEnvelope | undefined): T | undefined {
  return event?.payload as T | undefined
}

function experienceOutcome(result: RunResult, successes: number, failures: number): ExperienceRecord['outcome'] {
  if (result.status === 'limit') return 'limited'
  if (result.status === 'aborted') return 'aborted'
  if (result.status === 'error') return 'failed'
  if (successes > 0 && failures > 0) return 'mixed'
  if (failures > 0) return 'failed'
  return 'succeeded'
}

export async function compileExperienceFromTrace(file: string): Promise<ExperienceRecord> {
  const verification = await verifyRunTrace(file)
  if (!verification.valid) throw new Error(`Cannot compile experience from invalid trace ${file}`)
  const events = await readRunTrace(file)
  const start = events.find((event) => event.type === 'run-start')
  const finish = [...events].reverse().find((event) => event.type === 'run-finish')
  const prompt = events.find((event) => event.type === 'user-prompt')
  const metadata = payloadOf<{ cwd?: string }>(start)
  const result = payloadOf<RunResult>(finish)
  const promptPayload = payloadOf<{ prompt?: string }>(prompt)
  if (!start || !finish || !metadata?.cwd || !result || !promptPayload?.prompt) {
    throw new Error(`Trace ${file} lacks required run metadata, prompt, or result`)
  }

  const toolResults = events.filter((event) => {
    if (event.type !== 'engine-event') return false
    const payload = event.payload as { type?: string }
    return payload.type === 'tool-result'
  })
  const actions: string[] = []
  const tags = new Set<string>()
  let successes = 0
  let failures = 0
  for (const event of toolResults.slice(0, 64)) {
    const payload = event.payload as { name?: string; isError?: boolean }
    const name = plain(payload.name ?? 'Tool', 256) || 'Tool'
    const failed = payload.isError === true
    if (failed) failures++
    else successes++
    actions.push(`${name} ${failed ? 'failed' : 'succeeded'}.`.slice(0, 512))
    const tag = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
    if (tag) tags.add(tag)
  }
  const outcome = experienceOutcome(result, successes, failures)
  tags.add(outcome)
  const finalHash = finish.hash
  const record = ExperienceRecordSchema.parse({
    schemaVersion: 1,
    id: `exp-${digest([events[0]!.runId, finalHash]).slice(0, 48)}`,
    projectScope: projectId(metadata.cwd),
    situation: plain(promptPayload.prompt, 4_096) || 'Run objective unavailable.',
    actions,
    outcome,
    evidenceRefs: [...toolResults, finish]
      .slice(-64)
      .map((event) => `trace:${event.runId}:${event.hash}`),
    tags: [...tags].sort(),
    createdAt: finish.timestamp,
  })
  return record
}

export function deriveProvisionalGuidance(experience: ExperienceRecord): GuidanceRecord {
  const signal: GuidanceRecord['signal'] = experience.outcome === 'failed'
    ? 'avoid'
    : experience.outcome === 'limited'
      ? 'switch-if'
      : experience.outcome === 'aborted'
        ? 'stop-if'
        : 'consider'
  const text: Record<GuidanceRecord['signal'], string> = {
    consider: 'Consider the recorded tool sequence when the current objective is materially similar.',
    avoid: 'Avoid repeating the recorded tool sequence without reviewing its failure evidence.',
    'stop-if': 'Stop if the conditions associated with the recorded abort recur.',
    'switch-if': 'Switch to a narrower plan if similar work approaches its configured run budget.',
  }
  return GuidanceRecordSchema.parse({
    schemaVersion: 1,
    id: `guide-${digest([experience.id, signal]).slice(0, 48)}`,
    experienceIds: [experience.id],
    signal,
    text: text[signal],
    status: 'provisional',
    confidence: 0.4,
  })
}
