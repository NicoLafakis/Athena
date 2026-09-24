import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { latestUserMessageSourceRef, readSessionLineRecords, sessionLineDigest, stableSessionLineId, SessionStore } from '../../src/harness/sessions.js'
import { ContinuityStore } from '../../src/continuity/store.js'

let root: string
let sessionsRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-continuity-index-'))
  sessionsRoot = join(root, 'sessions')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ContinuityStore', () => {
  it('indexes source-verified Jev speech acts alongside each episode', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/jev-labels').create()
    session.appendMessage({ role: 'user', content: 'I would like concise paragraphs as my default.' })
    const sourceRef = latestUserMessageSourceRef(session.file, new SessionStore(sessionsRoot, 'C:/projects/jev-labels').projectId, session.id)
    expect(sourceRef).not.toBeNull()
    session.appendEvent({
      type: 'jev-speech-act-classification', schemaVersion: 1, model: 'jev-1.13.0',
      sourceRef, speechAct: 'preferred', confidence: 0.99,
    })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))

    store.rebuild(sessionsRoot)

    expect(store.listEpisodes()[0]?.speechActs).toContain('preferred')
  })

  it('omits legacy Jev speech-act events below the production confidence gate', () => {
    const sessions = new SessionStore(sessionsRoot, 'C:/projects/jev-low-confidence')
    const session = sessions.create()
    session.appendMessage({ role: 'user', content: 'I may prefer concise paragraphs.' })
    const sourceRef = latestUserMessageSourceRef(session.file, sessions.projectId, session.id)
    expect(sourceRef).not.toBeNull()
    session.appendEvent({
      type: 'jev-speech-act-classification', schemaVersion: 1, model: 'jev-1.13.0',
      sourceRef, speechAct: 'preferred', confidence: 0.979,
    })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))

    store.rebuild(sessionsRoot)

    expect(store.listEpisodes()[0]?.speechActs).toEqual([])
  })

  it('ignores a Jev label after its linked user message changes', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/jev-stale-label').create()
    session.appendMessage({ role: 'user', content: 'I would like concise paragraphs as my default.' })
    const storeForProject = new SessionStore(sessionsRoot, 'C:/projects/jev-stale-label')
    const sourceRef = latestUserMessageSourceRef(session.file, storeForProject.projectId, session.id)
    expect(sourceRef).not.toBeNull()
    session.appendEvent({
      type: 'jev-speech-act-classification', schemaVersion: 1, model: 'jev-1.13.0',
      sourceRef, speechAct: 'preferred', confidence: 0.99,
    })
    session.appendEvent({ type: 'turn-done' })
    const originalLines = readFileSync(session.file, 'utf8').trimEnd().split('\n')
    const userLine = JSON.parse(originalLines[0]!) as { data: { content: string } }
    userLine.data.content = 'The changed line is a plain statement.'
    originalLines[0] = JSON.stringify(userLine)
    writeFileSync(session.file, `${originalLines.join('\n')}\n`, 'utf8')
    const store = new ContinuityStore(join(root, 'continuity'))

    store.rebuild(sessionsRoot)

    expect(store.listEpisodes()[0]?.speechActs).not.toContain('preferred')
  })

  it('builds bounded linked episodes from canonical user turns without copying checkpoint snapshots', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/alpha').create()
    session.appendMessage({ role: 'user', content: 'I decided to keep the local memory index. sk-ant-api03-supersecretvalue123' })
    session.appendMessage({ role: 'assistant', content: 'We will keep it source-linked.' })
    session.appendEvent({ type: 'turn-done' })
    session.checkpoint([{ role: 'user', content: 'copied checkpoint content that must not be indexed' }])
    session.appendMessage({ role: 'user', content: 'What should we build next?' })
    session.appendMessage({ role: 'assistant', content: 'A deterministic local catalog.' })
    session.appendEvent({ type: 'turn-done' })

    const store = new ContinuityStore(join(root, 'continuity'), { now: () => new Date('2026-09-23T15:00:00.000Z') })
    const result = store.rebuild(sessionsRoot)
    const episodes = store.listEpisodes()

    expect(result).toMatchObject({ sessionCount: 1, episodeCount: 2, warnings: [] })
    expect(episodes).toHaveLength(2)
    expect(episodes[0]).toMatchObject({
      projectId: expect.stringMatching(/^alpha-/),
      sessionId: session.id,
      participants: ['user', 'assistant', 'runtime'],
      speechActs: ['decided'],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    expect(episodes[0]!.summary).toContain('I decided to keep the local memory index.')
    expect(episodes[0]!.summary).not.toContain('supersecretvalue123')
    expect(episodes[0]!.summary).not.toContain('copied checkpoint content')
    expect(episodes[0]!.sourceRefs).toHaveLength(3)
    expect(episodes[0]!.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    const recordsById = new Map(readSessionLineRecords(session.file).map((record) => [stableSessionLineId(record), record]))
    for (const sourceRef of episodes[0]!.sourceRefs) {
      expect(sourceRef.lineDigest).toBe(sessionLineDigest(recordsById.get(sourceRef.recordId)!))
    }
    expect(episodes[1]!.speechActs).toContain('asked')
  })

  it('rebuilds idempotently with deterministic episode IDs and source links', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/beta').create()
    session.appendMessage({ role: 'user', content: 'We decided to keep a source link.' })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)
    const first = store.listEpisodes()
    store.rebuild(sessionsRoot)
    const second = store.listEpisodes()

    expect(second).toEqual(first)
  })

  it('persists a compressed index envelope and reads it back without losing linked episodes', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/compressed-index').create()
    session.appendMessage({ role: 'user', content: 'A repeated source-linked phrase. '.repeat(40) })
    session.appendEvent({ type: 'turn-done' })
    const continuityRoot = join(root, 'continuity')
    const store = new ContinuityStore(continuityRoot)

    store.rebuild(sessionsRoot)

    const indexFile = join(continuityRoot, 'index.json')
    const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
      format?: string
      formatVersion?: number
      encoding?: string
      payload?: string
    }
    expect(persisted).toMatchObject({
      format: 'athena-continuity-index',
      formatVersion: 1,
      encoding: 'gzip+base64',
    })
    const decoded = JSON.parse(gunzipSync(Buffer.from(persisted.payload!, 'base64')).toString('utf8'))
    expect(decoded).toEqual(store.readIndex())
    expect(persisted.payload).not.toContain('A repeated source-linked phrase.')
    expect(Buffer.byteLength(readFileSync(indexFile, 'utf8'))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(decoded, null, 2) + '\n'),
    )
    expect(new ContinuityStore(continuityRoot).listEpisodes()).toEqual(store.listEpisodes())
  })

  it('reads a legacy plain JSON index and migrates it on rebuild', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/legacy-index').create()
    session.appendMessage({ role: 'user', content: 'The legacy index remains readable.' })
    session.appendEvent({ type: 'turn-done' })
    const continuityRoot = join(root, 'continuity')
    const initialStore = new ContinuityStore(continuityRoot)
    initialStore.rebuild(sessionsRoot)
    const expected = initialStore.listEpisodes()
    const indexFile = join(continuityRoot, 'index.json')
    writeFileSync(indexFile, JSON.stringify(initialStore.readIndex()), 'utf8')

    const legacyStore = new ContinuityStore(continuityRoot)
    expect(legacyStore.listEpisodes()).toEqual(expected)
    legacyStore.rebuild(sessionsRoot)

    const migrated = JSON.parse(readFileSync(indexFile, 'utf8')) as { format?: string }
    expect(migrated.format).toBe('athena-continuity-index')
    expect(new ContinuityStore(continuityRoot).listEpisodes()).toEqual(expected)
  })

  it('rejects a compressed index whose expanded JSON exceeds the configured byte limit', () => {
    const continuityRoot = join(root, 'continuity')
    mkdirSync(continuityRoot, { recursive: true })
    const validIndex = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-09-23T00:00:00.000Z',
      catalogComplete: true,
      sessions: [],
      episodes: [],
    }) + ' '.repeat(100_000)
    writeFileSync(join(continuityRoot, 'index.json'), JSON.stringify({
      format: 'athena-continuity-index',
      formatVersion: 1,
      encoding: 'gzip+base64',
      payload: gzipSync(Buffer.from(validIndex)).toString('base64'),
    }), 'utf8')
    const store = new ContinuityStore(continuityRoot, { maxIndexBytes: 512 })

    expect(store.status().state).toBe('corrupt')
    expect(store.listEpisodes()).toEqual([])
  })

  it('rejects a legacy JSON index above the expanded byte limit', () => {
    const continuityRoot = join(root, 'continuity')
    mkdirSync(continuityRoot, { recursive: true })
    const validIndex = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-09-23T00:00:00.000Z',
      catalogComplete: true,
      sessions: [],
      episodes: [],
    }) + ' '.repeat(600)
    writeFileSync(join(continuityRoot, 'index.json'), validIndex, 'utf8')
    const store = new ContinuityStore(continuityRoot, { maxIndexBytes: 512 })

    expect(store.status().state).toBe('corrupt')
    expect(store.listEpisodes()).toEqual([])
  })
  it('reuses immutable validated index snapshots and invalidates them when index bytes change', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/snapshot-cache').create()
    session.appendMessage({ role: 'user', content: 'A source-linked snapshot.' })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)

    const first = store.readIndex()!
    expect(store.readIndex()).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.episodes)).toBe(true)
    expect(Object.isFrozen(first.episodes[0])).toBe(true)
    expect(Object.isFrozen(first.episodes[0]!.sourceRefs)).toBe(true)
    expect(() => {
      ;(first.episodes[0] as { summary: string }).summary = 'Mutated in-memory snapshot.'
    }).toThrow()

    const indexFile = join(root, 'continuity', 'index.json')
    const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
      payload: string
    }
    const changed = JSON.parse(gunzipSync(Buffer.from(persisted.payload, 'base64')).toString('utf8')) as {
      episodes: Array<{ summary: string }>
    }
    changed.episodes[0]!.summary = 'Updated validated snapshot.'
    writeFileSync(indexFile, JSON.stringify(changed), 'utf8')

    const second = store.readIndex()!
    expect(second).not.toBe(first)
    expect(second.episodes[0]?.summary).toBe('Updated validated snapshot.')
  })

  it('warns on a corrupt index, provides no unvalidated records, and can rebuild it', () => {
    const warnings: string[] = []
    const store = new ContinuityStore(join(root, 'continuity'), { onWarn: (message) => warnings.push(message) })
    mkdirSync(join(root, 'continuity'), { recursive: true })
    writeFileSync(join(root, 'continuity', 'index.json'), '{invalid', 'utf8')
    expect(store.listEpisodes()).toEqual([])
    expect(warnings).toHaveLength(1)

    const session = new SessionStore(sessionsRoot, 'C:/projects/recovery').create()
    session.appendMessage({ role: 'user', content: 'Rebuild should recover this session.' })
    store.rebuild(sessionsRoot)
    expect(store.listEpisodes()).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(root, 'continuity', 'index.json'), 'utf8')).format).toBe(
      'athena-continuity-index',
    )
  })

  it('isolates an interrupted turn when the next user prompt begins', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/interrupted').create()
    session.appendMessage({ role: 'user', content: 'The first request was interrupted.' })
    session.appendMessage({ role: 'assistant', content: 'Partial answer.' })
    session.appendMessage({ role: 'user', content: 'A separate request after restart?' })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)
    expect(store.listEpisodes()).toHaveLength(2)
    expect(store.listEpisodes()[0]!.summary).toContain('Partial answer.')
    expect(store.listEpisodes()[1]!.summary).not.toContain('first request')
  })
})
