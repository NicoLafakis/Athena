import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'
import {
  PermissionEngine,
  matchesRule,
  parseRule,
  globToRegExp,
  normalizePathTarget,
  resolveTrustBootstrap,
} from '../../src/harness/permissions.js'
import { ProtectedPaths } from '../../src/harness/protected-paths.js'
import { ruleFor } from '../../src/engine/loop.js'
import type { PermissionMode, PermissionRequest } from '../../src/engine/types.js'

/** Platform-portable absolute path with forward slashes (C:/x on win32, /x on POSIX). */
function abs(p: string): string {
  return resolve(p).replaceAll('\\', '/')
}

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

describe('path normalization hardening', () => {
  const cases: Array<[rule: string, tool: string, input: unknown, expected: boolean]> = [
    // Traversal segments must not bypass deny-style rules.
    ['Edit(secret/**)',    'Edit', { file_path: 'a/../secret/x' }, true],
    ['Edit(**/secret/**)', 'Edit', { file_path: 'a/../secret/x' }, true],
    ['Edit(secret/**)',    'Edit', { file_path: './secret/x' }, true],
    // Backslash variants normalize to forward slashes.
    ['Edit(secret/**)',    'Edit', { file_path: 'secret\\x' }, true],
    ['Edit(**/secret/**)', 'Edit', { file_path: 'a\\..\\secret\\x' }, true],
    // **/ matches zero or more leading segments.
    ['Edit(**/secret/**)', 'Edit', { file_path: 'deep/nest/secret/x' }, true],
    ['Edit(**/secret/**)', 'Edit', { file_path: 'secret/x' }, true],
    // Non-matching paths still fall through.
    ['Edit(secret/**)',    'Edit', { file_path: 'a/../other/x' }, false],
    // Ordinary globs keep working on already-clean paths.
    ['Edit(src/**)',       'Edit', { file_path: 'src/deep/x.ts' }, true],
    ['Edit(src/**)',       'Edit', { file_path: 'docs/x.md' }, false],
  ]
  it.each(cases)('%s vs %s %j -> %s', (rule, tool, input, expected) => {
    expect(matchesRule(parseRule(rule), tool, input)).toBe(expected)
  })

  it.runIf(process.platform === 'win32')('matches file paths case-insensitively on win32', () => {
    expect(matchesRule(parseRule('Edit(secret/**)'), 'Edit', { file_path: 'SECRET\\X.TS' })).toBe(true)
    expect(matchesRule(parseRule('Edit(secret/**)'), 'Edit', { file_path: 'Secret/x' })).toBe(true)
  })

  it('globToRegExp supports an explicit case-insensitive flag', () => {
    expect(globToRegExp('**/secret/**', true).test('SECRET/x')).toBe(true)
    expect(globToRegExp('**/secret/**').test('SECRET/x')).toBe(false)
  })

  it('normalizePathTarget resolves dot segments and backslashes', () => {
    expect(normalizePathTarget('a\\..\\secret\\x')).toBe('secret/x')
    expect(normalizePathTarget('./a/./b')).toBe('a/b')
    expect(normalizePathTarget('a/../../x')).toBe('../x')
  })

  it('Bash command prefix matching is untouched by path normalization', () => {
    expect(matchesRule(parseRule('Bash(git:*)'), 'Bash', { command: 'git diff ../x' })).toBe(true)
    expect(matchesRule(parseRule('Bash(git:*)'), 'Bash', { command: 'GIT status' })).toBe(false)
    expect(matchesRule(parseRule('Bash(cat secret/x)'), 'Bash', { command: 'cat a/../secret/x' })).toBe(false)
  })

  it('deny rule with traversal input denies end-to-end', () => {
    const engine = new PermissionEngine({ mode: 'trusted', allow: [], deny: ['Edit(**/secret/**)'] })
    const decision = engine.check({
      toolName: 'Edit',
      input: { file_path: 'a/../secret/creds.txt', old_string: 'a', new_string: 'b' },
      readOnly: false,
      summary: 'Edit',
    })
    expect(decision.decision).toBe('deny')
  })
})

describe('canonical-absolute path matching (cwd-aware)', () => {
  it('deny Write(<vault>/**) catches a relative ../ escape from a sub-cwd', () => {
    const vault = abs('/vault')
    const engine = new PermissionEngine({
      mode: 'trusted',
      allow: [],
      deny: [`Write(${vault}/**)`],
      cwd: `${vault}/sub`,
    })
    const decision = engine.check({
      toolName: 'Write',
      input: { file_path: '../secrets.txt', content: 'x' },
      readOnly: false,
      summary: 'Write',
    })
    expect(decision.decision).toBe('deny')
  })

  it('relative allow rule Edit(src/**) matches an absolute target inside cwd', () => {
    const proj = abs('/proj')
    const engine = new PermissionEngine({ mode: 'normal', allow: ['Edit(src/**)'], deny: [], cwd: proj })
    const inside = engine.check({
      toolName: 'Edit',
      input: { file_path: `${proj}/src/x.ts`, old_string: 'a', new_string: 'b' },
      readOnly: false,
      summary: 'Edit',
    })
    expect(inside.decision).toBe('allow')
    // The same rule must NOT match a look-alike path outside cwd.
    const outside = engine.check({
      toolName: 'Edit',
      input: { file_path: `${abs('/other')}/src/x.ts`, old_string: 'a', new_string: 'b' },
      readOnly: false,
      summary: 'Edit',
    })
    expect(outside.decision).toBe('ask')
  })

  it('allow-always grant (ruleFor) round-trips: relative grant matches later absolute call and vice versa', () => {
    const proj = abs('/proj')
    const engine = new PermissionEngine({ mode: 'normal', allow: [], deny: [], cwd: proj })
    const block = {
      type: 'tool_use',
      id: 't1',
      name: 'Write',
      input: { file_path: 'src/new.ts', content: '' },
    } as ToolUseBlock
    expect(
      engine.check({ toolName: 'Write', input: block.input, readOnly: false, summary: 'Write' })
        .decision,
    ).toBe('ask')
    engine.grantSession(ruleFor(block, proj))
    for (const file_path of ['src/new.ts', `${proj}/src/new.ts`, 'src\\new.ts']) {
      expect(
        engine.check({
          toolName: 'Write',
          input: { file_path, content: '' },
          readOnly: false,
          summary: 'Write',
        }).decision,
      ).toBe('allow')
    }
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

describe('resolveTrustBootstrap', () => {
  it('trusted project with the default mode starts trusted, and win32 lifts the sandbox', () => {
    const result = resolveTrustBootstrap({
      permissionMode: 'normal',
      sandboxMode: 'workspace-write',
      explicitlyTrusted: true,
      platform: 'win32',
    })
    expect(result.permissionMode).toBe('trusted')
    expect(result.sandboxMode).toBe('unrestricted')
    expect(result.notice).toContain('trusted')
    expect(result.notice).toContain('unrestricted')
  })

  it('trusted project keeps the workspace-write sandbox where a backend exists', () => {
    const result = resolveTrustBootstrap({
      permissionMode: 'normal',
      sandboxMode: 'workspace-write',
      explicitlyTrusted: true,
      platform: 'linux',
    })
    expect(result).toMatchObject({ permissionMode: 'trusted', sandboxMode: 'workspace-write' })
  })

  it('respects an explicit restrictive mode and never fires without explicit trust', () => {
    const restrictive = resolveTrustBootstrap({
      permissionMode: 'acceptEdits',
      sandboxMode: 'workspace-write',
      explicitlyTrusted: true,
      platform: 'win32',
    })
    expect(restrictive).toEqual({ permissionMode: 'acceptEdits', sandboxMode: 'workspace-write' })
    const untrusted = resolveTrustBootstrap({
      permissionMode: 'normal',
      sandboxMode: 'workspace-write',
      explicitlyTrusted: false,
      platform: 'win32',
    })
    expect(untrusted).toEqual({ permissionMode: 'normal', sandboxMode: 'workspace-write' })
    expect(untrusted.notice).toBeUndefined()
  })

  it('an explicit non-default sandbox choice is respected even on win32', () => {
    const result = resolveTrustBootstrap({
      permissionMode: 'normal',
      sandboxMode: 'read-only',
      explicitlyTrusted: true,
      platform: 'win32',
    })
    expect(result).toMatchObject({ permissionMode: 'trusted', sandboxMode: 'read-only' })
  })
})

/**
 * The fence is tier 0 inside `check()`: above deny rules, above every permission
 * mode, above allow rules and session grants. A synthetic protected directory
 * under tmpdir stands in for C:\Windows so this runs on every platform.
 */
describe('protected-paths fence (tier 0, unconditional)', () => {
  let root: string
  let system: string
  let work: string
  let fence: ProtectedPaths

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'athena-fence-')))
    system = join(root, 'system')
    work = join(root, 'work')
    mkdirSync(system)
    mkdirSync(work)
    writeFileSync(join(system, 'kernel.bin'), 'critical')
    writeFileSync(join(work, 'app.ts'), 'export {}')
    fence = new ProtectedPaths([system])
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** The unrestricted, prompt-free posture: the only thing that can deny here
   *  is the fence itself. */
  const stewardEngine = (): PermissionEngine =>
    new PermissionEngine({
      mode: 'trusted',
      allow: ['Write(**)', 'Bash(rm:*)'],
      deny: [],
      cwd: work,
      sandboxMode: 'unrestricted',
      protectedPaths: fence,
    })

  it('trusted mode does not bypass the fence', () => {
    const decision = stewardEngine().check(
      req('Write', { file_path: join(system, 'kernel.bin'), content: 'x' }, false),
    )
    expect(decision.decision).toBe('deny')
    expect(decision.reason).toMatch(/protected system directory/i)
  })

  it.each(['normal', 'acceptEdits', 'plan', 'trusted'] as const)(
    'denies a fenced write in %s mode, and says why',
    (mode: PermissionMode) => {
      const engine = new PermissionEngine({
        mode,
        allow: ['Write(**)', 'Edit(**)'],
        deny: [],
        cwd: work,
        sandboxMode: 'unrestricted',
        protectedPaths: fence,
      })
      const decision = engine.check(
        req('Write', { file_path: join(system, 'x.bin'), content: 'x' }, false),
      )
      expect(decision.decision).toBe('deny')
      // Tier 0: the fence reason wins even in plan mode, which would also deny.
      expect(decision.reason).toMatch(/protected system directory/i)
    },
  )

  it('a session grant cannot open the fence', () => {
    const engine = stewardEngine()
    engine.grantSession('Write(**)')
    expect(
      engine.check(req('Write', { file_path: join(system, 'x.bin'), content: 'x' }, false)).decision,
    ).toBe('deny')
  })

  it('allows reads inside the fence', () => {
    expect(
      stewardEngine().check(req('Read', { file_path: join(system, 'kernel.bin') }, true)).decision,
    ).toBe('allow')
    expect(stewardEngine().check(req('Glob', { pattern: `${system}/**` }, true)).decision).toBe('allow')
  })

  it('blocks a symlink or junction aimed into the fence', () => {
    const link = join(work, 'escape')
    symlinkSync(system, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(
      stewardEngine().check(req('Write', { file_path: 'escape/kernel.bin', content: 'x' }, false))
        .decision,
    ).toBe('deny')
    expect(
      stewardEngine().check(req('Write', { file_path: 'escape/new.bin', content: 'x' }, false))
        .decision,
    ).toBe('deny')
  })

  it('blocks traversal into the fence from a relative target', () => {
    expect(
      stewardEngine().check(
        req('Write', { file_path: '../system/kernel.bin', content: 'x' }, false),
      ).decision,
    ).toBe('deny')
  })

  it('deletes and overwrites OUTSIDE the fence are allowed with no prompt', () => {
    const engine = stewardEngine()
    for (const decision of [
      engine.check(req('Write', { file_path: join(work, 'app.ts'), content: 'x' }, false)),
      engine.check(req('Write', { file_path: join(root, 'elsewhere', 'new.txt'), content: 'x' }, false)),
      engine.check(req('Bash', { command: `rm -rf ${join(work, 'dist')}` }, false)),
      engine.check(req('Bash', { command: 'rm -rf node_modules' }, false)),
      engine.check(req('PowerShell', { command: `Remove-Item -Recurse ${join(root, 'scratch')}` }, false)),
    ]) {
      expect(decision.decision).toBe('allow')
    }
  })

  it('scans shell commands for mutations aimed into the fence', () => {
    const engine = stewardEngine()
    const denied = engine.check(req('Bash', { command: `rm -rf ${system}` }, false))
    expect(denied.decision).toBe('deny')
    expect(denied.reason).toMatch(/protected system directory/i)
    expect(
      engine.check(req('PowerShell', { command: `Remove-Item -Force "${join(system, 'kernel.bin')}"` }, false))
        .decision,
    ).toBe('deny')
    expect(
      engine.check(req('Bash', { command: `echo x > ${join(system, 'x.bin')}` }, false)).decision,
    ).toBe('deny')
    // Reading inside the fence from a shell is still fine.
    expect(engine.check(req('Bash', { command: `cat ${join(system, 'kernel.bin')}` }, false)).decision).toBe(
      'allow',
    )
  })

  it('defaults to the environment fence when a caller omits one', () => {
    // Fail-safe: an engine constructed without protectedPaths is still fenced,
    // so the guarantee does not depend on every call site remembering.
    const engine = new PermissionEngine({ mode: 'trusted', allow: [], deny: [] })
    const target =
      process.platform === 'win32'
        ? join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32', 'athena-probe.bin')
        : '/proc/athena-probe'
    const decision = engine.check(req('Write', { file_path: target, content: 'x' }, false))
    if (process.platform === 'win32' || process.platform === 'linux') {
      expect(decision.decision).toBe('deny')
    } else {
      // darwin's default fence is /System only; assert the fence exists at all.
      expect(ProtectedPaths.defaults().roots.length).toBeGreaterThan(0)
    }
  })
})
