import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globTool } from '../../src/tools/glob.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-glob-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('globTool', () => {
  it('matches ** patterns relative to cwd, newest first, ignoring node_modules and .git', async () => {
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    const older = join(dir, 'src', 'old.ts')
    const newer = join(dir, 'src', 'deep', 'new.ts')
    writeFileSync(older, 'a')
    writeFileSync(newer, 'b')
    writeFileSync(join(dir, 'node_modules', 'pkg', 'decoy.ts'), 'x')
    writeFileSync(join(dir, '.git', 'decoy.ts'), 'x')
    // force distinct mtimes: older gets an old timestamp
    const past = new Date(Date.now() - 60_000)
    utimesSync(older, past, past)

    const res = await globTool.execute({ pattern: '**/*.ts' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    const lines = res.output.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('new.ts')
    expect(lines[1]).toContain('old.ts')
    expect(res.output).not.toContain('node_modules')
    expect(res.output).not.toContain('.git')
  })

  it('returns a no-matches message, not an error', async () => {
    const res = await globTool.execute({ pattern: '**/*.nope' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.output).toContain('No files matched')
  })
})
