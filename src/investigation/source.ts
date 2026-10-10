import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolContext } from '../engine/types.js'
import { resolveToolPath } from '../tools/files.js'
import { realPathForAccess } from '../harness/resource-policy.js'
import type { SourceRevision } from './types.js'

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sourcePath(ctx: ToolContext, path: string): { path: string; absolute: string } {
  const absolute = realPathForAccess(resolveToolPath(ctx, path, 'read'), ctx.cwd)
  const root = realPathForAccess(ctx.cwd, ctx.cwd)
  const local = relative(root, absolute)
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Source path is outside the investigation project')
  return { path: local.replaceAll('\\', '/'), absolute }
}

/** Finite source snapshot. No project scripts, hooks, or target code execute. */
export async function readSource(ctx: ToolContext, path: string): Promise<Buffer> {
  const file = sourcePath(ctx, path)
  const canonical = await realpath(file.absolute)
  const root = await realpath(ctx.cwd)
  const local = relative(root, canonical)
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Source symlink leaves the investigation project')
  const handle = await open(canonical, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Source is not a regular file')
    const buffer = Buffer.alloc(1_000_001)
    let size = 0
    while (size < buffer.length) {
      ctx.abortSignal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > 1_000_000) throw new Error('Source exceeds the 1 MB investigation limit')
    const bytes = buffer.subarray(0, size)
    if (bytes.includes(0)) throw new Error('Binary input requires a missing binary provider')
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new Error('Non-UTF-8 input requires a missing text/binary provider') }
    return bytes
  } finally {
    await handle.close()
  }
}

async function gitHead(cwd: string): Promise<string | null> {
  return new Promise(resolveHead => {
    execFile('git', ['--no-pager', 'rev-parse', 'HEAD'], {
      cwd, timeout: 2000, maxBuffer: 4096, windowsHide: true,
    }, (error, stdout) => {
      const value = stdout.trim()
      resolveHead(!error && /^[a-f0-9]{40,64}$/.test(value) ? value : null)
    })
  })
}

export async function captureRevision(ctx: ToolContext, paths: string[]): Promise<SourceRevision> {
  const files: SourceRevision['files'] = []
  for (const path of paths) {
    const file = sourcePath(ctx, path)
    try {
      const bytes = await readSource(ctx, file.path)
      files.push({ path: file.path, hash: createHash('sha256').update(bytes).digest('hex'), problem: null })
    } catch (error) {
      ctx.abortSignal.throwIfAborted()
      files.push({ path: file.path, hash: null, problem: (error as Error).message.slice(0, 2000) })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const head = await gitHead(resolve(ctx.cwd))
  return { id: digest({ gitHead: head, files }), gitHead: head, files }
}
