// src/brain/models.ts — single source of truth for providers and their models.
// MODELS is provider-scoped: provider -> { modelKey -> entry }. Per-entry capability
// flags gate which request parameters are legal: sending an unsupported field
// (output_config.effort to Haiku or any Kimi model, thinking to Kimi) returns HTTP 400.
// resolveModelRequest is the ONLY place allowed to assemble effort/thinking, so those
// landmines live in one spot.

export type ProviderId = 'anthropic' | 'kimi' | 'kimi-code'
export type ModelKey = string
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Legacy `enabled` (budget_tokens) is kept in the union for completeness, but it MUST
// NOT reach sonnet-5/opus-4-8/fable-5 — those speak `adaptive` only. resolveModelRequest
// never emits `enabled`.
export type ThinkingParam =
  | { type: 'adaptive' }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }

export const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'kimi', 'kimi-code']
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
  /** How the key is sent: Anthropic wants x-api-key; Moonshot's compat endpoint wants Authorization: Bearer. */
  authMode: 'x-api-key' | 'bearer'
  /** Provider-specific key guidance, shown by the auth wizard when validation fails. */
  keyHint?: string
}

export const PROVIDERS: Record<ProviderId, ProviderEntry> = {
  anthropic: {
    label: 'Anthropic',
    baseURL: null,
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'sonnet',
    validationModel: 'haiku',
    authMode: 'x-api-key',
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseURL: 'https://api.moonshot.ai/anthropic',
    envVar: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k3',
    validationModel: 'kimi-k2.6',
    authMode: 'bearer',
    keyHint:
      'Pay-per-token keys come from platform.kimi.ai (global; platform.moonshot.cn keys do not work here). Subscription keys from kimi.com/code/console belong to the kimi-code provider instead.',
  },
  'kimi-code': {
    label: 'Kimi Code (subscription)',
    baseURL: 'https://api.kimi.com/coding/',
    envVar: 'KIMI_CODE_API_KEY',
    defaultModel: 'kimi-for-coding',
    validationModel: 'kimi-for-coding',
    authMode: 'x-api-key',
    keyHint:
      'Kimi Code subscription keys come from kimi.com/code/console and work ONLY here. Pay-per-token keys belong to the kimi provider instead.',
  },
}

export interface ModelEntry {
  id: string
  label: string
  supportsEffort: boolean
  supportsThinking: boolean
}

// NOTE: Kimi ids verified against https://platform.kimi.ai/docs/models on 2026-07-23
// (k2-preview lineage EOL'd 2026-05-25). Keys equal wire ids — Moonshot's Anthropic-compatible
// endpoint accepts the same ids as the OpenAI one.
export const MODELS: Record<ProviderId, Record<ModelKey, ModelEntry>> = {
  anthropic: {
    haiku: { id: 'claude-haiku-4-5', label: 'Haiku 4.5', supportsEffort: false, supportsThinking: false },
    sonnet: { id: 'claude-sonnet-5', label: 'Sonnet 5', supportsEffort: true, supportsThinking: true },
    opus: { id: 'claude-opus-4-8', label: 'Opus 4.8', supportsEffort: true, supportsThinking: true },
    fable: { id: 'claude-fable-5', label: 'Fable 5', supportsEffort: true, supportsThinking: true },
  },
  kimi: {
    'kimi-k3': { id: 'kimi-k3', label: 'Kimi K3', supportsEffort: false, supportsThinking: false },
    'kimi-k2.7-code': { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', supportsEffort: false, supportsThinking: false },
    'kimi-k2.6': { id: 'kimi-k2.6', label: 'Kimi K2.6', supportsEffort: false, supportsThinking: false },
  },
  // NOTE: kimi-code ids verified against
  // https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html on 2026-07-23.
  // k3 (256K) and k3[1m] (1M context) require the Moderato tier or above — below that the
  // API returns a 404/permission error; kimi-for-coding works on every tier.
  'kimi-code': {
    'kimi-for-coding': { id: 'kimi-for-coding', label: 'Kimi for Coding', supportsEffort: false, supportsThinking: false },
    k3: { id: 'k3', label: 'Kimi K3 (256K)', supportsEffort: false, supportsThinking: false },
    'k3[1m]': { id: 'k3[1m]', label: 'Kimi K3 (1M)', supportsEffort: false, supportsThinking: false },
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

export function supportsThinking(provider: ProviderId, key: ModelKey): boolean {
  return entry(provider, key).supportsThinking
}

/** Accepts a model key (case-insensitive, trimmed) OR a legacy/full model id and maps
 *  it to a key WITHIN the given provider only. Exact key/id match first, then a
 *  longest-key substring pass so `claude-sonnet-4-5` -> sonnet stays working and, when
 *  two keys share a prefix, the longer key wins. Returns null for anything
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
