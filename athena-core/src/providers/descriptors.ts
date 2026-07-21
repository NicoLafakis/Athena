/**
 * Provider capability descriptors.
 *
 * Facts sourced from ADR 0001 (verified July 2026). Model IDs, context windows,
 * and temperature ranges are VOLATILE — the ADR mandates reading `/models` at
 * runtime rather than trusting these literals. Values here are the dialect
 * defaults the shaper needs; they are not authoritative model metadata.
 */

import type { ProviderCapabilities } from './types.js';

/** Anthropic — native. Manual prompt caching via `cache_control` breakpoints. */
export const anthropic = {
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  authHeader: 'x-api-key',
  authEnvVar: 'ANTHROPIC_API_KEY',
  contextWindow: 200_000,
  temperatureRange: [0, 1],
  requiresThinking: false,
  supportsThinkingBlocks: true,
  supportsCacheControl: true,
  supportsWebTools: true,
  dispatch: 'direct',
} satisfies ProviderCapabilities;

/**
 * Kimi (Moonshot) — Anthropic-compat endpoint.
 * `kimi-k2.7-code` REQUIRES thinking (400s otherwise); `kimi-k3` thinks by
 * default. Forcing `thinking:enabled` is safe for both. The Anthropic-compat
 * endpoint does NOT support web tools (set `ENABLE_TOOL_SEARCH=false`).
 */
export const kimi = {
  name: 'kimi',
  baseUrl: 'https://api.moonshot.ai/anthropic',
  authHeader: 'bearer',
  authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
  contextWindow: 262_144,
  temperatureRange: [0, 1],
  requiresThinking: true,
  supportsThinkingBlocks: true,
  supportsCacheControl: false,
  supportsWebTools: false,
  dispatch: 'direct',
  note: 'requiresThinking is provider-wide here (safe for k3); per-model refinement (k2.7-code vs k3) is a Phase 1 detail.',
} satisfies ProviderCapabilities;

/**
 * MiniMax — Anthropic-compat endpoint.
 * `MiniMax-M2.x` = text + tool-call blocks only (no thinking blocks); `M3` adds
 * thinking. Ignores `top_k`, `stop_sequences`, `mcp_servers`. Temp range [0, 2].
 */
export const minimax = {
  name: 'minimax',
  baseUrl: 'https://api.minimax.io/anthropic',
  authHeader: 'x-api-key',
  authEnvVar: 'ANTHROPIC_API_KEY',
  contextWindow: 204_800,
  temperatureRange: [0, 2],
  requiresThinking: false,
  supportsThinkingBlocks: false,
  supportsCacheControl: false,
  supportsWebTools: false,
  ignoredParams: ['top_k', 'stop_sequences', 'mcp_servers'],
  dispatch: 'direct',
  note: 'supportsThinkingBlocks=false reflects M2.x baseline; M3 adds thinking.',
} satisfies ProviderCapabilities;

/**
 * OpenAI — the only shape mismatch. Bridged by a LiteLLM sidecar (local,
 * pinned, OpenAI-scoped) that is NOT bundled in Phase 0. `cache_control` is
 * meaningless downstream and must be stripped. `dispatch: 'sidecar'` routes it
 * through the sidecar seam instead of a direct Anthropic-shaped HTTP call.
 */
export const openai = {
  name: 'openai',
  baseUrl: 'http://127.0.0.1:4000',
  authHeader: 'bearer',
  authEnvVar: 'OPENAI_API_KEY',
  contextWindow: 128_000,
  temperatureRange: [0, 2],
  requiresThinking: false,
  supportsThinkingBlocks: false,
  supportsCacheControl: false,
  supportsWebTools: false,
  dispatch: 'sidecar',
  note: 'baseUrl is the FUTURE local LiteLLM sidecar address; sidecar is a stub in Phase 0.',
} satisfies ProviderCapabilities;

export const descriptors: Record<ProviderCapabilities['name'], ProviderCapabilities> = {
  anthropic,
  kimi,
  minimax,
  openai,
};
