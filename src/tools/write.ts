import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const WriteInput = z.object({ file_path: z.string(), content: z.string() })

export const writeTool: ToolDefinition<z.infer<typeof WriteInput>> = {
  name: 'Write',
  description:
    'Create or overwrite a file. Overwriting requires the file to have been Read this session.',
  schema: WriteInput,
  readOnly: false,
  async execute(input, ctx) {
    const abs = resolve(ctx.cwd, input.file_path)
    if (existsSync(abs) && !ctx.fileReadRegistry.has(abs)) {
      return {
        output: `Refusing to overwrite ${abs}: file exists and has not been Read this session. Read it first.`,
        isError: true,
      }
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, input.content, 'utf8')
    ctx.fileReadRegistry.add(abs) // its current content is now known
    return { output: `Wrote ${input.content.length} chars to ${abs}`, isError: false }
  },
}
