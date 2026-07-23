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
