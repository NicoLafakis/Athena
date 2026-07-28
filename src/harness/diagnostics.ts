import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  createCredentialVault,
  type CredentialVault,
} from '../brain/credential-vault.js'
import { loadCredentials, resolveApiKey } from '../brain/credentials.js'
import { PROVIDER_IDS } from '../brain/models.js'
import type { BrainPaths } from '../brain/paths.js'
import { collectStaleness, type StalenessOptions } from './staleness.js'
import { ProjectTrustStore } from './trust.js'

export interface DiagnosticCheck {
  name: string
  status: 'ok' | 'warning' | 'error'
  detail: string
}

export interface AthenaDiagnostics {
  schemaVersion: 1
  version: string
  platform: NodeJS.Platform
  architecture: string
  node: string
  cwd: string
  checks: DiagnosticCheck[]
  update: {
    channel: 'source'
    automatic: false
    detail: string
  }
}

function commandAvailable(command: string, platform: NodeJS.Platform): boolean {
  const result =
    platform === 'win32'
      ? spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true })
      : spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
          stdio: 'ignore',
        })
  return result.status === 0
}

export function collectDiagnostics(
  paths: BrainPaths,
  cwd: string,
  version: string,
  options: {
    platform?: NodeJS.Platform
    architecture?: string
    nodeVersion?: string
    commandAvailable?: (command: string, platform: NodeJS.Platform) => boolean
    env?: NodeJS.ProcessEnv
    vault?: CredentialVault
    staleness?: StalenessOptions
  } = {},
): AthenaDiagnostics {
  const platform = options.platform ?? process.platform
  const available = options.commandAvailable ?? commandAvailable
  const checks: DiagnosticCheck[] = []
  checks.push({
    name: 'brain',
    status: existsSync(paths.brainDir) ? 'ok' : 'warning',
    detail: existsSync(paths.brainDir)
      ? `Brain directory exists at ${paths.brainDir}`
      : `Brain directory has not been initialized at ${paths.brainDir}`,
  })

  if (paths.projectBrainDir) {
    try {
      const trusted = new ProjectTrustStore(paths.trustFile).isTrusted(cwd)
      checks.push({
        name: 'project-trust',
        status: trusted ? 'ok' : 'warning',
        detail: trusted
          ? 'Project configuration is trusted; hook and MCP definitions still require digest-bound approval.'
          : 'Project configuration is untrusted and will be ignored.',
      })
    } catch (error) {
      checks.push({
        name: 'project-trust',
        status: 'error',
        detail: `Trust registry is invalid: ${(error as Error).message}`,
      })
    }
  } else {
    checks.push({
      name: 'project-trust',
      status: 'ok',
      detail: 'No project-local .athena configuration is present.',
    })
  }

  const vault = options.vault ?? createCredentialVault(paths, platform)
  const vaultStatus = vault.status()
  checks.push({
    name: 'credential-vault',
    status: vaultStatus.available ? 'ok' : 'warning',
    detail: `${vaultStatus.backend}: ${vaultStatus.detail}`,
  })
  try {
    const credentials = loadCredentials(paths)
    // resolveApiKey never throws: an unreadable vault entry (a DPAPI blob encrypted on a
    // different machine) comes back as "no key" plus a warning. Without this sink the
    // diagnostic would report a configured-but-unreadable provider as simply "not
    // configured", which is exactly the wrong thing for a doctor command to say.
    const vaultWarnings: string[] = []
    const configured = PROVIDER_IDS.filter((provider) =>
      Boolean(
        resolveApiKey(provider, credentials, options.env ?? process.env, vault, (message) => {
          if (!vaultWarnings.includes(message)) vaultWarnings.push(message)
        }),
      ),
    )
    const suffix = vaultWarnings.length > 0 ? ` ${vaultWarnings.join(' ')}` : ''
    checks.push({
      name: 'providers',
      status: configured.length > 0 && vaultWarnings.length === 0 ? 'ok' : 'warning',
      detail:
        (configured.length > 0
          ? `Configured providers: ${configured.join(', ')}`
          : 'No provider credential is configured.') + suffix,
    })
  } catch (error) {
    checks.push({
      name: 'providers',
      status: 'error',
      detail: (error as Error).message,
    })
  }

  for (const command of ['git', 'rg']) {
    const present = available(command, platform)
    checks.push({
      name: command,
      status: present ? 'ok' : 'warning',
      detail: present ? `${command} is available` : `${command} is not available on PATH`,
    })
  }

  const sandboxCommand =
    platform === 'linux' ? 'bwrap' : platform === 'darwin' ? 'sandbox-exec' : null
  const sandboxAvailable = sandboxCommand
    ? available(sandboxCommand, platform)
    : false
  checks.push({
    name: 'process-sandbox',
    status: sandboxAvailable ? 'ok' : 'warning',
    detail: sandboxAvailable
      ? `${sandboxCommand} provides fail-closed shell containment`
      : platform === 'win32'
        ? 'No supported Windows process sandbox; read-only/workspace-write shell calls fail closed. Use unrestricted only by explicit choice.'
        : `No supported process sandbox backend (${sandboxCommand ?? platform}); restricted shell calls fail closed.`,
  })

  // Environment staleness. Only 'stale' is a warning: 'not-applicable' (fresh clone, no
  // upstream) and 'unknown' (git absent or hung) are normal states for a doctor run to
  // report plainly, not conditions to flag.
  for (const signal of collectStaleness(options.staleness)) {
    checks.push({
      name: signal.name,
      status: signal.state === 'stale' ? 'warning' : 'ok',
      detail: signal.detail,
    })
  }

  return {
    schemaVersion: 1,
    version,
    platform,
    architecture: options.architecture ?? process.arch,
    node: options.nodeVersion ?? process.version,
    cwd,
    checks,
    update: {
      channel: 'source',
      automatic: false,
      detail:
        'Athena is currently a source-installed private package. Pull an explicitly reviewed revision, reinstall with the lockfile, run all quality gates, and rebuild; there is no silent self-updater.',
    },
  }
}

export function formatDiagnostics(report: AthenaDiagnostics): string {
  const header = [
    `Athena ${report.version}`,
    `${report.platform}/${report.architecture}`,
    `Node ${report.node}`,
    `Project ${report.cwd}`,
  ].join('\n')
  const checks = report.checks
    .map((check) => `[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`)
    .join('\n')
  return `${header}\n\n${checks}\n\nUpdate: ${report.update.detail}`
}
