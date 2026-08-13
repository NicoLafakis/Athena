import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtectedPaths } from '../../src/harness/protected-paths.js'
import { ResourcePolicy, ResourcePolicyError } from '../../src/harness/resource-policy.js'

let root: string
let workspace: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-policy-'))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ResourcePolicy', () => {
  it('allows workspace reads/writes and blocks traversal outside it', () => {
    const policy = new ResourcePolicy(workspace, 'workspace-write')
    expect(policy.contains('src/new.ts', 'write')).toBe(true)
    expect(policy.contains('../outside/secret.txt', 'read')).toBe(false)
    expect(policy.contains('../outside/new.txt', 'write')).toBe(false)
  })

  it('blocks symlink escapes after resolving the real path', () => {
    const link = join(workspace, 'escape')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const policy = new ResourcePolicy(workspace, 'workspace-write')
    expect(policy.contains('escape/secret.txt', 'read')).toBe(false)
    expect(policy.contains('escape/new.txt', 'write')).toBe(false)
  })

  it('read-only blocks writes and unrestricted permits explicit outside access', () => {
    expect(new ResourcePolicy(workspace, 'read-only').contains('new.txt', 'write')).toBe(false)
    expect(
      new ResourcePolicy(workspace, 'unrestricted').contains('../outside/secret.txt', 'read'),
    ).toBe(true)
  })
})

/**
 * A synthetic protected directory under tmpdir stands in for C:\Windows, so the
 * wiring is exercised on every platform. The Win32-specific normalization rules
 * (short names, device prefixes, admin shares) are covered in
 * protected-paths.test.ts against injected platform/env.
 */
describe('ResourcePolicy OS write fence', () => {
  let system: string
  let sibling: string
  let fence: ProtectedPaths

  beforeEach(() => {
    system = join(root, 'system')
    // Same string prefix, different directory: proves segment-boundary matching
    // survives all the way through realpath resolution.
    sibling = join(root, 'systemapps')
    mkdirSync(system)
    mkdirSync(sibling)
    writeFileSync(join(system, 'kernel.bin'), 'critical')
    // realpathSync matters on macOS, where tmpdir() is a /var -> /private/var symlink.
    fence = new ProtectedPaths([realpathSync.native(system)])
  })

  const policy = (mode: 'unrestricted' | 'workspace-write' = 'unrestricted'): ResourcePolicy =>
    new ResourcePolicy(workspace, mode, [], fence)

  it('denies writes inside the fence even in an unrestricted sandbox', () => {
    expect(policy().contains(join(system, 'kernel.bin'), 'write')).toBe(false)
    expect(policy().contains(join(system, 'new-file.bin'), 'write')).toBe(false)
    expect(policy().contains(join(system, 'nested', 'deep', 'new.bin'), 'write')).toBe(false)
    // The fenced directory itself, not only its contents.
    expect(policy().contains(system, 'write')).toBe(false)
  })

  it('still allows reads inside the fence', () => {
    expect(policy().contains(join(system, 'kernel.bin'), 'read')).toBe(true)
    expect(policy().resolvePath(join(system, 'kernel.bin'), 'read')).toBe(
      realpathSync.native(join(system, 'kernel.bin')),
    )
  })

  it('leaves every path outside the fence writable, deletes included', () => {
    expect(policy().contains(join(outside, 'secret.txt'), 'write')).toBe(true)
    expect(policy().contains(join(sibling, 'anything.txt'), 'write')).toBe(true)
    expect(policy().contains('new.txt', 'write')).toBe(true)
    expect(policy('workspace-write').contains('nested/new.txt', 'write')).toBe(true)
  })

  it('blocks a symlink or junction aimed into the fence', () => {
    const link = join(workspace, 'escape')
    symlinkSync(system, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(policy().contains('escape/kernel.bin', 'write')).toBe(false)
    expect(policy().contains('escape/created-later.bin', 'write')).toBe(false)
    // ...while the read through the same link is fine.
    expect(policy().contains('escape/kernel.bin', 'read')).toBe(true)
  })

  it('blocks traversal back into the fence from the workspace', () => {
    expect(policy().contains('../system/kernel.bin', 'write')).toBe(false)
    expect(policy().contains('./../system/./nested/../x.bin', 'write')).toBe(false)
  })

  it('throws a ResourcePolicyError naming the fenced root', () => {
    expect(() => policy().resolvePath(join(system, 'x.bin'), 'write')).toThrow(ResourcePolicyError)
    expect(() => policy().resolvePath(join(system, 'x.bin'), 'write')).toThrow(
      /protected system directory/i,
    )
  })

  it('defaults to the environment fence when a construction site omits one', () => {
    // Fail-safe: forgetting the argument must not produce an unfenced policy.
    expect(new ResourcePolicy(workspace).protectedPaths.roots.length).toBeGreaterThan(0)
  })
})
