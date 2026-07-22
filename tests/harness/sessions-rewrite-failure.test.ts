import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { SessionStore } from '../../src/harness/sessions.js'

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>()
  return { ...mod, renameSync: vi.fn(mod.renameSync) }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-sess-fail-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.mocked(renameSync).mockRestore()
})

const user = (text: string): MessageParam => ({ role: 'user', content: text })

describe('Session.rewrite failure cleanup', () => {
  it('removes the temp file and rethrows when the rename fails', () => {
    const store = new SessionStore(root, 'C:/proj')
    const session = store.create()
    session.appendMessage(user('original'))
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('EPERM: rename blocked')
    })
    expect(() => session.rewrite([user('replacement')])).toThrow('EPERM')
    const dir = join(root, readdirSync(root)[0]!)
    // No orphaned temp file, and the original content is untouched.
    expect(readdirSync(dir).filter((f) => !f.endsWith('.jsonl'))).toEqual([])
    const contents = readFileSync(session.file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { data: MessageParam }).data.content)
    expect(contents).toEqual(['original'])
  })
})
