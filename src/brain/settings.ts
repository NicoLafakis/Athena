import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFileSync } from '../tools/files.js'
import type { HookEventName, PermissionMode, SandboxMode } from '../engine/types.js'
import type { Effort, ProviderId } from './models.js'
import { normalizeModel, modelKeys, PROVIDERS } from './models.js'
import type { BrainPaths } from './paths.js'

const HookEventSchema = z.enum([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
  'Stop',
])
const HookCommonShape = {
  version: z.literal(1).default(1),
  event: HookEventSchema,
  matcher: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  maxOutputChars: z.number().int().positive().max(1_000_000).default(100_000),
}
const CommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  ...HookCommonShape,
})
const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  headerEnv: z.record(z.string(), z.string()).default({}),
  allowPrivateNetwork: z.boolean().default(false),
  ...HookCommonShape,
})
const McpToolHookSchema = z.object({
  type: z.literal('mcp-tool'),
  tool: z.string().min(1),
  ...HookCommonShape,
})
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().min(1),
  ...HookCommonShape,
})
const AgentHookSchema = z.object({
  type: z.literal('agent'),
  agent: z.string().min(1),
  prompt: z.string().optional(),
  ...HookCommonShape,
})

/** Legacy command hooks normalize to the versioned command contract. */
export const HookDefSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const value = raw as Record<string, unknown>
    return {
      ...value,
      type: value['type'] ?? 'command',
      version: value['version'] ?? 1,
    }
  },
  z.discriminatedUnion('type', [
    CommandHookSchema,
    HttpHookSchema,
    McpToolHookSchema,
    PromptHookSchema,
    AgentHookSchema,
  ]),
)
export type ParsedHookDef = z.infer<typeof HookDefSchema>

export interface HookDef {
  version?: 1
  event: HookEventName
  type?: 'command' | 'http' | 'mcp-tool' | 'prompt' | 'agent'
  matcher?: string
  timeoutMs?: number
  maxOutputChars?: number
  command?: string
  url?: string
  headers?: Record<string, string>
  headerEnv?: Record<string, string>
  allowPrivateNetwork?: boolean
  tool?: string
  prompt?: string
  agent?: string
}

// An MCP (Model Context Protocol) server Athena connects to as a client. stdio
// transport only for now — command + args spawn the server process; env is layered
// over the inherited process env. URL/SSE transports are a future seam (add a
// discriminated `transport` field then, defaulting to 'stdio').
const McpCommonShape = {
  maxOutputChars: z.number().int().positive().max(2_000_000).default(100_000),
  discoveryLimit: z.number().int().positive().max(1_000).default(200),
}

const McpStdioSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  envAllowlist: z.array(z.string()).default([]),
  ...McpCommonShape,
})

const McpHttpSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  // Maps HTTP header names to environment-variable names, keeping secret values
  // out of settings.json.
  headerEnv: z.record(z.string(), z.string()).default({}),
  bearerTokenEnv: z.string().optional(),
  oauth: z
    .object({
      flow: z.literal('client_credentials'),
      clientIdEnv: z.string().min(1),
      clientSecretEnv: z.string().min(1),
      scope: z.string().optional(),
    })
    .optional(),
  allowPrivateNetwork: z.boolean().default(false),
  ...McpCommonShape,
})

/** Versioned transport contract. Legacy `{command, args}` definitions normalize
 * to stdio so existing settings remain compatible. */
export const McpServerSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const value = raw as Record<string, unknown>
    return value['transport'] ? value : { ...value, transport: 'stdio' }
  },
  z.discriminatedUnion('transport', [McpStdioSchema, McpHttpSchema]),
)
export type ParsedMcpServerConfig = z.infer<typeof McpServerSchema>

export type McpStdioConfig = {
  transport?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  envAllowlist?: string[]
  maxOutputChars?: number
  discoveryLimit?: number
}

export type McpHttpConfig = {
  transport: 'http'
  url: string
  headers?: Record<string, string>
  headerEnv?: Record<string, string>
  bearerTokenEnv?: string
  oauth?: {
    flow: 'client_credentials'
    clientIdEnv: string
    clientSecretEnv: string
    scope?: string
  }
  allowPrivateNetwork?: boolean
  maxOutputChars?: number
  discoveryLimit?: number
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig

// Model keys are provider-scoped: a string (key OR legacy/full model id) is normalized
// within the active provider before validation; an unrecognized value fails with an
// error naming the provider and its valid keys.
function modelSchema(provider: ProviderId) {
  return z
    .preprocess(
      (v) => (typeof v === 'string' ? (normalizeModel(provider, v) ?? v) : v),
      z.string().refine(
        (v) => modelKeys(provider).includes(v),
        (v) => ({
          message: `unknown model '${String(v)}' for provider '${provider}' (valid: ${modelKeys(provider).join(', ')})`,
        }),
      ),
    )
    .default(PROVIDERS[provider].defaultModel)
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return !/^[+-]\d{2}(?::?\d{2})?$/.test(value)
  } catch {
    return false
  }
}

export const AccessibilitySettingsSchema = z.object({
  presentation: z.enum(['standard', 'screen-reader']).default('standard'),
  verbosity: z.enum(['concise', 'balanced', 'detailed']).default('balanced'),
  progressAnnouncements: z.enum(['off', 'milestones', 'timed']).default('milestones'),
  progressIntervalMs: z.number().int().min(10_000).max(3_600_000).default(60_000),
  directSpeech: z.enum(['off', 'exclusive', 'supplemental']).default('off'),
}).strict()
export type AccessibilitySettings = z.infer<typeof AccessibilitySettingsSchema>

export const VmpConnectorSchema = z.object({
  enabled: z.boolean().default(false),
  reportUrl: z.string().url().optional(),
  keyHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict()
export type VmpConnectorSettings = z.infer<typeof VmpConnectorSchema>

/** Jev classification is an account-wide user choice because it sends the current
 * redacted request to an external decision service. Project settings cannot opt in. */
export const JevDecisionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
}).strict()
export type JevDecisionSettings = z.infer<typeof JevDecisionSettingsSchema>

const baseShape = {
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  timeZone: z.string().max(128).refine(isIanaTimeZone, 'Expected a supported IANA timezone').optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  permissionMode: z.enum(['normal', 'acceptEdits', 'plan', 'trusted']).default('normal'),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'unrestricted']).default('workspace-write'),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  // Extra directories added to the unconditional OS write fence. A list of path
  // prefixes, not a rule language. Additive only: entries here extend the
  // environment-derived defaults (see defaultProtectedRoots) and can never
  // shrink them, so a project contributing to this list can only harden, never
  // weaken — which is why it concatenates like `deny` instead of being stripped.
  protectedPaths: z.array(z.string()).default([]),
  hooks: z.array(HookDefSchema).default([]),
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
  accessibility: AccessibilitySettingsSchema.default({}),
  jev: JevDecisionSettingsSchema.default({}),
  vmp: VmpConnectorSchema.default({}),
}

export function makeSettingsSchema(provider: ProviderId = 'anthropic') {
  return z.object({ model: modelSchema(provider), ...baseShape })
}

/** Anthropic-scoped schema — the default, and what pre-provider callers/tests use. */
export const SettingsSchema = makeSettingsSchema('anthropic')
export type Settings = z.infer<typeof SettingsSchema>

// Compile-time guards: settings enums must stay in lockstep with the canonical
// contracts in src/engine/types.ts (import from there, never redefine).
// model sync is enforced at runtime by modelSchema (ModelKey is an open string type).
type _AssertPermissionMode = Settings['permissionMode'] extends PermissionMode ? true : never
type _AssertSandboxMode = Settings['sandboxMode'] extends SandboxMode ? true : never
type _AssertHookEvent = HookDef['event'] extends HookEventName ? true : never
type _AssertEffort = Settings['effort'] extends Effort ? true : never
const _permissionModeInSync: _AssertPermissionMode = true
const _sandboxModeInSync: _AssertSandboxMode = true
const _hookEventInSync: _AssertHookEvent = true
const _effortInSync: _AssertEffort = true
void _permissionModeInSync
void _sandboxModeInSync
void _hookEventInSync
void _effortInSync

function readJsonIfExists(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Malformed JSON in ${file}: ${(err as Error).message}`)
  }
}

/** Cascade: global ~/.athena/settings.json <- project .athena/settings.json.
 *  Scalars: project wins. Rule/hook/protectedPaths arrays: concatenated global-first. Object maps
 *  (mcpServers): project wins wholesale via the base spread — a project that defines
 *  mcpServers replaces the global map entirely, rather than merging server-by-server.
 *  `provider` scopes model validation to the ACTIVE provider's keys. */
export function loadSettings(
  paths: BrainPaths,
  provider: ProviderId = 'anthropic',
  onWarn?: (msg: string) => void,
  policy: {
    projectTrusted?: boolean
    allowProjectHooks?: boolean
    allowProjectMcp?: boolean
  } = {},
): Settings {
  const global = readJsonIfExists(paths.settingsFile)
  const projectTrusted = policy.projectTrusted ?? true
  const project = projectTrusted && paths.projectBrainDir
    ? readJsonIfExists(join(paths.projectBrainDir, 'settings.json'))
    : {}
  if (global['timeZone'] !== undefined && (typeof global['timeZone'] !== 'string' || !isIanaTimeZone(global['timeZone']))) {
    onWarn?.(`Global timezone in ${paths.settingsFile} is invalid; OS local timezone will be inferred for continuity queries.`)
    delete global['timeZone']
  }
  if (Object.prototype.hasOwnProperty.call(project, 'timeZone')) {
    onWarn?.('Project settings cannot override the global user timezone; ignoring project timeZone.')
    delete project['timeZone']
  }
  const globalAccessibility = AccessibilitySettingsSchema.safeParse(global['accessibility'] ?? {})
  if (globalAccessibility.success) {
    global['accessibility'] = globalAccessibility.data
  } else {
    onWarn?.(
      `Global accessibility settings in ${paths.settingsFile} are invalid; using safe defaults. ` +
      `Fix or remove the accessibility object in ${paths.settingsFile}.`,
    )
    global['accessibility'] = AccessibilitySettingsSchema.parse({})
  }
  const globalJev = JevDecisionSettingsSchema.safeParse(global['jev'] ?? {})
  if (globalJev.success) {
    global['jev'] = globalJev.data
  } else {
    onWarn?.(
      `Global Jev settings in ${paths.settingsFile} are invalid; using the enabled-by-default configuration. ` +
      `Fix or remove the jev object in ${paths.settingsFile}.`,
    )
    global['jev'] = JevDecisionSettingsSchema.parse({})
  }
  if (Object.prototype.hasOwnProperty.call(project, 'accessibility')) {
    onWarn?.(
      'Project settings cannot override global accessibility preferences; ignoring project accessibility.',
    )
    delete project['accessibility']
  }
  if (Object.prototype.hasOwnProperty.call(project, 'jev')) {
    onWarn?.('Project settings cannot override global Jev decision settings; ignoring project jev.')
    delete project['jev']
  }
  if (project['permissionMode'] === 'trusted') {
    onWarn?.('Project settings cannot select trusted permission mode; using the global/default mode.')
    delete project['permissionMode']
  }
  if (project['sandboxMode'] === 'unrestricted') {
    onWarn?.('Project settings cannot select unrestricted sandbox mode; using the global/default mode.')
    delete project['sandboxMode']
  }
  if (policy.allowProjectHooks === false) delete project['hooks']
  if (policy.allowProjectMcp === false) delete project['mcpServers']
  const merged: Record<string, unknown> = { ...global, ...project }
  for (const key of ['allow', 'deny', 'hooks', 'protectedPaths'] as const) {
    merged[key] = [...((global[key] as unknown[]) ?? []), ...((project[key] as unknown[]) ?? [])]
  }
  // A model that does not resolve under the ACTIVE provider falls back to that
  // provider's default with a warning instead of throwing. The scaffold writes an
  // anthropic model into a fresh settings.json, so a strict parse under any other
  // provider would be a permanent crash loop; settings must never be one. The
  // schema refine below stays as the backstop.
  if (typeof merged['model'] === 'string' && !normalizeModel(provider, merged['model'])) {
    onWarn?.(
      `settings model '${merged['model']}' is not valid for provider '${provider}', using ${PROVIDERS[provider].defaultModel}`,
    )
    merged['model'] = PROVIDERS[provider].defaultModel
  }
  const result = makeSettingsSchema(provider).safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid settings (${paths.settingsFile}): ${issues}`)
  }
  return result.data
}

export interface ProjectSettingsCapabilities {
  hooks: unknown[]
  mcpServers: Record<string, unknown>
}

/** Reads only the executable project-controlled settings. Callers hash these
 * values for capability-specific approval; changing either invalidates the
 * corresponding grant without revoking trust in ordinary project instructions. */
export function readProjectSettingsCapabilities(paths: BrainPaths): ProjectSettingsCapabilities {
  if (!paths.projectBrainDir) return { hooks: [], mcpServers: {} }
  const project = readJsonIfExists(join(paths.projectBrainDir, 'settings.json'))
  return {
    hooks: Array.isArray(project['hooks']) ? project['hooks'] : [],
    mcpServers:
      project['mcpServers'] && typeof project['mcpServers'] === 'object'
        ? (project['mcpServers'] as Record<string, unknown>)
        : {},
  }
}

/** Persist settings back to the global settings file. Project settings are never
 *  overwritten from here; this is for user-controlled global state such as the
 *  VMP connector configuration. */
export function saveSettings(paths: BrainPaths, settings: Settings): void {
  const parsed = SettingsSchema.parse(settings)
  atomicWriteFileSync(paths.settingsFile, JSON.stringify(parsed, null, 2) + '\n')
}
