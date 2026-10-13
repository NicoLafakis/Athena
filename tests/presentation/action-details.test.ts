import { describe, expect, it } from 'vitest'
import { actionDetails, safeDetailText } from '../../src/presentation/action-details.js'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('safe action details', () => {
  it('shows the resolved file target and every additional effective target', () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-action-details-'))
    try {
      mkdirSync(join(root, 'actual'))
      symlinkSync(join(root, 'actual'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
      const target = join(realpathSync(root), 'actual', 'new.txt')
      const details = actionDetails({ toolName: 'Write', reason: 'test', cwd: root,
        input: { file_path: 'alias/new.txt', content: 'safe' }, targets: [target, join(root, 'MEMORY.md')] })
      expect(details).toContain(`Target: ${target}`)
      expect(details).toContain(`Additional target: ${join(root, 'MEMORY.md')}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each([
    '{"password":"fixture password with spaces","mode":"distinguishing"}',
    '{"access_token": "fixture-token", "mode": "distinguishing"}',
    "password='fixture password with spaces' mode=distinguishing",
    JSON.stringify({ content: '{"password":"fixture password with spaces","mode":"distinguishing"}' }),
    'OPENAI_API_KEY=fixture-secret mode=distinguishing',
    'DATABASE_PASSWORD=fixture-secret mode=distinguishing',
    'Authorization: Bearer fixture mode=distinguishing',
  ])('redacts textual secrets while preserving nonsecret context: %s', (text) => {
    const safe = safeDetailText(text)
    expect(safe).not.toContain('fixture')
    expect(safe).not.toContain('with spaces')
    expect(safe).toContain('[REDACTED]')
    expect(safe).toContain('distinguishing')
    expect(safeDetailText(safe)).toBe(safe)
  })

  it('redacts credentials in both effective arguments and available diff', () => {
    const details = actionDetails({ toolName: 'Edit', reason: 'test', input: {
      file_path: 'fixture.json', old_string: '{"password":"old-fixture"}',
      new_string: '{"password":"new-fixture","mode":"distinguishing"}',
    } })
    expect(details).not.toContain('old-fixture')
    expect(details).not.toContain('new-fixture')
    expect(details).toContain('[REDACTED]')
    expect(details).toContain('distinguishing')
  })
})
