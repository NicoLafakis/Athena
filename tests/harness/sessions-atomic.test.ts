import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { SessionStore } from '../../src/harness/sessions.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-sess-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const user = (text: string): MessageParam => ({ role: 'user', content: text })

describe('Session atomic rewrite + rewriteOrAppend', () => {
  it('rewrite replaces the file content and leaves no temp files behind', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.appendMessage(user('one'))
    session.appendMessage(user('two'))
    session.rewrite([user('compacted')])
    const lines = readFileSync(session.file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as { data: MessageParam }).data.content).toBe('compacted')
    const dir = join(root, readdirSync(root)[0]!)
    expect(readdirSync(dir).filter((f) => !f.endsWith('.jsonl'))).toEqual([])
  })

  it('appends after a rewrite land after the rewritten history (no interleaving corruption)', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.rewrite([user('a'), user('b')])
    session.appendMessage(user('c'))
    const contents = readFileSync(session.file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { data: MessageParam }).data.content)
    expect(contents).toEqual(['a', 'b', 'c'])
  })

  it('rewriteOrAppend appends when exactly one message was added, else rewrites', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.rewriteOrAppend([user('a')]) // 0 -> 1: append
    session.rewriteOrAppend([user('a'), user('b')]) // 1 -> 2: append
    session.rewriteOrAppend([user('summary'), user('b')]) // same length: rewrite
    const contents = readFileSync(session.file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { data: MessageParam }).data.content)
    expect(contents).toEqual(['summary', 'b'])
  })
})
