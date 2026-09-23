import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ToolContext } from '../engine/types.js'

export function resolveToolPath(
  ctx: ToolContext,
  path: string,
  access: 'read' | 'write',
): string {
  return ctx.resolvePath?.(path, access) ?? resolve(ctx.cwd, path)
}

/** Re-resolve a previously authorized target immediately before mutation.
 * This catches a parent path that became a symlink while content was being
 * prepared. The final syscall still relies on the active OS sandbox for a
 * complete race-free boundary. */
export function revalidateToolPath(
  ctx: ToolContext,
  expected: string,
  access: 'read' | 'write',
): void {
  const actual = resolveToolPath(ctx, expected, access)
  if (actual !== expected) {
    throw new Error(`path changed after authorization: expected ${expected}, resolved ${actual}`)
  }
}

export async function fileSha256(file: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** Same-directory temp + rename gives atomic replacement on supported local
 * filesystems. The optional validator reads the closed temp file before replacement,
 * so invalid durable state cannot displace the previous file. The unique temp name
 * prevents concurrent writers from sharing a scratch path; cleanup is best effort. */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.athena-${process.pid}-${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

export function atomicWriteFileSync(
  file: string,
  content: string,
  validateBeforeReplace?: (replacement: string) => void,
): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.athena-${process.pid}-${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temp, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    closeSync(descriptor)
    descriptor = null
    validateBeforeReplace?.(readFileSync(temp, 'utf8'))
    renameSync(temp, file)
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Best effort.
      }
    }
    rmSync(temp, { force: true })
    throw error
  }
}

export async function assertReadPrecondition(file: string, ctx: ToolContext): Promise<void> {
  if (!ctx.fileReadRegistry.has(file)) {
    throw new Error(`not Read this session. Read it first.`)
  }
  const expected = ctx.fileReadHashes?.get(file)
  if (expected !== undefined) {
    const actual = await fileSha256(file)
    if (actual !== expected) {
      throw new Error(`changed on disk since it was Read; read it again before editing.`)
    }
  }
}

export async function recordKnownFile(file: string, ctx: ToolContext): Promise<void> {
  ctx.fileReadRegistry.add(file)
  if (ctx.fileReadHashes) ctx.fileReadHashes.set(file, await fileSha256(file))
}
