/**
 * Provider registry + selection (ADR 0001, Phase 1).
 *
 * `resolveProvider(name, model?)` turns a provider name (+ optional model) into
 * the per-session ENVIRONMENT that selects that provider for the Agent SDK.
 *
 * This is the crux of the Phase 0 finding: the SDK owns the HTTP call and
 * exposes no per-request body interceptor, so provider switching is
 * env/settings-driven, exactly the way Claude Code itself does it. Verified in
 * step 0: `Options.env` (sdk.d.ts) is a real per-session field passed through to
 * the spawned CLI — so selection is clean per-session env injection with no
 * mutation of the parent `process.env`.
 *
 * Secret VALUES are read from `process.env` at call time and NEVER hardcoded. If
 * the required secret var is absent, the full NON-secret config is still
 * returned (with `missingKeyEnvVar` set) so resolution is unit-testable keyless.
 */

import { descriptors } from './descriptors.js';
import type {
  ProviderCapabilities,
  ProviderName,
  ResolvedProvider,
  SessionEnv,
} from './types.js';

/** Thrown when an unknown provider name is requested. */
export class UnknownProviderError extends Error {
  constructor(public readonly requested: string) {
    super(
      `unknown provider '${requested}'. Known providers: ${Object.keys(descriptors).join(', ')}.`,
    );
    this.name = 'UnknownProviderError';
  }
}

/** Thrown when a requested model is not in the provider's known list. */
export class UnknownModelError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly requested: string,
    public readonly known: string[],
  ) {
    super(
      `unknown model '${requested}' for provider '${provider}'. Known (VOLATILE — refresh via fetchModels): ` +
        `${known.join(', ')}. If this is a new model id, refresh the registry with fetchModels('${provider}').`,
    );
    this.name = 'UnknownModelError';
  }
}

/**
 * A local placeholder token the SDK sends to the LOCAL LiteLLM sidecar when no
 * `LITELLM_MASTER_KEY` is configured. NOT a secret — the sidecar is bound to
 * 127.0.0.1 and this only satisfies the CLI's "an auth var must be set" check.
 */
export const SIDECAR_PLACEHOLDER_KEY = 'sk-athena-litellm-local';

/**
 * Runtime overlay of the (volatile) per-provider model lists. `fetchModels`
 * writes here; `getKnownModels` reads registry-first, descriptor-fallback. The
 * const descriptors are never mutated.
 */
const modelRegistry = new Map<ProviderName, string[]>();

/** Effective known-model list: runtime refresh if present, else the descriptor snapshot. */
export function getKnownModels(name: ProviderName): string[] {
  return modelRegistry.get(name) ?? getDescriptor(name).models ?? [];
}

/** Overwrite the runtime known-model list for a provider (called by `fetchModels`). */
export function setKnownModels(name: ProviderName, models: string[]): void {
  modelRegistry.set(name, [...models]);
}

/** Clear runtime model refreshes (mainly for test isolation). */
export function resetKnownModels(name?: ProviderName): void {
  if (name) modelRegistry.delete(name);
  else modelRegistry.clear();
}

/** Look up a descriptor by name or throw {@link UnknownProviderError}. */
export function getDescriptor(name: string): ProviderCapabilities {
  const d = (descriptors as Record<string, ProviderCapabilities>)[name];
  if (!d) throw new UnknownProviderError(name);
  return d;
}

/** Resolve + validate a model id for a provider. Defaults to the descriptor default. */
export function resolveModel(name: ProviderName, requested?: string): string {
  const d = getDescriptor(name);
  const model = requested ?? d.defaultModel;
  if (!model) {
    throw new Error(`provider '${name}' has no default model and none was requested`);
  }
  const known = getKnownModels(name);
  // Lenient: only reject when we HAVE a known list and the model isn't in it.
  // (Model ids are volatile — an empty list means "don't gate".)
  if (known.length > 0 && !known.includes(model)) {
    throw new UnknownModelError(name, model, known);
  }
  return model;
}

/** Options for {@link resolveProvider} — injectable for keyless unit tests. */
export type ResolveProviderOptions = {
  /** Env to read secrets from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * Override the base URL written to `ANTHROPIC_BASE_URL`. For OpenAI this is the
   * live sidecar address (e.g. a `SidecarManager.baseUrl` or a mock server url).
   */
  baseUrl?: string;
};

/**
 * Resolve a provider (+ optional model) into its selection descriptor + the
 * per-session env that points the SDK at it.
 *
 * @param name  provider name (`anthropic` | `kimi` | `minimax` | `openai`)
 * @param model optional model id (defaults to the descriptor default; validated)
 * @param opts  injectable env / base-url override (keyless testing)
 */
export function resolveProvider(
  name: ProviderName,
  model?: string,
  opts: ResolveProviderOptions = {},
): ResolvedProvider {
  const env = opts.env ?? process.env;
  const descriptor = getDescriptor(name);
  const resolvedModel = resolveModel(name, model);

  const baseUrl = opts.baseUrl ?? descriptor.baseUrl;
  const sessionEnv: SessionEnv = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: resolvedModel,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(descriptor.contextWindow),
  };

  // Non-Anthropic endpoints don't host a claude-*-haiku small/fast model — pin
  // the small/fast model to the main one so background calls don't 404.
  if (descriptor.aliasSmallFastModel) {
    sessionEnv.ANTHROPIC_SMALL_FAST_MODEL = resolvedModel;
  }

  // The Anthropic-compat endpoints (Kimi/MiniMax) have no server-side web tools.
  if (!descriptor.supportsWebTools) {
    sessionEnv.ENABLE_TOOL_SEARCH = 'false';
  }

  const sdkAuthVar = descriptor.sdkAuthEnvVar ?? 'ANTHROPIC_API_KEY';
  const secretVar = descriptor.authEnvVar ?? sdkAuthVar;
  const secretVal = env[secretVar];
  let missingKeyEnvVar: string | undefined;

  if (descriptor.dispatch === 'sidecar') {
    // The real secret (OPENAI_API_KEY) is consumed by the SIDECAR process, not
    // the SDK. The SDK→sidecar hop uses a local (non-secret) master key.
    if (!secretVal) missingKeyEnvVar = secretVar;
    sessionEnv[sdkAuthVar] = env.LITELLM_MASTER_KEY || SIDECAR_PLACEHOLDER_KEY;
  } else {
    // Direct provider: inject the real secret VALUE under the var the SDK reads.
    if (secretVal) sessionEnv[sdkAuthVar] = secretVal;
    else missingKeyEnvVar = secretVar;
  }

  return { descriptor, sessionEnv, model: resolvedModel, missingKeyEnvVar };
}
