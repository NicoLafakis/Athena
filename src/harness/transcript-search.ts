import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { plainBounded } from '../interaction/format.js'
import { redactSessionValue } from './redaction.js'

export type TranscriptHitKind = 'user' | 'assistant' | 'thinking' | 'tool-call' | 'tool-result'

export interface TranscriptSearchHit {
  /** 1-based match index across all chronological matches. */
  index: number
  /** 0-based message index in the active session's message array. */
  messageIndex: number
  /** 0-based block index inside the message (0 for string messages). */
  blockIndex: number
  kind: TranscriptHitKind
  excerpt: string
}

export interface TranscriptSearchResult {
  query: string
  totalMatches: number
  page: number
  pageSize: number
  totalPages: number
  hits: TranscriptSearchHit[]
  error?: string
}

export interface TranscriptSearchOptions {
  page?: number
  pageSize?: number
  excerptChars?: number
}

function buildExcerpt(text: string, matchStart: number, matchLen: number, maxChars: number): string {
  const safe = plainBounded(String(redactSessionValue(text)), Math.max(maxChars * 4, 2_000))
  const lower = safe.toLowerCase()
  const needle = text.slice(matchStart, matchStart + matchLen).toLowerCase()
  const idx = lower.indexOf(needle)
  const pos = idx >= 0 ? idx : Math.min(matchStart, Math.max(0, safe.length - 1))
  const half = Math.max(16, Math.floor((maxChars - matchLen) / 2))
  const start = Math.max(0, pos - half)
  const end = Math.min(safe.length, pos + matchLen + half)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < safe.length ? '…' : ''
  return `${prefix}${safe.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

function extractSearchableBlocks(
  message: MessageParam,
): Array<{ blockIndex: number; kind: TranscriptHitKind; text: string }> {
  const defaultKind: TranscriptHitKind = message.role === 'user' ? 'user' : 'assistant'
  if (typeof message.content === 'string') {
    return message.content ? [{ blockIndex: 0, kind: defaultKind, text: message.content }] : []
  }
  const out: Array<{ blockIndex: number; kind: TranscriptHitKind; text: string }> = []
  for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
    const block = message.content[blockIndex] as unknown as Record<string, unknown>
    if (!block || typeof block !== 'object') continue
    const type = block['type']
    if (type === 'text' && typeof block['text'] === 'string') {
      out.push({ blockIndex, kind: defaultKind, text: block['text'] })
    } else if (type === 'thinking' && typeof block['thinking'] === 'string') {
      out.push({ blockIndex, kind: 'thinking', text: block['thinking'] })
    } else if (type === 'tool_use') {
      const name = typeof block['name'] === 'string' ? block['name'] : 'tool'
      const inputJson = JSON.stringify(block['input'] ?? {})
      out.push({ blockIndex, kind: 'tool-call', text: `${name} ${inputJson}` })
    } else if (type === 'tool_result') {
      const content = block['content']
      if (typeof content === 'string') {
        out.push({ blockIndex, kind: 'tool-result', text: content })
      } else if (Array.isArray(content)) {
        const joined = content
          .filter(
            (part): part is { type: 'text'; text: string } =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string',
          )
          .map((part) => part.text)
          .join('\n')
        if (joined) out.push({ blockIndex, kind: 'tool-result', text: joined })
      }
    }
  }
  return out
}

/**
 * Literal, case-insensitive local search over the active session's stored message blocks.
 * Zero provider calls, zero regex evaluation, zero mutation of session state.
 */
export function searchActiveTranscript(
  messages: readonly MessageParam[],
  rawQuery: string,
  options: TranscriptSearchOptions = {},
): TranscriptSearchResult {
  const query = rawQuery.trim()
  const pageSize = Math.max(1, Math.min(50, options.pageSize ?? 10))
  const excerptChars = Math.max(40, Math.min(400, options.excerptChars ?? 140))

  if (!query) {
    return {
      query: '',
      totalMatches: 0,
      page: 1,
      pageSize,
      totalPages: 0,
      hits: [],
      error: 'Enter a non-empty search query.',
    }
  }

  const needle = query.toLowerCase()
  const allHits: TranscriptSearchHit[] = []

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!
    for (const block of extractSearchableBlocks(message)) {
      const lower = block.text.toLowerCase()
      const pos = lower.indexOf(needle)
      if (pos === -1) continue
      allHits.push({
        index: allHits.length + 1,
        messageIndex,
        blockIndex: block.blockIndex,
        kind: block.kind,
        excerpt: buildExcerpt(block.text, pos, query.length, excerptChars),
      })
    }
  }

  const totalMatches = allHits.length
  const totalPages = totalMatches === 0 ? 0 : Math.ceil(totalMatches / pageSize)
  const page = totalPages === 0 ? 1 : Math.max(1, Math.min(totalPages, options.page ?? 1))
  const start = (page - 1) * pageSize
  const hits = allHits.slice(start, start + pageSize)

  return { query, totalMatches, page, pageSize, totalPages, hits }
}

export function formatTranscriptSearchResult(result: TranscriptSearchResult): string {
  if (result.error) return result.error
  if (result.totalMatches === 0) {
    return `No matches for "${result.query}" in the active session transcript.`
  }
  const first = result.hits[0]?.index ?? 0
  const last = result.hits[result.hits.length - 1]?.index ?? 0
  const header = `Showing ${first}-${last} of ${result.totalMatches} match(es) for "${result.query}" (page ${result.page}/${result.totalPages}):`
  const lines = result.hits.map(
    (hit) => `[#${hit.index} msg ${hit.messageIndex + 1} · ${hit.kind}] ${hit.excerpt}`,
  )
  const footer =
    result.page < result.totalPages
      ? `Next page: /search ${result.query} --page ${result.page + 1}`
      : null
  return [header, ...lines, ...(footer ? [footer] : [])].join('\n')
}
