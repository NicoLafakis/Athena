/**
 * Config loading + hook wiring (ADR 0001, seams 2 & 3).
 *
 * Points the Claude Agent SDK at the local `fixtures/.claude` config and proves,
 * without a model turn, that the SDK's own merge engine discovers the fixture's
 * hook (via {@link resolveSettings}). Also exposes a programmatic mirror of the
 * hook so the SDK-level `HookCallback` `additionalContext` contract is
 * type-checked and unit-testable.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, Options, ResolvedSettings } from '@anthropic-ai/claude-agent-sdk';
import { resolveProvider } from '../providers/resolveProvider.js';
import type { ProviderName, ResolvedProvider } from '../providers/types.js';
import { HOOK_MARKER } from '../hooks/contract.js';

export { HOOK_MARKER, SKILL_MARKER } from '../hooks/contract.js';

const here = dirname(fileURLToPath(import.meta.url)); // .../athena-core/src/config
/** Repo root of the spike (`athena-core/`). */
export const ATHENA_CORE_ROOT = resolve(here, '..', '..');
/** Project dir the SDK runs in = `$CLAUDE_PROJECT_DIR`. Holds `.claude/`. */
export const FIXTURE_PROJECT_DIR = resolve(ATHENA_CORE_ROOT, 'fixtures');
/** The fixture config directory. */
export const FIXTURE_CLAUDE_DIR = resolve(FIXTURE_PROJECT_DIR, '.claude');
/** The portable node hook. */
export const FIXTURE_HOOK_PATH = resolve(FIXTURE_CLAUDE_DIR, 'hooks', 'inject.mjs');
/** The fixture skill's SKILL.md. */
export const FIXTURE_SKILL_PATH = resolve(FIXTURE_CLAUDE_DIR, 'skills', 'hello', 'SKILL.md');

/**
 * Programmatic mirror of the file hook: an SDK `HookCallback` that injects the
 * marker via `SessionStart` `additionalContext`. Demonstrates the seam-2
 * contract in pure SDK form (no `node` on PATH required).
 */
export const sessionStartInjector: HookCallback = async (_input, _toolUseID, _options) => {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: HOOK_MARKER,
    },
  };
};

export type BuildOptions = {
  /** Also register the programmatic {@link sessionStartInjector} (default: false — rely on the file hook). */
  includeProgrammaticHook?: boolean;
  /** Extra SDK Options overrides. */
  overrides?: Partial<Options>;
};

/**
 * Shared base `Options` that make the Agent SDK discover the fixture `.claude`
 * config: its `settings.json` command hooks and its `hello` skill.
 *
 * `settingSources` MUST include `'project'` to load `.claude/settings.json` and
 * CLAUDE.md (per the SDK type docs); `'local'` adds `.claude/settings.local.json`.
 */
function buildBaseOptions(includeProgrammaticHook: boolean): Options {
  return {
    cwd: FIXTURE_PROJECT_DIR,
    settingSources: ['project', 'local'],
    skills: ['hello'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    ...(includeProgrammaticHook
      ? { hooks: { SessionStart: [{ hooks: [sessionStartInjector] }] } }
      : {}),
  };
}

/**
 * Phase 0 shape, preserved: build the fixture-wired SDK `Options` (no provider
 * selection). Kept intact so the Phase 0 config/hook proofs stay green.
 */
export function buildAthenaOptions(opts: BuildOptions = {}): Options {
  const { includeProgrammaticHook = false, overrides = {} } = opts;
  return { ...buildBaseOptions(includeProgrammaticHook), ...overrides };
}

export type BuildSessionArgs = {
  /** Provider to select. Default `'anthropic'`. */
  provider?: ProviderName;
  /** Model id (validated against the provider's known list). Defaults to descriptor default. */
  model?: string;
  /** Register the programmatic SessionStart injector as well (default false). */
  includeProgrammaticHook?: boolean;
  /** Extra SDK Options overrides (applied last). */
  overrides?: Partial<Options>;
  /** Env to read secrets from + spread into `Options.env` (default `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * Base-URL override for `ANTHROPIC_BASE_URL`. For OpenAI this is the live
   * sidecar address (a `SidecarManager.baseUrl` or a mock server url).
   */
  baseUrl?: string;
};

/** A built Athena session: the resolved provider selection + the SDK `Options`. */
export type AthenaSession = {
  /** The provider resolution (descriptor, sessionEnv, model, missingKeyEnvVar). */
  resolved: ResolvedProvider;
  /** SDK `Options` with `env` and `model` set for the chosen provider. */
  options: Options;
};

/**
 * Build a provider-configured SDK session. Evolution of {@link buildAthenaOptions}:
 * resolves the provider to a per-session env, then injects it via `Options.env`.
 *
 * CRITICAL (verified in step 0): `Options.env` REPLACES the spawned CLI's
 * environment entirely — it is NOT merged with `process.env`. So we spread the
 * incoming env FIRST and overlay the provider `sessionEnv` on top; otherwise the
 * CLI would lose `PATH`/`HOME` and fail to launch. This is what makes clean
 * multi-provider selection possible with no mutation of the parent `process.env`.
 */
export function buildSession(args: BuildSessionArgs = {}): AthenaSession {
  const {
    provider = 'anthropic',
    model,
    includeProgrammaticHook = false,
    overrides = {},
    env = process.env,
    baseUrl,
  } = args;

  const resolved = resolveProvider(provider, model, { env, baseUrl });

  const options: Options = {
    ...buildBaseOptions(includeProgrammaticHook),
    model: resolved.model,
    // Spread process.env FIRST (Options.env replaces, not merges), then overlay
    // the provider selection env.
    env: { ...env, ...resolved.sessionEnv },
    ...overrides,
  };

  return { resolved, options };
}

/**
 * Resolve the effective Claude Code settings the fixture config would produce —
 * using the SDK's own merge engine, WITHOUT spawning the CLI or a model turn.
 * The returned `effective.hooks` is the proof that the SDK discovered the
 * fixture's SessionStart / UserPromptSubmit command hooks.
 */
export async function resolveAthenaSettings(): Promise<ResolvedSettings> {
  return resolveSettings({
    cwd: FIXTURE_PROJECT_DIR,
    settingSources: ['project', 'local'],
  });
}
