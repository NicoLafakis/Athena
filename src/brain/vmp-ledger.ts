import { createReadStream, existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { Attempt, LedgerStore } from '../../api-calculator/src/types.js'
import { validateAttempt } from '../../api-calculator/src/contract.js'
import type { BrainPaths } from './paths.js'

/**
 * File-based JSONL ledger for the VMP API calculator.
 *
 * - Append-only writes keep ingestion O(1) and safe to retry.
 * - Duplicate external_ids are dropped in memory during listSince; the file is
 *   never rewritten for a normal write, so a crash mid-append leaves at worst a
 *   partial final line that validateAttempt will reject on read.
 */
export class FileLedgerStore implements LedgerStore {
  constructor(private readonly ledgerFile: string) {}

  static forPaths(paths: BrainPaths): FileLedgerStore {
    return new FileLedgerStore(paths.vmpLedgerFile)
  }

  async insertIfAbsent(attempt: Attempt): Promise<'inserted' | 'duplicate'> {
    const seen = await this.loadExternalIds()
    if (seen.has(attempt.external_id)) return 'duplicate'
    await mkdir(dirname(this.ledgerFile), { recursive: true })
    await appendFile(this.ledgerFile, JSON.stringify(validateAttempt(attempt)) + '\n', 'utf8')
    return 'inserted'
  }

  async listSince(start: Date): Promise<Attempt[]> {
    const attempts = await this.loadAll()
    return attempts.filter((attempt) => new Date(attempt.started_at).getTime() >= start.getTime())
  }

  private async loadAll(): Promise<Attempt[]> {
    if (!existsSync(this.ledgerFile)) return []
    const seen = new Set<string>()
    const results: Attempt[] = []
    const stream = createReadStream(this.ledgerFile, { encoding: 'utf8' })
    const reader = createInterface({ input: stream })
    for await (const line of reader) {
      if (!line.trim()) continue
      try {
        const parsed = validateAttempt(JSON.parse(line))
        if (seen.has(parsed.external_id)) continue
        seen.add(parsed.external_id)
        results.push(parsed)
      } catch {
        // Corrupt/legacy lines are skipped; the business data we care about is
        // the provider usage, and a partial line cannot be trusted.
      }
    }
    return results
  }

  private async loadExternalIds(): Promise<Set<string>> {
    const ids = new Set<string>()
    if (!existsSync(this.ledgerFile)) return ids
    const stream = createReadStream(this.ledgerFile, { encoding: 'utf8' })
    const reader = createInterface({ input: stream })
    for await (const line of reader) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { external_id?: unknown }
        if (typeof parsed.external_id === 'string') ids.add(parsed.external_id)
      } catch {
        // ignore corrupt lines
      }
    }
    return ids
  }
}
