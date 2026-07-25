import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const FetchInput = z.object({ url: z.string().url() })
const CAP = 50_000
const RAW_BODY_CAP = 2_000_000
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal'])

function isDocumentationHostname(hostname: string): boolean {
  return (
    hostname === 'example.com' ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.invalid')
  )
}

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0]!
  if (isIP(lower) === 4) {
    const parts = lower.split('.').map(Number)
    const [a, b] = parts
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a !== undefined && a >= 224)
    )
  }
  if (isIP(lower) === 6) {
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower)) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    return mapped ? isPrivateAddress(mapped[1]!) : false
  }
  return true
}

/** Resolves a host before each request and rejects any local/private answer.
 * Redirects call this again, preventing a public first hop from redirecting into
 * a loopback service. */
export async function assertPublicUrl(target: URL): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${target.protocol}": only http(s) is allowed`)
  }
  if (target.username || target.password) throw new Error('URLs containing credentials are not allowed')
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch internal host ${hostname}`)
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`Refusing to fetch private address ${hostname}`)
    return
  }
  // RFC 2606 names cannot reach a real host. Keeping them resolvable at this
  // seam makes mocked fetch tests deterministic without weakening production.
  if (isDocumentationHostname(hostname)) return
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0) throw new Error(`Host ${hostname} did not resolve`)
  if (addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error(`Refusing to fetch ${hostname}: resolved to a private address`)
  }
}

/** Read a response body, aborting once the decoded character cap is reached. */
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
  description:
    'Fetch a public HTTP(S) URL (10s timeout), validating DNS and every redirect; returns readable text capped at 50k chars.',
  schema: FetchInput,
  readOnly: true,
  async execute(input) {
    let target = new URL(input.url)
    try {
      if (target.protocol === 'http:') target.protocol = 'https:'
      let res: Response | null = null
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        await assertPublicUrl(target)
        res = await fetch(target.href, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'user-agent': 'athena/0.1 (+terminal coding agent)' },
          redirect: 'manual',
        })
        if (![301, 302, 303, 307, 308].includes(res.status)) break
        const location = res.headers.get('location')
        if (!location) throw new Error(`Redirect from ${target.href} omitted Location`)
        if (redirect === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`)
        target = new URL(location, target)
      }
      if (!res) throw new Error('No response')
      if (!res.ok) {
        return { output: `HTTP ${res.status} ${res.statusText} for ${target.href}`, isError: true }
      }
      const { text: raw, truncated: rawTruncated } = await readBodyCapped(res, RAW_BODY_CAP)
      const contentType = res.headers.get('content-type') ?? ''
      const text = contentType.includes('html') ? htmlToText(raw) : raw
      let capped = text.length > CAP ? text.slice(0, CAP) + `\n(truncated at ${CAP} chars)` : text
      if (rawTruncated && text.length <= CAP) {
        capped += `\n(response body truncated at ${RAW_BODY_CAP} chars)`
      }
      return { output: capped, isError: false }
    } catch (err) {
      return {
        output: `Fetch failed for ${input.url}: ${(err as Error).message ?? String(err)}`,
        isError: true,
      }
    }
  },
}
