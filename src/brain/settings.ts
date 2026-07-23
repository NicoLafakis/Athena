import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { HookEventName, PermissionMode } from '../engine/types.js'
import type { Effort, ModelKey, ProviderId } from './models.js'
import { normalizeModel, modelKeys, PROVIDERS } from './models.js'
import type { BrainPaths } from './paths.js'

export const HookDefSchema = z.object({
  event: z.enum(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']),
  matcher: z.string().optional(), // tool-name matcher for Pre/PostToolUse, e.g. "Bash" or "*"
  command: z.string(), // executable + args, run via the system shell
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
})
export type HookDef = z.infer<typeof HookDefSchema>

// An MCP (Model Context Protocol) server Athena connects to as a client. stdio
// transport only for now — command + args spawn the server process; env is layered
// over the inherited process env. URL/SSE transports are a future seam (add a
// discriminated `transport` field then, defaulting to 'stdio').
export const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
})
export type McpServerConfig = z.infer<typeof McpServerSchema>

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
          message: `unknown model '${String(v)}' for provider '${provider}' — valid: ${modelKeys(provider).join(', ')}`,
        }),
      ),
    )
    .default(PROVIDERS[provider].defaultModel)
}

const baseShape = {
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  permissionMode: z.enum(['normal', 'acceptEdits', 'plan', 'trusted']).default('normal'),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  hooks: z.array(HookDefSchema).default([]),
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
}

export function makeSettingsSchema(provider: ProviderId = 'anthropic') {
  return z.object({ model: modelSchema(provider), ...baseShape })
}

/** Anthropic-scoped schema — the default, and what pre-provider callers/tests use. */
export const SettingsSchema = makeSettingsSchema('anthropic')
export type Settings = z.infer<typeof SettingsSchema>

// Compile-time guards: settings enums must stay in lockstep with the canonical
// contracts in src/engine/types.ts (import from there, never redefine).
type _AssertPermissionMode = Settings['permissionMode'] extends PermissionMode ? true : never
type _AssertHookEvent = HookDef['event'] extends HookEventName ? true : never
type _AssertModel = Settings['model'] extends ModelKey ? true : never
type _AssertEffort = Settings['effort'] extends Effort ? true : never
const _permissionModeInSync: _AssertPermissionMode = true
const _hookEventInSync: _AssertHookEvent = true
const _modelInSync: _AssertModel = true
const _effortInSync: _AssertEffort = true
void _permissionModeInSync
void _hookEventInSync
void _modelInSync
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
 *  Scalars: project wins. Rule/hook arrays: concatenated global-first. Object maps
 *  (mcpServers): project wins wholesale via the base spread — a project that defines
 *  mcpServers replaces the global map entirely, rather than merging server-by-server.
 *  `provider` scopes model validation to the ACTIVE provider's keys. */
export function loadSettings(paths: BrainPaths, provider: ProviderId = 'anthropic'): Settings {
  const global = readJsonIfExists(paths.settingsFile)
  const project = paths.projectBrainDir
    ? readJsonIfExists(join(paths.projectBrainDir, 'settings.json'))
    : {}
  const merged: Record<string, unknown> = { ...global, ...project }
  for (const key of ['allow', 'deny', 'hooks'] as const) {
    merged[key] = [...((global[key] as unknown[]) ?? []), ...((project[key] as unknown[]) ?? [])]
  }
  const result = makeSettingsSchema(provider).safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid settings (${paths.settingsFile}): ${issues}`)
  }
  return result.data
}
