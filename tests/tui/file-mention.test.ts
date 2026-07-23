import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rankFileMatches,
  extractMentionBlocks,
  formatMentionBlock,
  readMentionFile,
  MAX_MENTION_FILE_BYTES,
} from '../../src/tui/fileMention.js'

describe('rankFileMatches', () => {
  const files = [
    'src/tui/components/InputBox.tsx',
    'src/tui/App.tsx',
    'src/tools/glob.ts',
    'src/tools/grep.ts',
    'README.md',
  ]

  it('empty query returns the first N files, alphabetically sorted', () => {
    const result = rankFileMatches('', files, 3)
    expect(result).toEqual(['README.md', 'src/tools/glob.ts', 'src/tools/grep.ts'])
  })

  it('fuzzy-matches a query against paths, ranking closer matches first', () => {
    const result = rankFileMatches('inputbox', files)
    expect(result[0]).toBe('src/tui/components/InputBox.tsx')
  })

  it('respects the limit', () => {
    const result = rankFileMatches('src', files, 2)
    expect(result).toHaveLength(2)
  })

  it('no match for a nonsense query returns an empty array', () => {
    const result = rankFileMatches('zzzznonexistentqqq', files)
    expect(result).toEqual([])
  })
})

describe('extractMentionBlocks', () => {
  it('includes a block only for paths still literally present in the text', () => {
    const mentioned = new Map([
      ['src/a.ts', { content: 'const a = 1', truncated: false }],
      ['src/b.ts', { content: 'const b = 2', truncated: false }],
    ])
    // Only @src/a.ts survived edits/history-recall into the final submitted text.
    const blocks = extractMentionBlocks('please review @src/a.ts', mentioned)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('@src/a.ts')
    expect(blocks[0]).toContain('const a = 1')
  })

  it('returns no blocks when no mentions survive in the text', () => {
    const mentioned = new Map([['src/a.ts', { content: 'x', truncated: false }]])
    expect(extractMentionBlocks('a message with no mentions left', mentioned)).toEqual([])
  })

  it('a mentioned path that is a literal prefix of another mentioned path in the same ' +
    'turn does not spuriously match inside the longer one (e.g. "@src/a.ts" vs ' +
    '"@src/a.ts.bak")', () => {
    const mentioned = new Map([
      ['src/a.ts', { content: 'short file', truncated: false }],
      ['src/a.ts.bak', { content: 'backup file', truncated: false }],
    ])
    // Only the longer path is actually still present in the submitted text.
    const blocks = extractMentionBlocks('please diff against @src/a.ts.bak', mentioned)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('backup file')
    expect(blocks[0]).not.toContain('short file')
  })

  it('still matches the shorter path on its own when the longer one is not mentioned', () => {
    const mentioned = new Map([
      ['src/a.ts', { content: 'short file', truncated: false }],
      ['src/a.ts.bak', { content: 'backup file', truncated: false }],
    ])
    const blocks = extractMentionBlocks('please review @src/a.ts', mentioned)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('short file')
  })

  it('mentioning both the shorter and longer path produces both blocks', () => {
    const mentioned = new Map([
      ['src/a.ts', { content: 'short file', truncated: false }],
      ['src/a.ts.bak', { content: 'backup file', truncated: false }],
    ])
    const blocks = extractMentionBlocks('compare @src/a.ts against @src/a.ts.bak', mentioned)
    expect(blocks).toHaveLength(2)
  })
})

describe('formatMentionBlock', () => {
  it('labels the block with the path and fences the content', () => {
    const block = formatMentionBlock('src/a.ts', 'hello', false)
    expect(block).toContain('@src/a.ts')
    expect(block).toContain('```\nhello\n```')
    expect(block).not.toContain('truncated')
  })

  it('notes truncation when the file was capped', () => {
    const block = formatMentionBlock('big.bin', 'partial', true)
    expect(block).toContain('truncated')
  })
})

describe('readMentionFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'athena-mention-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a small file in full, untruncated', () => {
    writeFileSync(join(dir, 'small.txt'), 'hello world', 'utf8')
    const result = readMentionFile(dir, 'small.txt')
    expect(result.content).toBe('hello world')
    expect(result.truncated).toBe(false)
  })

  it('caps files larger than MAX_MENTION_FILE_BYTES and flags truncation', () => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(MAX_MENTION_FILE_BYTES + 5_000), 'utf8')
    const result = readMentionFile(dir, 'big.txt')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBe(MAX_MENTION_FILE_BYTES)
  })

  it('reports a missing file without throwing', () => {
    const result = readMentionFile(dir, 'nope.txt')
    expect(result.content).toContain('not found')
    expect(result.truncated).toBe(false)
  })
})
