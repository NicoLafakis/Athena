import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatchTool } from '../../src/tools/apply-patch.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-apply-patch-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ApplyPatch', () => {
  it('atomically adds and updates multiple files', async () => {
    const existing = join(dir, 'src', 'a.txt')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(existing, 'one\ntwo\n')
    const ctx = makeCtx(dir)
    ctx.fileReadRegistry.add(existing)

    const result = await applyPatchTool.execute(
      {
        patch:
          '*** Begin Patch\n' +
          '*** Update File: src/a.txt\n' +
          '@@\n' +
          ' one\n' +
          '-two\n' +
          '+second\n' +
          '*** Add File: src/b.txt\n' +
          '+new\n' +
          '*** End Patch\n',
      },
      ctx,
    )
    expect(result.isError).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe('one\nsecond\n')
    expect(readFileSync(join(dir, 'src', 'b.txt'), 'utf8')).toBe('new\n')
  })

  it('requires a prior Read and makes no partial change when validation fails', async () => {
    const existing = join(dir, 'a.txt')
    writeFileSync(existing, 'original\n')
    const result = await applyPatchTool.execute(
      {
        patch:
          '*** Begin Patch\n' +
          '*** Update File: a.txt\n' +
          '@@\n' +
          '-original\n' +
          '+changed\n' +
          '*** Add File: b.txt\n' +
          'missing-plus\n' +
          '*** End Patch\n',
      },
      makeCtx(dir),
    )
    expect(result.isError).toBe(true)
    expect(readFileSync(existing, 'utf8')).toBe('original\n')
    expect(existsSync(join(dir, 'b.txt'))).toBe(false)
  })

  it('deletes and moves only after read preconditions', async () => {
    const remove = join(dir, 'remove.txt')
    const move = join(dir, 'move.txt')
    writeFileSync(remove, 'remove\n')
    writeFileSync(move, 'move\n')
    const ctx = makeCtx(dir)
    ctx.fileReadRegistry.add(remove)
    ctx.fileReadRegistry.add(move)
    const result = await applyPatchTool.execute(
      {
        patch:
          '*** Begin Patch\n' +
          '*** Delete File: remove.txt\n' +
          '*** Update File: move.txt\n' +
          '*** Move to: moved.txt\n' +
          '@@\n' +
          '-move\n' +
          '+moved\n' +
          '*** End Patch\n',
      },
      ctx,
    )
    expect(result.isError).toBe(false)
    expect(existsSync(remove)).toBe(false)
    expect(existsSync(move)).toBe(false)
    expect(readFileSync(join(dir, 'moved.txt'), 'utf8')).toBe('moved\n')
  })
})
