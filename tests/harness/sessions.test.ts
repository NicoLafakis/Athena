import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import {
  latestUserMessageSourceRef,
  parseSessionLineRecords,
  readSessionLineRecords,
  sessionLastLineNumber,
  Session,
  SessionStore,
  projectSlug,
} from '../../src/harness/sessions.js'

let sessionsRoot: string
beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), 'athena-sessions-'))
})
afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true })
})

describe('projectSlug', () => {
  it('slugifies the project path deterministically', () => {
    expect(projectSlug('C:/projects/my-app')).toMatch(/^my-app-[a-f0-9]{12}$/)
  })

  it('normalizes backslashes the same as forward slashes', () => {
    expect(projectSlug('C:\\projects\\my-app')).toBe(projectSlug('C:/projects/my-app'))
  })
})

describe('Session', () => {
  it('reports malformed JSONL positions while preserving valid neighboring records', () => {
    const result = parseSessionLineRecords([
      JSON.stringify({ kind: 'message', ts: '2026-08-01T12:00:00.000Z', data: { role: 'user', content: 'valid' } }),
      'null',
      '{"kind":"event","data":',
      JSON.stringify({ kind: 'event', ts: '2026-08-01T12:00:01.000Z', data: { type: 'turn-done' } }),
    ].join('\n'))

    expect(result.records.map((record) => record.lineNumber)).toEqual([1, 4])
    expect(result.malformedLineNumbers).toEqual([2, 3])
  })

  it('appends messages as JSONL lines incrementally', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/my-app')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'hello' })
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi', citations: null }],
    })
    const lines = readFileSync(session.file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'message', data: { role: 'user' } })
  })

  it('appendEvent writes a valid JSONL event line', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/my-app')
    const session = store.create()
    session.appendEvent({ type: 'turn-done', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } })
    const lines = readFileSync(session.file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as {
      version?: number
      kind: string
      ts: string
      timeZone?: string
      data: { type: string }
    }
    expect(parsed.version).toBe(3)
    expect(parsed.kind).toBe('event')
    expect(parsed.data.type).toBe('turn-done')
    expect(new Date(parsed.ts).getTime()).not.toBeNaN()
    expect(parsed.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: parsed.timeZone }).format()).not.toThrow()
  })

  it('continues reading legacy session lines without timezone metadata', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/legacy')
    const session = store.create()
    const legacyMessage = { role: 'user', content: 'before timezone capture' }
    writeFileSync(
      session.file,
      JSON.stringify({ version: 2, kind: 'message', id: 'legacy-line', ts: '2026-08-01T12:00:00.000Z', data: legacyMessage }) + '\n',
      'utf8',
    )
    expect(store.resume(session.id)).toEqual([legacyMessage])
  })

  it('appendEvent lines interleaved with messages are ignored by resume', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/my-app')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'q' })
    session.appendEvent({ type: 'error', message: 'stream died', fatal: true })
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a', citations: null }] })
    session.appendEvent({ type: 'turn-done', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } })
    expect(store.resume(session.id)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'a', citations: null }] },
    ])
    // All four lines are still on disk — events are journaled, not dropped.
    expect(readFileSync(session.file, 'utf8').trim().split('\n')).toHaveLength(4)
  })

  it('resolves only the latest persisted human prompt and ignores tool-result user messages', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/source-ref')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'earlier prompt' })
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer', citations: null }] })
    session.appendMessage({ role: 'user', content: 'remember my preference' })
    session.appendMessage({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'stored', is_error: false }],
    })

    const source = latestUserMessageSourceRef(session.file, store.projectId, session.id)
    const messages = readSessionLineRecords(session.file).filter((record) => record.line.kind === 'message')
    expect(source).toMatchObject({
      kind: 'session-message',
      projectId: store.projectId,
      sessionId: session.id,
      recordId: messages[2]!.line.id,
    })
    expect(source?.timestamp).toBe(messages[2]!.line.ts)
  })

  it('does not assign a source link when a malformed line follows the latest prompt', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/bad-source-ref')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'remember this' })
    appendFileSync(session.file, '{malformed\n', 'utf8')
    expect(latestUserMessageSourceRef(session.file, store.projectId, session.id)).toBeNull()
  })

  it('does not reuse an older identical prompt when the current write has not persisted', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/repeated-prompt')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'remember this preference' })
    const turnStartLine = sessionLastLineNumber(session.file)
    expect(
      latestUserMessageSourceRef(session.file, store.projectId, session.id, {
        expectedContent: 'remember this preference',
        afterLineNumber: turnStartLine,
      }),
    ).toBeNull()

    session.appendMessage({ role: 'user', content: 'remember this preference' })
    const current = readSessionLineRecords(session.file).at(-1)!
    expect(
      latestUserMessageSourceRef(session.file, store.projectId, session.id, {
        expectedContent: 'remember this preference',
        afterLineNumber: turnStartLine,
      })?.recordId,
    ).toBe(current.line.id)
  })

  it('rewrite appends an immutable checkpoint and reconstructs from it', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'one' })
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'two', citations: null }] })
    session.appendMessage({ role: 'user', content: 'three' })
    const compacted: MessageParam[] = [
      { role: 'user', content: 'summary of prior conversation' },
      { role: 'user', content: 'three' },
    ]
    session.rewrite(compacted)
    expect(store.resume(session.id)).toEqual(compacted)
    const lines = readFileSync(session.file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(JSON.parse(lines[3]!).kind).toBe('checkpoint')
  })
})

describe('SessionStore', () => {
  it('list returns sessions newest first with id, timestamps, and first user text as title', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const older = store.create()
    older.appendMessage({ role: 'user', content: 'older prompt' })
    const newer = store.create()
    newer.appendMessage({ role: 'user', content: 'newer prompt' })
    // Force distinct, deterministic mtimes (win32-safe; no sleeping).
    const t = Date.now() / 1000
    utimesSync(older.file, t - 60, t - 60)
    utimesSync(newer.file, t, t)

    const infos = store.list()
    expect(infos).toHaveLength(2)
    expect(infos[0]!.id).toBe(newer.id)
    expect(infos[0]!.title).toBe('newer prompt')
    expect(infos[1]!.id).toBe(older.id)
    expect(infos[1]!.title).toBe('older prompt')
    expect(infos[0]!.updatedAt.getTime()).toBeGreaterThan(infos[1]!.updatedAt.getTime())
    expect(infos[0]!.startedAt).toBeInstanceOf(Date)
    expect(infos[0]!.file).toBe(newer.file)
  })

  it('list returns [] when the project has no sessions', () => {
    expect(new SessionStore(sessionsRoot, 'C:/never-used').list()).toEqual([])
  })

  it('resume reconstructs Message[] exactly', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const session = store.create()
    const history: MessageParam[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } }] as never,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] as never,
      },
    ]
    for (const m of history) session.appendMessage(m)
    expect(store.resume(session.id)).toEqual(history)
  })

  it('resume throws for an unknown session id', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    expect(() => store.resume('nope')).toThrow(/No session/)
  })

  it('continue picks the most recently written session', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const first = store.create()
    first.appendMessage({ role: 'user', content: 'first session' })
    const second = store.create()
    second.appendMessage({ role: 'user', content: 'second session' })
    const t = Date.now() / 1000
    utimesSync(first.file, t, t)
    utimesSync(second.file, t - 60, t - 60)

    const latest = store.continueLatest()
    expect(latest).not.toBeNull()
    expect(latest!.id).toBe(first.id)
    expect(latest!.messages).toEqual([{ role: 'user', content: 'first session' }])
  })

  it('continueLatest returns null when there are no sessions', () => {
    expect(new SessionStore(sessionsRoot, 'C:/empty').continueLatest()).toBeNull()
  })

  it('skips corrupt trailing line (crash mid-write) instead of throwing', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'intact' })
    appendFileSync(session.file, '{"kind":"message","ts":"2026-', 'utf8')
    expect(store.resume(session.id)).toEqual([{ role: 'user', content: 'intact' }])
  })

  it('non-message lines (e.g. hand-written event lines) are preserved on disk but excluded from resume()', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'q' })
    appendFileSync(
      session.file,
      JSON.stringify({ kind: 'event', ts: new Date().toISOString(), data: { type: 'assistant-text', delta: 'partial' } }) + '\n',
      'utf8',
    )
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a', citations: null }] })
    const lines = readFileSync(session.file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(store.resume(session.id)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'a', citations: null }] },
    ])
  })

  it('reconstructing a Session by id from list() keeps appending to the same file', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'before' })
    const info = store.list()[0]!
    const reopened = new Session(info.id, info.file)
    reopened.appendMessage({ role: 'user', content: 'after' })
    expect(store.resume(session.id)).toEqual([
      { role: 'user', content: 'before' },
      { role: 'user', content: 'after' },
    ])
  })

  it('redacts common secrets before durable persistence', () => {
    const store = new SessionStore(sessionsRoot, 'C:/projects/my-app')
    const session = store.create()
    session.appendMessage({
      role: 'user',
      content: 'use sk-ant-api03-supersecretvalue123 and Bearer abcdefghijklmnop',
    })
    session.appendEvent({ apiKey: 'plain-secret', nested: { password: 'hunter2' } })
    const disk = readFileSync(session.file, 'utf8')
    expect(disk).not.toContain('supersecretvalue123')
    expect(disk).not.toContain('abcdefghijklmnop')
    expect(disk).not.toContain('plain-secret')
    expect(disk).not.toContain('hunter2')
    expect(disk).toContain('[REDACTED]')
  })

  it('supports checkpoint rewind, fork, rename, search, and delete lifecycles', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'first state' })
    const checkpoint = session.checkpoint([{ role: 'user', content: 'first state' }], 'before change')
    session.appendMessage({ role: 'assistant', content: 'second state' })

    expect(store.checkpoints(session.id)).toEqual([
      expect.objectContaining({ id: checkpoint, label: 'before change', messageCount: 1 }),
    ])
    expect(store.rewind(session.id, checkpoint)).toEqual([{ role: 'user', content: 'first state' }])
    const fork = store.fork(session.id)
    expect(store.resume(fork.id)).toEqual([{ role: 'user', content: 'first state' }])
    const forkEvent = JSON.parse(readFileSync(fork.file, 'utf8').trim().split('\n').at(-1)!)
    const sourceRecords = readFileSync(session.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(forkEvent.data).toMatchObject({
      type: 'session-fork',
      sourceProjectId: projectSlug('C:/p'),
      sourceSessionId: session.id,
      sourceLineId: sourceRecords.at(-1).id,
    })

    store.rename(session.id, 'Important work')
    expect(store.list().find((item) => item.id === session.id)?.title).toBe('Important work')
    expect(store.search('important').map((item) => item.id)).toContain(session.id)
    store.delete(fork.id)
    expect(() => store.resume(fork.id)).toThrow(/No session/)
  })

  it('restores the most recent recoverable copy to its original session path', () => {
    const store = new SessionStore(sessionsRoot, 'C:/restore')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'recoverable conversation' })
    const originalFile = session.file
    expect(() => store.assertExists(session.id)).not.toThrow()
    expect(() => store.assertExists('missing-session')).toThrow(/No session/)
    store.delete(session.id)

    const restoredFile = store.restore(session.id)

    expect(restoredFile).toBe(originalFile)
    expect(store.resume(session.id)).toEqual([{ role: 'user', content: 'recoverable conversation' }])
  })

  it('is idempotent when the session source is already live', () => {
    const store = new SessionStore(sessionsRoot, 'C:/already-restored')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'already live' })
    expect(store.restore(session.id)).toBe(session.file)
  })

  it('anchors an explicit checkpoint fork at the checkpoint source line', () => {
    const store = new SessionStore(sessionsRoot, 'C:/p')
    const session = store.create()
    session.appendMessage({ role: 'user', content: 'before checkpoint' })
    const checkpoint = session.checkpoint([{ role: 'user', content: 'checkpoint state' }], 'stable point')
    session.appendMessage({ role: 'user', content: 'after checkpoint' })

    const fork = store.fork(session.id, checkpoint)
    const forkEvent = JSON.parse(readFileSync(fork.file, 'utf8').trim().split('\n').at(-1)!)
    const sourceLines = readFileSync(session.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(forkEvent.data).toMatchObject({
      sourceSessionId: session.id,
      sourceLineId: sourceLines.find((line) => line.kind === 'checkpoint' && line.data.checkpointId === checkpoint).id,
      checkpointId: checkpoint,
    })
  })

  it('uses a path hash so formerly colliding readable slugs remain distinct', () => {
    expect(projectSlug('/a-b/c')).not.toBe(projectSlug('/a/b-c'))
  })
})
