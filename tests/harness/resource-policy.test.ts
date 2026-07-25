import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResourcePolicy } from '../../src/harness/resource-policy.js'

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
