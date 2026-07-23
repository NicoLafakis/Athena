# Athena Auth & Multi-Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace env-var-only auth with a credentials file + first-run wizard, and add Kimi (Moonshot) as a switchable second provider via its Anthropic-compatible endpoint.

**Architecture:** A provider registry generalizes the four-family model table into provider-scoped models; a credentials store (~/.athena/credentials.json, env vars override) feeds a mutable client holder that the engine, orchestrator, and compactor all read through; a pre-TUI wizard and `athena auth` command manage keys.

**Tech Stack:** TypeScript, @anthropic-ai/sdk (baseURL option), zod, existing test runner.

---

Spec: `docs/superpowers/specs/2026-07-23-athena-auth-design.md`. Test runner: **vitest** (`pnpm test` = `vitest run`; single file = `pnpm vitest run <path>`). Test style matches `tests/brain/models.test.ts` / `tests/brain/settings.test.ts` (describe/it/expect, `mkdtempSync` temp homes, imports from `../../src/**/*.js`).

Two conventions used throughout:

- `ProviderId = 'anthropic' | 'kimi'` and `ModelKey = string` (the old `ModelFamily` union is renamed; the four Anthropic family names remain valid keys).
- `provider` parameters default to `'anthropic'` at the Engine/orchestrator seams so the existing test suite stays green while the CLI threads the real value.

**Kimi model ids:** this plan uses `kimi-k2-0711-preview` / `kimi-k2-turbo-preview`. Verify the current ids against https://platform.moonshot.ai docs at implementation time (the ONE permitted deferral in this plan). Base URL is fixed: `https://api.moonshot.ai/anthropic`.

---

## File Structure

**Create:**

- `src/brain/credentials.ts` — zod-validated load/save of `~/.athena/credentials.json` (best-effort 0o600), env-over-file key resolution, redaction, `athena auth status` formatting.
- `src/engine/client-holder.ts` — mutable `ModelClient` wrapper; engine, orchestrator `clientFactory`, and compactor all read through it so `/provider` swaps everywhere at once.
- `src/auth/wizard.ts` — first-run / `athena auth` wizard: provider pick, masked raw-mode key input, live validation call, save.
- `tests/brain/credentials.test.ts` — resolution order, save path + perms, malformed file, redaction.
- `tests/engine/client-holder.test.ts` — stream/complete route through the current client; swap re-routes.
- `tests/auth/wizard.test.ts` — save path, activeProvider update, loop-back on invalid key.
- `tests/cli/args.test.ts` — `auth`, `auth status`, `--provider` parsing.
- `tests/harness/provider-switch.test.ts` — after a holder swap, orchestrator sub-agent calls hit the new provider's client.

**Modify:**

- `src/brain/models.ts` — provider registry (`PROVIDERS`), provider-scoped `MODELS`, provider-aware `modelId`/`modelLabel`/`supportsEffort`/`normalizeModel`/`resolveModelRequest`, `supportsThinking` flag, `normalizeProvider`.
- `src/brain/settings.ts` — `makeSettingsSchema(provider)`; `settings.model` validated against the active provider's keys.
- `src/brain/paths.ts` — add `credentialsFile`.
- `src/engine/loop.ts` — `provider` option + get/set; 401/403 mapped to an actionable auth message.
- `src/engine/client.ts` — optional `baseURL` constructor param.
- `src/harness/agents.ts` — `defaultProvider` thunk; frontmatter model normalized within that provider.
- `src/tui/slash.ts` — `/provider` command.
- `src/tui/App.tsx` — busy-guard also defers `/provider`.
- `src/cli.ts` — `auth` subcommand, `--provider` flag, wizard replaces the hard exit, `ClientHolder` wiring, `/provider` handler, HELP_TEXT.
- `tests/brain/models.test.ts` — rewritten provider-aware.
- `tests/brain/settings.test.ts` — provider-scoped validation cases added.
- `tests/harness/agents.test.ts` — `ModelFamily` import renamed to `ModelKey` (one line).
- `tests/tui/slash.test.ts` — `/provider` parse cases.
- `tests/engine/loop.test.ts` — 401 mapping test added.
- `README.md` — setup rewritten around the wizard; env vars demoted to advanced override.

---

### Task 1: Provider registry + provider-scoped model registry

**Files:**
- Modify: `src/brain/models.ts`
- Test: `tests/brain/models.test.ts` (rewrite)

**Steps:**

- [ ] Rewrite `tests/brain/models.test.ts` with this exact content:

```ts
import { describe, it, expect } from 'vitest'
import {
  PROVIDERS,
  PROVIDER_IDS,
  MODELS,
  EFFORTS,
  modelKeys,
  modelId,
  modelLabel,
  supportsEffort,
  normalizeProvider,
  normalizeModel,
  resolveModelRequest,
} from '../../src/brain/models.js'

describe('provider registry', () => {
  it('exposes exactly two providers and five efforts', () => {
    expect([...PROVIDER_IDS]).toEqual(['anthropic', 'kimi'])
    expect([...EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('anthropic uses the SDK default URL; kimi uses the Moonshot Anthropic-compatible endpoint', () => {
    expect(PROVIDERS.anthropic.baseURL).toBeNull()
    expect(PROVIDERS.kimi.baseURL).toBe('https://api.moonshot.ai/anthropic')
    expect(PROVIDERS.anthropic.envVar).toBe('ANTHROPIC_API_KEY')
    expect(PROVIDERS.kimi.envVar).toBe('MOONSHOT_API_KEY')
  })

  it('per-provider default and validation models exist in that provider registry', () => {
    for (const p of PROVIDER_IDS) {
      expect(modelKeys(p)).toContain(PROVIDERS[p].defaultModel)
      expect(modelKeys(p)).toContain(PROVIDERS[p].validationModel)
    }
  })

  it('normalizeProvider maps names (moonshot alias included), null otherwise', () => {
    expect(normalizeProvider('anthropic')).toBe('anthropic')
    expect(normalizeProvider(' KIMI ')).toBe('kimi')
    expect(normalizeProvider('moonshot')).toBe('kimi')
    expect(normalizeProvider('openai')).toBeNull()
    expect(normalizeProvider('')).toBeNull()
  })
})

describe('provider-scoped model registry', () => {
  it('keeps the four Anthropic families with their current ids and labels', () => {
    expect(modelKeys('anthropic')).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(modelId('anthropic', 'haiku')).toBe('claude-haiku-4-5')
    expect(modelId('anthropic', 'sonnet')).toBe('claude-sonnet-5')
    expect(modelId('anthropic', 'opus')).toBe('claude-opus-4-8')
    expect(modelId('anthropic', 'fable')).toBe('claude-fable-5')
    expect(modelLabel('anthropic', 'opus')).toBe('Opus 4.8')
  })

  it('anthropic effort/thinking flags: haiku has neither, the other three have both', () => {
    expect(supportsEffort('anthropic', 'haiku')).toBe(false)
    expect(MODELS.anthropic['haiku']!.supportsThinking).toBe(false)
    for (const k of ['sonnet', 'opus', 'fable']) {
      expect(supportsEffort('anthropic', k)).toBe(true)
      expect(MODELS.anthropic[k]!.supportsThinking).toBe(true)
    }
  })

  it('kimi models never support effort or thinking', () => {
    expect(modelKeys('kimi').length).toBeGreaterThan(0)
    for (const k of modelKeys('kimi')) {
      expect(MODELS.kimi[k]!.supportsEffort).toBe(false)
      expect(MODELS.kimi[k]!.supportsThinking).toBe(false)
    }
  })

  it('modelId throws a clear error for a cross-provider key', () => {
    expect(() => modelId('kimi', 'sonnet')).toThrow(/Unknown model 'sonnet' for provider 'kimi'/)
    expect(() => modelId('anthropic', 'kimi-k2')).toThrow(/Unknown model 'kimi-k2'/)
  })
})

describe('normalizeModel (scoped to the active provider)', () => {
  it.each([
    ['haiku', 'haiku'],
    ['sonnet', 'sonnet'],
    ['opus', 'opus'],
    ['fable', 'fable'],
    ['  OPUS  ', 'opus'],
    ['Sonnet', 'sonnet'],
  ] as const)('anthropic: maps family name %s -> %s', (input, expected) => {
    expect(normalizeModel('anthropic', input)).toBe(expected)
  })

  it.each([
    ['claude-opus-4-8', 'opus'],
    ['claude-sonnet-4-5', 'sonnet'], // legacy id still resolves (non-breaking)
    ['claude-sonnet-5', 'sonnet'],
    ['claude-haiku-4-5', 'haiku'],
    ['claude-fable-5', 'fable'],
  ] as const)('anthropic: maps legacy/full id %s -> %s', (input, expected) => {
    expect(normalizeModel('anthropic', input)).toBe(expected)
  })

  it('kimi: resolves keys and full ids, preferring the longest key on substrings', () => {
    expect(normalizeModel('kimi', 'kimi-k2')).toBe('kimi-k2')
    expect(normalizeModel('kimi', 'kimi-k2-0711-preview')).toBe('kimi-k2')
    expect(normalizeModel('kimi', 'kimi-k2-turbo')).toBe('kimi-k2-turbo')
    expect(normalizeModel('kimi', 'kimi-k2-turbo-preview')).toBe('kimi-k2-turbo')
  })

  it('does NOT resolve cross-provider names', () => {
    expect(normalizeModel('kimi', 'sonnet')).toBeNull()
    expect(normalizeModel('kimi', 'claude-opus-4-8')).toBeNull()
    expect(normalizeModel('anthropic', 'kimi-k2')).toBeNull()
  })

  it.each(['', '   ', 'gpt-4', 'gemini', 'bogus'])('returns null for unrecognized %j', (input) => {
    expect(normalizeModel('anthropic', input)).toBeNull()
    expect(normalizeModel('kimi', input)).toBeNull()
  })
})

describe('resolveModelRequest (capability gating lives HERE, nowhere else)', () => {
  it('anthropic haiku carries NO effort and NO thinking (both 400 on it)', () => {
    const req = resolveModelRequest('anthropic', 'haiku', 'high')
    expect(req).toEqual({ model: 'claude-haiku-4-5' })
    expect('effort' in req).toBe(false)
    expect('thinking' in req).toBe(false)
  })

  it.each(['sonnet', 'opus', 'fable'] as const)(
    'anthropic %s carries the effort dial + adaptive thinking',
    (key) => {
      const req = resolveModelRequest('anthropic', key, 'xhigh')
      expect(req.model).toBe(modelId('anthropic', key))
      expect(req.effort).toBe('xhigh')
      expect(req.thinking).toEqual({ type: 'adaptive' })
    },
  )

  it('every kimi model carries NEITHER effort nor thinking (would 400 on Moonshot)', () => {
    for (const k of modelKeys('kimi')) {
      const req = resolveModelRequest('kimi', k, 'high')
      expect(req).toEqual({ model: MODELS.kimi[k]!.id })
    }
  })
})
```

- [ ] Run `pnpm vitest run tests/brain/models.test.ts` — expect FAIL: `SyntaxError: The requested module '../../src/brain/models.js' does not provide an export named 'PROVIDERS'`.
- [ ] Rewrite `src/brain/models.ts` with this exact content:

```ts
// src/brain/models.ts — single source of truth for providers and their models.
// MODELS is provider-scoped: provider -> { modelKey -> entry }. Per-entry capability
// flags gate which request parameters are legal: sending an unsupported field
// (output_config.effort to Haiku or any Kimi model, thinking to Kimi) returns HTTP 400.
// resolveModelRequest is the ONLY place allowed to assemble effort/thinking, so those
// landmines live in one spot.

export type ProviderId = 'anthropic' | 'kimi'
export type ModelKey = string
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Legacy `enabled` (budget_tokens) is kept in the union for completeness, but it MUST
// NOT reach sonnet-5/opus-4-8/fable-5 — those speak `adaptive` only. resolveModelRequest
// never emits `enabled`.
export type ThinkingParam =
  | { type: 'adaptive' }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }

export const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'kimi']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ProviderEntry {
  label: string
  /** null = SDK default (api.anthropic.com); otherwise passed to the SDK as baseURL. */
  baseURL: string | null
  /** Env var that overrides the credentials file for this provider. */
  envVar: string
  defaultModel: ModelKey
  /** Cheapest model — the auth wizard's live validation call targets this. */
  validationModel: ModelKey
}

export const PROVIDERS: Record<ProviderId, ProviderEntry> = {
  anthropic: {
    label: 'Anthropic',
    baseURL: null,
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'sonnet',
    validationModel: 'haiku',
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseURL: 'https://api.moonshot.ai/anthropic',
    envVar: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k2',
    validationModel: 'kimi-k2',
  },
}

export interface ModelEntry {
  id: string
  label: string
  supportsEffort: boolean
  supportsThinking: boolean
}

// NOTE: verify the current Kimi ids against https://platform.moonshot.ai docs at
// implementation time; the kimi-k2-*-preview ids below are the documented lineage
// as of planning.
export const MODELS: Record<ProviderId, Record<ModelKey, ModelEntry>> = {
  anthropic: {
    haiku: { id: 'claude-haiku-4-5', label: 'Haiku 4.5', supportsEffort: false, supportsThinking: false },
    sonnet: { id: 'claude-sonnet-5', label: 'Sonnet 5', supportsEffort: true, supportsThinking: true },
    opus: { id: 'claude-opus-4-8', label: 'Opus 4.8', supportsEffort: true, supportsThinking: true },
    fable: { id: 'claude-fable-5', label: 'Fable 5', supportsEffort: true, supportsThinking: true },
  },
  kimi: {
    'kimi-k2': { id: 'kimi-k2-0711-preview', label: 'Kimi K2', supportsEffort: false, supportsThinking: false },
    'kimi-k2-turbo': { id: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo', supportsEffort: false, supportsThinking: false },
  },
}

export function normalizeProvider(input: string): ProviderId | null {
  const s = input.trim().toLowerCase()
  if (s === 'moonshot') return 'kimi'
  return PROVIDER_IDS.find((p) => p === s) ?? null
}

export function modelKeys(provider: ProviderId): ModelKey[] {
  return Object.keys(MODELS[provider])
}

function entry(provider: ProviderId, key: ModelKey): ModelEntry {
  const e = MODELS[provider][key]
  if (!e) {
    throw new Error(
      `Unknown model '${key}' for provider '${provider}' (valid: ${modelKeys(provider).join(', ')})`,
    )
  }
  return e
}

export function modelId(provider: ProviderId, key: ModelKey): string {
  return entry(provider, key).id
}

export function modelLabel(provider: ProviderId, key: ModelKey): string {
  return entry(provider, key).label
}

export function supportsEffort(provider: ProviderId, key: ModelKey): boolean {
  return entry(provider, key).supportsEffort
}

/** Accepts a model key (case-insensitive, trimmed) OR a legacy/full model id and maps
 *  it to a key WITHIN the given provider only. Exact key/id match first, then a
 *  longest-key substring pass so `claude-sonnet-4-5` -> sonnet stays working and
 *  `kimi-k2-turbo-preview` hits kimi-k2-turbo, not kimi-k2. Returns null for anything
 *  unrecognized so callers can surface a clear error. */
export function normalizeModel(provider: ProviderId, input: string): ModelKey | null {
  const s = input.trim().toLowerCase()
  if (s === '') return null
  const keys = modelKeys(provider)
  for (const k of keys) {
    if (s === k || s === MODELS[provider][k]!.id.toLowerCase()) return k
  }
  for (const k of [...keys].sort((a, b) => b.length - a.length)) {
    if (s.includes(k)) return k
  }
  return null
}

/** The crux: assemble the wire parameters for provider + model key + effort. Effort and
 *  thinking are attached ONLY when the entry supports them — Anthropic Haiku and all
 *  Kimi models get a bare { model }. Adaptive thinking MUST be sent explicitly where
 *  supported or Opus runs with no thinking at all. Never emits legacy budget_tokens
 *  thinking — that shape 400s on sonnet-5/opus-4-8/fable-5. */
export function resolveModelRequest(
  provider: ProviderId,
  key: ModelKey,
  effort: Effort,
): { model: string; effort?: Effort; thinking?: ThinkingParam } {
  const e = entry(provider, key)
  const req: { model: string; effort?: Effort; thinking?: ThinkingParam } = { model: e.id }
  if (e.supportsEffort) req.effort = effort
  if (e.supportsThinking) req.thinking = { type: 'adaptive' }
  return req
}
```

- [ ] Run `pnpm vitest run tests/brain/models.test.ts` — expect PASS (all suites). Note: `pnpm typecheck` is expected RED until Task 3 updates the consumers — do not run it as a gate yet.
- [ ] Commit:

```
git add src/brain/models.ts tests/brain/models.test.ts
git commit -m "feat(models): provider-scoped model registry (anthropic + kimi) with per-entry effort/thinking gating

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Settings model validated against the active provider

**Files:**
- Modify: `src/brain/settings.ts`
- Test: `tests/brain/settings.test.ts` (add cases)

**Steps:**

- [ ] Append this describe block to `tests/brain/settings.test.ts` (after the existing `loadSettings` describe; add `makeSettingsSchema` to the existing import from `../../src/brain/settings.js`):

```ts
describe('provider-scoped model validation', () => {
  it('anthropic schema accepts the four family names and normalizes legacy ids', () => {
    const schema = makeSettingsSchema('anthropic')
    expect(schema.parse({ model: 'fable' }).model).toBe('fable')
    expect(schema.parse({ model: 'claude-opus-4-8' }).model).toBe('opus')
    expect(schema.parse({}).model).toBe('sonnet')
  })

  it('kimi schema accepts kimi keys and defaults to kimi-k2', () => {
    const schema = makeSettingsSchema('kimi')
    expect(schema.parse({ model: 'kimi-k2-turbo' }).model).toBe('kimi-k2-turbo')
    expect(schema.parse({ model: 'kimi-k2-0711-preview' }).model).toBe('kimi-k2')
    expect(schema.parse({}).model).toBe('kimi-k2')
  })

  it('rejects cross-provider keys with an error naming the provider and valid keys', () => {
    expect(() => makeSettingsSchema('kimi').parse({ model: 'sonnet' })).toThrow(
      /unknown model 'sonnet' for provider 'kimi'.*kimi-k2/,
    )
    expect(() => makeSettingsSchema('anthropic').parse({ model: 'kimi-k2' })).toThrow(
      /unknown model 'kimi-k2' for provider 'anthropic'.*haiku, sonnet, opus, fable/,
    )
  })

  it('loadSettings validates against the provider it is given', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ model: 'opus' }))
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    expect(loadSettings(paths, 'anthropic').model).toBe('opus')
    expect(() => loadSettings(paths, 'kimi')).toThrow(/unknown model 'opus' for provider 'kimi'/)
  })
})
```

- [ ] Run `pnpm vitest run tests/brain/settings.test.ts` — expect FAIL: `does not provide an export named 'makeSettingsSchema'`.
- [ ] Rewrite `src/brain/settings.ts` with this exact content:

```ts
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
```

- [ ] Run `pnpm vitest run tests/brain/settings.test.ts` — expect PASS (existing cases still green: `model` is now a string but 'sonnet'/'opus'/'haiku' values and legacy-id normalization behave identically).
- [ ] Commit:

```
git add src/brain/settings.ts tests/brain/settings.test.ts
git commit -m "feat(settings): validate settings.model against the active provider's model keys

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Thread provider through engine, orchestrator, and CLI

**Files:**
- Modify: `src/engine/loop.ts`, `src/harness/agents.ts`, `src/cli.ts`, `tests/harness/agents.test.ts`
- Test: existing suite (`pnpm test`) + `pnpm typecheck` as the gate

**Steps:**

- [ ] In `src/engine/loop.ts`, change the models import and `EngineOptions`:

```ts
import { modelId, resolveModelRequest, type ProviderId, type ModelKey, type Effort } from '../brain/models.js'
```

and in `EngineOptions` replace `model: ModelFamily` with:

```ts
  /** Active provider; defaults to 'anthropic' so pre-provider constructions keep working. */
  provider?: ProviderId
  model: ModelKey
```

- [ ] In `src/engine/loop.ts`, replace the `setModel`/`getModel`/`getModelId` block with:

```ts
  setModel(key: ModelKey): void {
    this.opts.model = key
  }

  getModel(): ModelKey {
    return this.opts.model
  }

  setProvider(p: ProviderId): void {
    this.opts.provider = p
  }

  getProvider(): ProviderId {
    return this.opts.provider ?? 'anthropic'
  }

  /** Resolved wire id for the current provider+key — what the API and the compactor need. */
  getModelId(): string {
    return modelId(this.getProvider(), this.opts.model)
  }
```

- [ ] In `src/engine/loop.ts` `runTurnInner`, replace the `resolveModelRequest` call:

```ts
      // Resolve provider+key -> wire id + per-model effort/thinking. Anthropic Haiku and
      // all Kimi models return neither (both 400 there); gating lives in resolveModelRequest.
      const req = resolveModelRequest(this.getProvider(), this.opts.model, this.opts.effort)
```

- [ ] In `src/harness/agents.ts`, update the import and options:

```ts
import { normalizeModel, type ProviderId, type ModelKey, type Effort } from '../brain/models.js'
```

In `AgentOrchestratorOptions` replace `defaultModel: () => ModelFamily` with:

```ts
  /** Thunk, not a snapshot: read at spawn time so /model mid-session reaches sub-agents. */
  defaultModel: () => ModelKey
  /** Thunk, same reason: /provider mid-session reaches later sub-agents. Defaults to anthropic. */
  defaultProvider?: () => ProviderId
```

In `runAgent`, before the `new Engine({...})` construction add `const provider = this.opts.defaultProvider?.() ?? 'anthropic'` and inside the Engine options replace the `model:` line with:

```ts
      provider,
      // Frontmatter `model` is a raw string (key or legacy id); normalize it within the
      // active provider, falling back to the session default when absent or unrecognized.
      model: normalizeModel(provider, def.model ?? '') ?? this.opts.defaultModel(),
```

- [ ] In `tests/harness/agents.test.ts` line 11, change `import type { ModelFamily } from '../../src/brain/models.js'` to `import type { ModelKey } from '../../src/brain/models.js'` and rename any `ModelFamily` usages in that file to `ModelKey`.
- [ ] In `src/cli.ts`, make the existing wiring provider-aware (still hardcoded to anthropic until Task 7). Change the models import to:

```ts
import { normalizeModel, modelLabel, supportsEffort, type ProviderId } from './brain/models.js'
```

In `main()` insert `const provider: ProviderId = 'anthropic'` immediately after the API-key check, change `loadSettings(paths)` to `loadSettings(paths, provider)`, add `provider,` to the `new Engine({...})` options, add `defaultProvider: () => engine.getProvider(),` to the orchestrator options, and change the render status line to `model: modelLabel(provider, settings.model),`.
- [ ] In `makeSlashHandler` update the two provider-scoped call sites — `case 'model'`:

```ts
      case 'model': {
        const provider = engine.getProvider()
        const key = normalizeModel(provider, cmd.value)
        if (!key) {
          info(`Unknown model: ${cmd.value} — choose one of the ${provider} models (see /help).`)
          break
        }
        engine.setModel(key)
        bus.emit({ type: 'status', patch: { model: modelLabel(provider, key) } })
        info(
          supportsEffort(provider, key)
            ? `Model: ${modelLabel(provider, key)} (effort ${engine.getEffort()})`
            : `Model: ${modelLabel(provider, key)} — effort/extended thinking not applicable on this model.`,
        )
        break
      }
```

and `case 'effort'`:

```ts
      case 'effort': {
        engine.setEffort(cmd.value)
        bus.emit({ type: 'status', patch: { effort: cmd.value } })
        const provider = engine.getProvider()
        const key = engine.getModel()
        info(
          supportsEffort(provider, key)
            ? `Effort: ${cmd.value}`
            : `Effort set to ${cmd.value} — ${modelLabel(provider, key)} ignores it.`,
        )
        break
      }
```

- [ ] Run `pnpm typecheck` — expect PASS (this is the gate that Task 1's rename left red). Then run `pnpm test` — expect PASS (Engine/orchestrator provider defaults keep every existing test green).
- [ ] Commit:

```
git add src/engine/loop.ts src/harness/agents.ts src/cli.ts tests/harness/agents.test.ts
git commit -m "feat(engine): thread ProviderId through engine, orchestrator thunks, and CLI wiring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Credentials store

**Files:**
- Modify: `src/brain/paths.ts`
- Create: `src/brain/credentials.ts`
- Test: `tests/brain/credentials.test.ts`

**Steps:**

- [ ] Write `tests/brain/credentials.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import {
  loadCredentials,
  saveCredentials,
  setProviderKey,
  resolveApiKey,
  redactKey,
  CredentialsSchema,
} from '../../src/brain/credentials.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-proj-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

const paths = () => resolveBrainPaths({ cwd: project, homeOverride: home })

describe('credentials load/save', () => {
  it('paths expose credentialsFile under the brain dir', () => {
    expect(paths().credentialsFile).toBe(join(home, '.athena', 'credentials.json'))
  })

  it('missing file loads schema defaults (no providers, anthropic active)', () => {
    const creds = loadCredentials(paths())
    expect(creds.providers).toEqual({})
    expect(creds.activeProvider).toBe('anthropic')
  })

  it('save + load round-trips and setProviderKey updates activeProvider', () => {
    const p = paths()
    saveCredentials(p, {
      providers: { anthropic: { apiKey: 'sk-ant-file-key' } },
      activeProvider: 'anthropic',
    })
    expect(loadCredentials(p).providers.anthropic?.apiKey).toBe('sk-ant-file-key')

    const next = setProviderKey(p, 'kimi', 'sk-kimi-key')
    expect(next.activeProvider).toBe('kimi')
    expect(next.providers.anthropic?.apiKey).toBe('sk-ant-file-key') // merged, not replaced
    expect(loadCredentials(p).providers.kimi?.apiKey).toBe('sk-kimi-key')
    expect(existsSync(p.credentialsFile)).toBe(true)
  })

  it('applies 0o600 on POSIX (best-effort no-op on Windows)', () => {
    const p = paths()
    setProviderKey(p, 'anthropic', 'sk-ant-x')
    if (process.platform !== 'win32') {
      expect(statSync(p.credentialsFile).mode & 0o777).toBe(0o600)
    } else {
      expect(existsSync(p.credentialsFile)).toBe(true)
    }
  })

  it('malformed JSON throws an actionable error naming the file and athena auth', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(p.credentialsFile, '{ not json', 'utf8')
    expect(() => loadCredentials(p)).toThrow(/credentials\.json/)
    expect(() => loadCredentials(p)).toThrow(/athena auth/)
  })

  it('unknown providers are rejected with a clear error', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(
      p.credentialsFile,
      JSON.stringify({ providers: { openai: { apiKey: 'x' } }, activeProvider: 'anthropic' }),
      'utf8',
    )
    expect(() => loadCredentials(p)).toThrow(/openai/)
    expect(() => loadCredentials(p)).toThrow(/athena auth/)
  })

  it('setProviderKey regenerates over a malformed file instead of throwing', () => {
    const p = paths()
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(p.credentialsFile, '{ not json', 'utf8')
    const creds = setProviderKey(p, 'anthropic', 'sk-ant-new')
    expect(creds.providers.anthropic?.apiKey).toBe('sk-ant-new')
    expect(loadCredentials(p).activeProvider).toBe('anthropic')
  })
})

describe('resolveApiKey (env over file, per provider)', () => {
  const creds = CredentialsSchema.parse({
    providers: { anthropic: { apiKey: 'sk-ant-from-file' }, kimi: { apiKey: 'sk-kimi-from-file' } },
    activeProvider: 'anthropic',
  })

  it('env var wins over the file, per provider', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-from-env' }
    expect(resolveApiKey('anthropic', creds, env)).toEqual({ key: 'sk-ant-from-env', source: 'env' })
    expect(resolveApiKey('kimi', creds, env)).toEqual({ key: 'sk-kimi-from-file', source: 'file' })
  })

  it('falls back to the file, and to null when neither exists', () => {
    expect(resolveApiKey('anthropic', creds, {})).toEqual({ key: 'sk-ant-from-file', source: 'file' })
    expect(resolveApiKey('kimi', CredentialsSchema.parse({}), {})).toBeNull()
  })

  it('MOONSHOT_API_KEY is the kimi env var', () => {
    expect(resolveApiKey('kimi', creds, { MOONSHOT_API_KEY: 'sk-kimi-env' })).toEqual({
      key: 'sk-kimi-env',
      source: 'env',
    })
  })
})

describe('redactKey', () => {
  it('keeps only prefix and last 4 chars', () => {
    expect(redactKey('sk-ant-api03-abcdefabc4')).toBe('sk-ant...abc4')
  })
  it('never leaks short keys', () => {
    expect(redactKey('short')).toBe('***')
    expect(redactKey('')).toBe('***')
  })
})
```

- [ ] Run `pnpm vitest run tests/brain/credentials.test.ts` — expect FAIL: `Failed to load ../../src/brain/credentials.js` (module does not exist).
- [ ] In `src/brain/paths.ts`, add `credentialsFile: string` to the `BrainPaths` interface (after `settingsFile`) and `credentialsFile: join(brainDir, 'credentials.json'),` to the returned object in `resolveBrainPaths` (after `settingsFile`).
- [ ] Write `src/brain/credentials.ts`:

```ts
// src/brain/credentials.ts — ~/.athena/credentials.json: per-provider API keys plus the
// persisted default provider. Resolution order per provider: explicit env var overrides
// the file (existing env-var setups keep working); the file is the documented path.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { PROVIDERS, type ProviderId } from './models.js'
import type { BrainPaths } from './paths.js'

const ProviderCredSchema = z.object({ apiKey: z.string().min(1) })

export const CredentialsSchema = z.object({
  providers: z
    .object({
      anthropic: ProviderCredSchema.optional(),
      kimi: ProviderCredSchema.optional(),
    })
    .strict() // unknown providers are rejected, not silently kept
    .default({}),
  activeProvider: z.enum(['anthropic', 'kimi']).default('anthropic'),
})
export type Credentials = z.infer<typeof CredentialsSchema>

/** Missing file -> defaults. Malformed/invalid file -> actionable error (never a raw
 *  parse stack): names the file and offers `athena auth` to regenerate. */
export function loadCredentials(paths: BrainPaths): Credentials {
  if (!existsSync(paths.credentialsFile)) return CredentialsSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(paths.credentialsFile, 'utf8'))
  } catch {
    throw new Error(
      `Malformed credentials file ${paths.credentialsFile} — run \`athena auth\` to regenerate it.`,
    )
  }
  const result = CredentialsSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(
      `Invalid credentials file ${paths.credentialsFile} (${issues}) — run \`athena auth\` to regenerate it.`,
    )
  }
  return result.data
}

/** Owner-only permissions are best-effort: 0o600 on POSIX; chmod is a no-op on
 *  Windows/NTFS, where the file relies on the user-profile directory ACL. */
export function saveCredentials(paths: BrainPaths, creds: Credentials): void {
  mkdirSync(dirname(paths.credentialsFile), { recursive: true })
  writeFileSync(paths.credentialsFile, JSON.stringify(creds, null, 2) + '\n', 'utf8')
  try {
    chmodSync(paths.credentialsFile, 0o600)
  } catch {
    /* best-effort */
  }
}

/** Merge one provider's key in and make it the active provider. Tolerates a malformed
 *  existing file (this IS the regeneration path `athena auth` promises). */
export function setProviderKey(paths: BrainPaths, provider: ProviderId, key: string): Credentials {
  let creds: Credentials
  try {
    creds = loadCredentials(paths)
  } catch {
    creds = CredentialsSchema.parse({})
  }
  const next: Credentials = {
    providers: { ...creds.providers, [provider]: { apiKey: key } },
    activeProvider: provider,
  }
  saveCredentials(paths, next)
  return next
}

export interface ResolvedKey {
  key: string
  source: 'env' | 'file'
}

export function resolveApiKey(
  provider: ProviderId,
  creds: Credentials,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKey | null {
  const envKey = env[PROVIDERS[provider].envVar]
  if (envKey) return { key: envKey, source: 'env' }
  const fileKey = creds.providers[provider]?.apiKey
  if (fileKey) return { key: fileKey, source: 'file' }
  return null
}

/** `sk-ant-api03-...abc4` -> `sk-ant...abc4`. Short keys collapse to '***' so a
 *  redacted rendering can never reconstruct the key. */
export function redactKey(key: string): string {
  if (key.length <= 10) return '***'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}
```

- [ ] Run `pnpm vitest run tests/brain/credentials.test.ts` — expect PASS. Also `pnpm vitest run tests/brain/paths.test.ts` — expect PASS (interface addition only).
- [ ] Commit:

```
git add src/brain/paths.ts src/brain/credentials.ts tests/brain/credentials.test.ts
git commit -m "feat(credentials): ~/.athena/credentials.json store with env-over-file resolution and redaction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: AnthropicClient baseURL + mutable ClientHolder

**Files:**
- Modify: `src/engine/client.ts`
- Create: `src/engine/client-holder.ts`
- Test: `tests/engine/client-holder.test.ts`

**Steps:**

- [ ] Write `tests/engine/client-holder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ClientHolder } from '../../src/engine/client-holder.js'
import { AnthropicClient } from '../../src/engine/client.js'
import type { ModelClient, StreamResult } from '../../src/engine/client.js'
import { MockAnthropicClient, textBlock } from '../helpers/mock-client.js'

function namedClient(name: string, log: string[]): ModelClient {
  const inner = new MockAnthropicClient([{ blocks: [textBlock(name)], stopReason: 'end_turn' }])
  return {
    stream(params, callbacks): Promise<StreamResult> {
      log.push(`${name}:stream`)
      return inner.stream(params, callbacks)
    },
    complete(params): Promise<string> {
      log.push(`${name}:complete`)
      return inner.complete(params)
    },
  }
}

describe('ClientHolder', () => {
  it('routes stream and complete through the CURRENT client, and swap re-routes both', async () => {
    const log: string[] = []
    const holder = new ClientHolder(namedClient('a', log))
    await holder.stream(
      {
        model: 'm',
        system: 's',
        messages: [],
        tools: [],
        maxTokens: 10,
        signal: new AbortController().signal,
      },
      { onTextDelta: () => {}, onThinkingDelta: () => {} },
    )
    await holder.complete({ model: 'm', prompt: 'p', maxTokens: 10 })
    holder.swap(namedClient('b', log))
    await holder.complete({ model: 'm', prompt: 'p', maxTokens: 10 })
    expect(log).toEqual(['a:stream', 'a:complete', 'b:complete'])
  })

  it('is itself a ModelClient, so engine/orchestrator/compactor can hold it directly', () => {
    const holder: ModelClient = new ClientHolder(new MockAnthropicClient([]))
    expect(typeof holder.stream).toBe('function')
    expect(typeof holder.complete).toBe('function')
  })
})

describe('AnthropicClient baseURL', () => {
  it('passes baseURL through to the SDK when given', () => {
    const c = new AnthropicClient('sk-x', 'https://api.moonshot.ai/anthropic')
    const sdk = (c as unknown as { sdk: { baseURL: string } }).sdk
    expect(sdk.baseURL).toBe('https://api.moonshot.ai/anthropic')
  })

  it('keeps the SDK default when omitted', () => {
    const c = new AnthropicClient('sk-x')
    const sdk = (c as unknown as { sdk: { baseURL: string } }).sdk
    expect(sdk.baseURL).toBe('https://api.anthropic.com')
  })
})
```

- [ ] Run `pnpm vitest run tests/engine/client-holder.test.ts` — expect FAIL: `Failed to load ../../src/engine/client-holder.js`.
- [ ] In `src/engine/client.ts`, replace the `AnthropicClient` constructor:

```ts
  constructor(apiKey?: string, baseURL?: string) {
    this.sdk = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
  }
```

- [ ] Write `src/engine/client-holder.ts`:

```ts
// src/engine/client-holder.ts — one mutable indirection over ModelClient. The engine,
// the orchestrator's clientFactory, and the compactor's complete() all hold THIS object,
// so a /provider swap reaches every call site at once — sub-agents and compaction can
// never be left on the old provider's client.
import type { ModelClient, StreamCallbacks, StreamResult } from './client.js'

export class ClientHolder implements ModelClient {
  private current: ModelClient

  constructor(initial: ModelClient) {
    this.current = initial
  }

  swap(next: ModelClient): void {
    this.current = next
  }

  get(): ModelClient {
    return this.current
  }

  stream(
    params: Parameters<ModelClient['stream']>[0],
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    return this.current.stream(params, callbacks)
  }

  complete(params: { model: string; prompt: string; maxTokens: number }): Promise<string> {
    return this.current.complete(params)
  }
}
```

- [ ] Run `pnpm vitest run tests/engine/client-holder.test.ts tests/engine/client.test.ts` — expect PASS (the constructor change is backward compatible: first positional arg is still the apiKey).
- [ ] Commit:

```
git add src/engine/client.ts src/engine/client-holder.ts tests/engine/client-holder.test.ts
git commit -m "feat(client): baseURL option + mutable ClientHolder read by engine, orchestrator, compactor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Auth wizard module (masked input + live validation + save)

**Files:**
- Create: `src/auth/wizard.ts`
- Test: `tests/auth/wizard.test.ts`

**Steps:**

- [ ] Write `tests/auth/wizard.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { loadCredentials } from '../../src/brain/credentials.js'
import { runAuthWizard, type WizardIO } from '../../src/auth/wizard.js'
import type { ProviderId } from '../../src/brain/models.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-proj-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

function fakeIO(provider: ProviderId, keys: string[], said: string[]): WizardIO {
  let i = 0
  return {
    say: (m) => said.push(m),
    pickProvider: async () => provider,
    readKey: async () => keys[i++] ?? '',
  }
}

describe('runAuthWizard', () => {
  it('saves the key, sets activeProvider, and returns provider+key on first valid entry', async () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const said: string[] = []
    const result = await runAuthWizard({
      paths,
      io: fakeIO('kimi', ['sk-kimi-valid'], said),
      validate: async () => null,
    })
    expect(result).toEqual({ provider: 'kimi', key: 'sk-kimi-valid' })
    const creds = loadCredentials(paths)
    expect(creds.activeProvider).toBe('kimi')
    expect(creds.providers.kimi?.apiKey).toBe('sk-kimi-valid')
  })

  it('loops back on a rejected key, surfacing the provider error, then saves the good one', async () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const said: string[] = []
    const validated: string[] = []
    const result = await runAuthWizard({
      paths,
      provider: 'anthropic', // scoped: pickProvider must NOT be called
      io: {
        say: (m) => said.push(m),
        pickProvider: async () => {
          throw new Error('pickProvider must not be called when provider is scoped')
        },
        readKey: (() => {
          const keys = ['sk-bad', 'sk-good']
          let i = 0
          return async () => keys[i++] ?? ''
        })(),
      },
      validate: async (_p, key) => {
        validated.push(key)
        return key === 'sk-bad' ? 'invalid x-api-key' : null
      },
    })
    expect(validated).toEqual(['sk-bad', 'sk-good'])
    expect(result.key).toBe('sk-good')
    expect(said.join('\n')).toMatch(/invalid x-api-key/)
    expect(loadCredentials(paths).providers.anthropic?.apiKey).toBe('sk-good')
  })

  it('re-prompts on an empty key without calling validate', async () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const said: string[] = []
    const validated: string[] = []
    await runAuthWizard({
      paths,
      io: fakeIO('anthropic', ['', '  ', 'sk-ok'], said),
      validate: async (_p, key) => {
        validated.push(key)
        return null
      },
    })
    expect(validated).toEqual(['sk-ok'])
  })
})
```

- [ ] Run `pnpm vitest run tests/auth/wizard.test.ts` — expect FAIL: `Failed to load ../../src/auth/wizard.js`.
- [ ] Write `src/auth/wizard.ts`:

```ts
// src/auth/wizard.ts — first-run and `athena auth` setup: pick provider, paste key
// (masked), validate with a minimal live call to the provider's cheapest model, save to
// ~/.athena/credentials.json, set activeProvider. Runs PRE-TUI (plain stdin/stdout —
// Ink is not mounted yet), so a manual raw-mode echo handler does the masking; Node's
// readline cannot mask input natively.
import { createInterface } from 'node:readline'
import { PROVIDERS, PROVIDER_IDS, modelId, type ProviderId } from '../brain/models.js'
import { setProviderKey } from '../brain/credentials.js'
import type { BrainPaths } from '../brain/paths.js'
import { AnthropicClient } from '../engine/client.js'

export interface WizardIO {
  say(message: string): void
  pickProvider(): Promise<ProviderId>
  readKey(provider: ProviderId): Promise<string>
}

/** null = key accepted; otherwise the provider's error message. */
export type ValidateFn = (provider: ProviderId, key: string) => Promise<string | null>

/** Live check: one minimal message to the provider's cheapest model. */
export async function validateKey(provider: ProviderId, key: string): Promise<string | null> {
  try {
    const client = new AnthropicClient(key, PROVIDERS[provider].baseURL ?? undefined)
    await client.complete({
      model: modelId(provider, PROVIDERS[provider].validationModel),
      prompt: 'hi',
      maxTokens: 1,
    })
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export async function runAuthWizard(opts: {
  paths: BrainPaths
  /** When set, the wizard is scoped to this provider and skips the provider pick. */
  provider?: ProviderId
  io?: WizardIO
  validate?: ValidateFn
}): Promise<{ provider: ProviderId; key: string }> {
  const io = opts.io ?? terminalIO()
  const validate = opts.validate ?? validateKey
  const provider = opts.provider ?? (await io.pickProvider())
  for (;;) {
    const key = (await io.readKey(provider)).trim()
    if (key === '') {
      io.say('Empty key — paste your API key (input is hidden).')
      continue
    }
    io.say(`Validating against ${PROVIDERS[provider].label}…`)
    const error = await validate(provider, key)
    if (error !== null) {
      io.say(`Key rejected: ${error}\nTry again (Ctrl-C to abort).`)
      continue
    }
    setProviderKey(opts.paths, provider, key)
    io.say(`Saved to ${opts.paths.credentialsFile}. Active provider: ${provider}.`)
    return { provider, key }
  }
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** Masked input: raw mode, echo '*' per char, handle backspace/Ctrl-C/Enter manually. */
export function promptMasked(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question)
    const stdin = process.stdin
    const wasRaw = stdin.isRaw ?? false
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const finish = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish()
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          // Ctrl-C: restore the terminal before dying, standard 130 exit code.
          finish()
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        value += ch
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

function terminalIO(): WizardIO {
  return {
    say: (m) => console.log(m),
    pickProvider: async () => {
      for (;;) {
        console.log('Pick a provider:')
        PROVIDER_IDS.forEach((p, i) => console.log(`  ${i + 1}. ${PROVIDERS[p].label}`))
        const answer = (await ask('> ')).trim()
        const byIndex = PROVIDER_IDS[Number(answer) - 1]
        const byName = PROVIDER_IDS.find((p) => p === answer.toLowerCase())
        const picked = byName ?? byIndex
        if (picked) return picked
        console.log(`Unrecognized: ${answer}`)
      }
    },
    readKey: (p) => promptMasked(`${PROVIDERS[p].label} API key (input hidden): `),
  }
}
```

- [ ] Run `pnpm vitest run tests/auth/wizard.test.ts` — expect PASS.
- [ ] Commit:

```
git add src/auth/wizard.ts tests/auth/wizard.test.ts
git commit -m "feat(auth): setup wizard with masked raw-mode input, live key validation, credentials save

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CLI integration — `--provider` flag, wizard replaces the hard exit, holder wiring

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli/args.test.ts`

**Steps:**

- [ ] Write `tests/cli/args.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../src/cli.js'

describe('parseArgs — auth and --provider', () => {
  it('parses athena auth and athena auth status', () => {
    expect(parseArgs(['auth'])).toEqual({ command: 'auth', sub: 'wizard' })
    expect(parseArgs(['auth', 'status'])).toEqual({ command: 'auth', sub: 'status' })
    expect(parseArgs(['auth', 'bogus'])).toEqual({
      command: 'error',
      message: 'Usage: athena auth [status]',
    })
  })

  it('parses --provider on run/continue/resume (moonshot aliases to kimi)', () => {
    expect(parseArgs(['--provider', 'kimi'])).toEqual({ command: 'run', provider: 'kimi' })
    expect(parseArgs(['--provider', 'moonshot'])).toEqual({ command: 'run', provider: 'kimi' })
    expect(parseArgs(['--continue', '--provider', 'anthropic'])).toEqual({
      command: 'continue',
      provider: 'anthropic',
    })
    expect(parseArgs(['--provider', 'kimi', '--resume'])).toEqual({
      command: 'resume',
      provider: 'kimi',
    })
  })

  it('rejects a missing or unknown --provider value', () => {
    expect(parseArgs(['--provider'])).toEqual({
      command: 'error',
      message: '--provider needs one of: anthropic, kimi',
    })
    expect(parseArgs(['--provider', 'openai'])).toEqual({
      command: 'error',
      message: '--provider needs one of: anthropic, kimi',
    })
  })

  it('existing commands still parse (no provider key when the flag is absent)', () => {
    expect(parseArgs([])).toEqual({ command: 'run', provider: undefined })
    expect(parseArgs(['--help'])).toEqual({ command: 'help' })
    expect(parseArgs(['import', 'x'])).toEqual({ command: 'import', sourceDir: 'x', force: false })
    expect(parseArgs(['bogus'])).toEqual({
      command: 'error',
      message: 'Unknown argument: bogus (try --help)',
    })
  })
})
```

- [ ] Run `pnpm vitest run tests/cli/args.test.ts` — expect FAIL: assertion errors (`auth` currently parses as `Unknown argument: auth`).
- [ ] In `src/cli.ts`, add the new imports (alongside the existing ones):

```ts
import { PROVIDERS, PROVIDER_IDS, normalizeProvider } from './brain/models.js'
import { loadCredentials, resolveApiKey, type Credentials } from './brain/credentials.js'
import { runAuthWizard } from './auth/wizard.js'
import { ClientHolder } from './engine/client-holder.js'
```

(merge `PROVIDERS, PROVIDER_IDS, normalizeProvider` into the existing `./brain/models.js` import line).
- [ ] Replace `CliCommand` and `parseArgs` with:

```ts
export type CliCommand =
  | { command: 'run'; provider?: ProviderId }
  | { command: 'resume'; provider?: ProviderId }
  | { command: 'continue'; provider?: ProviderId }
  | { command: 'help' }
  | { command: 'auth'; sub: 'wizard' | 'status' }
  | { command: 'import'; sourceDir: string; force: boolean }
  | { command: 'error'; message: string }

export function parseArgs(argv: string[]): CliCommand {
  if (argv[0] === 'import') {
    const sourceDir = argv[1]
    if (!sourceDir || sourceDir.startsWith('--'))
      return { command: 'error', message: 'Usage: athena import <path> [--force]' }
    return { command: 'import', sourceDir, force: argv.includes('--force') }
  }
  if (argv[0] === 'auth') {
    if (argv.length === 1) return { command: 'auth', sub: 'wizard' }
    if (argv[1] === 'status' && argv.length === 2) return { command: 'auth', sub: 'status' }
    return { command: 'error', message: 'Usage: athena auth [status]' }
  }
  const rest = [...argv]
  let provider: ProviderId | undefined
  const pi = rest.indexOf('--provider')
  if (pi !== -1) {
    const value = rest[pi + 1]
    const p = value ? normalizeProvider(value) : null
    if (!p) return { command: 'error', message: `--provider needs one of: ${PROVIDER_IDS.join(', ')}` }
    provider = p
    rest.splice(pi, 2)
  }
  const known = new Set(['--help', '-h', '--resume', '--continue'])
  const unknown = rest.find((a) => !known.has(a))
  if (unknown) return { command: 'error', message: `Unknown argument: ${unknown} (try --help)` }
  if (rest.includes('--help') || rest.includes('-h')) return { command: 'help' }
  if (rest.includes('--resume')) return { command: 'resume', provider }
  if (rest.includes('--continue')) return { command: 'continue', provider }
  return { command: 'run', provider }
}
```

- [ ] Update `HELP_TEXT`:

```ts
const HELP_TEXT = `athena — standalone terminal coding agent

Usage:
  athena                 new session in the current project
  athena --continue      resume the most recent session here
  athena --resume        pick a past session
  athena --provider <anthropic|kimi>  session-only provider override (combines with the above)
  athena auth            add/replace API keys, switch the default provider
  athena auth status     show configured providers and redacted keys
  athena import <path>   one-time import of an ares-style brain (--force to merge)
  athena --help          this help

In-session: /help /clear /resume /compact /model /effort /provider /mode /memory /skills /agents /quit. Esc interrupts a turn.`
```

- [ ] In `main()`, replace the `ANTHROPIC_API_KEY` hard-exit block (keep the TTY check above it) with credential resolution + wizard fallback, and delete the Task 3 placeholder `const provider: ProviderId = 'anthropic'`:

```ts
  let credentials: Credentials
  try {
    credentials = loadCredentials(paths)
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
    return
  }
  const provider: ProviderId = cmd.provider ?? credentials.activeProvider
  let resolved = resolveApiKey(provider, credentials)
  if (!resolved) {
    // First run (or a provider selected via --provider that has no key yet): drop into
    // the wizard scoped to that provider, then continue straight into the session.
    console.log(`No API key found for ${PROVIDERS[provider].label} — let's set one up.`)
    const done = await runAuthWizard({ paths, provider })
    resolved = { key: done.key, source: 'file' }
  }
```

- [ ] Still in `main()`, replace `const client = new AnthropicClient(process.env['ANTHROPIC_API_KEY'])` with:

```ts
  const client = new ClientHolder(makeClient(provider, resolved.key))
```

and add this helper above `main()`:

```ts
function makeClient(provider: ProviderId, key: string): AnthropicClient {
  return new AnthropicClient(key, PROVIDERS[provider].baseURL ?? undefined)
}
```

In `SlashDeps`, change `client: AnthropicClient` to `client: ClientHolder`. Everything else (engine `client:`, orchestrator `clientFactory: () => client`, `/compact`'s `client.complete`) already flows through the same `client` variable and now reads through the holder. Add a minimal `auth` handler in `main()` after the `import` handler:

```ts
  if (cmd.command === 'auth') {
    if (cmd.sub === 'status') {
      // Minimal but complete rendering; Task 8 upgrades it to formatAuthStatus with
      // env-override indication.
      try {
        const creds = loadCredentials(paths)
        for (const p of PROVIDER_IDS) {
          const r = resolveApiKey(p, creds)
          const detail = r ? `${redactKey(r.key)} (${r.source})` : 'not configured'
          console.log(`${p}: ${detail}${p === creds.activeProvider ? ' [active]' : ''}`)
        }
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
      return
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('athena auth needs an interactive terminal.')
      process.exitCode = 1
      return
    }
    await runAuthWizard({ paths })
    return
  }
```

(Add `redactKey` to the credentials import for this. Task 8 replaces this loop with the tested `formatAuthStatus` — a same-plan upgrade one commit later, not open-ended scaffolding.)
- [ ] Run `pnpm vitest run tests/cli/args.test.ts` — expect PASS. Then `pnpm typecheck && pnpm test` — expect PASS.
- [ ] Commit:

```
git add src/cli.ts tests/cli/args.test.ts
git commit -m "feat(cli): first-run wizard replaces the API-key hard exit; --provider flag; ClientHolder wiring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `athena auth status` — configured providers, redacted keys, env overrides

**Files:**
- Modify: `src/brain/credentials.ts`, `src/cli.ts`
- Test: `tests/brain/credentials.test.ts` (add cases)

**Steps:**

- [ ] Append to `tests/brain/credentials.test.ts` (add `formatAuthStatus` to the existing import from `../../src/brain/credentials.js`):

```ts
describe('formatAuthStatus', () => {
  const creds = CredentialsSchema.parse({
    providers: { anthropic: { apiKey: 'sk-ant-api03-abcdefabc4' } },
    activeProvider: 'anthropic',
  })

  it('lists all providers, marks the active one, redacts keys, flags unconfigured', () => {
    const out = formatAuthStatus(creds, 'anthropic', {})
    expect(out).toContain('sk-ant...abc4 (file)')
    expect(out).toContain('[active]')
    expect(out).toContain('not configured')
    expect(out).not.toContain('sk-ant-api03-abcdefabc4') // full key never printed
  })

  it('shows when an env var overrides the file, still redacted', () => {
    const out = formatAuthStatus(creds, 'anthropic', { ANTHROPIC_API_KEY: 'sk-ant-envkey-wxyz' })
    expect(out).toContain('(env ANTHROPIC_API_KEY — overrides file)')
    expect(out).toContain('sk-ant...wxyz')
    expect(out).not.toContain('sk-ant-envkey-wxyz')
  })

  it('shows an env-only key as env-sourced', () => {
    const out = formatAuthStatus(CredentialsSchema.parse({}), 'kimi', {
      MOONSHOT_API_KEY: 'sk-kimi-envonly-9876',
    })
    expect(out).toContain('(env MOONSHOT_API_KEY)')
    expect(out).toContain('sk-kim...9876')
  })
})
```

- [ ] Run `pnpm vitest run tests/brain/credentials.test.ts` — expect FAIL: `does not provide an export named 'formatAuthStatus'`.
- [ ] Append to `src/brain/credentials.ts` (and add `PROVIDER_IDS` to its models import):

```ts
/** One line per known provider: label, redacted key + source, env-override flag,
 *  [active] marker. Full keys never appear — everything goes through redactKey. */
export function formatAuthStatus(
  creds: Credentials,
  activeProvider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return PROVIDER_IDS.map((p) => {
    const info = PROVIDERS[p]
    const envKey = env[info.envVar]
    const fileKey = creds.providers[p]?.apiKey
    let detail: string
    if (envKey && fileKey) detail = `${redactKey(envKey)} (env ${info.envVar} — overrides file)`
    else if (envKey) detail = `${redactKey(envKey)} (env ${info.envVar})`
    else if (fileKey) detail = `${redactKey(fileKey)} (file)`
    else detail = 'not configured'
    const active = p === activeProvider ? ' [active]' : ''
    return `${info.label.padEnd(16)} ${detail}${active}`
  }).join('\n')
}
```

- [ ] In `src/cli.ts`, add `formatAuthStatus` to the credentials import and replace the status placeholder inside the `auth` handler with:

```ts
    if (cmd.sub === 'status') {
      try {
        const creds = loadCredentials(paths)
        console.log(formatAuthStatus(creds, creds.activeProvider))
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
      return
    }
```

- [ ] Run `pnpm vitest run tests/brain/credentials.test.ts` — expect PASS.
- [ ] Commit:

```
git add src/brain/credentials.ts src/cli.ts tests/brain/credentials.test.ts
git commit -m "feat(auth): athena auth status with redacted keys, sources, and env-override flags

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `/provider` TUI command + swap-reaches-everywhere test

**Files:**
- Modify: `src/tui/slash.ts`, `src/tui/App.tsx`, `src/cli.ts`
- Test: `tests/tui/slash.test.ts` (add cases), `tests/harness/provider-switch.test.ts` (create)

**Steps:**

- [ ] Append to `tests/tui/slash.test.ts`:

```ts
describe('/provider', () => {
  it('parses /provider with a value', () => {
    expect(parseSlash('/provider kimi')).toEqual({ kind: 'provider', value: 'kimi' })
    expect(parseSlash('/provider anthropic')).toEqual({ kind: 'provider', value: 'anthropic' })
  })

  it('errors without a value', () => {
    expect(parseSlash('/provider')).toEqual({
      kind: 'error',
      value: 'Usage: /provider <anthropic|kimi>',
    })
  })
})
```

- [ ] Write `tests/harness/provider-switch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AgentOrchestrator } from '../../src/harness/agents.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { readTool } from '../../src/tools/read.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { ClientHolder } from '../../src/engine/client-holder.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { ModelClient, StreamResult } from '../../src/engine/client.js'
import type { PermissionGate, ToolDefinition } from '../../src/engine/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'
import { MockAnthropicClient, textBlock } from '../helpers/mock-client.js'

function namedClient(name: string, log: string[]): ModelClient {
  const inner = new MockAnthropicClient(
    [{ blocks: [textBlock(name)], stopReason: 'end_turn' }],
    `${name}-summary`,
  )
  return {
    stream(params, callbacks): Promise<StreamResult> {
      log.push(`${name}:stream`)
      return inner.stream(params, callbacks)
    },
    complete(params): Promise<string> {
      log.push(`${name}:complete`)
      return inner.complete(params)
    },
  }
}

const def: AgentDef = {
  name: 'researcher',
  description: 'read-only',
  tools: ['Read'],
  model: null,
  systemPrompt: 'You research.',
  file: 'x.md',
}

const gate: PermissionGate = {
  check: () => ({ decision: 'allow', reason: 'test gate allows all' }),
  grantSession: () => {},
}

describe('provider switch through the ClientHolder', () => {
  it('sub-agent calls and compactor calls go through the NEW client after swap', async () => {
    const log: string[] = []
    const holder = new ClientHolder(namedClient('old', log))
    const registry = new ToolRegistry()
    registry.register(readTool as ToolDefinition<never>)
    const orchestrator = new AgentOrchestrator({
      defs: [def],
      clientFactory: () => holder, // same wiring as cli.ts: the factory returns the holder
      baseRegistry: registry,
      gate,
      hooks: new HookRunner([]),
      defaultModel: () => 'sonnet',
      defaultEffort: () => 'high',
      defaultProvider: () => 'anthropic',
      systemPromptBase: 'sys',
    })

    const before = await orchestrator.runAgent(def, 'q1', makeCtx(process.cwd()))
    expect(before.output).toBe('old')

    holder.swap(namedClient('new', log)) // what the /provider handler does

    const after = await orchestrator.runAgent(def, 'q2', makeCtx(process.cwd()))
    expect(after.output).toBe('new')

    // Compactor path: /compact calls complete() on the same holder.
    expect(await holder.complete({ model: 'm', prompt: 'p', maxTokens: 8 })).toBe('new-summary')
    expect(log).toEqual(['old:stream', 'new:stream', 'new:complete'])
  })
})
```

- [ ] Run `pnpm vitest run tests/tui/slash.test.ts tests/harness/provider-switch.test.ts` — expect FAIL: slash cases fail with `{ kind: 'error', value: 'Unknown command: /provider' }`; the provider-switch test PASSES already (holder + thunks landed in Tasks 3/5/7) — it pins the invariant against regression.
- [ ] In `src/tui/slash.ts`, add to the `SlashCommand` union:

```ts
  | { kind: 'provider'; value: string }
```

and in `parseSlash`, after the `model` branch:

```ts
  if (cmd === 'provider')
    return arg
      ? { kind: 'provider', value: arg }
      : { kind: 'error', value: 'Usage: /provider <anthropic|kimi>' }
```

- [ ] In `src/tui/App.tsx` (the busy-guard near line 134), extend the deferred-while-busy set:

```ts
        } else if (busy && (slash.kind === 'compact' || slash.kind === 'model' || slash.kind === 'provider')) {
```

- [ ] In `src/cli.ts` `makeSlashHandler`, add a `provider` case (after `model`; `/provider` is session-only — it never writes `activeProvider`, only the wizard / `athena auth` does):

```ts
      case 'provider': {
        const p = normalizeProvider(cmd.value)
        if (!p) {
          info(`Unknown provider: ${cmd.value} — choose ${PROVIDER_IDS.join(' or ')}.`)
          break
        }
        if (p === engine.getProvider()) {
          info(`Already on ${PROVIDERS[p].label}.`)
          break
        }
        let resolved
        try {
          resolved = resolveApiKey(p, loadCredentials(paths))
        } catch (err) {
          info((err as Error).message)
          break
        }
        if (!resolved) {
          info(
            `No API key configured for ${PROVIDERS[p].label} — run \`athena auth\` (or restart with \`athena --provider ${p}\`) to add one.`,
          )
          break
        }
        client.swap(makeClient(p, resolved.key))
        engine.setProvider(p)
        engine.setModel(PROVIDERS[p].defaultModel)
        bus.emit({ type: 'status', patch: { model: modelLabel(p, PROVIDERS[p].defaultModel) } })
        info(
          `Provider: ${PROVIDERS[p].label}, model ${modelLabel(p, PROVIDERS[p].defaultModel)} (session-only; \`athena auth\` changes the default).`,
        )
        break
      }
```

Also update the `/help` string in the same function to include `/provider <anthropic|kimi>` in the command list.
- [ ] Run `pnpm vitest run tests/tui/slash.test.ts tests/harness/provider-switch.test.ts` then `pnpm typecheck && pnpm test` — expect PASS.
- [ ] Commit:

```
git add src/tui/slash.ts src/tui/App.tsx src/cli.ts tests/tui/slash.test.ts tests/harness/provider-switch.test.ts
git commit -m "feat(provider): session-only /provider switch that swaps the shared client holder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 401/403 mid-session mapped to an actionable auth error

**Files:**
- Modify: `src/engine/loop.ts`
- Test: `tests/engine/loop.test.ts` (add cases)

**Steps:**

- [ ] Append to `tests/engine/loop.test.ts` this describe block, reusing the file's existing Engine-construction helper if one exists; otherwise self-contained as written (imports of `Engine`, `EngineEventBus`, `ContextManager`, `ToolRegistry`, `HookRunner`, `makeCtx`, and event types are already present in that file — extend them as needed):

```ts
describe('auth failure mapping', () => {
  function authFailingEngine(status: number, bus: EngineEventBus): Engine {
    const failingClient: ModelClient = {
      stream: async () => {
        throw Object.assign(new Error('invalid x-api-key'), { status })
      },
      complete: async () => '',
    }
    return new Engine({
      client: failingClient,
      bus,
      registry: new ToolRegistry(),
      gate: { check: () => ({ decision: 'allow', reason: 'test' }), grantSession: () => {} },
      hooks: new HookRunner([]),
      contextManager: new ContextManager({ modelWindowTokens: 200_000 }),
      toolContext: makeCtx(process.cwd()),
      provider: 'kimi',
      model: 'kimi-k2',
      effort: 'high',
      systemPrompt: 'sys',
      maxTokens: 100,
    })
  }

  it.each([401, 403])('maps %i to "API key rejected for <provider> — run athena auth"', async (status) => {
    const bus = new EngineEventBus()
    const errors: string[] = []
    bus.on((e) => {
      if (e.type === 'error') errors.push(e.message)
    })
    await authFailingEngine(status, bus).runTurn('hi')
    expect(errors.some((m) => m === 'API key rejected for kimi — run `athena auth`')).toBe(true)
    expect(errors.join('\n')).not.toContain('invalid x-api-key')
  })

  it('leaves non-auth API errors on the raw-message path', async () => {
    const bus = new EngineEventBus()
    const errors: string[] = []
    bus.on((e) => {
      if (e.type === 'error') errors.push(e.message)
    })
    await authFailingEngine(500, bus).runTurn('hi')
    expect(errors.some((m) => m.startsWith('API error: invalid x-api-key'))).toBe(true)
  })
})
```

- [ ] Run `pnpm vitest run tests/engine/loop.test.ts` — expect FAIL: the 401/403 cases receive `API error: invalid x-api-key` instead of the mapped message.
- [ ] In `src/engine/loop.ts` `runTurnInner`, replace the stream `catch` block with:

```ts
      } catch (err) {
        const aborted = signal.aborted
        const status = (err as { status?: number }).status
        // 401/403 = the key itself was rejected: point at `athena auth`, never a raw SDK stack.
        const message = aborted
          ? 'Turn aborted'
          : status === 401 || status === 403
            ? `API key rejected for ${this.getProvider()} — run \`athena auth\``
            : `API error: ${(err as Error).message}`
        bus.emit({ type: 'error', message, fatal: !aborted })
        break
      }
```

- [ ] Run `pnpm vitest run tests/engine/loop.test.ts` — expect PASS (all cases in the file).
- [ ] Commit:

```
git add src/engine/loop.ts tests/engine/loop.test.ts
git commit -m "feat(errors): map mid-session 401/403 to an actionable athena-auth message

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: README rewrite — wizard-first setup

**Files:**
- Modify: `README.md`

**Steps:**

- [ ] Replace the `## Quickstart` section of `README.md` with:

```markdown
## Quickstart

    pnpm install
    pnpm build
    npm link          # puts `athena` on PATH
    cd path/to/your/project
    athena

On first run Athena asks you to pick a provider (Anthropic or Kimi/Moonshot) and paste
an API key — input is hidden, the key is validated live, then saved to
`~/.athena/credentials.json` and the session starts. No shell environment setup needed.

    athena auth            # add/replace keys or switch the default provider any time
    athena auth status     # configured providers, active provider, redacted keys

First run also scaffolds `~/.athena` (constitution, settings, memory, skills, agents, hooks, sessions).
```

- [ ] Replace the `## Commands` section body with:

```markdown
    athena                 # new session in the current project
    athena --continue      # resume the most recent session here
    athena --resume        # pick a past session
    athena --provider kimi # session-only provider override
    athena auth            # setup wizard: keys + default provider
    athena auth status     # redacted key/provider overview
    athena import <path>   # one-time import of an ares-style brain (--force to merge)

In-session: `/help /clear /resume /compact /model /effort /provider /mode /memory /skills /agents /quit`. Esc interrupts a turn.
```

- [ ] In the `## Configuration` section, update the model sentence to name provider scoping, and append the providers + advanced-override subsection:

```markdown
model is a key of the ACTIVE provider (`haiku | sonnet | opus | fable` for Anthropic,
`kimi-k2 | kimi-k2-turbo` for Kimi — a legacy/full id like `claude-opus-4-8` is also
accepted and normalized), effort (`low | medium | high | xhigh | max`; applies to
Sonnet/Opus/Fable, which also run adaptive thinking — Haiku and all Kimi models ignore
it), permissionMode (`normal | acceptEdits | plan | trusted`), allow/deny rules like
`"Bash(git:*)"` or `"Edit(src/**)"`, and hooks (`SessionStart | UserPromptSubmit |
PreToolUse | PostToolUse | Stop`).
Switch live with `/model <key>`, `/effort <level>`, and `/provider <anthropic|kimi>`
(`/provider` is session-only; `athena auth` changes the persisted default).

### Providers

- **Anthropic** — default SDK endpoint; console API key from console.anthropic.com.
- **Kimi (Moonshot)** — Anthropic-compatible endpoint `https://api.moonshot.ai/anthropic`;
  key from platform.moonshot.ai. Kimi models do not support the effort dial or extended
  thinking; Athena omits those request fields automatically.

### Advanced: env-var override

Keys normally live in `~/.athena/credentials.json` (written by the wizard with
owner-only permissions where the OS supports it). If `ANTHROPIC_API_KEY` or
`MOONSHOT_API_KEY` is set in the environment, it overrides the file for that provider —
useful for CI or ephemeral machines. `athena auth status` shows when an override is
active.
```

- [ ] Run `pnpm typecheck && pnpm test` — expect PASS (docs-only change; final whole-plan gate).
- [ ] Commit:

```
git add README.md
git commit -m "docs(readme): wizard-first setup; env vars demoted to advanced override

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec section | Requirement | Task(s) |
|---|---|---|
| §1 Credential store | credentials.json, zod, 0o600 best-effort, env-over-file, unknown-provider rejection, malformed-file actionable error | 4 |
| §2 First-run wizard | pre-TUI wizard replaces hard exit; provider pick; masked input; live validation; save + continue | 6, 7 |
| §2 Commands | `athena auth`, `athena auth status` (redacted keys, env-override indication) | 7, 8 |
| §3 Kimi provider | baseURL on AnthropicClient; provider registry with Moonshot endpoint; Kimi model entries | 1, 5 |
| §3 Capability gating | effort/thinking attached only where supported, at the resolveModelRequest seam | 1, 3 |
| §3 Model registry generalization | provider-scoped MODELS; provider-aware resolveModelRequest; settings.model per provider; /model scoped to active provider; four Anthropic names unchanged | 1, 2, 3 |
| §4 Provider switching | `--provider` flag; `/provider` session-only; model picker scoped; ClientHolder swap reaches engine/orchestrator/compactor; only wizard/auth persist activeProvider | 5, 7, 9 |
| §5 Error handling | 401/403 -> "API key rejected for <provider> — run `athena auth`"; missing key for `--provider` -> wizard scoped to it; `/provider` missing key -> guidance (see deviation note below) | 7, 9, 10 |
| §6 Tests | resolution order (T4), wizard save path (T6), gating per provider (T1, T10 engine-level), redaction (T8), malformed file (T4), registry/settings validation (T1, T2), client holder swap incl. sub-agents + compactor (T5, T9) | 1, 2, 4, 5, 6, 8, 9, 10 |
| §7 Documentation | README: install -> run athena -> paste key; env vars advanced-only | 11 |

**Deviation note (§5):** for a `/provider` switch to a key-less provider mid-TUI, Athena shows "No API key configured for … — run `athena auth`" and refuses the switch, instead of launching the raw-mode wizard while Ink owns stdin (the two would fight for the terminal). The `--provider` startup path does drop into the scoped wizard exactly as specced.

**Kimi id note:** `kimi-k2-0711-preview` / `kimi-k2-turbo-preview` must be verified against https://platform.moonshot.ai docs at implementation time (Task 1).
