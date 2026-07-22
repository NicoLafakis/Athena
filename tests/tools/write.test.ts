import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTool } from '../../src/tools/read.js'
import { writeTool } from '../../src/tools/write.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-write-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeTool', () => {
  it('creates a new file without prior Read', async () => {
    const target = join(dir, 'nested', 'new.txt')
    const res = await writeTool.execute({ file_path: target, content: 'hello' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('hello')
  })

  it('refuses to overwrite an existing file not read this session', async () => {
    writeFileSync(join(dir, 'a.txt'), 'old')
    const res = await writeTool.execute(
      { file_path: join(dir, 'a.txt'), content: 'new' },
      makeCtx(dir),
    )
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/read/i)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('old')
  })

  it('overwrites after a Read in the same session', async () => {
    writeFileSync(join(dir, 'a.txt'), 'old')
    const ctx = makeCtx(dir)
    await readTool.execute({ file_path: join(dir, 'a.txt') }, ctx)
    const res = await writeTool.execute({ file_path: join(dir, 'a.txt'), content: 'new' }, ctx)
    expect(res.isError).toBe(false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('new')
  })
})
