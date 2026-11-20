import { createInterface } from 'node:readline/promises'
import type { BrainPaths } from '../brain/paths.js'
import {
  loadSettings,
  readProjectSettingsCapabilities,
  SettingsSchema,
  type Settings,
} from '../brain/settings.js'
import type { PermissionPosture } from '../harness/diagnostics.js'
import { resolveTrustBootstrap } from '../harness/permissions.js'
import { ProtectedPaths } from '../harness/protected-paths.js'
import {
  ProjectTrustStore,
  capabilityDigest,
  canonicalProjectPath,
  type ProjectCapability,
} from '../harness/trust.js'

function describeCapability(capability: ProjectCapability, value: unknown): string {
  if (capability === 'hooks') {
    const hooks = Array.isArray(value) ? value : []
    return hooks
      .map((hook) => {
        const item = hook as Record<string, unknown>
        return `  ${String(item['event'] ?? '?')}: ${String(item['command'] ?? '?')}`
      })
      .join('\n')
  }
  return Object.entries((value ?? {}) as Record<string, unknown>)
    .map(([name, raw]) => {
      const item = (raw ?? {}) as Record<string, unknown>
      const args = Array.isArray(item['args']) ? item['args'].map(String) : []
      const envNames = Object.keys((item['env'] ?? {}) as Record<string, unknown>)
      return `  ${name}: ${String(item['command'] ?? '?')} ${args.join(' ')}\n    cwd: ${process.cwd()}\n    env names: ${envNames.join(', ') || '(none)'}`
    })
    .join('\n')
}

async function confirm(question: string): Promise<boolean> {
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    reader.close()
  }
}

export interface ResolvedProjectTrust {
  trusted: boolean
  allowProjectHooks: boolean
  allowProjectMcp: boolean
}

export async function resolveProjectTrust(
  paths: BrainPaths,
  cwd: string,
): Promise<ResolvedProjectTrust> {
  if (!paths.projectBrainDir) {
    return { trusted: true, allowProjectHooks: true, allowProjectMcp: true }
  }
  const store = new ProjectTrustStore(paths.trustFile)
  let trusted = store.isTrusted(cwd)
  if (!trusted) {
    trusted = await confirm(
      `Trust project ${canonicalProjectPath(cwd)}? Project instructions and extensions are ignored until trusted.`,
    )
    if (trusted) store.trust(cwd)
  }
  if (!trusted) return { trusted: false, allowProjectHooks: false, allowProjectMcp: false }

  const capabilities = readProjectSettingsCapabilities(paths)
  const approved: Record<ProjectCapability, boolean> = { hooks: true, mcp: true }
  for (const capability of ['hooks', 'mcp'] as const) {
    const value = capability === 'hooks' ? capabilities.hooks : capabilities.mcpServers
    const present =
      capability === 'hooks'
        ? capabilities.hooks.length > 0
        : Object.keys(capabilities.mcpServers).length > 0
    if (!present) continue
    const digest = capabilityDigest(value)
    if (store.isCapabilityApproved(cwd, capability, digest)) continue
    const details = describeCapability(capability, value)
    const accepted = await confirm(
      `Approve project ${capability.toUpperCase()} configuration?\n${details}\nApproval is invalidated when it changes.`,
    )
    approved[capability] = accepted
    if (accepted) store.approveCapability(cwd, capability, digest)
  }
  return {
    trusted,
    allowProjectHooks: approved.hooks,
    allowProjectMcp: approved.mcp,
  }
}

export function resolveStoredProjectTrust(
  paths: BrainPaths,
  cwd: string,
): ResolvedProjectTrust {
  if (!paths.projectBrainDir) {
    return { trusted: true, allowProjectHooks: true, allowProjectMcp: true }
  }
  const store = new ProjectTrustStore(paths.trustFile)
  const trusted = store.isTrusted(cwd)
  if (!trusted) return { trusted: false, allowProjectHooks: false, allowProjectMcp: false }
  const capabilities = readProjectSettingsCapabilities(paths)
  return {
    trusted: true,
    allowProjectHooks:
      capabilities.hooks.length === 0 ||
      store.isCapabilityApproved(cwd, 'hooks', capabilityDigest(capabilities.hooks)),
    allowProjectMcp:
      Object.keys(capabilities.mcpServers).length === 0 ||
      store.isCapabilityApproved(cwd, 'mcp', capabilityDigest(capabilities.mcpServers)),
  }
}

/** Explicit-registry trust only: the defaulted `trusted=true` a project without
 *  `.athena/` receives must never bootstrap trusted mode (that would make every
 *  directory shell-trusted). */
export function explicitProjectTrust(paths: BrainPaths, cwd: string): boolean {
  if (!paths.projectBrainDir) return false
  return new ProjectTrustStore(paths.trustFile).isTrusted(cwd)
}

/**
 * The posture `athena doctor` reports: settings plus the trust bootstrap, i.e.
 * what an interactive session in this cwd would actually run with. Never throws
 * — a doctor command that dies on malformed settings is useless precisely when
 * it is needed, so a load failure degrades to the schema defaults.
 */
export function doctorPosture(paths: BrainPaths, cwd: string): PermissionPosture {
  let settings: Settings
  try {
    settings = loadSettings(paths, 'anthropic', undefined, { projectTrusted: false })
  } catch {
    settings = SettingsSchema.parse({})
  }
  const bootstrap = resolveTrustBootstrap({
    permissionMode: settings.permissionMode,
    sandboxMode: settings.sandboxMode,
    explicitlyTrusted: explicitProjectTrust(paths, cwd),
  })
  return {
    permissionMode: bootstrap.permissionMode,
    sandboxMode: bootstrap.sandboxMode,
    protectedPaths: ProtectedPaths.from(settings.protectedPaths),
  }
}

/** Fold the trust bootstrap into loaded settings; the notice is loud on purpose. */
export function applyTrustBootstrap(settings: Settings, paths: BrainPaths, cwd: string): void {
  const bootstrap = resolveTrustBootstrap({
    permissionMode: settings.permissionMode,
    sandboxMode: settings.sandboxMode,
    explicitlyTrusted: explicitProjectTrust(paths, cwd),
  })
  settings.permissionMode = bootstrap.permissionMode
  settings.sandboxMode = bootstrap.sandboxMode
  if (bootstrap.notice) console.error(bootstrap.notice)
}
