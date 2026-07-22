import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readTool } from '../../src/tools/read.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-read-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readTool', () => {
  it('numbers lines cat -n style and registers the file in fileReadRegistry', async () => {
    writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\n')
    const ctx = makeCtx(dir)
    const res = await readTool.execute({ file_path: join(dir, 'a.txt') }, ctx)
    expect(res.isError).toBe(false)
    expect(res.output).toBe('     1\talpha\n     2\tbeta')
    expect(ctx.fileReadRegistry.has(resolve(join(dir, 'a.txt')))).toBe(true)
  })

  it('applies offset and limit', async () => {
    writeFileSync(join(dir, 'b.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    const res = await readTool.execute(
      { file_path: join(dir, 'b.txt'), offset: 2, limit: 2 },
      makeCtx(dir),
    )
    expect(res.isError).toBe(false)
    expect(res.output).toBe(
      '     2\ttwo\n     3\tthree\n(truncated: showing lines 2-3 of 5)',
    )
  })

  it('defaults to 2000 lines and notes truncation', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`)
    writeFileSync(join(dir, 'big.txt'), lines.join('\n') + '\n')
    const res = await readTool.execute({ file_path: join(dir, 'big.txt') }, makeCtx(dir))
    expect(res.isError).toBe(false)
    const outLines = res.output.split('\n')
    // 2000 numbered lines + 1 truncation notice
    expect(outLines).toHaveLength(2001)
    expect(outLines[0]).toBe('     1\tline 1')
    expect(outLines[1999]).toBe('  2000\tline 2000')
    expect(outLines[2000]).toBe('(truncated: showing lines 1-2000 of 2500)')
  })

  it('errors on missing file', async () => {
    const missing = join(dir, 'nope.txt')
    const res = await readTool.execute({ file_path: missing }, makeCtx(dir))
    expect(res.isError).toBe(true)
    expect(res.output).toContain(resolve(missing))
  })
})
