import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { z } from 'zod'
import type { ToolDefinition, ToolOutput } from '../engine/types.js'

const GrepInput = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().optional(),
})
const OUTPUT_CAP = 30_000

export const grepTool: ToolDefinition<z.infer<typeof GrepInput>> = {
  name: 'Grep',
  description: 'Content search via ripgrep. Full regex syntax. Returns file:line:text matches.',
  schema: GrepInput,
  readOnly: true,
  execute(input, ctx): Promise<ToolOutput> {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '500']
    if (input.case_insensitive) args.push('-i')
    if (input.glob) args.push('--glob', input.glob)
    args.push('--', input.pattern, resolve(ctx.cwd, input.path ?? '.'))
    return new Promise((resolvePromise) => {
      const child = spawn(rgPath, args, { signal: ctx.abortSignal })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString('utf8')
      })
      child.on('error', (e) =>
        resolvePromise({ output: `ripgrep failed to start: ${e.message}`, isError: true }),
      )
      child.on('close', (code) => {
        if (code === 1) return resolvePromise({ output: 'No matches found.', isError: false })
        if (code !== 0)
          return resolvePromise({ output: `ripgrep exited ${code}: ${err.trim()}`, isError: true })
        const capped =
          out.length > OUTPUT_CAP
            ? out.slice(0, OUTPUT_CAP) + `\n(truncated: output exceeded ${OUTPUT_CAP} chars)`
            : out
        resolvePromise({ output: capped.trimEnd(), isError: false })
      })
    })
  },
}
