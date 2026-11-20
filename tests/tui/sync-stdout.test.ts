import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createSyncStdout, SYNC_OUTPUT_END, SYNC_OUTPUT_START } from '../../src/tui/sync-stdout.js'

class FakeStream extends EventEmitter {
  chunks: string[] = []
  columns = 120
  rows = 30
  constructor(public isTTY: boolean) {
    super()
  }
  write = (chunk: string | Uint8Array): boolean => {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
}

describe('createSyncStdout (DEC Mode 2026 zero-flicker output)', () => {
  it('wraps TTY frame writes atomically in DEC Mode 2026 begin/end markers', () => {
    const raw = new FakeStream(true)
    const synced = createSyncStdout(raw as unknown as NodeJS.WriteStream)
    synced.write('hello frame')
    expect(raw.chunks).toEqual([`${SYNC_OUTPUT_START}hello frame${SYNC_OUTPUT_END}`])
    expect(synced.columns).toBe(120)
    expect(synced.rows).toBe(30)
  })

  it('passes non-TTY writes through without escape markers', () => {
    const raw = new FakeStream(false)
    const synced = createSyncStdout(raw as unknown as NodeJS.WriteStream)
    synced.write('plain output')
    expect(raw.chunks).toEqual(['plain output'])
  })

  it('does not double-wrap chunks that already contain DEC Mode 2026 markers', () => {
    const raw = new FakeStream(true)
    const synced = createSyncStdout(raw as unknown as NodeJS.WriteStream)
    const already = `${SYNC_OUTPUT_START}frame${SYNC_OUTPUT_END}`
    synced.write(already)
    expect(raw.chunks).toEqual([already])
  })
})
