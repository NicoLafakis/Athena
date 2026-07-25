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

describe('Session immutable checkpoints + rewriteOrAppend', () => {
  it('rewrite appends a checkpoint and leaves no lock files behind', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.appendMessage(user('one'))
    session.appendMessage(user('two'))
    session.rewrite([user('compacted')])
    const lines = readFileSync(session.file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect((JSON.parse(lines[2]!) as { kind: string }).kind).toBe('checkpoint')
    expect(store.resume(session.id)).toEqual([user('compacted')])
    const dir = join(root, readdirSync(root)[0]!)
    expect(readdirSync(dir).filter((f) => !f.endsWith('.jsonl'))).toEqual([])
  })

  it('appends after a checkpoint in reconstructed order', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.rewrite([user('a'), user('b')])
    session.appendMessage(user('c'))
    expect(store.resume(session.id)).toEqual([user('a'), user('b'), user('c')])
  })

  it('rewriteOrAppend appends when exactly one message was added, else rewrites', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.rewriteOrAppend([user('a')]) // 0 -> 1: append
    session.rewriteOrAppend([user('a'), user('b')]) // 1 -> 2: append
    session.rewriteOrAppend([user('summary'), user('b')]) // same length: rewrite
    expect(store.resume(session.id)).toEqual([user('summary'), user('b')])
    expect(readFileSync(session.file, 'utf8').trim().split('\n')).toHaveLength(3)
  })
})
