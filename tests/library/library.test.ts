import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, renameSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { createNote, digest, reviewNote, promoteNote, releaseRecovery, rejectNote, retrieveNotes, type LibraryNote, type Review } from '../../src/library/core.js'
import { projectFile } from '../../src/library/config.js'
import { LibraryStore } from '../../src/library/store.js'
import { LibraryRuntime } from '../../src/library/runtime.js'
import { libraryCommand } from '../../src/library/cli.js'
import { makeLibraryReadTool } from '../../src/tools/library.js'
import { makeCtx } from '../helpers/tool-ctx.js'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, renameSync: vi.fn(original.renameSync) }
})
const safe = () => false
const fresh = () => true
const commit = 'a'.repeat(40)
const input = { scope: 'synthetic-project', detail: 'Detailed implementation rationale with its original qualification.',
  summary: 'Implementation rationale.', categories: ['context', 'memory'], sources: [{ id: 'synthetic-source', revision: digest('source') }] }
const stages: Review['stage'][] = ['request', 'implementation', 'verification', 'librarian']
function reviewed(): LibraryNote {
  return stages.reduce((note, stage) => reviewNote(note, { stage, evidence: digest(stage), reviewer: `synthetic-${stage}` }, fresh), createNote(input, safe))
}
const durable = () => promoteNote(reviewed(), commit, fresh, () => true)
const roots: string[] = []
function store(): LibraryStore {
  const root = mkdtempSync(join(tmpdir(), 'athena-library-synthetic-'))
  roots.push(root)
  return new LibraryStore(root, safe)
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('librarian lifecycle', () => {
  it('keeps detailed notes authoritative and summaries explicitly requested', () => {
    const note = durable()
    const query = { scope: input.scope, keys: [' CONTEXT '] }
    expect(retrieveNotes([note], query, fresh)[0]?.content).toBe(input.detail)
    expect(retrieveNotes([note], { ...query, shape: 'summary' }, fresh)[0]?.content).toBe(input.summary)
    expect(retrieveNotes([note], query, fresh)[0]?.sources).toEqual(input.sources)
  })
  it('uses stable IDs and category order independent of duplicate input keys', () => {
    expect(createNote({ ...input, categories: ['memory', 'context', 'memory'] }, safe).id).toBe(createNote(input, safe).id)
  })
  it('requires complete distinct reviews and independently checked committed work', () => {
    expect(() => promoteNote(createNote(input, safe), commit, fresh, () => true)).toThrow('Four distinct')
    expect(() => promoteNote(reviewed(), commit, fresh, () => false)).toThrow('not verified')
    expect(() => promoteNote(reviewed(), commit, () => false, () => true)).toThrow('stale')
    expect(() => promoteNote({ ...reviewed(), reviews: Array(4).fill(reviewed().reviews[0]) }, commit, fresh, () => true)).toThrow('Four distinct')
    const first = reviewed().reviews[0]!
    expect(() => reviewNote(createNote(input, safe), first, () => false)).toThrow('stale')
    expect(() => reviewNote(reviewed(), first, fresh)).toThrow('already recorded')
  })
  it('excludes stale, rejected, superseded, wrong-scope, unlocked and oversized notes', () => {
    const note = durable()
    const query = { scope: input.scope, keys: ['context'] }
    expect(retrieveNotes([note], query, () => false)).toEqual([])
    expect(retrieveNotes([rejectNote(note)], query, fresh)).toEqual([])
    expect(retrieveNotes([{ ...note, status: 'superseded' }], query, fresh)).toEqual([])
    expect(retrieveNotes([note], { ...query, scope: 'other' }, fresh)).toEqual([])
    expect(retrieveNotes([note], { ...query, keys: ['unknown'] }, fresh)).toEqual([])
    expect(retrieveNotes([note], { ...query, maxChars: 20 }, fresh)).toEqual([])
    expect(retrieveNotes([note], { ...query, maxItems: 0 }, fresh)).toEqual([])
  })
  it('revalidates every retrieval rather than retaining old recall after a source edit', () => {
    let valid = true
    const note = durable()
    const query = { scope: input.scope, keys: ['context'] }
    expect(retrieveNotes([note], query, () => valid)).toHaveLength(1)
    valid = false
    expect(retrieveNotes([note], query, () => valid)).toHaveLength(0)
  })
  it('quarantines abandoned work and requires fresh full review after release', () => {
    const note = createNote(input, safe, true)
    expect(retrieveNotes([note], { scope: input.scope, keys: ['context'] }, fresh)).toEqual([])
    expect(() => reviewNote(note, reviewed().reviews[0]!, fresh)).toThrow('Only candidates')
    expect(() => releaseRecovery(note, () => false)).toThrow('stale')
    expect(releaseRecovery(note, fresh)).toMatchObject({ status: 'candidate', reviews: [] })
    expect(() => promoteNote(releaseRecovery(note, fresh), commit, fresh, () => true)).toThrow('Four distinct')
  })
  it('refuses common credentials and caller-defined sensitive information', () => {
    expect(() => createNote({ ...input, detail: 'api_key=synthetic-only' }, safe)).toThrow('sensitive-data')
    expect(() => createNote(input, content => content.includes('qualification'))).toThrow('sensitive-data')
  })
})

describe('isolated persistence and recovery', () => {
  it('persists linked records and detects competing writers without clobbering', () => {
    const library = store()
    const initial = library.read()
    const saved = library.save([durable()], initial.revision)
    expect(library.read()).toEqual(saved)
    expect(() => library.save([], initial.revision)).toThrow('changed since read')
    expect(library.read()).toEqual(saved)
    expect(existsSync(join(library.root, 'writer.lock'))).toBe(false)
  })
  it('rolls back only the exact expected state and permits idempotent retries', () => {
    const library = store()
    const initial = library.read()
    const saved = library.save([durable()], initial.revision)
    const retry = library.save(saved.notes, saved.revision)
    expect(retry.revision).toBe(saved.revision)
    expect(library.restore(initial, retry.revision).notes).toEqual([])
    expect(() => library.restore(saved, retry.revision)).toThrow('changed since read')
  })
  it('does not write rejected sensitive content, even through direct storage', () => {
    const library = store()
    const initial = library.read()
    expect(() => library.save([{ ...durable(), summary: 'password=synthetic-only' }], initial.revision)).toThrow('sensitive-data')
    expect(existsSync(join(library.root, 'library.json'))).toBe(false)
    expect(library.read()).toEqual(initial)
  })
  it('preserves corrupt storage for inspection instead of replacing it', () => {
    const library = store()
    writeFileSync(join(library.root, 'library.json'), '{torn')
    expect(() => library.read()).toThrow()
    expect(() => library.save([], 'unknown')).toThrow()
    expect(existsSync(join(library.root, 'writer.lock'))).toBe(false)
  })
  it('preserves the prior snapshot and cleans temporary state when atomic replacement fails', () => {
    const library = store()
    const initial = library.read()
    const saved = library.save([durable()], initial.revision)
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('synthetic rename failure') })
    expect(() => library.save([], saved.revision)).toThrow('synthetic rename failure')
    expect(library.read()).toEqual(saved)
    expect(readdirSync(library.root)).toEqual(['library.json'])
  })
  it('rejects content tampering while preserving the old file', () => {
    const library = store()
    const initial = library.read()
    expect(() => library.save([{ ...durable(), detail: 'Tampered original text.' }], initial.revision)).toThrow('identity')
    expect(library.read()).toEqual(initial)
  })
  it('refuses an existing writer lock and preserves the prior snapshot', () => {
    const library = store()
    const initial = library.read()
    writeFileSync(join(library.root, 'writer.lock'), 'synthetic lock')
    expect(() => library.save([], initial.revision)).toThrow()
    expect(library.read()).toEqual(initial)
    expect(existsSync(join(library.root, 'writer.lock'))).toBe(true)
  })
})

describe('library CLI per-operation validation', () => {
  it('rejects missing required fields via Zod before touching runtime state', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'athena-library-cli-'))
    roots.push(cwd)
    mkdirSync(join(cwd, '.athena'))
    writeFileSync(join(cwd, 'detail.md'), 'Detail.\n')
    writeFileSync(join(cwd, 'summary.md'), 'Summary.\n')
    writeFileSync(
      join(cwd, '.athena', 'library.config.json'),
      JSON.stringify({
        enabled: true,
        publicSources: ['detail.md', 'summary.md'],
        categories: ['context'],
        checks: [{ id: 'ok', args: ['check.mjs'] }],
      }),
    )
    for (const op of ['submit', 'review', 'promote', 'reverify', 'release', 'reject', 'rollback'] as const) {
      expect(() => libraryCommand(cwd, op, {}), `expected ${op} with {} to fail Zod validation`).toThrow(ZodError)
    }
    expect(existsSync(join(cwd, '.athena', 'library', 'library.json'))).toBe(false)
  })

  it('canonicalizes OS-level symlinked parent prefixes (e.g. macOS /var -> /private/var) while still rejecting symlinked project files or library roots', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'athena-library-alias-'))
    roots.push(outer)
    const realParent = join(outer, 'real-parent')
    const aliasParent = join(outer, 'alias-parent')
    const projectReal = join(realParent, 'project')
    mkdirSync(join(projectReal, '.athena'), { recursive: true })
    writeFileSync(join(projectReal, 'detail.md'), 'Detail.\n')
    writeFileSync(join(projectReal, 'summary.md'), 'Summary.\n')
    writeFileSync(
      join(projectReal, '.athena', 'library.config.json'),
      JSON.stringify({
        enabled: true,
        publicSources: ['detail.md', 'summary.md'],
        categories: ['context'],
        checks: [{ id: 'ok', args: ['check.mjs'] }],
      }),
    )
    symlinkSync(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir')

    const aliasedCwd = join(aliasParent, 'project')
    // Project accessed via symlinked ancestor prefix (like macOS /var -> /private/var) succeeds:
    expect(projectFile(aliasedCwd, 'detail.md')).toContain('real-parent')
    expect(libraryCommand(aliasedCwd, 'status')).toMatchObject({ enabled: true })
    // Direct LibraryStore under a symlinked OS ancestor prefix also succeeds:
    expect(new LibraryStore(join(aliasedCwd, '.athena', 'library'), safe).read().notes).toEqual([])
    // LibraryRead tool invoked with the aliased cwd matches its canonical LibraryRuntime scope:
    const aliasedRuntime = LibraryRuntime.open(aliasedCwd, true)!
    const readTool = makeLibraryReadTool(aliasedRuntime)
    const toolRes = await readTool.execute(readTool.schema.parse({ op: 'status' }), makeCtx(aliasedCwd))
    expect(toolRes.isError).toBe(false)
    // A different project cwd is still refused by the tool scope check:
    const otherRes = await readTool.execute(readTool.schema.parse({ op: 'status' }), makeCtx(outer))
    expect(otherRes.isError).toBe(true)

    // Direct symlink at the library root itself is still rejected:
    const targetDir = join(outer, 'redirect-target')
    mkdirSync(join(targetDir, 'library'), { recursive: true })
    writeFileSync(join(targetDir, 'outside.md'), 'Outside.\n')
    const redirectedRoot = join(projectReal, '.athena', 'library-link')
    symlinkSync(targetDir, redirectedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new LibraryStore(redirectedRoot, safe).read()).toThrow(/redirected/)

    // Symlink at the immediate parent (.athena-link -> targetDir) when targetDir/library already
    // exists must NEVER be unwrapped, with or without an explicit project boundary:
    const redirectedParent = join(projectReal, '.athena-link')
    symlinkSync(targetDir, redirectedParent, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new LibraryStore(join(redirectedParent, 'library'), safe).read()).toThrow(/redirected/)
    expect(() => new LibraryStore(join(redirectedParent, 'library'), safe, projectReal).read()).toThrow(/redirected/)

    // Symlinked directory inside the project pointing outside is still rejected:
    const internalLink = join(projectReal, 'sub-link')
    symlinkSync(targetDir, internalLink, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => projectFile(aliasedCwd, 'sub-link/outside.md')).toThrow(/redirected/)
  })
})
