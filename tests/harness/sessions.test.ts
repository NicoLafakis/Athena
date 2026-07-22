import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { Session, SessionStore, projectSlug } from '../../src/harness/sessions.js'

let sessionsRoot: string
beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), 'athena-sessions-'))
})
afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true })
})

describe('projectSlug', () => {
  it('slugifies the project path deterministically', () => {
    expect(projectSlug('C:/projects/my-app')).toBe('C--projects-my-app')
  })

  it('normalizes backslashes the same as forward slashes', () => {
    expect(projectSlug('C:\\projects\\my-app')).toBe(projectSlug('C:/projects/my-app'))
  })
})

describe('Session', () => {
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
    const parsed = JSON.parse(lines[0]!) as { kind: string; ts: string; data: { type: string } }
    expect(parsed.kind).toBe('event')
    expect(parsed.data.type).toBe('turn-done')
    expect(new Date(parsed.ts).getTime()).not.toBeNaN()
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

  it('rewrite truncates and re-appends the full message array', () => {
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
    expect(lines).toHaveLength(2)
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
})
