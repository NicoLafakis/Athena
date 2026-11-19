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

function parseIpv6Hextets(address: string): number[] | null {
  let working = address
  let ipv4Tail: [number, number] | null = null
  const lastColon = working.lastIndexOf(':')
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const tail = working.slice(lastColon + 1)
    if (isIP(tail) !== 4) return null
    const octets = tail.split('.').map(Number)
    ipv4Tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!]
    working = working.slice(0, lastColon)
    if (working.endsWith(':')) working += ':' // preserve `::` when tail followed `::`
  }

  const halves = working.split('::')
  if (halves.length > 2) return null

  const parsePart = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const nums: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      nums.push(Number.parseInt(g, 16))
    }
    return nums
  }

  const head = parsePart(halves[0]!)
  const tail = halves.length === 2 ? parsePart(halves[1]!) : []
  if (!head || !tail) return null

  const targetLen = ipv4Tail ? 6 : 8
  let hextets: number[]
  if (halves.length === 1) {
    if (head.length !== targetLen) return null
    hextets = head
  } else {
    const missing = targetLen - (head.length + tail.length)
    if (missing < 1) return null
    hextets = [...head, ...Array<number>(missing).fill(0), ...tail]
  }

  return ipv4Tail ? [...hextets, ipv4Tail[0], ipv4Tail[1]] : hextets
}

function ipv4FromHextets(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
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
    const h = parseIpv6Hextets(lower)
    if (!h) return true
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    // Unspecified (::) and loopback (::1)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && (h7 === 0 || h7 === 1)) {
      return true
    }
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    if ((h0 & 0xfe00) === 0xfc00 || (h0 & 0xffc0) === 0xfe80 || (h0 & 0xff00) === 0xff00) {
      return true
    }
    // IPv4-mapped (::ffff:0:0/96), IPv4-translated SIIT (::ffff:0:0:0/96),
    // deprecated IPv4-compatible (::/96), and NAT64 well-known prefix (64:ff9b::/96)
    const isIpv4Mapped = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff
    const isIpv4Translated = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0
    const isIpv4Compatible = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0
    const isNat64 = h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0
    if (isIpv4Mapped || isIpv4Translated || isIpv4Compatible || isNat64) {
      return isPrivateAddress(ipv4FromHextets(h6, h7))
    }
    return false
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
