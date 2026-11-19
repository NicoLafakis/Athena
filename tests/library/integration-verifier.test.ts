import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LibraryRuntime } from '../../src/library/runtime.js'
import { libraryCommand } from '../../src/library/cli.js'
import { digest } from '../../src/library/core.js'
import { createLibraryFixtureHarness } from '../helpers/library-fixture.js'

const harness = createLibraryFixtureHarness()
afterEach(async () => harness.cleanupEach())
afterAll(() => harness.cleanupAll())

describe('project librarian verifier and check receipts', () => {
  it('uses Git canonical blobs for CRLF sources and multiline reviews under core.autocrlf=true', () => {
    const f = harness.fixture(true, true)
    expect(readFileSync(join(f.cwd, 'detail.md'), 'utf8')).toContain('\r\n')
    expect(f.git('show', 'HEAD:detail.md')).not.toContain('\r')
    expect(f.git('diff', '--name-only', 'HEAD')).toBe('')
    const note = f.library.submit(f.input)
    const commit = f.reviewed(note)
    expect(readFileSync(join(f.cwd, 'reviews', 'librarian.json'), 'utf8')).toContain('\r\n')
    expect(f.library.promote(note.id, commit).note.status).toBe('durable')
    expect(f.library.retrieve({ keys: ['context'] })).toHaveLength(1)
    // Checkout line-ending representation is equivalent; semantic edits are not.
    const original = readFileSync(join(f.cwd, 'detail.md'), 'utf8')
    writeFileSync(join(f.cwd, 'detail.md'), original.replace(/\r\n/g, '\n'))
    expect(f.library.retrieve({ keys: ['context'] })).toHaveLength(1)
    writeFileSync(join(f.cwd, 'detail.md'), original.replace('Qualify', 'Discard'))
    expect(f.library.retrieve({ keys: ['context'] })).toEqual([])
  })

  it('refuses custom clean filters before hashing sources', () => {
    const f = harness.fixture()
    writeFileSync(join(f.cwd, '.gitattributes'), 'detail.md filter=blocked\n')
    f.git('config', 'filter.blocked.clean', 'this-command-must-never-run')
    expect(() => f.library.submit(f.input)).toThrow('custom filters')
  })

  it('requires fresh verification when exact check arguments change, even with the same ID', () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    writeFileSync(join(f.cwd, 'failing.mjs'), 'process.exit(1)\n')
    const config = { ...f.config, checks: [{ id: 'source-fixture', args: ['failing.mjs'] }] }
    writeFileSync(join(f.cwd, '.athena', 'library.config.json'), JSON.stringify(config))
    f.git('add', '--', 'failing.mjs', '.athena/library.config.json')
    f.git('commit', '--no-gpg-sign', '-m', 'synthetic changed check definition')
    const restarted = LibraryRuntime.open(f.cwd, true)!
    expect(restarted.retrieve({ keys: ['context'] })).toEqual([])
    expect(() => restarted.reverify(note.id, f.git('rev-parse', 'HEAD'))).toThrow('checks failed')
    writeFileSync(join(f.cwd, 'failing.mjs'), 'process.exit(0)\n')
    f.git('add', '--', 'failing.mjs')
    f.git('commit', '--no-gpg-sign', '-m', 'synthetic fixed check')
    expect(restarted.reverify(note.id, f.git('rev-parse', 'HEAD')).note.checks?.[0]?.definitionHash).toBe(
      restarted.verifier.definitionHash(config.checks[0]!),
    )
    expect(restarted.retrieve({ keys: ['context'] })).toHaveLength(1)
  })

  it('invalidates receipts when the executed entry script changes without renaming it', () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    writeFileSync(join(f.cwd, 'check.mjs'), 'process.exit(1)\n')
    expect(LibraryRuntime.open(f.cwd, true)!.retrieve({ keys: ['context'] })).toEqual([])
  })

  it('excludes legacy receipts missing their executed-definition digest', () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    f.library.promote(note.id, f.reviewed(note))
    const before = f.library.store.read()
    f.library.store.save(
      before.notes.map((item) => ({
        ...item,
        checks: item.checks?.map(({ definitionHash: _missing, ...receipt }) => receipt),
      })),
      before.revision,
    )
    expect(LibraryRuntime.open(f.cwd, true)!.retrieve({ keys: ['context'] })).toEqual([])
  })

  it('executes checks against committed sources and returns detailed notes through the CLI', () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    const commit = f.reviewed(note)
    expect(f.library.promote(note.id, commit).checks).toEqual([
      expect.objectContaining({ id: 'source-fixture', passed: true }),
    ])
    expect(libraryCommand(f.cwd, 'retrieve', { keys: ['context'] })).toEqual([
      expect.objectContaining({ content: readFileSync(join(f.cwd, 'detail.md'), 'utf8').trim() }),
    ])
    expect(libraryCommand(f.cwd, 'retrieve', { keys: ['context'], shape: 'summary' })).toEqual([
      expect.objectContaining({ content: 'Retain source-linked context.' }),
    ])
    writeFileSync(join(f.cwd, 'detail.md'), 'Changed original sources.\n')
    expect(libraryCommand(f.cwd, 'retrieve', { keys: ['context'] })).toEqual([])
  })

  it('refuses self-attested review hashes, changed check scripts and failed real checks', () => {
    const f = harness.fixture()
    const note = f.library.submit(f.input)
    expect(() => f.library.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow('Four distinct')
    const before = f.library.store.read()
    const forged = {
      ...note,
      reviews: (['request', 'implementation', 'verification', 'librarian'] as const).map((stage) => ({
        stage,
        evidence: digest(stage),
        reviewer: 'self-attested',
      })),
    }
    f.library.store.save([forged], before.revision)
    expect(() => f.library.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow('hashes alone')
    f.library.store.save([note], f.library.store.read().revision)
    const commit = f.reviewed(note)
    writeFileSync(join(f.cwd, 'check.mjs'), 'process.exit(0)')
    expect(() => f.library.promote(note.id, commit)).toThrow('committed implementation')
    f.git('checkout', '--', 'check.mjs')
    writeFileSync(join(f.cwd, 'check.mjs'), 'process.exit(1)')
    f.git('add', '--', 'check.mjs')
    f.git('commit', '--no-gpg-sign', '-m', 'synthetic failing check')
    expect(() => f.library.promote(note.id, f.git('rev-parse', 'HEAD'))).toThrow('checks failed')
  })
})
