import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { LibraryRuntime, SubmissionSchema } from './runtime.js'

const EmptyInputSchema = z.object({}).strict()
const RetrieveInputSchema = z.object({
  keys: z.array(z.string().min(1).max(80)).max(32).default([]),
  shape: z.enum(['detail', 'summary']).optional(),
}).strict()
const IdInputSchema = z.object({ id: z.string().min(1) }).strict()
const ReviewInputSchema = z.object({
  id: z.string().min(1),
  commit: z.string().min(1),
  path: z.string().min(1),
}).strict()
const PromoteInputSchema = z.object({
  id: z.string().min(1),
  commit: z.string().min(1),
  supersedes: z.string().min(1).optional(),
}).strict()
const ReverifyInputSchema = z.object({
  id: z.string().min(1),
  commit: z.string().min(1),
}).strict()
const RollbackInputSchema = z.object({
  id: z.string().min(1),
  expectedRevision: z.string().min(1),
}).strict()

export function libraryCommand(cwd: string, operation: string, raw: unknown = {}): unknown {
  const library = LibraryRuntime.open(resolve(cwd), true)
  if (!library) {
    if (operation === 'status') return { enabled: false }
    throw new Error('Project library is disabled; explicit project opt-in is required')
  }
  switch (operation) {
    case 'status':
    case 'recheck': {
      EmptyInputSchema.parse(raw)
      return library.status()
    }
    case 'submit': {
      const input = SubmissionSchema.parse(raw)
      return { id: library.submit(input).id }
    }
    case 'retrieve': {
      const input = RetrieveInputSchema.parse(raw)
      return library.retrieve({ keys: input.keys, shape: input.shape })
    }
    case 'review': {
      const input = ReviewInputSchema.parse(raw)
      return { id: library.review(input.id, input.commit, input.path).id }
    }
    case 'promote': {
      const input = PromoteInputSchema.parse(raw)
      const result = library.promote(input.id, input.commit, input.supersedes)
      return { id: result.note.id, status: result.note.status, checks: result.checks }
    }
    case 'reverify': {
      const input = ReverifyInputSchema.parse(raw)
      const result = library.reverify(input.id, input.commit)
      return { id: result.note.id, status: result.note.status, checks: result.checks }
    }
    case 'release': {
      const input = IdInputSchema.parse(raw)
      return { id: library.release(input.id).id }
    }
    case 'reject': {
      const input = IdInputSchema.parse(raw)
      return { id: library.reject(input.id).id }
    }
    case 'rollback': {
      const input = RollbackInputSchema.parse(raw)
      library.rollback(input.id, input.expectedRevision)
      return { rolledBack: true }
    }
    default:
      throw new Error('Unknown library operation')
  }
}

function safeDiagnostic(error: unknown): string {
  if (error instanceof z.ZodError) {
    const fields = error.issues.map((issue) => issue.path.join('.') || '(root)').slice(0, 5)
    return `Input validation failed (${fields.join(', ')}).`
  }
  if (error instanceof SyntaxError) return 'Input JSON could not be parsed.'
  return 'Library operation failed its configuration, source, review, check or storage policy.'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , operation = 'status', cwd = process.cwd(), inputPath] = process.argv
    if (inputPath && statSync(inputPath).size > 64_000) throw new Error('Input budget exceeded')
    const input = inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : {}
    console.log(JSON.stringify(libraryCommand(cwd, operation, input)))
  } catch (error) {
    console.error(`${safeDiagnostic(error)} No completion is certified. Inspect project configuration and synthetic tests.`)
    process.exitCode = 1
  }
}
