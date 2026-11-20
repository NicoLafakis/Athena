import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  consolidationDue,
  detectSameCitationContradictions,
  extractCitations,
  flagFreeTextMemory,
  formatFreeTextReviewList,
  markConsolidated,
  recordMemoryWriteForHygiene,
  rebuildFreeTextMemoryIndex,
  restoreFreeTextMemory,
  supersedeFreeTextMemory,
  tombstoneFreeTextMemory,
  verifyCitations,
} from '../../src/brain/free-text-hygiene.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { memoryTool } from '../../src/tools/memory.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let root: string
let repoDir: string
let brainDir: string
let memoryDir: string

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore', windowsHide: true })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-ft-hygiene-'))
  repoDir = join(root, 'repo')
  brainDir = join(root, 'brain')
  memoryDir = join(brainDir, 'memory')
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('extractCitations', () => {
  it('extracts file:line, ranges, bare paths, backticked flags, and athena commands while ignoring prose', () => {
    const body = [
      'Vault logic lives in src/brain/paths.ts:44 and src/cli/args.ts:10-20.',
      'See docs/guide.md for background.',
      'Run `athena learn consolidate` with `--force` or flag:--approve.',
      'Meeting at 12:30 with ratio 3:4 and https://example.com:8080/foo.',
    ].join('\n')

    const citations = extractCitations(body)
    expect(citations.map((c) => c.raw)).toEqual(
      expect.arrayContaining([
        'src/brain/paths.ts:44',
        'src/cli/args.ts:10-20',
        'docs/guide.md',
        'cmd:athena learn consolidate',
        'flag:--force',
        'flag:--approve',
      ]),
    )
    expect(citations.some((c) => c.raw.includes('12:30') || c.raw.includes('8080'))).toBe(false)
  })
})

describe('verifyCitations', () => {
  it('fingerprints valid file:line citations, silently tracks ±10 line drift, and flags edited/missing lines', () => {
    const srcFile = join(repoDir, 'src', 'example.ts')
    writeFileSync(srcFile, 'line1\nexport const FENCE_VERSION = 1\nline3\n', 'utf8')
    const memFile = join(memoryDir, 'fence.md')
    writeFileSync(memFile, 'Fence version is defined at src/example.ts:2.\n', 'utf8')

    // Initial verification captures fingerprint and stays active.
    const first = verifyCitations(memoryDir, repoDir)
    expect(first.flagged).toEqual([])
    expect(first.checked).toBe(1)

    // Insert 4 lines above — line 2 moves to line 6 (within ±10 window): auto-updates without flagging.
    writeFileSync(srcFile, 'a\nb\nc\nd\nline1\nexport const FENCE_VERSION = 1\nline3\n', 'utf8')
    const drifted = verifyCitations(memoryDir, repoDir, { touchedFiles: ['src/example.ts'] })
    expect(drifted.flagged).toEqual([])
    expect(drifted.relocated).toBe(1)

    // Edit the cited line content — now flags with a specific reason while leaving body untouched.
    writeFileSync(srcFile, 'a\nb\nc\nd\nline1\nexport const FENCE_VERSION = 999\nline3\n', 'utf8')
    const edited = verifyCitations(memoryDir, repoDir, { touchedFiles: ['src/example.ts'] })
    expect(edited.flagged).toHaveLength(1)
    expect(edited.flagged[0]!.path).toBe('fence.md')
    expect(edited.flagged[0]!.reason).toMatch(/moved or was edited/i)
    expect(readFileSync(memFile, 'utf8')).toContain('Fence version is defined at src/example.ts:2.')
  })

  it('auto-relocates renamed files via git log --follow instead of false-flagging', () => {
    git(['init'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'src', 'old-name.ts'), 'export const MAGIC = 42\n', 'utf8')
    git(['add', 'src/old-name.ts'])
    git(['commit', '-m', 'add old-name'])

    const memFile = join(memoryDir, 'magic.md')
    writeFileSync(memFile, 'Magic constant in src/old-name.ts:1.\n', 'utf8')
    expect(verifyCitations(memoryDir, repoDir).flagged).toEqual([])

    git(['mv', 'src/old-name.ts', 'src/new-name.ts'])
    git(['commit', '-m', 'rename'])

    const afterRename = verifyCitations(memoryDir, repoDir)
    expect(afterRename.flagged).toEqual([])
    expect(afterRename.relocated).toBeGreaterThanOrEqual(1)
    expect(readFileSync(memFile, 'utf8')).toContain('src/new-name.ts')
  })

  it('skips MEMORY.md, LEARNED.md, journal/, and semantic/ directories', () => {
    mkdirSync(join(memoryDir, 'journal'), { recursive: true })
    mkdirSync(join(memoryDir, 'semantic'), { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n- src/missing.ts:1\n', 'utf8')
    writeFileSync(join(memoryDir, 'LEARNED.md'), 'src/missing.ts:1\n', 'utf8')
    writeFileSync(join(memoryDir, 'journal', 'j.md'), 'src/missing.ts:1\n', 'utf8')
    writeFileSync(join(memoryDir, 'semantic', 's.md'), 'src/missing.ts:1\n', 'utf8')

    const result = verifyCitations(memoryDir, repoDir)
    expect(result.checked).toBe(0)
    expect(result.flagged).toEqual([])
  })
})

describe('free-text lifecycle ops and index ordering', () => {
  it('supports flag, restore, supersede (bidirectional), tombstone (terminal), and contradiction hints', () => {
    writeFileSync(join(memoryDir, 'a.md'), 'Rule A references src/app.ts:10.\n', 'utf8')
    writeFileSync(join(memoryDir, 'b.md'), 'Rule B also references src/app.ts:10.\n', 'utf8')
    writeFileSync(join(memoryDir, 'c.md'), 'Replacement rule C.\n', 'utf8')

    const contradictions = detectSameCitationContradictions(memoryDir)
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]!.files).toEqual(['a.md', 'b.md'])

    flagFreeTextMemory(memoryDir, 'a.md', 'citation missing')
    expect(formatFreeTextReviewList(memoryDir)).toContain('a.md')
    restoreFreeTextMemory(memoryDir, 'a.md')
    expect(readFileSync(join(memoryDir, 'a.md'), 'utf8')).toContain('status: active')

    supersedeFreeTextMemory(memoryDir, 'a.md', 'c.md')
    expect(readFileSync(join(memoryDir, 'a.md'), 'utf8')).toContain('supersededBy: c.md')
    expect(readFileSync(join(memoryDir, 'c.md'), 'utf8')).toContain('supersedes: a.md')
    expect(() => restoreFreeTextMemory(memoryDir, 'a.md')).toThrow(/terminal/i)

    tombstoneFreeTextMemory(memoryDir, 'b.md', 'no longer true')
    expect(() => restoreFreeTextMemory(memoryDir, 'b.md')).toThrow(/terminal/i)

    rebuildFreeTextMemoryIndex(memoryDir)
    const idx = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    expect(idx).toContain('c.md')
    expect(idx).toContain('superseded by c.md')
    expect(idx).toContain('TOMBSTONED')
    // Active entries appear before superseded/tombstoned.
    expect(idx.indexOf('c.md')).toBeLessThan(idx.indexOf('superseded by c.md'))
  })

  it('tracks count-triggered consolidation state across writes', () => {
    expect(consolidationDue(memoryDir, 3)).toBe(false)
    recordMemoryWriteForHygiene(memoryDir)
    recordMemoryWriteForHygiene(memoryDir)
    expect(consolidationDue(memoryDir, 3)).toBe(false)
    recordMemoryWriteForHygiene(memoryDir)
    expect(consolidationDue(memoryDir, 3)).toBe(true)
    markConsolidated(memoryDir)
    expect(consolidationDue(memoryDir, 3)).toBe(false)
  })
})

describe('memoryTool hygiene ops and read banners', () => {
  it('supports flag, restore, and tombstone ops and prepends a warning banner on read', async () => {
    const ctx = makeCtx(brainDir)
    await memoryTool.execute({ op: 'write', path: 'note.md', content: 'Old fact body' }, ctx)

    const flagged = await memoryTool.execute(
      { op: 'flag', path: 'note.md', description: 'source changed' },
      ctx,
    )
    expect(flagged.isError).toBe(false)

    const readFlagged = await memoryTool.execute({ op: 'read', path: 'note.md' }, ctx)
    expect(readFlagged.isError).toBe(false)
    expect(readFlagged.output).toMatch(/FLAGGED/i)
    expect(readFlagged.output).toContain('source changed')
    expect(readFlagged.output).toContain('Old fact body')

    const restored = await memoryTool.execute({ op: 'restore', path: 'note.md' }, ctx)
    expect(restored.isError).toBe(false)
    const readRestored = await memoryTool.execute({ op: 'read', path: 'note.md' }, ctx)
    expect(readRestored.output).not.toMatch(/FLAGGED/i)

    const tombstoned = await memoryTool.execute(
      { op: 'tombstone', path: 'note.md', description: 'obsolete' },
      ctx,
    )
    expect(tombstoned.isError).toBe(false)
    const readTomb = await memoryTool.execute({ op: 'read', path: 'note.md' }, ctx)
    expect(readTomb.output).toMatch(/TOMBSTONED/i)
    const badRestore = await memoryTool.execute({ op: 'restore', path: 'note.md' }, ctx)
    expect(badRestore.isError).toBe(true)
  })
})

describe('HookRunner internal hooks', () => {
  it('runs registered internal hooks alongside user hooks without subprocess overhead', async () => {
    const runner = new HookRunner([])
    runner.registerInternal('UserPromptSubmit', (payload) => {
      if (typeof payload.prompt === 'string' && /outdated/i.test(payload.prompt)) {
        return { addedContext: 'Check stored memories for outdated facts.' }
      }
      return {}
    })
    const hit = await runner.run('UserPromptSubmit', { prompt: 'That setting is outdated now.' })
    expect(hit.allowed).toBe(true)
    expect(hit.addedContext).toContain('Check stored memories')

    const miss = await runner.run('UserPromptSubmit', { prompt: 'Run pnpm test please.' })
    expect(miss.allowed).toBe(true)
    expect(miss.addedContext).toBeUndefined()
  })
})
