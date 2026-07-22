import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grepTool } from '../../src/tools/grep.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-grep-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('grepTool', () => {
  it('finds pattern with file:line via ripgrep', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello needle world\nsecond line\n')
    const res = await grepTool.execute(
      { pattern: 'needle', case_insensitive: false },
      makeCtx(dir),
    )
    expect(res.isError).toBe(false)
    expect(res.output).toContain('a.txt')
    expect(res.output).toMatch(/a\.txt:1:/)
    expect(res.output).toContain('hello needle world')
  })

  it('returns no-matches cleanly when rg exits 1', async () => {
    writeFileSync(join(dir, 'a.txt'), 'nothing here\n')
    const res = await grepTool.execute(
      { pattern: 'zzz_absent_zzz', case_insensitive: false },
      makeCtx(dir),
    )
    expect(res.isError).toBe(false)
    expect(res.output).toBe('No matches found.')
  })

  it('caps output at 30000 chars with truncation notice', async () => {
    const line = 'needle ' + 'x'.repeat(90) + '\n'
    writeFileSync(join(dir, 'big.txt'), line.repeat(2000))
    const res = await grepTool.execute(
      { pattern: 'needle', case_insensitive: false },
      makeCtx(dir),
    )
    expect(res.isError).toBe(false)
    expect(res.output.length).toBeLessThanOrEqual(30_000 + 100)
    expect(res.output).toContain('(truncated: output exceeded 30000 chars)')
  })
})
