import { describe, it, expect, vi } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { ContextManager } from '../../src/engine/context.js'

function makeMessages(n: number): MessageParam[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `m${i}`,
  }))
}

describe('ContextManager', () => {
  it('needsCompaction triggers at 80% of the model window', () => {
    const mgr = new ContextManager({ modelWindowTokens: 1000 })
    mgr.update({ inputTokens: 700, outputTokens: 99, cacheReadTokens: 0 })
    expect(mgr.needsCompaction()).toBe(false)
    mgr.update({ inputTokens: 700, outputTokens: 101, cacheReadTokens: 0 })
    expect(mgr.needsCompaction()).toBe(true) // 801 >= 800
  })

  it('reports zero usage before any update', () => {
    const mgr = new ContextManager({ modelWindowTokens: 1000 })
    expect(mgr.usedFraction()).toBe(0)
    expect(mgr.needsCompaction()).toBe(false)
  })

  it('counts cache-read tokens toward the window', () => {
    const mgr = new ContextManager({ modelWindowTokens: 1000 })
    mgr.update({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 700 })
    expect(mgr.needsCompaction()).toBe(true)
    expect(mgr.usedFraction()).toBe(0.9)
  })

  it('respects a custom compactionThreshold', () => {
    const mgr = new ContextManager({ modelWindowTokens: 1000, compactionThreshold: 0.5 })
    mgr.update({ inputTokens: 500, outputTokens: 0, cacheReadTokens: 0 })
    expect(mgr.needsCompaction()).toBe(true)
  })

  it('compact keeps the recent tail intact and replaces older messages with one summary message', async () => {
    const summarize = vi.fn(async () => 'SUMMARY: decided X; modified src/a.ts')
    const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 4 })
    const messages = makeMessages(10)
    const { messages: next, summary } = await mgr.compact(messages, summarize)
    expect(summary).toContain('decided X')
    expect(next).toHaveLength(5) // 1 summary + 4 tail
    expect(next[0]!.role).toBe('user')
    expect(String(next[0]!.content)).toContain('SUMMARY: decided X')
    expect(next.slice(1)).toEqual(messages.slice(6)) // tail untouched
  })

  it('the summarization prompt demands decisions and files-modified sections', async () => {
    const summarize = vi.fn(async (prompt: string) => {
      expect(prompt).toMatch(/Decisions made/i)
      expect(prompt).toMatch(/Files modified/i)
      return 'ok'
    })
    await new ContextManager({ modelWindowTokens: 1000 }).compact(makeMessages(10), summarize)
    expect(summarize).toHaveBeenCalledOnce()
  })

  it('compact is a no-op when messages fit within the tail', async () => {
    const summarize = vi.fn(async () => 'never')
    const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 6 })
    const messages = makeMessages(4)
    const { messages: next, summary } = await mgr.compact(messages, summarize)
    expect(next).toBe(messages)
    expect(summary).toBe('')
    expect(summarize).not.toHaveBeenCalled()
  })

  it('the summary prompt contains the older transcript, not the tail', async () => {
    let captured = ''
    const summarize = vi.fn(async (prompt: string) => {
      captured = prompt
      return 'ok'
    })
    const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 4 })
    await mgr.compact(makeMessages(10), summarize)
    expect(captured).toContain('[user] m0')
    expect(captured).toContain('[assistant] m5')
    expect(captured).not.toContain('m6')
  })

  it('advances the cut point when the tail would start with orphaned tool_result blocks', async () => {
    // m0 user, m1 assistant(tool_use tu_1), m2 user(tool_result tu_1), m3 assistant, m4 user, m5 assistant
    const messages: MessageParam[] = [
      { role: 'user', content: 'm0' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', id: 'tu_1', name: 'Echo', input: { value: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'echo: x' }],
      },
      { role: 'assistant', content: 'm3' },
      { role: 'user', content: 'm4' },
      { role: 'assistant', content: 'm5' },
    ]
    // keepRecent 4 puts the naive cut at m2 — a tool_result whose tool_use (m1) would be summarized away.
    const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 4 })
    const { messages: next } = await mgr.compact(messages, async () => 'S')
    const firstTail = next[1]!
    expect(JSON.stringify(firstTail.content)).not.toContain('tool_result')
    expect(next.slice(1)).toEqual(messages.slice(3)) // boundary walked forward past m2
  })

  it('truncates oversized tool blocks in the summary prompt', async () => {
    const huge = 'x'.repeat(10_000)
    const messages: MessageParam[] = [
      ...makeMessages(8),
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: huge }],
      },
      ...makeMessages(4),
    ]
    let captured = ''
    const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 4 })
    await mgr.compact(messages, async (prompt) => {
      captured = prompt
      return 'S'
    })
    expect(captured).not.toContain('x'.repeat(2100))
    expect(captured).toContain('[truncated]')
  })

  it('guards keepRecentMessages <= 0 by keeping at least one message', async () => {
    const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 0 })
    const messages = makeMessages(10)
    const { messages: next, summary } = await mgr.compact(messages, async () => 'S')
    expect(summary).toBe('S')
    expect(next).toHaveLength(2) // summary + one kept message (clamped to 1, not "keep everything")
    expect(next.at(-1)).toEqual(messages.at(-1))
  })

  it('compact resets usage so needsCompaction is false until the next update', async () => {
    const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 4 })
    mgr.update({ inputTokens: 900, outputTokens: 0, cacheReadTokens: 0 })
    expect(mgr.needsCompaction()).toBe(true)
    await mgr.compact(makeMessages(10), async () => 'ok')
    expect(mgr.needsCompaction()).toBe(false)
  })
})
