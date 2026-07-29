import { mkdtempSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchObservationSchema } from './schemas.js'
import type { WatchBackendStatus, WatchObservation } from './types.js'

export type FilesystemWatchFactory = (
  path: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher

export interface FilesystemProbeOptions {
  timeoutMs?: number
  watchFactory?: FilesystemWatchFactory
  now?: () => string
}

export async function probeFilesystemWatch(
  options: FilesystemProbeOptions = {},
): Promise<WatchBackendStatus> {
  const backend = 'node-fs-watch' as const
  const probedAt = (options.now ?? (() => new Date().toISOString()))()
  const recoveryCommand = 'athena watch --status' as const
  const root = mkdtempSync(join(tmpdir(), 'athena-watch-probe-'))
  const sentinel = 'sentinel.txt'
  const sentinelPath = join(root, sentinel)
  writeFileSync(sentinelPath, 'before')
  let watcher: FSWatcher | null = null
  try {
    const available = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        watcher?.close()
        resolve(value)
      }
      const timeout = setTimeout(() => finish(false), Math.max(50, options.timeoutMs ?? 2_000))
      try {
        watcher = (options.watchFactory ?? watch)(root, (_eventType, filename) => {
          if (filename === null || filename.toString() === sentinel) finish(true)
        })
        watcher.on('error', () => finish(false))
        setTimeout(() => {
          try {
            writeFileSync(sentinelPath, 'after')
          } catch {
            finish(false)
          }
        }, 10)
      } catch {
        finish(false)
      }
    })
    return {
      backend,
      available,
      detail: available ? 'Sentinel change observed.' : 'Sentinel change was not observed.',
      recoveryCommand,
      probedAt,
    }
  } finally {
    ;(watcher as FSWatcher | null)?.close()
    rmSync(root, { recursive: true, force: true })
  }
}

export interface ForegroundFilesystemWatchOptions {
  watchId: string
  resourcePath: string
  signal: AbortSignal
  onObservation: (event: WatchObservation) => void
  onFailure?: (warning: string) => void
  watchFactory?: FilesystemWatchFactory
  now?: () => string
  minIntervalMs?: number
}

export interface ForegroundWatchHandle {
  close(): void
}

export function runForegroundFilesystemWatch(
  options: ForegroundFilesystemWatchOptions,
): ForegroundWatchHandle {
  let watcher: FSWatcher | null = null
  let closed = false
  let lastObservation = 0
  const close = () => {
    closed = true
    watcher?.close()
    watcher = null
  }
  if (options.signal.aborted) return { close }
  try {
    watcher = (options.watchFactory ?? watch)(options.resourcePath, () => {
      if (closed) return
      const nowMs = Date.now()
      if (nowMs - lastObservation < Math.max(0, options.minIntervalMs ?? 250)) return
      lastObservation = nowMs
      options.onObservation(WatchObservationSchema.parse({
        schemaVersion: 1,
        watchId: options.watchId,
        kind: 'changed',
        summary: 'Filesystem resource changed.',
        observedAt: (options.now ?? (() => new Date().toISOString()))(),
      }))
    })
    watcher.on('error', () => {
      close()
      options.onFailure?.(
        `Watch ${options.watchId} failed using node-fs-watch; run \`athena watch --status\` and restart the foreground watch.`,
      )
    })
    options.signal.addEventListener('abort', close, { once: true })
    return { close }
  } catch {
    close()
    options.onFailure?.(
      `Watch ${options.watchId} could not start using node-fs-watch; run \`athena watch --status\` and retry.`,
    )
    return { close }
  }
}
