import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileLedgerStore } from '../../src/brain/vmp-ledger.js'

function makeAttempt(externalId: string, startedAt: string) {
  return {
    external_id: externalId,
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4',
    operation: 'chat',
    started_at: startedAt,
    outcome: 'ok' as const,
    meters: [{ name: 'input_uncached', value: 10, unit: 'token' as const }],
  }
}

describe('FileLedgerStore', () => {
  let dir: string
  let store: FileLedgerStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'athena-vmp-ledger-'))
    store = new FileLedgerStore(join(dir, 'ledger.jsonl'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts and lists attempts', async () => {
    const now = new Date().toISOString()
    await expect(store.insertIfAbsent(makeAttempt('a', now))).resolves.toBe('inserted')
    const list = await store.listSince(new Date(Date.now() - 86_400_000))
    expect(list).toHaveLength(1)
    expect(list[0]?.external_id).toBe('a')
  })

  it('deduplicates by external_id', async () => {
    const now = new Date().toISOString()
    await store.insertIfAbsent(makeAttempt('same', now))
    await expect(store.insertIfAbsent({ ...makeAttempt('same', now), operation: 'retry' })).resolves.toBe('duplicate')
    const list = await store.listSince(new Date(Date.now() - 86_400_000))
    expect(list).toHaveLength(1)
  })

  it('filters by start window', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const now = new Date().toISOString()
    await store.insertIfAbsent(makeAttempt('old', old))
    await store.insertIfAbsent(makeAttempt('new', now))
    const list = await store.listSince(new Date(Date.now() - 2 * 86_400_000))
    expect(list.map((a) => a.external_id)).toEqual(['new'])
  })

  it('survives corrupt lines and still returns valid attempts', async () => {
    const now = new Date().toISOString()
    await store.insertIfAbsent(makeAttempt('good', now))
    const ledger = new FileLedgerStore(store['ledgerFile'])
    // Write a corrupt line directly into the file.
    const { appendFile } = await import('node:fs/promises')
    await appendFile(store['ledgerFile'], 'this is not json\n', 'utf8')
    const list = await ledger.listSince(new Date(Date.now() - 86_400_000))
    expect(list.map((a) => a.external_id)).toEqual(['good'])
  })
})
