import { describe, expect, it } from 'vitest'
import { statusUpdateTool } from '../../src/tools/status-update.js'
import { makeCtx } from '../helpers/tool-ctx.js'

describe('StatusUpdate tool', () => {
  it('emits bounded agent assertions without a verified outcome field', async () => {
    const ctx = makeCtx(process.cwd(), { toolCallId: 'status-1', runId: 'child-run' })
    const result = await statusUpdateTool.execute({
      objective: 'Prepare the release.',
      nextExpected: 'Run the verification gates.',
    }, ctx)

    expect(result).toEqual({ output: 'Status update recorded.', isError: false })
    expect(ctx.events).toContainEqual({
      type: 'agent-status-update',
      objective: 'Prepare the release.',
      nextExpected: 'Run the verification gates.',
      sourceRef: 'status-1',
      runId: 'child-run',
    })
    expect(JSON.stringify(ctx.events)).not.toContain('verified')
    expect(statusUpdateTool.readOnly).toBe(true)
  })

  it('rejects empty and oversized assertions at the schema boundary', () => {
    expect(statusUpdateTool.schema.safeParse({}).success).toBe(false)
    expect(statusUpdateTool.schema.safeParse({ objective: 'x'.repeat(4_097) }).success).toBe(false)
    expect(statusUpdateTool.schema.safeParse({ nextExpected: 'x'.repeat(1_025) }).success).toBe(false)
  })
})
