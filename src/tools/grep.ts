import { spawn } from 'node:child_process'
import { rgPath } from '@vscode/ripgrep'
import { z } from 'zod'
import type { ToolDefinition, ToolOutput } from '../engine/types.js'
import { resolveToolPath } from './files.js'

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
    let base: string
    try {
      base = resolveToolPath(ctx, input.path ?? '.', 'read')
    } catch (err) {
      return Promise.resolve({ output: (err as Error).message, isError: true })
    }
    args.push('--', input.pattern, base)
    return new Promise((resolvePromise) => {
      const child = spawn(rgPath, args, { signal: ctx.abortSignal })
      let out = ''
      let err = ''
      let truncated = false
      child.stdout.on('data', (d: Buffer) => {
        const chunk = d.toString('utf8')
        if (out.length >= OUTPUT_CAP) {
          truncated = true
          return
        }
        const remaining = OUTPUT_CAP - out.length
        out += chunk.slice(0, remaining)
        if (chunk.length > remaining) truncated = true
      })
      child.stderr.on('data', (d: Buffer) => {
        if (err.length >= OUTPUT_CAP) return
        err += d.toString('utf8').slice(0, OUTPUT_CAP - err.length)
      })
      child.on('error', (e) =>
        resolvePromise({ output: `ripgrep failed to start: ${e.message}`, isError: true }),
      )
      child.on('close', (code) => {
        if (code === 1) return resolvePromise({ output: 'No matches found.', isError: false })
        if (code !== 0)
          return resolvePromise({ output: `ripgrep exited ${code}: ${err.trim()}`, isError: true })
        const capped = truncated
          ? out + `\n(truncated: output exceeded ${OUTPUT_CAP} chars)`
          : out
        resolvePromise({ output: capped.trimEnd(), isError: false })
      })
    })
  },
}
