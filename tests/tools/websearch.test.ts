import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { websearchTool, parseDuckDuckGoHtml } from '../../src/tools/websearch.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-websearch-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('websearchTool', () => {
  it('parses DuckDuckGo result anchors into title/url/snippet triples', async () => {
    const html =
      '<div class="result"><a class="result__a" href="https://a.example/page">First Hit</a>' +
      '<a class="result__snippet" href="#">Snippet text here</a></div>'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    const res = await websearchTool.execute({ query: 'athena harness' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.output).toContain('First Hit')
    expect(res.output).toContain('https://a.example/page')
    expect(res.output).toContain('Snippet text here')
  })

  it('degrades gracefully when fetch throws (no crash, informative message)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const res = await websearchTool.execute({ query: 'x' }, makeCtx(dir))
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/search unavailable/i)
  })

  it('degrades gracefully on HTTP failure status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 503 })))
    const res = await websearchTool.execute({ query: 'x' }, makeCtx(dir))
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/search unavailable/i)
  })

  it('reports zero results without error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
    const res = await websearchTool.execute({ query: 'nothing here' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.output).toContain('No results')
  })

  it('respects max_results', async () => {
    const html = Array.from(
      { length: 5 },
      (_, i) =>
        `<div class="result"><a class="result__a" href="https://e.example/${i}">Hit ${i}</a>` +
        `<a class="result__snippet" href="#">Snip ${i}</a></div>`,
    ).join('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    const res = await websearchTool.execute({ query: 'q', max_results: 2 }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.output).toContain('Hit 0')
    expect(res.output).toContain('Hit 1')
    expect(res.output).not.toContain('Hit 2')
  })
})

describe('parseDuckDuckGoHtml', () => {
  it('decodes uddg-wrapped redirect URLs', () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpath&amp;rut=abc">Wrapped</a>'
    const hits = parseDuckDuckGoHtml(html, 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.url).toBe('https://real.example/path')
    expect(hits[0]!.title).toBe('Wrapped')
  })

  it('returns empty array for HTML with no results', () => {
    expect(parseDuckDuckGoHtml('<html><body>captcha</body></html>', 5)).toEqual([])
  })
})
