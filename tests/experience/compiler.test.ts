import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineEventBus } from '../../src/engine/events.js'
import { RunTraceWriter } from '../../src/harness/traces.js'
import {
  captureExperienceBestEffort,
  compileExperienceFromTrace,
  deriveProvisionalGuidance,
  ExperienceStore,
} from '../../src/experience/index.js'
import { projectId } from '../../src/harness/trust.js'

describe('experience trace compiler', () => {
  it('deterministically compiles redacted evidence and provisional guidance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-experience-compile-'))
    try {
      const cwd = join(root, 'project')
      const trace = await RunTraceWriter.create(join(root, 'runs'), {
        cwd,
        provider: 'fixture',
        model: 'fixture',
        mode: 'normal',
        sandbox: 'workspace-write',
        runId: 'run-1',
      })
      const bus = new EngineEventBus()
      trace.attach(bus)
      trace.recordPrompt('Release sk-ant-api03-supersecretvalue1234 accessibility changes.\nSafely.')
      bus.emit({ type: 'tool-result', id: 'write-1', name: 'Write', output: 'private output', isError: false })
      bus.emit({ type: 'tool-result', id: 'test-1', name: 'Bash', output: 'failed details', isError: true })
      await trace.close({
        status: 'completed',
        reason: 'completed',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          modelCalls: 1,
          toolCalls: 2,
          turns: 1,
          durationMs: 1,
        },
      })

      const first = await compileExperienceFromTrace(trace.file)
      const second = await compileExperienceFromTrace(trace.file)
      expect(second).toEqual(first)
      expect(first).toMatchObject({
        projectScope: projectId(cwd),
        situation: 'Release [REDACTED] accessibility changes. Safely.',
        actions: ['Write succeeded.', 'Bash failed.'],
        outcome: 'mixed',
        tags: expect.arrayContaining(['write', 'bash', 'mixed']),
      })
      expect(first.evidenceRefs.every((reference) => reference.startsWith('trace:run-1:'))).toBe(true)
      expect(JSON.stringify(first)).not.toContain('private output')
      expect(JSON.stringify(first)).not.toContain('failed details')
      expect(JSON.stringify(first)).not.toContain('supersecretvalue1234')

      expect(deriveProvisionalGuidance(first)).toMatchObject({
        status: 'provisional',
        signal: 'consider',
        confidence: 0.4,
        experienceIds: [first.id],
      })

      const store = new ExperienceStore(join(root, 'experience'))
      const captured = await captureExperienceBestEffort(trace.file, store)
      expect(captured?.experience).toEqual(first)
      expect(store.listExperiences()).toHaveLength(1)
      expect(store.listGuidance()).toMatchObject([{ status: 'provisional' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a trace whose hash chain was not verified', async () => {
    await expect(compileExperienceFromTrace(join(process.cwd(), 'missing-trace.jsonl'))).rejects.toThrow()
    const warnings: string[] = []
    await expect(captureExperienceBestEffort(
      join(process.cwd(), 'missing-trace.jsonl'),
      new ExperienceStore(join(process.cwd(), 'missing-experience-store')),
      (warning) => warnings.push(warning),
    )).resolves.toBeNull()
    expect(warnings).toHaveLength(1)
  })
})
