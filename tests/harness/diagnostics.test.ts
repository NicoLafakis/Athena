import { describe, expect, it } from 'vitest'
import type { CredentialVault } from '../../src/brain/credential-vault.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { collectDiagnostics, formatDiagnostics } from '../../src/harness/diagnostics.js'

const unavailableVault: CredentialVault = {
  status: () => ({
    backend: 'unavailable',
    available: false,
    detail: 'test vault unavailable',
  }),
  get: () => null,
  set: () => {},
  delete: () => {},
}

describe('harness diagnostics', () => {
  it('reports fail-closed Windows sandbox and never claims an automatic updater', () => {
    const paths = resolveBrainPaths({
      cwd: 'C:\\workspace\\athena',
      homeOverride: 'C:\\profile',
    })
    const report = collectDiagnostics(paths, 'C:\\workspace\\athena', '0.1.0', {
      platform: 'win32',
      architecture: 'x64',
      nodeVersion: 'v22.0.0',
      commandAvailable: (command) => command === 'git' || command === 'rg',
      env: {},
      vault: unavailableVault,
    })

    expect(report.update).toMatchObject({ channel: 'source', automatic: false })
    expect(report.checks.find((check) => check.name === 'process-sandbox')).toMatchObject({
      status: 'warning',
    })
    expect(formatDiagnostics(report)).toContain('shell calls fail closed')
  })

  it('recognizes an available Linux bubblewrap backend', () => {
    const paths = resolveBrainPaths({ cwd: '/workspace/athena', homeOverride: '/profile' })
    const report = collectDiagnostics(paths, '/workspace/athena', '0.1.0', {
      platform: 'linux',
      commandAvailable: (command) => command === 'git' || command === 'rg' || command === 'bwrap',
      env: {},
      vault: unavailableVault,
    })
    expect(report.checks.find((check) => check.name === 'process-sandbox')).toMatchObject({
      status: 'ok',
    })
  })
})
