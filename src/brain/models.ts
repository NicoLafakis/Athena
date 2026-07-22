// src/brain/models.ts — single source of truth for the model families Athena exposes.
// Exactly four Anthropic families, each pinned to its current model id. Per-family
// capability flags gate which request parameters are legal: sending an unsupported
// field (output_config.effort to Haiku, or legacy budget_tokens thinking to any of
// the GA-thinking models) returns HTTP 400. resolveModelRequest is the ONLY place
// allowed to assemble effort/thinking, so those landmines live in one spot.

export type ModelFamily = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Legacy `enabled` (budget_tokens) is kept in the union for completeness, but it MUST
// NOT reach sonnet-5/opus-4-8/fable-5 — those speak `adaptive` only. resolveModelRequest
// never emits `enabled`.
export type ThinkingParam =
  | { type: 'adaptive' }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }

export const MODEL_FAMILIES: readonly ModelFamily[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

interface ModelEntry {
  id: string
  label: string
  supportsEffort: boolean
}

export const MODELS: Record<ModelFamily, ModelEntry> = {
  haiku: { id: 'claude-haiku-4-5', label: 'Haiku 4.5', supportsEffort: false },
  sonnet: { id: 'claude-sonnet-5', label: 'Sonnet 5', supportsEffort: true },
  opus: { id: 'claude-opus-4-8', label: 'Opus 4.8', supportsEffort: true },
  fable: { id: 'claude-fable-5', label: 'Fable 5', supportsEffort: true },
}

export function modelId(f: ModelFamily): string {
  return MODELS[f].id
}

export function modelLabel(f: ModelFamily): string {
  return MODELS[f].label
}

export function supportsEffort(f: ModelFamily): boolean {
  return MODELS[f].supportsEffort
}

/** Accepts a family name (case-insensitive, trimmed) OR a legacy/full model id and
 *  maps it to a family. Substring match on the id keeps `/model claude-opus-4-8`,
 *  `/model claude-sonnet-4-5`, and `/model opus` all working (non-breaking). Returns
 *  null for anything unrecognized so callers can surface a clear error. */
export function normalizeModel(input: string): ModelFamily | null {
  const s = input.trim().toLowerCase()
  if (s === '') return null
  for (const f of MODEL_FAMILIES) {
    if (s === f || s.includes(f)) return f
  }
  return null
}

/** The crux: assemble the wire parameters for a family + effort. Haiku is the fast
 *  tier — no effort, no thinking (both 400 on it). The other three carry the GA effort
 *  dial plus adaptive thinking; adaptive MUST be sent explicitly or Opus runs with no
 *  thinking at all. Never emits legacy budget_tokens thinking — that shape 400s on
 *  sonnet-5/opus-4-8/fable-5. Both fields are GA (no beta header needed). */
export function resolveModelRequest(
  family: ModelFamily,
  effort: Effort,
): { model: string; effort?: Effort; thinking?: ThinkingParam } {
  const id = modelId(family)
  if (!supportsEffort(family)) return { model: id }
  return { model: id, effort, thinking: { type: 'adaptive' } }
}
