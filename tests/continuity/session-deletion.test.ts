import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContinuityStore } from '../../src/continuity/store.js'
import { SessionStore } from '../../src/harness/sessions.js'

let root: string
let sessionsRoot: string
let continuityRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-continuity-delete-'))
  sessionsRoot = join(root, 'sessions')
  continuityRoot = join(root, 'continuity')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('session deletion tombstones', () => {
  it('suppresses deleted sessions across rebuilds and restores only through the explicit restore path', () => {
    const sessions = new SessionStore(sessionsRoot, 'C:/projects/delete-me')
    const session = sessions.create()
    session.appendMessage({ role: 'user', content: 'A source-linked episode that can be restored.' })
    session.appendEvent({ type: 'turn-done' })
    const continuity = new ContinuityStore(continuityRoot)
    continuity.rebuild(sessionsRoot)
    expect(continuity.listEpisodes()).toHaveLength(1)

    continuity.tombstoneSession(sessions.projectId, session.id)
    expect(continuity.listEpisodes()).toEqual([])
    expect(continuity.indexSession(sessionsRoot, sessions.projectId, session.id)).toEqual({ state: 'removed', episodeCount: 0 })
    const ledger = readFileSync(join(continuityRoot, 'tombstones.json'), 'utf8')
    expect(ledger).toContain(session.id)
    expect(ledger).not.toContain('A source-linked episode that can be restored.')
    expect(continuity.rebuild(sessionsRoot).episodeCount).toBe(0)

    sessions.delete(session.id)
    const restarted = new ContinuityStore(continuityRoot)
    expect(restarted.listEpisodes()).toEqual([])
    expect(restarted.buildRollups('UTC').rollups).toEqual([])
    expect(restarted.rebuild(sessionsRoot).episodeCount).toBe(0)

    sessions.restore(session.id)
    const restored = restarted.restoreSession(sessions.projectId, session.id, sessionsRoot)
    expect(restored).toMatchObject({ state: 'indexed', episodeCount: 1 })
    expect(new ContinuityStore(continuityRoot).listEpisodes()).toHaveLength(1)
  })

  it('fails closed when the tombstone ledger is corrupt and does not overwrite it during rebuild', () => {
    const sessions = new SessionStore(sessionsRoot, 'C:/projects/corrupt-ledger')
    const session = sessions.create()
    session.appendMessage({ role: 'user', content: 'This must stay suppressed when state is corrupt.' })
    session.appendEvent({ type: 'turn-done' })
    const continuity = new ContinuityStore(continuityRoot)
    continuity.rebuild(sessionsRoot)
    continuity.tombstoneSession(sessions.projectId, session.id)
    const ledgerFile = join(continuityRoot, 'tombstones.json')
    const before = '{invalid ledger'
    writeFileSync(ledgerFile, before, 'utf8')

    const warnings: string[] = []
    const restarted = new ContinuityStore(continuityRoot, { onWarn: (warning) => warnings.push(warning) })
    expect(restarted.listEpisodes()).toEqual([])
    expect(restarted.status().state).toBe('corrupt')
    expect(warnings.some((warning) => warning.includes('tombstones.json') && warning.includes('repair the versioned ledger'))).toBe(true)
    expect(() => restarted.rebuild(sessionsRoot)).toThrow(/tombstone ledger.*corrupt/i)
    expect(readFileSync(ledgerFile, 'utf8')).toBe(before)
  })

  it('recovers a still-live source if deletion stopped after writing its tombstone', () => {
    const sessions = new SessionStore(sessionsRoot, 'C:/projects/interrupted-delete')
    const session = sessions.create()
    session.appendMessage({ role: 'user', content: 'Recover the interrupted delete safely.' })
    session.appendEvent({ type: 'turn-done' })
    const continuity = new ContinuityStore(continuityRoot)
    continuity.rebuild(sessionsRoot)
    continuity.tombstoneSession(sessions.projectId, session.id)
    expect(new ContinuityStore(continuityRoot).listEpisodes()).toEqual([])

    const restoredFile = sessions.restore(session.id)
    const result = new ContinuityStore(continuityRoot).restoreSession(sessions.projectId, session.id, sessionsRoot)

    expect(restoredFile).toBe(session.file)
    expect(result).toMatchObject({ state: 'indexed', episodeCount: 1 })
    expect(new ContinuityStore(continuityRoot).listEpisodes()).toHaveLength(1)
  })
})
