import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import {
  assertReadPrecondition,
  atomicWriteFile,
  recordKnownFile,
  revalidateToolPath,
  resolveToolPath,
} from './files.js'

const MAX_EDIT_BYTES = 10 * 1024 * 1024

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
    let abs: string
    try {
      abs = resolveToolPath(ctx, input.file_path, 'write')
    } catch (err) {
      return { output: (err as Error).message, isError: true }
    }
    if (!existsSync(abs)) return { output: `File not found: ${abs}`, isError: true }
    try {
      await assertReadPrecondition(abs, ctx)
    } catch (err) {
      return { output: `Refusing to edit ${abs}: ${(err as Error).message}`, isError: true }
    }
    if (input.old_string === input.new_string) {
      return { output: 'old_string and new_string are identical.', isError: true }
    }
    const info = await stat(abs)
    if (info.size > MAX_EDIT_BYTES) {
      return {
        output: `Refusing to edit ${abs}: file exceeds ${MAX_EDIT_BYTES} bytes`,
        isError: true,
      }
    }
    const text = await readFile(abs, 'utf8')
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
      : text.replace(input.old_string, () => input.new_string) // callback form: literal, no $-pattern expansion
    revalidateToolPath(ctx, abs, 'write')
    await atomicWriteFile(abs, next)
    await recordKnownFile(abs, ctx)
    return {
      output: `Replaced ${input.replace_all ? count : 1} occurrence(s) in ${abs}`,
      isError: false,
    }
  },
}
