import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionEngine } from '../../src/harness/permissions.js'
import { ResourcePolicy } from '../../src/harness/resource-policy.js'
import { ProtectedPaths } from '../../src/harness/protected-paths.js'
import { memoryTool } from '../../src/tools/memory.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let root: string
let workspace: string
let brain: string
let memory: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-memory-policy-'))
  workspace = join(root, 'workspace')
  brain = join(root, 'brain')
  memory = join(brain, 'memory')
  mkdirSync(workspace)
  mkdirSync(memory, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function gate(mode: 'normal' | 'plan' = 'normal', deny: string[] = [], sandboxMode: 'workspace-write' | 'read-only' = 'workspace-write') {
  return new PermissionEngine({ mode, allow: [], deny, cwd: workspace, sandboxMode,
    resourcePolicy: new ResourcePolicy(workspace, sandboxMode), memoryRoot: memory })
}
function request(op: string, path?: string) {
  return { toolName: 'Memory', input: { op, ...(path ? { path } : {}) }, readOnly: false, summary: 'memory' }
}

describe('Memory scoped authorization', () => {
  it('matches relative and absolute rules through a linked brain parent', () => {
    const linkedBrain = join(root, 'linked-brain')
    symlinkSync(brain, linkedBrain, process.platform === 'win32' ? 'junction' : 'dir')
    const linkedMemory = join(linkedBrain, 'memory')
    const policy = (allow: string[], deny: string[] = []) => new PermissionEngine({
      mode: 'normal', allow, deny, cwd: workspace, memoryRoot: linkedMemory,
    })
    expect(policy(['Memory(fact.md)', 'Memory(MEMORY.md)']).check(request('write', 'fact.md')).decision).toBe('allow')
    for (const pattern of ['fact.md', join(linkedMemory, 'fact.md'), join(linkedMemory, '*.md')]) {
      expect(policy([], [`Memory(${pattern.replaceAll('\\', '/')})`]).check(request('read', 'fact.md')).decision).toBe('deny')
    }
    expect(policy(['Memory'], [`Memory(${join(linkedMemory, 'MEMORY.md').replaceAll('\\', '/')})`]).check(request('write', 'fact.md')).decision).toBe('deny')
  })

  it('keeps a protected root fence when its parent is an alias', () => {
    const linkedBrain = join(root, 'linked-brain')
    symlinkSync(brain, linkedBrain, process.platform === 'win32' ? 'junction' : 'dir')
    const linkedMemory = join(linkedBrain, 'memory')
    const protectedPaths = ProtectedPaths.from([linkedMemory])
    const policy = new PermissionEngine({ mode: 'trusted', allow: ['Memory'], deny: [],
      cwd: workspace, memoryRoot: memory, sandboxMode: 'unrestricted', protectedPaths })
    expect(policy.check(request('write', 'fact.md')).decision).toBe('deny')
    expect(protectedPaths.deniedRoot(join(linkedMemory, 'fact.md'), workspace)).not.toBeNull()
    const futureFence = new ProtectedPaths([join(linkedMemory, 'not-created')])
    const canonicalMemory = new ResourcePolicy(memory).workspaceRoot
    expect(futureFence.deniedRoot(join(canonicalMemory, 'not-created', 'fact.md'), workspace)).not.toBeNull()
    expect(futureFence.deniedRoot(join(linkedMemory, 'not-created', 'fact.md'), workspace)).not.toBeNull()
  })
  it('requires approval when only the fact is allowed but its index mutation still asks', () => {
    const policy = new PermissionEngine({ mode: 'normal', allow: ['Memory(fact.md)'], deny: [],
      cwd: workspace, memoryRoot: memory, sandboxMode: 'workspace-write' })
    expect(policy.check(request('write', 'fact.md')).decision).toBe('ask')
    policy.grantSession('Memory(MEMORY.md)')
    expect(policy.check(request('write', 'fact.md')).decision).toBe('allow')
  })
  it('authorizes against the same memory target execution uses, not a workspace namesake', async () => {
    writeFileSync(join(memory, 'fact.md'), 'memory fact')
    expect(gate('normal', [`Memory(${join(memory, 'fact.md').replaceAll('\\', '/')})`]).check(request('read', 'fact.md')).decision).toBe('deny')
    expect(gate('normal', ['Memory(fact.md)']).check(request('read', 'fact.md')).decision).toBe('deny')
    expect(gate('plan').check(request('read', 'fact.md')).decision).toBe('allow')
    const result = await memoryTool.execute({ op: 'read', path: 'fact.md' }, makeCtx(workspace, { brainDir: brain }))
    expect(result.output).toBe('memory fact')
  })

  it('allows read/list in plan and read-only mode, but never mutations', () => {
    for (const policy of [gate('plan'), gate('normal', [], 'read-only')]) {
      expect(policy.check(request('read', 'fact.md')).decision).toBe('allow')
      expect(policy.check(request('list')).decision).toBe('allow')
      expect(policy.check(request('write', 'fact.md')).decision).toBe('deny')
      expect(policy.check(request('delete', 'fact.md')).decision).toBe('deny')
    }
  })

  it('applies deny rules to the implicit index mutation', () => {
    expect(gate('normal', [`Memory(${join(memory, 'MEMORY.md').replaceAll('\\', '/')})`]).check(request('write', 'fact.md')).decision).toBe('deny')
  })

  it('rejects linked directory escapes during read, write, delete and list', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'fact.md'), 'untouched')
    symlinkSync(outside, join(memory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = makeCtx(workspace, { brainDir: brain })
    for (const op of ['read', 'write', 'delete'] as const) {
      expect(gate().check(request(op, 'linked/fact.md')).decision).toBe('deny')
      expect((await memoryTool.execute({ op, path: 'linked/fact.md', content: 'changed' }, ctx)).isError).toBe(true)
    }
    expect(gate().check(request('list')).decision).toBe('deny')
    expect((await memoryTool.execute({ op: 'list' }, ctx)).isError).toBe(true)
    expect(readFileSync(join(outside, 'fact.md'), 'utf8')).toBe('untouched')
  })

  it('checks the index before writing the requested fact', async () => {
    // A directory link is portable on Windows without developer-mode file symlinks.
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(memory, 'MEMORY.md'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(gate().check(request('write', 'fact.md')).decision).toBe('deny')
    expect((await memoryTool.execute({ op: 'write', path: 'fact.md', content: 'new' }, makeCtx(workspace, { brainDir: brain }))).isError).toBe(true)
    expect(existsSync(join(memory, 'fact.md'))).toBe(false)
  })

  it('rejects dangling links rather than treating them as new directories', async () => {
    symlinkSync(join(root, 'not-created'), join(memory, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(gate().check(request('write', 'dangling/fact.md')).decision).toBe('deny')
    expect((await memoryTool.execute({ op: 'write', path: 'dangling/fact.md', content: 'new' }, makeCtx(workspace, { brainDir: brain }))).isError).toBe(true)
  })

  it('rechecks read-only mode at direct execution and protects reserved targets through aliases', async () => {
    const ctx = makeCtx(workspace, { brainDir: brain, sandboxMode: 'read-only' })
    expect((await memoryTool.execute({ op: 'write', path: 'fact.md', content: 'new' }, ctx)).isError).toBe(true)
    mkdirSync(join(memory, 'journal'))
    symlinkSync(join(memory, 'journal'), join(memory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(gate().check(request('write', 'alias/fact.md')).decision).toBe('deny')
    expect((await memoryTool.execute({ op: 'write', path: 'alias/fact.md', content: 'new' }, { ...ctx, sandboxMode: 'workspace-write' })).isError).toBe(true)
  })

  it('does not extend ordinary Read access to the brain', () => {
    expect(gate().check({ toolName: 'Read', input: { file_path: join(brain, 'settings.json') }, readOnly: true, summary: 'read' }).decision).toBe('deny')
  })

  it('retains protected-path denies even in trusted unrestricted mode', () => {
    const policy = new PermissionEngine({ mode: 'trusted', allow: ['Memory'], deny: [], cwd: workspace,
      sandboxMode: 'unrestricted', memoryRoot: memory, protectedPaths: ProtectedPaths.from([memory]) })
    expect(policy.check(request('write', 'fact.md')).decision).toBe('deny')
    expect(policy.check(request('read', 'fact.md')).decision).toBe('allow')
  })

  it('checks denied entries during list and fails closed without an explicit memory scope', () => {
    writeFileSync(join(memory, 'private.md'), 'private')
    expect(gate('plan', ['Memory(private.md)']).check(request('list')).decision).toBe('deny')
    expect(new PermissionEngine({ mode: 'trusted', allow: ['Memory'], deny: [], cwd: workspace }).check(request('read', 'fact.md')).decision).toBe('deny')
  })
})
