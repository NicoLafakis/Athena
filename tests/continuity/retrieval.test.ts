import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../src/harness/sessions.js'
import { ContinuityStore } from '../../src/continuity/store.js'
import { loadEpisodeSourceContext, searchEpisodes } from '../../src/continuity/retrieval.js'
import { resolveTemporalWindow } from '../../src/continuity/time.js'

let root: string
let sessionsRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-continuity-retrieval-'))
  sessionsRoot = join(root, 'sessions')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('continuity retrieval', () => {
  it('finds the same cross-project episode under an explicit temporal window', () => {
    const first = new SessionStore(sessionsRoot, 'C:/projects/alpha').create()
    first.appendMessage({ role: 'user', content: 'I decided to use source-linked memory episodes.' })
    first.appendMessage({ role: 'assistant', content: 'That keeps each recollection grounded.' })
    first.appendEvent({ type: 'turn-done' })
    writeFileSync(
      first.file,
      readFileSync(first.file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.stringify({ ...JSON.parse(line), ts: '2026-09-16T15:00:00.000Z' }))
        .join('\n') + '\n',
      'utf8',
    )
    const second = new SessionStore(sessionsRoot, 'C:/projects/beta').create()
    second.appendMessage({ role: 'user', content: 'We discussed unrelated interface styling.' })
    second.appendEvent({ type: 'turn-done' })

    const store = new ContinuityStore(join(root, 'continuity'), { now: () => new Date('2026-09-23T15:00:00.000Z') })
    store.rebuild(sessionsRoot)
    const temporal = resolveTemporalWindow('What did I decide last week?', {
      now: new Date('2026-09-23T15:00:00.000Z'),
      configuredTimeZone: 'America/New_York',
    })
    expect(temporal.status).toBe('resolved')
    if (temporal.status !== 'resolved') return
    const hits = searchEpisodes(store.listEpisodes(), { text: 'What did I decide about source linked memory?', window: temporal.window })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.episode.sessionId).toBe(first.id)
    const context = loadEpisodeSourceContext(sessionsRoot, hits[0]!.episode)
    expect(context.status).toBe('ok')
    if (context.status === 'ok') {
      expect(context.messages.map((message) => message.content)).toContain('I decided to use source-linked memory episodes.')
      expect(JSON.stringify(context.messages)).toContain('That keeps each recollection grounded.')
    }
  })

  it('applies project filtering and deterministic recency ordering', () => {
    const old = new SessionStore(sessionsRoot, 'C:/projects/alpha').create()
    old.appendMessage({ role: 'user', content: 'The continuity project should keep memory linked.' })
    old.appendEvent({ type: 'turn-done' })
    const other = new SessionStore(sessionsRoot, 'C:/projects/beta').create()
    other.appendMessage({ role: 'user', content: 'The continuity project should keep memory linked.' })
    other.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)
    const projectId = new SessionStore(sessionsRoot, 'C:/projects/alpha').projectId
    expect(searchEpisodes(store.listEpisodes(), { text: 'continuity memory', projectId })).toHaveLength(1)
    expect(searchEpisodes(store.listEpisodes(), { text: 'nothing matches these terms' })).toEqual([])
  })

  it('can load bounded adjacent turns without changing an episode’s own source refs', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/adjacent-turns').create()
    session.appendMessage({ role: 'user', content: 'Earlier we were comparing two memory options.' })
    session.appendMessage({ role: 'assistant', content: 'We had not chosen one yet.' })
    session.appendEvent({ type: 'turn-done' })
    session.appendMessage({ role: 'user', content: 'I decided on linked episodes.' })
    session.appendMessage({ role: 'assistant', content: 'I will keep them tied to their sources.' })
    session.appendEvent({ type: 'turn-done' })
    session.appendMessage({ role: 'user', content: 'One more detail about that choice.' })
    session.appendMessage({ role: 'assistant', content: 'The original lines remain inspectable.' })
    session.appendEvent({ type: 'turn-done' })

    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)
    const episode = store.listEpisodes().find((item) => item.summary.includes('linked episodes'))!
    const context = loadEpisodeSourceContext(sessionsRoot, episode, 8, true)

    expect(context.status).toBe('ok')
    if (context.status === 'ok') {
      expect(context.messages.map((message) => message.content)).toEqual([
        'I decided on linked episodes.',
        'I will keep them tied to their sources.',
      ])
      expect(context.adjacentMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ relation: 'preceding-turn', content: 'We had not chosen one yet.' }),
        expect.objectContaining({ relation: 'following-turn', content: 'One more detail about that choice.' }),
      ]))
      expect(context.adjacentMessages).toHaveLength(4)
      expect(context.messages.length + context.adjacentMessages.length).toBeLessThanOrEqual(8)
      expect(context.sourceRefs.map((ref) => ref.recordId)).toEqual(episode.sourceRefs.map((ref) => ref.recordId))
    }
  })

  it('enforces the eight-message limit across the episode and adjacent turns', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/context-limit').create()
    session.appendMessage({ role: 'user', content: 'Prior topic.' })
    session.appendMessage({ role: 'assistant', content: 'Prior response.' })
    session.appendEvent({ type: 'turn-done' })
    session.appendMessage({ role: 'user', content: 'Target episode.' })
    for (let index = 0; index < 9; index++) {
      session.appendMessage({ role: 'assistant', content: `Target response ${index}.` })
    }
    session.appendEvent({ type: 'turn-done' })
    session.appendMessage({ role: 'user', content: 'Following topic.' })
    session.appendMessage({ role: 'assistant', content: 'Following response.' })
    session.appendEvent({ type: 'turn-done' })

    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)
    const episode = store.listEpisodes().find((item) => item.summary.includes('Target episode.'))!
    const context = loadEpisodeSourceContext(sessionsRoot, episode, 8, true)

    expect(context.status).toBe('ok')
    if (context.status === 'ok') {
      expect(context.messages.length + context.adjacentMessages.length).toBeLessThanOrEqual(8)
      expect(context.truncated).toBe(true)
    }
  })

  it('loads only source-linked messages and rejects changed source records as stale', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/source').create()
    session.appendMessage({ role: 'user', content: 'What did we decide about the index?' })
    session.appendMessage({ role: 'assistant', content: 'We decided to keep it local.' })
    session.appendEvent({ type: 'turn-done' })
    session.checkpoint([{ role: 'user', content: 'checkpoint copy must stay out of recall' }])
    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)
    const episode = store.listEpisodes()[0]!
    const context = loadEpisodeSourceContext(sessionsRoot, episode)
    expect(context.status).toBe('ok')
    if (context.status !== 'ok') return
    expect(context.messages).toHaveLength(2)
    expect(JSON.stringify(context.messages)).not.toContain('checkpoint copy')
    expect(context.sourceRefs).toHaveLength(3)

    const lines = readFileSync(session.file, 'utf8').split('\n')
    const changed = JSON.parse(lines[0]!)
    changed.data.content = 'Edited after the index was built.'
    lines[0] = JSON.stringify(changed)
    writeFileSync(session.file, lines.join('\n'), 'utf8')
    expect(loadEpisodeSourceContext(sessionsRoot, episode).status).toBe('stale')
  })

  it('reports missing sessions and avoids showing raw path data in the result', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/missing-source').create()
    session.appendMessage({ role: 'user', content: 'A source session that will disappear.' })
    session.appendEvent({ type: 'turn-done' })
    const store = new ContinuityStore(join(root, 'continuity'))
    store.rebuild(sessionsRoot)
    const episode = store.listEpisodes()[0]!
    rmSync(session.file)
    const result = loadEpisodeSourceContext(sessionsRoot, episode)
    expect(result.status).toBe('missing')
    expect(JSON.stringify(result)).not.toContain(sessionsRoot)
  })

  it('keeps malformed timestamp lines out of episode text and marks affected turns uncertain', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/malformed-time').create()
    session.appendMessage({ role: 'user', content: 'The request remains verifiable.' })
    session.appendMessage({ role: 'assistant', content: 'This malformed line must not enter the summary.' })
    session.appendEvent({ type: 'turn-done' })

    const lines = readFileSync(session.file, 'utf8').trimEnd().split('\n')
    const malformed = JSON.parse(lines[1]!)
    malformed.ts = 'not-a-timestamp'
    lines[1] = JSON.stringify(malformed)
    writeFileSync(session.file, `${lines.join('\n')}\n`, 'utf8')

    const store = new ContinuityStore(join(root, 'continuity'))
    const rebuilt = store.rebuild(sessionsRoot)
    expect(rebuilt.warnings).toContain(
      `Skipped malformed continuity records in session ${new SessionStore(sessionsRoot, 'C:/projects/malformed-time').projectId}/${session.id}; affected episodes are marked uncertain`,
    )
    const [episode] = store.listEpisodes()
    expect(episode).toBeDefined()
    expect(episode?.completion).toBe('uncertain')
    expect(episode?.summary).not.toContain('malformed line')
    const context = loadEpisodeSourceContext(sessionsRoot, episode!)
    expect(context.status).toBe('ok')
    if (context.status === 'ok') {
      expect(context.messages.map((message) => message.content)).not.toContain('This malformed line must not enter the summary.')
    }
  })

  it('marks a turn uncertain when a malformed JSONL line interrupts its source records', () => {
    const session = new SessionStore(sessionsRoot, 'C:/projects/malformed-json').create()
    session.appendMessage({ role: 'user', content: 'Keep the valid source lines.' })
    session.appendMessage({ role: 'assistant', content: 'This line will be truncated.' })
    session.appendEvent({ type: 'turn-done' })

    const lines = readFileSync(session.file, 'utf8').trimEnd().split('\n')
    lines[1] = '{"kind":"message","data":{"content":"truncated turn content"}'
    writeFileSync(session.file, `${lines.join('\n')}\n`, 'utf8')

    const store = new ContinuityStore(join(root, 'continuity'))
    const rebuilt = store.rebuild(sessionsRoot)
    expect(rebuilt.warnings).toContain(
      `Skipped malformed continuity records in session ${new SessionStore(sessionsRoot, 'C:/projects/malformed-json').projectId}/${session.id}; affected episodes are marked uncertain`,
    )
    const [episode] = store.listEpisodes()
    expect(episode?.completion).toBe('uncertain')
    expect(episode?.summary).not.toContain('truncated turn content')
    const context = loadEpisodeSourceContext(sessionsRoot, episode!)
    expect(context.status).toBe('ok')
    if (context.status === 'ok') {
      expect(context.messages.map((message) => message.content)).toEqual(['Keep the valid source lines.'])
    }
  })
})
