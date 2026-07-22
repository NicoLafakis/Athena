import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const FetchInput = z.object({ url: z.string().url() })
const CAP = 50_000
const RAW_BODY_CAP = 2_000_000
const TIMEOUT_MS = 10_000

// Hosts where plain http is acceptable (local dev servers).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
// Obviously-internal literal hosts (cloud metadata endpoints) — never fetch.
const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

/** Read a response body, aborting the read once `capChars` decoded chars have
 *  accumulated, so a huge or endless stream cannot OOM the harness. */
export async function readBodyCapped(
  res: Response,
  capChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.length >= capChars) {
      await reader.cancel()
      return { text: text.slice(0, capChars), truncated: true }
    }
  }
  text += decoder.decode()
  return { text, truncated: false }
}

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
    const target = new URL(input.url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return {
        output: `Unsupported URL scheme "${target.protocol}" for ${input.url}: only http(s) is allowed`,
        isError: true,
      }
    }
    if (BLOCKED_HOSTS.has(target.hostname)) {
      return { output: `Refusing to fetch internal host ${target.hostname}`, isError: true }
    }
    // Upgrade plain http to https except for local dev hosts.
    if (target.protocol === 'http:' && !LOCAL_HOSTS.has(target.hostname)) {
      target.protocol = 'https:'
    }
    try {
      const res = await fetch(target.href, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'athena/0.1 (+terminal coding agent)' },
        redirect: 'follow',
      })
      if (!res.ok)
        return { output: `HTTP ${res.status} ${res.statusText} for ${target.href}`, isError: true }
      const { text: raw, truncated: rawTruncated } = await readBodyCapped(res, RAW_BODY_CAP)
      const contentType = res.headers.get('content-type') ?? ''
      const text = contentType.includes('html') ? htmlToText(raw) : raw
      let capped = text.length > CAP ? text.slice(0, CAP) + `\n(truncated at ${CAP} chars)` : text
      if (rawTruncated && text.length <= CAP)
        capped += `\n(response body truncated at ${RAW_BODY_CAP} chars)`
      return { output: capped, isError: false }
    } catch (err) {
      return {
        output: `Fetch failed for ${input.url}: ${(err as Error).message ?? String(err)}`,
        isError: true,
      }
    }
  },
}
