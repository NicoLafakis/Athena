import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { RunTraceWriter } from '../../src/harness/traces.js'
import { reflectTraces } from '../../src/learning/candidates.js'
import { TraceWarehouse } from '../../src/learning/warehouse.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'athena-learning-warehouse-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('TraceWarehouse learning provenance', () => {
  it('admits intact evidence and rejects a tampered hash chain', async () => {
    const paths = resolveBrainPaths({ cwd: home, homeOverride: home })
    const writer = await RunTraceWriter.create(paths.runsDir, {
      cwd: home,
      provider: 'anthropic',
      model: 'sonnet',
      mode: 'normal',
      sandbox: 'workspace-write',
    })
    await writer.close({
      status: 'completed',
      reason: 'completed',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        modelCalls: 1,
        toolCalls: 0,
        turns: 1,
        durationMs: 1,
      },
    })

    const record = await new TraceWarehouse(paths.runsDir).get(writer.runId)
    expect(record).toMatchObject({ integrity: 'valid', status: 'completed' })
    const candidate = await reflectTraces(paths, [writer.runId])
    expect(candidate.provenance.traceHashes).toEqual([record.finalHash])
    expect(candidate.confidence).toBeLessThanOrEqual(0.25)

    const lines = readFileSync(writer.file, 'utf8').trimEnd().split('\n')
    const first = JSON.parse(lines[0]!) as { payload: unknown }
    first.payload = { tampered: true }
    lines[0] = JSON.stringify(first)
    writeFileSync(writer.file, lines.join('\n') + '\n')

    await expect(new TraceWarehouse(paths.runsDir).requireEvidence([writer.runId]))
      .rejects.toThrow(/invalid trace/)
  })
})
