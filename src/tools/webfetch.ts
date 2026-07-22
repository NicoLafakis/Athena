import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const FetchInput = z.object({ url: z.string().url() })
const CAP = 50_000
const TIMEOUT_MS = 10_000

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim()
}

export const webfetchTool: ToolDefinition<z.infer<typeof FetchInput>> = {
  name: 'WebFetch',
  description: 'Fetch a URL (10s timeout) and return its readable text content, capped at 50k chars.',
  schema: FetchInput,
  readOnly: true,
  async execute(input) {
    try {
      const res = await fetch(input.url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'athena/0.1 (+terminal coding agent)' },
        redirect: 'follow',
      })
      if (!res.ok)
        return { output: `HTTP ${res.status} ${res.statusText} for ${input.url}`, isError: true }
      const raw = await res.text()
      const contentType = res.headers.get('content-type') ?? ''
      const text = contentType.includes('html') ? htmlToText(raw) : raw
      const capped = text.length > CAP ? text.slice(0, CAP) + `\n(truncated at ${CAP} chars)` : text
      return { output: capped, isError: false }
    } catch (err) {
      return {
        output: `Fetch failed for ${input.url}: ${(err as Error).message ?? String(err)}`,
        isError: true,
      }
    }
  },
}
