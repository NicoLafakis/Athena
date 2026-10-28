import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNote, digest, reviewNote, promoteNote, releaseRecovery, rejectNote, retrieveNotes, type LibraryNote, type Review } from '../../src/library/core.js'
import { LibraryStore } from '../../src/library/store.js'

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
