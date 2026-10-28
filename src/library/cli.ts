import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { LibraryRuntime } from './runtime.js'

const InputSchema = z.object({ id: z.string().optional(), commit: z.string().optional(), path: z.string().optional(),
  supersedes: z.string().optional(), expectedRevision: z.string().optional(),
  keys: z.array(z.string().min(1).max(80)).max(32).optional(), shape: z.enum(['detail', 'summary']).optional(),
  detailPath: z.string().optional(), summaryPath: z.string().optional(), categories: z.array(z.string()).optional(),
  sourcePaths: z.array(z.string()).optional(), recovery: z.boolean().optional() }).strict()
export function libraryCommand(cwd: string, operation: string, raw: unknown = {}): unknown {
  const library = LibraryRuntime.open(resolve(cwd), true)
  if (!library) {
    if (operation === 'status') return { enabled: false }
    throw new Error('Project library is disabled; explicit project opt-in is required')
  }
  const input = InputSchema.parse(raw)
  switch (operation) {
    case 'status': case 'recheck': return library.status()
    case 'submit': return { id: library.submit({ detailPath: input.detailPath!, summaryPath: input.summaryPath!, categories: input.categories!, sourcePaths: input.sourcePaths, recovery: input.recovery }).id }
    case 'retrieve': return library.retrieve({ keys: input.keys ?? [], shape: input.shape })
    case 'review': return { id: library.review(input.id!, input.commit!, input.path!).id }
    case 'promote': { const result = library.promote(input.id!, input.commit!, input.supersedes); return { id: result.note.id, status: result.note.status, checks: result.checks } }
    case 'reverify': { const result = library.reverify(input.id!, input.commit!); return { id: result.note.id, status: result.note.status, checks: result.checks } }
    case 'release': return { id: library.release(input.id!).id }
    case 'reject': return { id: library.reject(input.id!).id }
    case 'rollback': library.rollback(input.id!, input.expectedRevision!); return { rolledBack: true }
    default: throw new Error('Unknown library operation')
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , operation = 'status', cwd = process.cwd(), inputPath] = process.argv
    if (inputPath && statSync(inputPath).size > 64_000) throw new Error('Input budget exceeded')
    const input = inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : {}
    console.log(JSON.stringify(libraryCommand(cwd, operation, input)))
  } catch {
    console.error('Library operation failed its configuration, source, review, check or storage policy. No completion is certified. Inspect project configuration and synthetic tests.')
    process.exitCode = 1
  }
}
