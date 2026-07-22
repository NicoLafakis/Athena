import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import { htmlToText } from './webfetch.js'

const SearchInput = z.object({
  query: z.string().min(1),
  max_results: z.number().int().min(1).max(20).optional(),
})
const DEFAULT_MAX_RESULTS = 8

interface SearchHit {
  title: string
  url: string
  snippet: string
}

export function parseDuckDuckGoHtml(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = []
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const snippets = [...html.matchAll(snippetRe)].map((m) => htmlToText(m[1]!))
  let m: RegExpExecArray | null
  let i = 0
  while ((m = anchorRe.exec(html)) !== null && hits.length < max) {
    let url = m[1]!
    // DDG wraps targets as //duckduckgo.com/l/?uddg=<encoded>
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1]!)
    hits.push({ title: htmlToText(m[2]!), url, snippet: snippets[i] ?? '' })
    i += 1
  }
  return hits
}

export const websearchTool: ToolDefinition<z.infer<typeof SearchInput>> = {
  name: 'WebSearch',
  description: 'Web search (DuckDuckGo). Returns title, url, and snippet per result.',
  schema: SearchInput,
  readOnly: true,
  async execute(input) {
    try {
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`,
        {
          signal: AbortSignal.timeout(10_000),
          headers: { 'user-agent': 'athena/0.1 (+terminal coding agent)' },
        },
      )
      if (!res.ok) return { output: `Search unavailable: HTTP ${res.status}`, isError: true }
      const hits = parseDuckDuckGoHtml(await res.text(), input.max_results ?? DEFAULT_MAX_RESULTS)
      if (hits.length === 0) return { output: `No results for: ${input.query}`, isError: false }
      const out = hits.map((h, n) => `${n + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n')
      return { output: out, isError: false }
    } catch (err) {
      return {
        output: `Search unavailable: ${(err as Error).message ?? String(err)}`,
        isError: true,
      }
    }
  },
}
