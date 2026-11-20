import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, sha256Text } from '../../src/harness/hash.js'
import { runGit } from '../../src/harness/git.js'
import { parseAndVerifyRunTraceText } from '../../src/harness/traces.js'
import { RESERVED_COMMAND_NAMES } from '../../src/brain/commands.js'
import { RESERVED_COMMAND_NAMES as LOADER_RESERVED } from '../../src/brain/loader.js'
import { parseSlash } from '../../src/tui/slash.js'

describe('shared harness primitives', () => {
  it('computes distinct canonical JSON digest vs raw sha256Text', () => {
    expect(sha256Text('hello')).toMatch(/^[a-f0-9]{64}$/)
    expect(digest('hello')).toBe(sha256Text(JSON.stringify('hello')))
    expect(digest({ a: 1 })).toBe(sha256Text('{"a":1}'))
  })

  it('runGit executes git commands cleanly and throws on non-zero exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'athena-rungit-'))
    try {
      runGit(dir, ['init'])
      writeFileSync(join(dir, 'a.txt'), 'hi\n')
      expect(runGit(dir, ['status', '--porcelain'])).toContain('a.txt')
      expect(() => runGit(dir, ['rev-parse', '--verify', 'HEAD'])).toThrow(/git rev-parse/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parseAndVerifyRunTraceText validates hash chains and enforces event bounds', () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const base1 = {
      schemaVersion: 1 as const,
      runId,
      parentRunId: null,
      sequence: 1,
      timestamp: '2026-11-19T00:00:00.000Z',
      type: 'run-start',
      payload: { cwd: '/tmp', provider: 'anthropic', model: 'sonnet' },
      previousHash: null,
    }
    const env1 = { ...base1, hash: digest(base1) }
    const text = JSON.stringify(env1) + '\n'
    expect(parseAndVerifyRunTraceText(text, { requireTrailingNewline: true })).toHaveLength(1)
    expect(() =>
      parseAndVerifyRunTraceText(JSON.stringify(env1), { requireTrailingNewline: true }),
    ).toThrow(/incomplete/i)
    expect(() => parseAndVerifyRunTraceText(text, { maxEvents: 0 })).toThrow(/bound/i)
    const tampered = JSON.stringify({ ...env1, type: 'tampered' }) + '\n'
    expect(() => parseAndVerifyRunTraceText(tampered)).toThrow(/integrity/i)
  })

  it('keeps RESERVED_COMMAND_NAMES as a single source of truth matching parseSlash', () => {
    expect(LOADER_RESERVED).toBe(RESERVED_COMMAND_NAMES)
    for (const name of RESERVED_COMMAND_NAMES) {
      const parsed = parseSlash(`/${name}`)
      expect(parsed).not.toBeNull()
      // Either parsed cleanly as a bare command or gave a usage error (never "Unknown command")
      if (parsed?.kind === 'error') {
        expect(parsed.value).not.toContain('Unknown command')
      }
    }
  })
})
