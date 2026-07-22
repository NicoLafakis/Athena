import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { editTool } from '../../src/tools/edit.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import type { ToolContext } from '../../src/engine/types.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-edit-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctxWithRead(file: string): ToolContext {
  const ctx = makeCtx(dir)
  ctx.fileReadRegistry.add(resolve(file))
  return ctx
}

describe('editTool', () => {
  it('replaces an exact unique match', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'alpha beta gamma')
    const res = await editTool.execute(
      { file_path: file, old_string: 'beta', new_string: 'BETA', replace_all: false },
      ctxWithRead(file),
    )
    expect(res.isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('alpha BETA gamma')
  })

  it('errors when old_string is not found', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'alpha')
    const res = await editTool.execute(
      { file_path: file, old_string: 'zeta', new_string: 'x', replace_all: false },
      ctxWithRead(file),
    )
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/not found/i)
    expect(readFileSync(file, 'utf8')).toBe('alpha')
  })

  it('errors when old_string matches more than once without replace_all', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'dup dup dup')
    const res = await editTool.execute(
      { file_path: file, old_string: 'dup', new_string: 'x', replace_all: false },
      ctxWithRead(file),
    )
    expect(res.isError).toBe(true)
    expect(res.output).toContain('3')
    expect(readFileSync(file, 'utf8')).toBe('dup dup dup')
  })

  it('replace_all replaces every occurrence and reports the count', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'dup dup dup')
    const res = await editTool.execute(
      { file_path: file, old_string: 'dup', new_string: 'x', replace_all: true },
      ctxWithRead(file),
    )
    expect(res.isError).toBe(false)
    expect(res.output).toContain('3')
    expect(readFileSync(file, 'utf8')).toBe('x x x')
  })

  it('requires the file to have been Read this session', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'alpha')
    const res = await editTool.execute(
      { file_path: file, old_string: 'alpha', new_string: 'x', replace_all: false },
      makeCtx(dir),
    )
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/read/i)
    expect(readFileSync(file, 'utf8')).toBe('alpha')
  })
})
