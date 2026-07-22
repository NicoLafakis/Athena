import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryTool } from '../../src/tools/memory.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-memory-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const memFile = (rel: string) => join(dir, 'memory', rel)
const indexFile = () => join(dir, 'memory', 'MEMORY.md')

describe('memoryTool', () => {
  it('write creates the file and appends an index line to MEMORY.md', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute(
      { op: 'write', path: 'facts/x.md', content: 'fact body', description: 'a fact' },
      ctx,
    )
    expect(res.isError).toBe(false)
    expect(existsSync(memFile(join('facts', 'x.md')))).toBe(true)
    const idx = readFileSync(indexFile(), 'utf8')
    expect(idx).toContain('[facts/x.md]')
    expect(idx).toContain('a fact')
  })

  it('list returns relative paths, read returns content, delete removes file and index line', async () => {
    const ctx = makeCtx(dir)
    await memoryTool.execute({ op: 'write', path: 'facts/x.md', content: 'fact body' }, ctx)
    await memoryTool.execute({ op: 'write', path: 'top.md', content: 'top fact' }, ctx)

    const listRes = await memoryTool.execute({ op: 'list' }, ctx)
    expect(listRes.isError).toBe(false)
    expect(listRes.output).toContain('facts/x.md')
    expect(listRes.output).toContain('top.md')

    const readRes = await memoryTool.execute({ op: 'read', path: 'facts/x.md' }, ctx)
    expect(readRes.isError).toBe(false)
    expect(readRes.output).toBe('fact body')

    const delRes = await memoryTool.execute({ op: 'delete', path: 'facts/x.md' }, ctx)
    expect(delRes.isError).toBe(false)
    expect(existsSync(memFile(join('facts', 'x.md')))).toBe(false)
    expect(readFileSync(indexFile(), 'utf8')).not.toContain('[facts/x.md]')
  })

  it('write without description uses the first content line for the index', async () => {
    const ctx = makeCtx(dir)
    await memoryTool.execute({ op: 'write', path: 'y.md', content: 'first line\nsecond' }, ctx)
    expect(readFileSync(indexFile(), 'utf8')).toContain('first line')
  })

  it('rejects paths escaping the memory dir', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'read', path: '../settings.json' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/escapes/i)
  })

  it('read of a missing file errors', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'read', path: 'nope.md' }, ctx)
    expect(res.isError).toBe(true)
  })

  it('read/write/delete without path errors', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'read' }, ctx)
    expect(res.isError).toBe(true)
  })

  it('rejects write and delete of the reserved MEMORY.md index (any case)', async () => {
    const ctx = makeCtx(dir)
    for (const name of ['MEMORY.md', 'memory.md', 'Memory.MD', './MEMORY.md']) {
      const res = await memoryTool.execute({ op: 'write', path: name, content: 'x' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.output).toMatch(/reserved/i)
    }
    const del = await memoryTool.execute({ op: 'delete', path: 'MEMORY.md' }, ctx)
    expect(del.isError).toBe(true)
    expect(del.output).toMatch(/reserved/i)
  })

  it('still allows reading MEMORY.md', async () => {
    const ctx = makeCtx(dir)
    await memoryTool.execute({ op: 'write', path: 'x.md', content: 'fact' }, ctx)
    const res = await memoryTool.execute({ op: 'read', path: 'MEMORY.md' }, ctx)
    expect(res.isError).toBe(false)
    expect(res.output).toContain('[x.md]')
  })

  it('list on empty memory reports empty', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'list' }, ctx)
    expect(res.isError).toBe(false)
    expect(res.output).toBe('(memory is empty)')
  })
})
