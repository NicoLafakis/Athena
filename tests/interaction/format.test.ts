import { describe, expect, it } from 'vitest'
import { formatAnnouncementDetails, formatInteractionStatus } from '../../src/interaction/format.js'
import { applyInteractionEnvelope, createInteractionSnapshot } from '../../src/interaction/state.js'

const timestamp = '2026-07-29T12:00:00.000Z'

describe('interaction formatters', () => {
  it('labels provenance and material state without a model call', () => {
    let snapshot = createInteractionSnapshot('run-1', timestamp)
    const inputs = [
      {
        schemaVersion: 1,
        id: 'run-1:1',
        runId: 'run-1',
        sequence: 1,
        timestamp,
        source: 'user',
        kind: 'objective-set',
        payload: { objective: 'Ship safely.' },
      },
      {
        schemaVersion: 1,
        id: 'run-1:2',
        runId: 'run-1',
        sequence: 2,
        timestamp,
        source: 'runtime',
        kind: 'phase-changed',
        payload: { phase: 'thinking' },
      },
      {
        schemaVersion: 1,
        id: 'run-1:3',
        runId: 'run-1',
        sequence: 3,
        timestamp,
        source: 'runtime',
        kind: 'outcome-recorded',
        payload: {
          outcome: { status: 'succeeded', summary: 'Tests passed.', verified: true, operation: 'test' },
        },
      },
    ]
    for (const input of inputs) snapshot = applyInteractionEnvelope(snapshot, input).snapshot

    expect(formatInteractionStatus(snapshot)).toBe([
      'Status: thinking.',
      'Objective (user): Ship safely.',
      'Activity: none.',
      'Attention: none.',
      'Verified outcome (runtime): Tests passed.',
      'Next: unknown.',
    ].join('\n'))
  })

  it('redacts secret shapes and strips control sequences from details', () => {
    const output = formatAnnouncementDetails({
      schemaVersion: 1,
      id: 'a1',
      runId: 'run-1',
      priority: 'assertive',
      category: 'error',
      text: '\u001b[31mFailed with sk-ant-api03-supersecretvalue1234\u001b[0m',
      detail: 'Inspect\u0000the trace.',
      dedupeKey: 'error:1',
      requiresAcknowledgement: false,
      provenance: [{
        source: 'runtime',
        runId: 'run-1',
        sequence: 1,
        sourceEventType: 'attention-added',
        sourceEventId: 'runtime-error',
      }],
      createdAt: timestamp,
    }, 'runs/run-1.jsonl')

    expect(output).not.toMatch(/[\u001b\u0000]/)
    expect(output).not.toContain('supersecretvalue1234')
    expect(output).toContain('[REDACTED]')
    expect(output).toContain('Evidence: runtime attention-added runtime-error, sequence 1.')
    expect(output).toContain('Full trace: runs/run-1.jsonl')
    expect(output.length).toBeLessThanOrEqual(4_096)
  })
})
