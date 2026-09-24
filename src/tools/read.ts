import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import { recordKnownFile, resolveToolPath } from './files.js'

const ReadInput = z.object({
  file_path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
})
const DEFAULT_LIMIT = 2000
const MAX_SCAN_BYTES = 10_000_000
const MAX_LINE_CHARS = 20_000

export const readTool: ToolDefinition<z.infer<typeof ReadInput>> = {
  name: 'Read',
  description:
    'Read a file with cat -n style line numbers. Supports offset (1-based first line) and limit.',
  schema: ReadInput,
  readOnly: true,
  async execute(input, ctx) {
    let abs: string
    try {
      abs = resolveToolPath(ctx, input.file_path, 'read')
    } catch (err) {
      return { output: (err as Error).message, isError: true }
    }
    if (!existsSync(abs)) return { output: `File not found: ${abs}`, isError: true }
    const offset = input.offset ?? 1
    const limit = input.limit ?? DEFAULT_LIMIT
    const lines: string[] = []
    let lineNumber = 0
    let scannedBytes = 0
    let hasMore = false
    let scanTruncated = false
    let streamClosed: Promise<unknown> = Promise.resolve()
    try {
      const stream = createReadStream(abs, { encoding: 'utf8', signal: ctx.abortSignal })
      streamClosed = finished(stream, { cleanup: true }).then(
        () => undefined,
        (error: unknown) => error,
      )
      stream.on('data', (chunk: string | Buffer) => {
        scannedBytes += Buffer.byteLength(chunk)
      })
      const reader = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of reader) {
        lineNumber++
        if (scannedBytes > MAX_SCAN_BYTES) {
          scanTruncated = true
          hasMore = true
          reader.close()
          stream.destroy()
          break
        }
        if (lineNumber < offset) continue
        if (lines.length >= limit) {
          hasMore = true
          continue
        }
        lines.push(
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}…[line truncated]`
            : line,
        )
      }
      const streamError = await streamClosed
      if (!scanTruncated && streamError) throw streamError
    } catch (err) {
      await streamClosed
      return { output: `Cannot read ${abs}: ${(err as Error).message}`, isError: true }
    }
    const numbered = lines
      .map((line, i) => `${String(offset + i).padStart(6, ' ')}\t${line}`)
      .join('\n')
    await recordKnownFile(abs, ctx)
    const shown = lines.length
    const notice = hasMore
      ? `\n(truncated: showing lines ${offset}-${offset + shown - 1} of ${
          scanTruncated ? 'at least ' : ''
        }${lineNumber})`
      : ''
    return { output: numbered + notice, isError: false }
  },
}
