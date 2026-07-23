import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { glob } from 'tinyglobby'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const GlobInput = z.object({ pattern: z.string(), path: z.string().optional() })

/** Shared ignore convention for project-wide file walks — reused by the @-mention
 *  file walker (src/tui/fileMention.ts) so both tools agree on what "the project's files" means. */
export const DEFAULT_IGNORE_GLOBS = ['**/node_modules/**', '**/.git/**']

export const globTool: ToolDefinition<z.infer<typeof GlobInput>> = {
  name: 'Glob',
  description: 'Fast file pattern matching, e.g. "src/**/*.ts". Results sorted newest-modified first.',
  schema: GlobInput,
  readOnly: true,
  async execute(input, ctx) {
    const base = resolve(ctx.cwd, input.path ?? '.')
    const matches = await glob(input.pattern, {
      cwd: base,
      dot: true,
      absolute: true,
      ignore: DEFAULT_IGNORE_GLOBS,
    })
    if (matches.length === 0)
      return { output: `No files matched ${input.pattern} in ${base}`, isError: false }
    const sorted = matches
      .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f)
    return { output: sorted.join('\n'), isError: false }
  },
}
