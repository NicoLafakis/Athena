import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webfetchTool, htmlToText } from '../../src/tools/webfetch.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-webfetch-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('webfetchTool', () => {
  it('strips HTML to readable text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<html><head><style>.x{}</style><script>bad()</script></head><body><h1>Title</h1><p>Hello &amp; world</p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          ),
      ),
    )
    const res = await webfetchTool.execute({ url: 'https://example.com' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.output).toContain('Title')
    expect(res.output).toContain('Hello & world')
    expect(res.output).not.toContain('bad()')
  })

  it('returns non-HTML content as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"a":1}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    const res = await webfetchTool.execute({ url: 'https://example.com/api' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.output).toBe('{"a":1}')
  })

  it('caps output at 50000 chars with a truncation notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('x'.repeat(80_000), {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    )
    const res = await webfetchTool.execute({ url: 'https://big.example' }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.output).toContain('truncated at 50000 chars')
    expect(res.output.length).toBeLessThan(50_100)
  })

  it('returns isError on HTTP failure status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })),
    )
    const res = await webfetchTool.execute({ url: 'https://missing.example' }, makeCtx(dir))
    expect(res.isError).toBe(true)
    expect(res.output).toContain('404')
  })

  it('returns isError on timeout/network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('timeout', 'TimeoutError')
      }),
    )
    const res = await webfetchTool.execute({ url: 'https://slow.example' }, makeCtx(dir))
    expect(res.isError).toBe(true)
  })

  it('rejects non-URL input via schema', () => {
    expect(webfetchTool.schema.safeParse({ url: 'not a url' }).success).toBe(false)
  })
})

describe('htmlToText', () => {
  it('decodes common entities and collapses whitespace', () => {
    expect(htmlToText('<p>a&nbsp;&lt;b&gt;   &quot;c&quot;&#39;</p>')).toBe('a <b> "c"\'')
  })

  it('turns block-level closers into newlines', () => {
    const text = htmlToText('<div>one</div><p>two</p><li>three</li>')
    expect(text).toContain('one')
    expect(text).toContain('two')
    expect(text).toContain('three')
    expect(text).toMatch(/one\s*\n/)
  })
})
