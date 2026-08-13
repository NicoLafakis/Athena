import { describe, expect, it } from 'vitest'
import type { CredentialVault } from '../../src/brain/credential-vault.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { collectDiagnostics, formatDiagnostics } from '../../src/harness/diagnostics.js'
import { ProtectedPaths } from '../../src/harness/protected-paths.js'

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

  it('reports environment staleness, warning only on genuinely stale state', () => {
    const paths = resolveBrainPaths({ cwd: '/workspace/athena', homeOverride: '/profile' })
    const report = collectDiagnostics(paths, '/workspace/athena', '0.1.0', {
      platform: 'linux',
      commandAvailable: () => true,
      env: {},
      vault: unavailableVault,
      staleness: {
        // A directory that does not exist: no build, no lockfile -> not-applicable, plus
        // a git that is not in a repository -> not-applicable. None of it is a warning.
        packageRoot: '/workspace/athena/nowhere',
        runGit: () => ({
          status: 128,
          stdout: '',
          stderr: 'fatal: not a git repository',
          timedOut: false,
        }),
      },
    })
    for (const name of ['stale-build', 'stale-deps', 'branch-behind', 'uncommitted-work']) {
      expect(report.checks.find((check) => check.name === name)).toMatchObject({ status: 'ok' })
    }
    expect(formatDiagnostics(report)).toContain('Not a git repository')
  })
})

describe('permission posture reporting', () => {
  const paths = resolveBrainPaths({ cwd: 'C:\workspace\athena', homeOverride: 'C:\profile' })
  const base = {
    platform: 'win32' as const,
    architecture: 'x64',
    nodeVersion: 'v22.0.0',
    commandAvailable: () => true,
    env: {},
    vault: unavailableVault,
  }

  it('names the active posture and every fenced directory', () => {
    const report = collectDiagnostics(paths, 'C:\workspace\athena', '0.1.0', {
      ...base,
      posture: {
        permissionMode: 'trusted',
        sandboxMode: 'unrestricted',
        protectedPaths: new ProtectedPaths(['C:\Windows', 'C:\Program Files'], {
          platform: 'win32',
          env: {},
        }),
      },
    })
    const posture = report.checks.find((check) => check.name === 'permission-posture')
    expect(posture?.detail).toContain('permissionMode=trusted')
    expect(posture?.detail).toContain('without a prompt')
    expect(posture?.detail).toContain('sandboxMode=unrestricted')
    const fence = report.checks.find((check) => check.name === 'protected-paths')
    expect(fence?.status).toBe('ok')
    expect(fence?.detail).toContain('C:\Windows')
    expect(fence?.detail).toContain('C:\Program Files')
    expect(fence?.detail).toContain('reads are still allowed')
    expect(formatDiagnostics(report)).toContain('protected-paths')
  })

  it('warns when the fence resolved to nothing', () => {
    const report = collectDiagnostics(paths, 'C:\workspace\athena', '0.1.0', {
      ...base,
      posture: {
        permissionMode: 'normal',
        sandboxMode: 'workspace-write',
        protectedPaths: new ProtectedPaths([], { platform: 'win32', env: {} }),
      },
    })
    expect(report.checks.find((check) => check.name === 'protected-paths')?.status).toBe('warning')
    expect(report.checks.find((check) => check.name === 'permission-posture')?.detail).toContain(
      'prompt for approval',
    )
  })

  it('still reports the environment fence when no posture is supplied', () => {
    const report = collectDiagnostics(paths, 'C:\workspace\athena', '0.1.0', base)
    expect(report.checks.some((check) => check.name === 'permission-posture')).toBe(false)
    expect(report.checks.find((check) => check.name === 'protected-paths')?.detail).toBeTruthy()
  })
})
