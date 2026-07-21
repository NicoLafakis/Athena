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
  sdkAuthEnvVar: 'ANTHROPIC_API_KEY',
  contextWindow: 200_000,
  temperatureRange: [0, 1],
  requiresThinking: false,
  supportsThinkingBlocks: true,
  supportsCacheControl: true,
  supportsWebTools: true,
  dispatch: 'direct',
  // Model ids are VOLATILE (sourced from the SDK's own d.ts examples); refresh via fetchModels.
  defaultModel: 'claude-sonnet-5',
  models: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'],
  modelsPath: '/v1/models',
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
  sdkAuthEnvVar: 'ANTHROPIC_AUTH_TOKEN',
  contextWindow: 262_144,
  temperatureRange: [0, 1],
  requiresThinking: true,
  supportsThinkingBlocks: true,
  supportsCacheControl: false,
  supportsWebTools: false,
  dispatch: 'direct',
  // VOLATILE (ADR 0001, verified July 2026); refresh via fetchModels.
  defaultModel: 'kimi-k3',
  models: ['kimi-k3', 'kimi-k2.7-code'],
  aliasSmallFastModel: true,
  modelsPath: '/v1/models',
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
  sdkAuthEnvVar: 'ANTHROPIC_API_KEY',
  contextWindow: 204_800,
  temperatureRange: [0, 2],
  requiresThinking: false,
  supportsThinkingBlocks: false,
  supportsCacheControl: false,
  supportsWebTools: false,
  ignoredParams: ['top_k', 'stop_sequences', 'mcp_servers'],
  dispatch: 'direct',
  // VOLATILE (ADR 0001, verified July 2026); refresh via fetchModels.
  defaultModel: 'MiniMax-M2',
  models: ['MiniMax-M2', 'MiniMax-M3'],
  aliasSmallFastModel: true,
  modelsPath: '/v1/models',
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
  // The REAL secret. Consumed by the LiteLLM sidecar PROCESS (not the SDK), which
  // reads it via `os.environ/OPENAI_API_KEY` in its config.yaml.
  authEnvVar: 'OPENAI_API_KEY',
  // The SDK talks to the LOCAL sidecar, not OpenAI. It authenticates with the
  // sidecar's (non-secret) master key placed in ANTHROPIC_API_KEY.
  sdkAuthEnvVar: 'ANTHROPIC_API_KEY',
  contextWindow: 128_000,
  temperatureRange: [0, 2],
  requiresThinking: false,
  supportsThinkingBlocks: false,
  supportsCacheControl: false,
  supportsWebTools: false,
  dispatch: 'sidecar',
  // VOLATILE placeholders; refresh via fetchModels against the sidecar's /v1/models.
  defaultModel: 'gpt-4o',
  models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  aliasSmallFastModel: true,
  modelsPath: '/v1/models',
  note: 'baseUrl is the local LiteLLM sidecar (unified /v1/messages route); ANTHROPIC_BASE_URL points here for OpenAI selection.',
} satisfies ProviderCapabilities;

export const descriptors: Record<ProviderCapabilities['name'], ProviderCapabilities> = {
  anthropic,
  kimi,
  minimax,
  openai,
};
