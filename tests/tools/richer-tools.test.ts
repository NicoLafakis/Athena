import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diagnosticsTool } from '../../src/tools/diagnostics.js'
import { readImageTool } from '../../src/tools/image.js'
import { notebookEditTool } from '../../src/tools/notebook.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { ResourcePolicy } from '../../src/harness/resource-policy.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-rich-tools-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('richer standard tools', () => {
  it('returns provider-native bounded image content', async () => {
    const file = join(dir, 'pixel.png')
    writeFileSync(
      file,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4l8AAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const result = await readImageTool.execute({ file_path: file }, makeCtx(dir))
    expect(result.isError).toBe(false)
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          source: expect.objectContaining({ media_type: 'image/png' }),
        }),
      ]),
    )
  })

  it('atomically edits a notebook cell after a Read precondition', async () => {
    const file = join(dir, 'work.ipynb')
    writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        cells: [{ id: 'cell-a', cell_type: 'code', source: ['print(1)'] }],
      }),
    )
    const ctx = makeCtx(dir)
    ctx.fileReadRegistry.add(file)
    const result = await notebookEditTool.execute(
      { file_path: file, cell_id: 'cell-a', new_source: 'print(2)' },
      ctx,
    )
    expect(result.isError).toBe(false)
    const notebook = JSON.parse(readFileSync(file, 'utf8')) as {
      cells: Array<{ source: string[] }>
    }
    expect(notebook.cells[0]!.source).toEqual(['print(2)'])
  })

  it('collects TypeScript diagnostics without executing project scripts', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
    )
    writeFileSync(join(dir, 'src', 'bad.ts'), 'const value: string = 1\n')
    const result = await diagnosticsTool.execute({ path: dir }, makeCtx(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('TS2322')
  })

  it('does not let TypeScript config traversal read outside the sandbox', async () => {
    const external = mkdtempSync(join(tmpdir(), 'athena-rich-tools-external-'))
    try {
      writeFileSync(
        join(external, 'base.json'),
        JSON.stringify({ compilerOptions: { strict: true }, secret: 'do-not-leak' }),
      )
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ extends: join(external, 'base.json'), include: [] }),
      )
      const ctx = makeCtx(dir)
      const policy = new ResourcePolicy(dir, 'read-only')
      ctx.resolvePath = (path, access) => policy.resolvePath(path, access)
      const result = await diagnosticsTool.execute({ path: dir }, ctx)
      expect(result.isError).toBe(true)
      expect(result.output).not.toContain('do-not-leak')
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })
})
