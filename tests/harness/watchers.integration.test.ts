import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import {
  probeFilesystemWatch,
  runForegroundFilesystemWatch,
} from '../../src/harness/watchers/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('real filesystem watcher backend', () => {
  it('round-trips a sentinel instead of inferring availability', async () => {
    const result = await probeFilesystemWatch({ timeoutMs: 3_000 })
    expect(result.backend).toBe('node-fs-watch')
    expect(result.available, result.detail).toBe(true)
    expect(result.probedAt).toEqual(expect.any(String))
  }, 10_000)

  it('observes a known resource and stops through AbortSignal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-watch-live-'))
    roots.push(root)
    const target = join(root, 'watched.txt')
    writeFileSync(target, 'one')
    const controller = new AbortController()
    const observed = new Promise<string>((resolve) => {
      runForegroundFilesystemWatch({
        watchId: 'watch-1',
        resourcePath: target,
        signal: controller.signal,
        onObservation: (event) => resolve(event.watchId),
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    writeFileSync(target, 'two')
    await expect(Promise.race([
      observed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('watch event timed out')), 3_000)),
    ])).resolves.toBe('watch-1')
    controller.abort()
  }, 10_000)

  it('reports backend failure without throwing through the optional probe boundary', async () => {
    const result = await probeFilesystemWatch({
      timeoutMs: 100,
      watchFactory: () => { throw new Error('backend unavailable') },
    })
    expect(result).toMatchObject({
      available: false,
      backend: 'node-fs-watch',
      recoveryCommand: 'athena watch --status',
    })
    expect(result.detail).not.toContain('backend unavailable')
  })

  it('degrades a runner startup failure and suppresses queued events after abort', () => {
    const warnings: string[] = []
    expect(() => runForegroundFilesystemWatch({
      watchId: 'watch-failed',
      resourcePath: 'unavailable',
      signal: new AbortController().signal,
      onObservation: () => { throw new Error('must not observe') },
      onFailure: (warning) => warnings.push(warning),
      watchFactory: () => { throw new Error('backend unavailable') },
    })).not.toThrow()
    expect(warnings[0]).toContain('watch-failed')
    expect(warnings[0]).toContain('node-fs-watch')
    expect(warnings[0]).toContain('athena watch --status')

    let listener: (() => void) | undefined
    let closed = false
    const fake = new EventEmitter() as FSWatcher
    fake.close = () => { closed = true }
    const controller = new AbortController()
    const observations: unknown[] = []
    runForegroundFilesystemWatch({
      watchId: 'watch-race',
      resourcePath: 'fixture',
      signal: controller.signal,
      onObservation: (event) => observations.push(event),
      watchFactory: (_path, callback) => {
        listener = () => callback('change', 'fixture')
        return fake
      },
    })
    controller.abort()
    listener?.()
    expect(closed).toBe(true)
    expect(observations).toEqual([])
  })
})
