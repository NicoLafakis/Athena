import { describe, expect, it } from 'vitest'
import { describeProjectTrust } from '../../src/harness/trust-disclosure.js'

describe('project trust disclosure', () => {
  it('discloses Windows default authority before consent', () => {
    const text = describeProjectTrust({ permissionMode: 'normal', sandboxMode: 'workspace-write', platform: 'win32' })
    expect(text).toContain('permission mode: trusted')
    expect(text).toContain('sandbox: unrestricted')
    expect(text).toContain('automatically approves mutating tools, including shell commands')
    expect(text).toContain('no Windows OS sandbox')
    expect(text).toContain('Project instructions and extensions')
    expect(text).toContain('Project settings hooks and MCP configurations require separate approval')
    expect(text).toContain('Deny rules')
  })
  it('reflects explicit plan/read-only settings without promising automatic approval', () => {
    const text = describeProjectTrust({ permissionMode: 'plan', sandboxMode: 'read-only', platform: 'win32' })
    expect(text).toContain('permission mode: plan; sandbox: read-only')
    expect(text).not.toContain('automatically approves')
    expect(text).not.toContain('sandbox: unrestricted')
  })
  it('retains the Linux workspace sandbox', () => {
    expect(describeProjectTrust({ permissionMode: 'normal', sandboxMode: 'workspace-write', platform: 'linux' })).toContain('permission mode: trusted; sandbox: workspace-write')
  })
})
