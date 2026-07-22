import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const EditInput = z.object({
  file_path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
})

export const editTool: ToolDefinition<z.infer<typeof EditInput>> = {
  name: 'Edit',
  description:
    'Exact string replacement. old_string must match exactly once unless replace_all is true.',
  schema: EditInput,
  readOnly: false,
  async execute(input, ctx) {
    const abs = resolve(ctx.cwd, input.file_path)
    if (!existsSync(abs)) return { output: `File not found: ${abs}`, isError: true }
    if (!ctx.fileReadRegistry.has(abs)) {
      return { output: `Refusing to edit ${abs}: not Read this session. Read it first.`, isError: true }
    }
    if (input.old_string === input.new_string) {
      return { output: 'old_string and new_string are identical.', isError: true }
    }
    const text = readFileSync(abs, 'utf8')
    const count = text.split(input.old_string).length - 1
    if (count === 0) {
      return {
        output: `old_string not found in ${abs}. Match must be exact, including whitespace.`,
        isError: true,
      }
    }
    if (count > 1 && !input.replace_all) {
      return {
        output: `old_string matches ${count} times in ${abs}. Provide a longer unique string or set replace_all: true.`,
        isError: true,
      }
    }
    const next = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string)
    writeFileSync(abs, next, 'utf8')
    return {
      output: `Replaced ${input.replace_all ? count : 1} occurrence(s) in ${abs}`,
      isError: false,
    }
  },
}
