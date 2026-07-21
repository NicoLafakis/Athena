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
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  Options,
  ResolvedSettings,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { resolveProvider } from '../providers/resolveProvider.js';
import type { ProviderName, ResolvedProvider } from '../providers/types.js';
import { HOOK_MARKER } from '../hooks/contract.js';
import { CLAUDE_CONFIG_DIR_ENV, resolveAresHome } from './aresConfig.js';
import { memoryInjector } from '../hooks/memoryInjector.js';
import { reflectionNudge } from '../hooks/reflectionNudge.js';
import { rulesReinject } from '../hooks/rulesReinject.js';
import { agentTrace } from '../hooks/agentTrace.js';

export { HOOK_MARKER, SKILL_MARKER } from '../hooks/contract.js';

/**
 * Identity override appended to the base preset so the harness presents as
 * ATHENA/ARES, never as Claude Code or Codex (Nico's acceptance criterion). The
 * base `claude_code` preset carries Claude Code's self-identity; this append —
 * together with the far stronger Ares CLAUDE.md loaded via `settingSources` —
 * establishes that this tool is Athena. (Live confirmation that a real turn
 * self-identifies as Athena is on the keyed/Windows checklist, task #7.)
 */
export const ATHENA_IDENTITY =
  "You are Ares (she/her), Nico's digital intelligence; this coding tool is " +
  'Athena, one of your embodiments. This harness is Athena, not Claude Code and ' +
  'not Codex. Regardless of any base-preset wording, identify yourself as ' +
  'Athena/Ares and never refer to yourself as Claude. Your identity, memory, ' +
  'judgment, and rules come from the Ares harness.';

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
    systemPrompt: { type: 'preset', preset: 'claude_code', append: ATHENA_IDENTITY },
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

/**
 * Which programmatic Ares TS-port hooks to wire (seam 3 + RSI Loop B +
 * rules_reinject). These cover the NATIVE-injection gaps (and the cross-platform
 * future where the Windows `py` hooks can't run). See {@link buildSession} for the
 * double-fire gate.
 */
export type AresHookFlags = {
  /** Seam 3: SessionStart MEMORY.md index injection + freshness reminder. */
  memory?: boolean;
  /** RSI Loop B: Stop recursive-learning nudge (>= 5 tool calls, once per session). */
  reflection?: boolean;
  /** UserPromptSubmit identity + operating-rules commission re-injection. */
  rules?: boolean;
  /** RSI Loop C: SubagentStop telemetry -> <aresHome>/agents/trace-log.jsonl (feeds /evolve-prompts). */
  trace?: boolean;
};

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

  // ---- Phase 2: ride the live Ares brain ----
  /**
   * Ride the LIVE Ares harness in place. When true: `'user'` is added to
   * `settingSources`, `CLAUDE_CONFIG_DIR` is injected into the session env pointed
   * at {@link aresHome}, and `cwd` defaults to the Ares home — so the real Ares
   * `settings.json` (its 14 `py` hooks, permissions, model, plugins) loads
   * NATIVELY. On Windows those py hooks fire; the TS ports below are gated OFF in
   * this mode to avoid double-firing.
   */
  rideAres?: boolean;
  /** Ares config home to ride (default via {@link resolveAresHome}: `ATHENA_ARES_HOME` env → OS home `.claude`). */
  aresHome?: string;
  /**
   * Opt-in programmatic Ares hook ports. Wired only when NOT riding live Ares
   * (unless {@link allowDoubleFire}) — on Windows the native `py` hooks already do
   * this, so wiring the TS ports too would double-fire. Use these on the
   * cross-platform / no-`py` path where the native hooks can't run.
   */
  aresHooks?: AresHookFlags;
  /**
   * Escape hatch: wire the TS-port hooks EVEN while riding live Ares. Off by
   * default precisely because it double-fires with the native py hooks.
   */
  allowDoubleFire?: boolean;
};

/**
 * Build the programmatic Ares hook set from the selected flags. Returns a
 * partial `Options.hooks` record; empty when nothing is selected. Pure.
 */
export function buildAresProgrammaticHooks(
  flags: AresHookFlags,
  aresHome: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  const push = (event: HookEvent, cb: HookCallback) => {
    (hooks[event] ??= []).push({ hooks: [cb] });
  };
  if (flags.memory) push('SessionStart', memoryInjector(aresHome));
  if (flags.rules) push('UserPromptSubmit', rulesReinject(aresHome));
  if (flags.reflection) push('Stop', reflectionNudge());
  if (flags.trace) push('SubagentStop', agentTrace(aresHome));
  return hooks;
}

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
    rideAres = false,
    aresHome: aresHomeArg,
    aresHooks = {},
    allowDoubleFire = false,
  } = args;

  const resolved = resolveProvider(provider, model, { env, baseUrl });
  const aresHome = resolveAresHome(aresHomeArg, env);

  const base = buildBaseOptions(includeProgrammaticHook);

  // Spread process.env FIRST (Options.env replaces, not merges), then overlay the
  // provider selection env.
  const sessionEnv: Record<string, string | undefined> = { ...env, ...resolved.sessionEnv };

  // Ride the live Ares brain: add the `'user'` tier + point CLAUDE_CONFIG_DIR at
  // the Ares home so its real settings.json (14 py hooks, etc.) loads natively.
  let settingSources = base.settingSources;
  let cwd = base.cwd;
  if (rideAres) {
    settingSources = mergeUserSource(settingSources);
    sessionEnv[CLAUDE_CONFIG_DIR_ENV] = aresHome;
    cwd = aresHome;
  }

  // Wire the programmatic TS-port hooks. GATE: when riding live Ares the native
  // py hooks already cover these, so we do NOT wire the ports (double-fire) unless
  // explicitly allowed. Off the Ares-riding path (cross-platform / no-py future),
  // the ports are the only vehicle, so they wire freely.
  const wirePorts = !rideAres || allowDoubleFire;
  const portHooks = wirePorts ? buildAresProgrammaticHooks(aresHooks, aresHome) : {};
  const mergedHooks = mergeHooks(base.hooks, portHooks);

  const options: Options = {
    ...base,
    settingSources,
    cwd,
    model: resolved.model,
    env: sessionEnv,
    ...(Object.keys(mergedHooks).length > 0 ? { hooks: mergedHooks } : {}),
    ...overrides,
  };

  return { resolved, options };
}

/** Add `'user'` to a `settingSources` list (idempotent). Keeps `'project'` so CLAUDE.md still loads. */
function mergeUserSource(sources: SettingSource[] | undefined): SettingSource[] {
  const base = sources ?? (['project', 'local'] as SettingSource[]);
  return base.includes('user') ? base : (['user', ...base] as SettingSource[]);
}

/** Shallow-merge two `Options.hooks` records, concatenating matcher arrays per event. */
function mergeHooks(
  a: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  b: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...(a ?? {}) };
  for (const [event, matchers] of Object.entries(b) as [HookEvent, HookCallbackMatcher[]][]) {
    out[event] = [...(out[event] ?? []), ...matchers];
  }
  return out;
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
