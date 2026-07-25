import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition, ToolResultContent } from '../engine/types.js'
import { recordKnownFile, resolveToolPath } from './files.js'

const ImageInput = z.object({ file_path: z.string() })
const IMAGE_CAP_BYTES = 5 * 1024 * 1024

const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
} as const

export const readImageTool: ToolDefinition<z.infer<typeof ImageInput>> = {
  name: 'ReadImage',
  description:
    'Read a PNG, JPEG, GIF, or WebP (maximum 5 MiB) as provider-native image content so the model can inspect it.',
  schema: ImageInput,
  readOnly: true,
  async execute(input, ctx) {
    try {
      const file = resolveToolPath(ctx, input.file_path, 'read')
      const mediaType = MIME_BY_EXTENSION[
        extname(file).toLowerCase() as keyof typeof MIME_BY_EXTENSION
      ]
      if (!mediaType) throw new Error('supported image types are PNG, JPEG, GIF, and WebP')
      const info = await stat(file)
      if (!info.isFile()) throw new Error('path is not a file')
      if (info.size > IMAGE_CAP_BYTES) {
        throw new Error(`image exceeds the ${IMAGE_CAP_BYTES}-byte limit`)
      }
      const data = await readFile(file)
      await recordKnownFile(file, ctx)
      const content: ToolResultContent = [
        { type: 'text', text: `Image: ${file} (${info.size} bytes, ${mediaType})` },
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
        },
      ]
      return {
        output: `Loaded image ${file} (${info.size} bytes, ${mediaType})`,
        content,
        isError: false,
      }
    } catch (error) {
      return { output: `ReadImage failed: ${(error as Error).message}`, isError: true }
    }
  },
}
