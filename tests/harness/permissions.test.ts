import { describe, it, expect } from 'vitest'
import { PermissionEngine, matchesRule, parseRule } from '../../src/harness/permissions.js'
import type { PermissionMode, PermissionRequest } from '../../src/engine/types.js'

function req(toolName: string, input: unknown, readOnly: boolean): PermissionRequest {
  return { toolName, input, readOnly, summary: `${toolName}` }
}

describe('parseRule / matchesRule', () => {
  const cases: Array<[rule: string, tool: string, input: unknown, expected: boolean]> = [
    ['Read(**)',        'Read',  { file_path: 'src/a.ts' }, true],
    ['Read(**)',        'Write', { file_path: 'src/a.ts' }, false],
    ['Edit(src/**)',    'Edit',  { file_path: 'src/deep/x.ts', old_string: 'a', new_string: 'b' }, true],
    ['Edit(src/**)',    'Edit',  { file_path: 'docs/x.md', old_string: 'a', new_string: 'b' }, false],
    ['Bash(git:*)',     'Bash',  { command: 'git status' }, true],
    ['Bash(git:*)',     'Bash',  { command: 'git commit -m x' }, true],
    ['Bash(git:*)',     'Bash',  { command: 'gitk' }, false],          // prefix is word-bounded
    ['Bash(git:*)',     'Bash',  { command: 'rm -rf /' }, false],
    ['Bash(pnpm test:*)', 'Bash', { command: 'pnpm test tests/x' }, true],
    ['Grep',            'Grep',  { pattern: 'x' }, true],              // bare tool rule matches any input
    ['Glob(*.ts)',      'Glob',  { pattern: 'a.ts' }, true],
    ['Glob(*.ts)',      'Glob',  { pattern: 'src/a.ts' }, false],      // * does not cross /
  ]
  it.each(cases)('%s vs %s %j -> %s', (rule, tool, input, expected) => {
    expect(matchesRule(parseRule(rule), tool, input)).toBe(expected)
  })
})

describe('PermissionEngine precedence and modes', () => {
  const table: Array<{
    name: string
    mode: PermissionMode
    allow?: string[]
    deny?: string[]
    request: PermissionRequest
    expected: 'allow' | 'deny' | 'ask'
  }> = [
    { name: 'readOnly always allowed in normal', mode: 'normal', request: req('Read', { file_path: 'x' }, true), expected: 'allow' },
    { name: 'mutating asks in normal', mode: 'normal', request: req('Write', { file_path: 'x', content: '' }, false), expected: 'ask' },
    { name: 'allow rule beats normal-mode ask', mode: 'normal', allow: ['Write(src/**)'], request: req('Write', { file_path: 'src/x.ts', content: '' }, false), expected: 'allow' },
    { name: 'deny beats allow', mode: 'trusted', allow: ['Bash(git:*)'], deny: ['Bash(git:*)'], request: req('Bash', { command: 'git push' }, false), expected: 'deny' },
    { name: 'deny beats trusted mode', mode: 'trusted', deny: ['Bash(rm:*)'], request: req('Bash', { command: 'rm -rf x' }, false), expected: 'deny' },
    { name: 'acceptEdits auto-approves Write/Edit', mode: 'acceptEdits', request: req('Edit', { file_path: 'x', old_string: 'a', new_string: 'b' }, false), expected: 'allow' },
    { name: 'acceptEdits still asks for shell', mode: 'acceptEdits', request: req('Bash', { command: 'echo hi' }, false), expected: 'ask' },
    { name: 'plan blocks mutating tools outright', mode: 'plan', request: req('Write', { file_path: 'x', content: '' }, false), expected: 'deny' },
    { name: 'plan allows readOnly', mode: 'plan', request: req('Grep', { pattern: 'x' }, true), expected: 'allow' },
    { name: 'trusted allows mutating without rules', mode: 'trusted', request: req('Bash', { command: 'echo hi' }, false), expected: 'allow' },
  ]
  it.each(table)('$name', ({ mode, allow = [], deny = [], request, expected }) => {
    const engine = new PermissionEngine({ mode, allow, deny })
    expect(engine.check(request).decision).toBe(expected)
  })

  it('grantSession adds a live allow rule', () => {
    const engine = new PermissionEngine({ mode: 'normal', allow: [], deny: [] })
    expect(engine.check(req('Bash', { command: 'git status' }, false)).decision).toBe('ask')
    engine.grantSession('Bash(git:*)')
    expect(engine.check(req('Bash', { command: 'git status' }, false)).decision).toBe('allow')
  })

  it('setMode switches behavior live', () => {
    const engine = new PermissionEngine({ mode: 'normal', allow: [], deny: [] })
    engine.setMode('plan')
    expect(engine.check(req('Write', { file_path: 'x', content: '' }, false)).decision).toBe('deny')
  })
})
