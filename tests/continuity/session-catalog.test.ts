import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectSlug, SessionStore } from '../../src/harness/sessions.js'
import {
  canonicalSessionRecords,
  listAllProjectSessions,
  readSessionLineRecords,
  resolveSessionLineage,
  stableSessionLineId,
} from '../../src/continuity/session-catalog.js'

let sessionsRoot: string

beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), 'athena-continuity-sessions-'))
})

afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true })
})

describe('all-project session catalog', () => {
  it('enumerates persisted sessions across project partitions with stable IDs', () => {
    const firstStore = new SessionStore(sessionsRoot, 'C:/projects/alpha')
    const secondStore = new SessionStore(sessionsRoot, 'C:/projects/beta')
    const alpha = firstStore.create()
    const beta = secondStore.create()
    alpha.appendMessage({ role: 'user', content: 'alpha' })
    beta.appendMessage({ role: 'user', content: 'beta' })

    expect(listAllProjectSessions(sessionsRoot)).toEqual([
      expect.objectContaining({ projectId: projectSlug('C:/projects/alpha'), sessionId: alpha.id }),
      expect.objectContaining({ projectId: projectSlug('C:/projects/beta'), sessionId: beta.id }),
    ])
    for (const session of listAllProjectSessions(sessionsRoot)) {
      expect(session.file).toBe(join(sessionsRoot, session.projectId, `${session.sessionId}.jsonl`))
    }
  })

  it('skips trash, locks, temporary files, hidden entries, and non-session files', () => {
    const projectPath = 'C:/projects/cleanup'
    const store = new SessionStore(sessionsRoot, projectPath)
    const active = store.create()
    const deleted = store.create()
    active.appendMessage({ role: 'user', content: 'active' })
    deleted.appendMessage({ role: 'user', content: 'deleted' })
    store.delete(deleted.id)
    const projectDir = join(sessionsRoot, projectSlug(projectPath))
    mkdirSync(join(projectDir, '.trash'), { recursive: true })
    writeFileSync(join(projectDir, 'pending.jsonl.lock'), '{}')
    writeFileSync(join(projectDir, 'pending.jsonl.tmp'), '{}')
    writeFileSync(join(projectDir, '.hidden.jsonl'), '{}')
    writeFileSync(join(projectDir, 'notes.txt'), 'not a session')
    writeFileSync(join(projectDir, '.trash', 'trashed.jsonl'), '{}')
    writeFileSync(join(sessionsRoot, 'not-a-project.txt'), '{}')

    expect(listAllProjectSessions(sessionsRoot).map((entry) => entry.sessionId)).toEqual([active.id])
  })

  it('returns raw line and physical line identity while skipping malformed lines', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/lines')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'valid source' })
    appendFileSync(session.file, '{torn-json\n', 'utf8')

    const records = readSessionLineRecords(session.file)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      lineNumber: 1,
      line: { version: 3, kind: 'message', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    })
    expect(JSON.parse(records[0]!.rawLine)).toMatchObject({ id: expect.any(String) })
  })

  it('indexes canonical source lines but excludes copied checkpoint and rewind snapshots', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/branches')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'original question' })
    const checkpointId = session.checkpoint([{ role: 'user', content: 'compacted state' }])
    session.appendEvent({ type: 'turn-done' })
    session.rewind([{ role: 'user', content: 'rewound state' }], checkpointId, 'rewind')

    expect(canonicalSessionRecords(readSessionLineRecords(session.file)).map(({ line }) => line.kind)).toEqual([
      'message',
      'event',
    ])
  })

  it('uses immutable line IDs and deterministic identities for legacy records', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/legacy-lines')
    const session = store.create()
    writeFileSync(session.file, '{"kind":"message","ts":"2026-08-01T12:00:00.000Z","data":{"role":"user","content":"old"}}\n', 'utf8')
    const [record] = readSessionLineRecords(session.file)
    expect(stableSessionLineId(record!)).toMatch(/^legacy:1:[a-f0-9]{64}$/)
    expect(stableSessionLineId(record!)).toBe(stableSessionLineId(record!))
  })

  it('resolves inherited context through a stable source boundary without copying snapshots', () => {
    const projectPath = 'C:/projects/lineage'
    const store = new SessionStore(sessionsRoot, projectPath)
    const parent = store.create()
    parent.appendMessage({ role: 'user', content: 'before fork point' })
    const checkpointId = parent.checkpoint([{ role: 'user', content: 'reconstructed context' }])
    parent.appendMessage({ role: 'user', content: 'after fork point' })
    const child = store.fork(parent.id, checkpointId)
    child.appendMessage({ role: 'user', content: 'new branch contribution' })

    const catalog = listAllProjectSessions(sessionsRoot)
    const childSource = catalog.find((source) => source.sessionId === child.id)!
    const lineage = resolveSessionLineage(sessionsRoot, childSource)
    expect(lineage.complete).toBe(true)
    expect(lineage.ancestors).toHaveLength(1)
    expect(lineage.ancestors[0]!.records.map(({ line }) => line.data)).toEqual([
      { role: 'user', content: 'before fork point' },
    ])
    expect(lineage.ancestors[0]!.throughLineId).toBe(
      readSessionLineRecords(parent.file).find(({ line }) => line.kind === 'checkpoint')!.line.id,
    )
  })

  it('follows multi-level fork lineage even when a fork boundary names the initial checkpoint', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/nested-lineage')
    const root = store.create()
    root.appendMessage({ role: 'user', content: 'Root source conversation.' })
    const firstFork = store.fork(root.id)
    const firstCheckpoint = readSessionLineRecords(firstFork.file).find(({ line }) => line.kind === 'checkpoint')!
    const secondFork = store.fork(firstFork.id, (firstCheckpoint.line.data as { checkpointId: string }).checkpointId)

    const source = listAllProjectSessions(sessionsRoot).find((item) => item.sessionId === secondFork.id)!
    const lineage = resolveSessionLineage(sessionsRoot, source)
    expect(lineage.complete).toBe(true)
    expect(lineage.ancestors.map((item) => item.sessionId)).toEqual([firstFork.id, root.id])
    expect(lineage.ancestors[1]!.records.map(({ line }) => line.data)).toContainEqual({
      role: 'user', content: 'Root source conversation.',
    })
  })

  it('marks missing parent sources and lineage cycles incomplete without returning guessed context', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/broken-lineage')
    const parent = store.create()
    parent.appendMessage({ role: 'user', content: 'parent context' })
    const child = store.fork(parent.id)
    rmSync(parent.file)
    let result = resolveSessionLineage(
      sessionsRoot,
      listAllProjectSessions(sessionsRoot).find((item) => item.sessionId === child.id)!,
    )
    expect(result.complete).toBe(false)
    expect(result.ancestors).toEqual([])
    expect(result.issues[0]).toContain('unavailable')

    const left = store.create()
    const right = store.create()
    left.appendMessage({ role: 'user', content: 'left' })
    right.appendMessage({ role: 'user', content: 'right' })
    const leftBoundary = readSessionLineRecords(left.file)[0]!
    const rightBoundary = readSessionLineRecords(right.file)[0]!
    left.appendEvent({
      type: 'session-fork', sourceProjectId: store.projectId, sourceSessionId: right.id,
      sourceLineId: stableSessionLineId(rightBoundary),
    })
    right.appendEvent({
      type: 'session-fork', sourceProjectId: store.projectId, sourceSessionId: left.id,
      sourceLineId: stableSessionLineId(leftBoundary),
    })
    result = resolveSessionLineage(
      sessionsRoot,
      listAllProjectSessions(sessionsRoot).find((item) => item.sessionId === left.id)!,
    )
    expect(result.complete).toBe(false)
    expect(result.issues).toContain('Fork lineage contains a cycle')
  })

  it('reports unresolved lineage instead of inventing history for legacy fork events', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/old-fork')
    const parent = store.create()
    parent.appendMessage({ role: 'user', content: 'parent' })
    const child = store.create()
    child.appendEvent({ type: 'session-fork', sourceSessionId: parent.id, checkpointId: null })

    const lineage = resolveSessionLineage(sessionsRoot, listAllProjectSessions(sessionsRoot).find((source) => source.sessionId === child.id)!)
    expect(lineage.complete).toBe(false)
    expect(lineage.issues).toContain('Fork source does not include a stable project and line boundary')
    expect(lineage.ancestors).toEqual([])
  })

  it('returns an empty list when no session root exists', () => {
    const missing = join(sessionsRoot, 'missing')
    expect(existsSync(missing)).toBe(false)
    expect(listAllProjectSessions(missing)).toEqual([])
  })
})
