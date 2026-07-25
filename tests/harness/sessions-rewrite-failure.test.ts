import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { SessionStore } from '../../src/harness/sessions.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-sess-lock-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const user = (text: string): MessageParam => ({ role: 'user', content: text })

describe('Session writer locking', () => {
  it('fails closed on a live competing lock without corrupting prior records', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.appendMessage(user('original'))
    writeFileSync(`${session.file}.lock`, 'held')
    expect(() => session.rewrite([user('replacement')])).toThrow(/locked by another writer/)
    expect(store.resume(session.id)).toEqual([user('original')])
    expect(readFileSync(session.file, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
