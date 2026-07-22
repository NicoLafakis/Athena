import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const ReadInput = z.object({
  file_path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
})
const DEFAULT_LIMIT = 2000

export const readTool: ToolDefinition<z.infer<typeof ReadInput>> = {
  name: 'Read',
  description:
    'Read a file with cat -n style line numbers. Supports offset (1-based first line) and limit.',
  schema: ReadInput,
  readOnly: true,
  async execute(input, ctx) {
    const abs = resolve(ctx.cwd, input.file_path)
    if (!existsSync(abs)) return { output: `File not found: ${abs}`, isError: true }
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch (err) {
      return { output: `Cannot read ${abs}: ${(err as Error).message}`, isError: true }
    }
    const allLines = text.split('\n')
    if (allLines.at(-1) === '') allLines.pop() // trailing newline is not a line
    const offset = input.offset ?? 1
    const limit = input.limit ?? DEFAULT_LIMIT
    const slice = allLines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(6, ' ')}\t${line}`)
      .join('\n')
    ctx.fileReadRegistry.add(abs)
    const shown = slice.length
    const truncated = offset - 1 + shown < allLines.length
    const notice = truncated
      ? `\n(truncated: showing lines ${offset}-${offset + shown - 1} of ${allLines.length})`
      : ''
    return { output: numbered + notice, isError: false }
  },
}
