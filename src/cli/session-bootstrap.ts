import type { ProviderId } from '../brain/models.js'
import type { BrainPaths } from '../brain/paths.js'
import { loadPluginRuntimeExtensions, type PluginRuntimeExtensions } from '../brain/plugins.js'
import { loadSettings, type Settings } from '../brain/settings.js'
import { stalenessBootWarnings } from '../harness/staleness.js'
import {
  applyTrustBootstrap,
  resolveProjectTrust,
  resolveStoredProjectTrust,
  type ResolvedProjectTrust,
} from './trust.js'

export interface SessionTrustContext {
  projectTrust: ResolvedProjectTrust
  effectivePaths: BrainPaths
}

export interface SessionSettingsOptions {
  paths: BrainPaths
  effectivePaths: BrainPaths
  cwd: string
  provider: ProviderId
  projectTrust: ResolvedProjectTrust
  applyTrust: boolean
  warn?: (message: string) => void
}

export interface SessionEnvironmentOptions {
  paths: BrainPaths
  cwd: string
  provider: ProviderId
  interactiveTrust: boolean
  applyTrust: boolean
  warn?: (message: string) => void
}

export interface PreparedSessionEnvironment extends SessionTrustContext {
  settings: Settings
  pluginExtensions: PluginRuntimeExtensions
}

/** Emit filesystem-only staleness warnings once per session boot. */
export function emitStalenessWarnings(warn: (message: string) => void = console.error): void {
  for (const warning of stalenessBootWarnings()) warn(warning)
}

/** Resolve project trust and compute `effectivePaths` (nulling `projectBrainDir` when untrusted). */
export async function resolveSessionTrust(
  paths: BrainPaths,
  cwd: string,
  interactive: boolean,
): Promise<SessionTrustContext> {
  const projectTrust = interactive
    ? await resolveProjectTrust(paths, cwd)
    : resolveStoredProjectTrust(paths, cwd)
  const effectivePaths: BrainPaths = projectTrust.trusted
    ? paths
    : { ...paths, projectBrainDir: null }
  return { projectTrust, effectivePaths }
}

/** Load merged settings, optional trusted-project bootstrap, and plugin runtime extensions. */
export function loadSessionSettings(
  options: SessionSettingsOptions,
): { settings: Settings; pluginExtensions: PluginRuntimeExtensions } {
  const warn = options.warn ?? console.error
  const settings = loadSettings(options.paths, options.provider, warn, {
    projectTrusted: options.projectTrust.trusted,
    allowProjectHooks: options.projectTrust.allowProjectHooks,
    allowProjectMcp: options.projectTrust.allowProjectMcp,
  })
  if (options.applyTrust) applyTrustBootstrap(settings, options.paths, options.cwd)
  const pluginExtensions = loadPluginRuntimeExtensions(options.effectivePaths, warn)
  settings.hooks = [...pluginExtensions.hooks, ...settings.hooks]
  settings.mcpServers = { ...pluginExtensions.mcpServers, ...settings.mcpServers }
  return { settings, pluginExtensions }
}

/**
 * Shared session environment bootstrap used across `voice`, `exec`, `screen-reader`,
 * and `tui`: staleness warnings, trust -> `effectivePaths`, settings, and plugin extensions.
 */
export async function prepareSessionEnvironment(
  options: SessionEnvironmentOptions,
): Promise<PreparedSessionEnvironment> {
  const warn = options.warn ?? console.error
  emitStalenessWarnings(warn)
  const { projectTrust, effectivePaths } = await resolveSessionTrust(
    options.paths,
    options.cwd,
    options.interactiveTrust,
  )
  const { settings, pluginExtensions } = loadSessionSettings({
    paths: options.paths,
    effectivePaths,
    cwd: options.cwd,
    provider: options.provider,
    projectTrust,
    applyTrust: options.applyTrust,
    warn,
  })
  return { projectTrust, effectivePaths, settings, pluginExtensions }
}
