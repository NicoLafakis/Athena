import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LibraryRuntime } from '../../src/library/runtime.js'
import { loadLibraryConfig } from '../../src/library/config.js'
import { libraryCommand } from '../../src/library/cli.js'
import { makeLibraryWriteTool } from '../../src/tools/library.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { createLibraryFixtureHarness } from '../helpers/library-fixture.js'

const harness = createLibraryFixtureHarness()
afterEach(async () => harness.cleanupEach())
afterAll(() => harness.cleanupAll())

describe('project librarian operator lifecycle and policies', () => {
  it('does not let tool input invoke promotion or store arbitrary/unapproved/sensitive text', async () => {
    const f = harness.fixture()
    const tool = makeLibraryWriteTool(f.library)
    const ctx = makeCtx(f.cwd)
    expect(tool.schema.safeParse({ op: 'promote', id: 'a'.repeat(64) }).success).toBe(false)
    expect(tool.schema.safeParse({ op: 'submit', text: 'arbitrary content' }).success).toBe(false)
    const rejected = await tool.execute(tool.schema.parse({ op: 'submit', ...f.input, detailPath: 'check.mjs' }), ctx)
    expect(rejected.isError).toBe(true)
    writeFileSync(join(f.cwd, 'detail.md'), 'password=synthetic-only')
    expect((await tool.execute(tool.schema.parse({ op: 'submit', ...f.input }), ctx)).isError).toBe(true)
    expect(existsSync(join(f.cwd, '.athena', 'library', 'library.json'))).toBe(false)
  })

  it('keeps recovery candidates quarantined across restart and clears reviews on release', () => {
    const f = harness.fixture()
    const note = f.library.submit({ ...f.input, recovery: true })
    const restarted = LibraryRuntime.open(f.cwd, true)!
    expect(restarted.retrieve({ keys: ['context'] })).toEqual([])
    expect(() => restarted.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow()
    expect(restarted.release(note.id)).toMatchObject({ status: 'candidate', reviews: [] })
    restarted.reject(note.id)
    expect(restarted.submit(f.input).status).toBe('rejected')
  })

  it('supersedes atomically and rolls back only the exact reviewed revision', () => {
    const f = harness.fixture()
    const first = f.library.submit(f.input)
    f.library.promote(first.id, f.reviewed(first))
    writeFileSync(join(f.cwd, 'detail.md'), 'Revised detailed original sources rationale.\n')
    f.git('add', '--', 'detail.md')
    f.git('commit', '--no-gpg-sign', '-m', 'synthetic revised source')
    const second = f.library.submit(f.input)
    const commit = f.reviewed(second)
    f.library.promote(second.id, commit, first.id)
    expect(f.library.store.read().notes.find((note) => note.id === first.id)?.status).toBe('superseded')
    const revision = f.library.store.read().revision
    expect(() => f.library.rollback(second.id, 'wrong')).toThrow('changed')
    f.library.rollback(second.id, revision)
    expect(f.library.store.read().notes.find((note) => note.id === first.id)?.status).toBe('durable')
    // Restoring status never makes the old, changed source eligible again.
    expect(f.library.retrieve({ keys: ['context'] })).toEqual([])
  })

  it('revokes an existing runtime immediately when public-source opt-in changes', () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    f.library.select({ keys: ['context'] })
    writeFileSync(join(f.cwd, '.athena', 'library.config.json'), JSON.stringify({ ...f.config, enabled: false }))
    expect(f.library.context()).not.toContain('Detailed context retention rationale')
    expect(() => f.library.submit(f.input)).toThrow('opt-in changed')
  })

  it('invalidates recall when committed review evidence is changed', () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    writeFileSync(join(f.cwd, 'reviews', 'librarian.json'), '{}')
    expect(f.library.retrieve({ keys: ['context'] })).toEqual([])
  })

  it('defaults disabled and ignores untrusted project opt-in', () => {
    const f = harness.fixture(false)
    expect(loadLibraryConfig(f.cwd, true)).toBeNull()
    expect(libraryCommand(f.cwd, 'status')).toEqual({ enabled: false })
    expect(existsSync(join(f.cwd, '.athena', 'library'))).toBe(false)
    expect(loadLibraryConfig(f.cwd, false)).toBeNull()
  })

  it('runs the actual standalone CLI without the installed dist build', () => {
    const f = harness.fixture(false)
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/library/cli.ts'), 'status', f.cwd],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    )
    expect(JSON.parse(output)).toEqual({ enabled: false })
  })
})
