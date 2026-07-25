import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import {
  assertReadPrecondition,
  atomicWriteFile,
  recordKnownFile,
  revalidateToolPath,
  resolveToolPath,
} from './files.js'

const WriteInput = z.object({ file_path: z.string(), content: z.string() })

export const writeTool: ToolDefinition<z.infer<typeof WriteInput>> = {
  name: 'Write',
  description:
    'Create or overwrite a file. Overwriting requires the file to have been Read this session.',
  schema: WriteInput,
  readOnly: false,
  async execute(input, ctx) {
    let abs: string
    try {
      abs = resolveToolPath(ctx, input.file_path, 'write')
      if (existsSync(abs)) await assertReadPrecondition(abs, ctx)
    } catch (err) {
      return { output: `Refusing to overwrite ${input.file_path}: ${(err as Error).message}`, isError: true }
    }
    await mkdir(dirname(abs), { recursive: true })
    revalidateToolPath(ctx, abs, 'write')
    await atomicWriteFile(abs, input.content)
    await recordKnownFile(abs, ctx)
    return { output: `Wrote ${input.content.length} chars to ${abs}`, isError: false }
  },
}
