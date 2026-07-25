import { opendir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import { resolveToolPath } from './files.js'

const GlobInput = z.object({ pattern: z.string(), path: z.string().optional() })
const RESULT_CAP = 10_000

export const DEFAULT_IGNORE_GLOBS = ['**/node_modules/**', '**/.git/**']
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git'])

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '')
  let expression = '^'
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!
    const next = normalized[index + 1]
    if (char === '*' && next === '*') {
      index++
      if (normalized[index + 1] === '/') {
        index++
        expression += '(?:.*/)?'
      } else {
        expression += '.*'
      }
    } else if (char === '*') {
      expression += '[^/]*'
    } else if (char === '?') {
      expression += '[^/]'
    } else if (char === '{') {
      const end = normalized.indexOf('}', index + 1)
      if (end !== -1) {
        const choices = normalized
          .slice(index + 1, end)
          .split(',')
          .map((choice) => choice.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&'))
        expression += `(?:${choices.join('|')})`
        index = end
      } else {
        expression += '\\{'
      }
    } else {
      expression += char.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`)
}

async function collectMatches(
  root: string,
  pattern: RegExp,
  signal: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let truncated = false
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= RESULT_CAP || signal.aborted) {
      truncated = files.length >= RESULT_CAP
      return
    }
    const handle = await opendir(directory)
    try {
      for await (const entry of handle) {
        if (files.length >= RESULT_CAP || signal.aborted) {
          truncated = files.length >= RESULT_CAP
          break
        }
        if (entry.isSymbolicLink()) continue
        const full = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(full)
        } else if (entry.isFile()) {
          const path = relative(root, full).replaceAll('\\', '/')
          if (pattern.test(path)) files.push(full)
        }
      }
    } finally {
      // for-await closes the handle itself; close only if traversal exited early.
      await handle.close().catch(() => {})
    }
  }
  await visit(root)
  if (signal.aborted) throw new Error('Glob aborted')
  return { files, truncated }
}

export const globTool: ToolDefinition<z.infer<typeof GlobInput>> = {
  name: 'Glob',
  description:
    'Stream file pattern matching with a 10,000-result producer cap. Results are newest-modified first.',
  schema: GlobInput,
  readOnly: true,
  async execute(input, ctx) {
    let base: string
    try {
      base = resolveToolPath(ctx, input.path ?? '.', 'read')
      const matches = await collectMatches(base, globRegex(input.pattern), ctx.abortSignal)
      if (matches.files.length === 0) {
        return { output: `No files matched ${input.pattern} in ${base}`, isError: false }
      }
      const withStats = await Promise.all(
        matches.files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })),
      )
      const output = withStats
        .sort((a, b) => b.mtime - a.mtime)
        .map((item) => item.file)
        .join('\n')
      return {
        output:
          output +
          (matches.truncated ? `\n(truncated: Glob stopped at ${RESULT_CAP} results)` : ''),
        isError: false,
      }
    } catch (error) {
      return { output: `Glob failed: ${(error as Error).message}`, isError: true }
    }
  },
}
