import { describe, expect, it } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import {
  formatTranscriptSearchResult,
  searchActiveTranscript,
} from '../../src/harness/transcript-search.js'

const sampleMessages: MessageParam[] = [
  { role: 'user', content: 'Please check src/brain/paths.ts for [regex] (literal) chars.' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Let me inspect the paths helper for regex handling.', signature: 'sig' },
      { type: 'text', text: 'I will read src/brain/paths.ts now.' },
      { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: 'src/brain/paths.ts' } },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu-1',
        content: 'export function resolveBrainPaths() { /* paths.ts body */ }',
      },
    ],
  },
  {
    role: 'assistant',
    content: 'Done! paths.ts resolves global and project brain directories.',
  },
]

describe('searchActiveTranscript', () => {
  it('performs literal case-insensitive search across user, assistant, thinking, tool-call, and tool-result blocks in chronological order', () => {
    const res = searchActiveTranscript(sampleMessages, 'PATHS.TS')
    expect(res.error).toBeUndefined()
    expect(res.totalMatches).toBe(5)
    expect(res.hits.map((h) => h.kind)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result',
      'assistant',
    ])
    expect(res.hits[0]!.messageIndex).toBe(0)
    expect(res.hits[3]!.excerpt).toContain('paths.ts')
  })

  it('searches stored thinking blocks without inventing redacted/missing thinking', () => {
    const res = searchActiveTranscript(sampleMessages, 'inspect the paths helper')
    expect(res.totalMatches).toBe(1)
    expect(res.hits[0]!.kind).toBe('thinking')
  })

  it('treats regex metacharacters literally and rejects empty/whitespace queries', () => {
    const literal = searchActiveTranscript(sampleMessages, '[regex] (literal)')
    expect(literal.totalMatches).toBe(1)
    expect(literal.hits[0]!.kind).toBe('user')

    const empty = searchActiveTranscript(sampleMessages, '   ')
    expect(empty.totalMatches).toBe(0)
    expect(empty.hits).toEqual([])
    expect(empty.error).toMatch(/non-empty/i)
  })

  it('paginates high match counts with bounded excerpts and clear continuation hint', () => {
    const many: MessageParam[] = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Entry ${i}: target-token appears in this line with surrounding context.`,
    }))

    const page1 = searchActiveTranscript(many, 'target-token', { page: 1, pageSize: 10 })
    expect(page1.totalMatches).toBe(25)
    expect(page1.totalPages).toBe(3)
    expect(page1.hits).toHaveLength(10)
    const formatted = formatTranscriptSearchResult(page1)
    expect(formatted).toContain('1-10 of 25')
    expect(formatted).toContain('--page 2')

    const page3 = searchActiveTranscript(many, 'target-token', { page: 3, pageSize: 10 })
    expect(page3.hits).toHaveLength(5)
    expect(page3.hits[0]!.index).toBe(21)
  })

  it('reports no matches cleanly without mutating messages', () => {
    const res = searchActiveTranscript(sampleMessages, 'nonexistent-needle-xyz')
    expect(res.totalMatches).toBe(0)
    expect(formatTranscriptSearchResult(res)).toMatch(/No matches/i)
  })
})
