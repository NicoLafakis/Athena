import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import {
  assertReadPrecondition,
  atomicWriteFile,
  recordKnownFile,
  revalidateToolPath,
  resolveToolPath,
} from './files.js'

const NotebookInput = z
  .object({
    file_path: z.string(),
    cell_index: z.number().int().nonnegative().optional(),
    cell_id: z.string().optional(),
    new_source: z.string(),
    cell_type: z.enum(['code', 'markdown', 'raw']).optional(),
  })
  .refine((value) => value.cell_index !== undefined || value.cell_id !== undefined, {
    message: 'cell_index or cell_id is required',
  })

interface NotebookCell {
  id?: string
  cell_type?: string
  source?: string | string[]
  [key: string]: unknown
}

interface Notebook {
  cells?: NotebookCell[]
  [key: string]: unknown
}

const NOTEBOOK_CAP = 20 * 1024 * 1024

export const notebookEditTool: ToolDefinition<z.infer<typeof NotebookInput>> = {
  name: 'NotebookEdit',
  description:
    'Atomically replace one Jupyter notebook cell by index or id. The notebook must be Read first and is capped at 20 MiB.',
  schema: NotebookInput,
  readOnly: false,
  async execute(input, ctx) {
    try {
      const file = resolveToolPath(ctx, input.file_path, 'write')
      if (!file.toLowerCase().endsWith('.ipynb')) throw new Error('file must end in .ipynb')
      await assertReadPrecondition(file, ctx)
      const source = await readFile(file, 'utf8')
      if (source.length > NOTEBOOK_CAP) throw new Error(`notebook exceeds ${NOTEBOOK_CAP} characters`)
      const notebook = JSON.parse(source) as Notebook
      if (!Array.isArray(notebook.cells)) throw new Error('notebook has no cells array')
      const index =
        input.cell_index ??
        notebook.cells.findIndex((cell) => cell.id === input.cell_id)
      if (index < 0 || index >= notebook.cells.length) throw new Error('target cell was not found')
      const cell = notebook.cells[index]!
      const newline = input.new_source.includes('\r\n') ? '\r\n' : '\n'
      const lines = input.new_source.split(/\r?\n/)
      cell.source = lines.map((line, lineIndex) =>
        lineIndex < lines.length - 1 ? `${line}${newline}` : line,
      )
      if (input.cell_type) cell.cell_type = input.cell_type
      revalidateToolPath(ctx, file, 'write')
      await atomicWriteFile(file, JSON.stringify(notebook, null, 1) + '\n')
      await recordKnownFile(file, ctx)
      return { output: `Updated notebook cell ${index} in ${file}`, isError: false }
    } catch (error) {
      return { output: `NotebookEdit failed: ${(error as Error).message}`, isError: true }
    }
  },
}
