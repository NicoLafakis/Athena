import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProjectTrustStore,
  capabilityDigest,
  canonicalProjectPath,
  projectId,
} from '../../src/harness/trust.js'

let root: string
let project: string
let trustFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-trust-'))
  project = join(root, 'project')
  trustFile = join(root, 'brain', 'trust.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ProjectTrustStore', () => {
  it('keys trust by canonical project identity outside the project', () => {
    const store = new ProjectTrustStore(trustFile)
    expect(store.isTrusted(project)).toBe(false)
    const record = store.trust(project)
    expect(record.projectId).toBe(projectId(project))
    expect(record.canonicalPath).toBe(canonicalProjectPath(project))
    expect(store.isTrusted(project)).toBe(true)
    expect(trustFile.startsWith(project)).toBe(false)
  })

  it('binds capability approval to the exact configuration digest', () => {
    const store = new ProjectTrustStore(trustFile)
    store.trust(project)
    const first = capabilityDigest([{ command: 'safe' }])
    const changed = capabilityDigest([{ command: 'changed' }])
    store.approveCapability(project, 'hooks', first)
    expect(store.isCapabilityApproved(project, 'hooks', first)).toBe(true)
    expect(store.isCapabilityApproved(project, 'hooks', changed)).toBe(false)
  })

  it('revokes project and capability trust together', () => {
    const store = new ProjectTrustStore(trustFile)
    store.trust(project)
    store.approveCapability(project, 'mcp', capabilityDigest({ server: 'x' }))
    expect(store.revoke(project)).toBe(true)
    expect(store.isTrusted(project)).toBe(false)
    expect(store.revoke(project)).toBe(false)
  })
})
