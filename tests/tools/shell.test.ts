import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bashTool, powershellTool, backgroundTasks } from '../../src/tools/shell.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-shell-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('powershellTool', () => {
  it('runs a command and returns stdout', async () => {
    const res = await powershellTool.execute({ command: 'Write-Output hello' }, makeCtx(dir))
    expect(res.output).toContain('hello')
    expect(res.isError).toBe(false)
  }, 30_000)

  it('nonzero exit returns isError true', async () => {
    const res = await powershellTool.execute({ command: 'exit 3' }, makeCtx(dir))
    expect(res.isError).toBe(true)
  }, 30_000)

  it('kills the process at timeout and says so', async () => {
    const res = await powershellTool.execute(
      { command: 'Start-Sleep 10', timeout: 500 },
      makeCtx(dir),
    )
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/timed out/)
  }, 30_000)

  it('caps combined output at 30000 chars with a truncation notice', async () => {
    const res = await powershellTool.execute(
      { command: "1..400 | ForEach-Object { Write-Output ('x' * 100) }" },
      makeCtx(dir),
    )
    expect(res.isError).toBe(false)
    expect(res.output).toContain('(truncated: output exceeded 30000 chars)')
    expect(res.output.length).toBeLessThan(30_100)
  }, 60_000)

  it('rejects timeout above 600000ms via schema', () => {
    expect(powershellTool.schema.safeParse({ command: 'x', timeout: 700_000 }).success).toBe(false)
  })

  it('accepts a bare command via schema', () => {
    expect(powershellTool.schema.safeParse({ command: 'Write-Output hi' }).success).toBe(true)
  })

  it('background mode returns a task id immediately and later emits a tool-result event', async () => {
    const ctx = makeCtx(dir)
    const res = await powershellTool.execute(
      { command: 'Write-Output done', run_in_background: true },
      ctx,
    )
    expect(res.isError).toBe(false)
    expect(res.output).toMatch(/^Started background task bg-/)
    const id = /bg-[0-9a-f]+/.exec(res.output)?.[0]
    expect(id).toBeDefined()
    expect(backgroundTasks.get(id!)?.status).toBe('running')
    await vi.waitFor(
      () => {
        expect(
          ctx.events.some((e) => e.type === 'tool-result' && e.output.includes('done')),
        ).toBe(true)
      },
      { timeout: 30_000 },
    )
    expect(backgroundTasks.get(id!)?.status).toBe('done')
  }, 40_000)
})

describe('bashTool', () => {
  it('runs a command and returns stdout', async () => {
    const res = await bashTool.execute({ command: 'echo hello-from-bash' }, makeCtx(dir))
    expect(res.output).toContain('hello-from-bash')
    expect(res.isError).toBe(false)
  }, 30_000)

  it('nonzero exit returns isError true', async () => {
    const res = await bashTool.execute({ command: 'exit 3' }, makeCtx(dir))
    expect(res.isError).toBe(true)
  }, 30_000)
})
