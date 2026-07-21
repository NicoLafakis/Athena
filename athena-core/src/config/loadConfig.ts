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
 * Build the SDK `Options` that make the Agent SDK discover the fixture `.claude`
 * config: its `settings.json` command hooks and its `hello` skill.
 *
 * `settingSources` MUST include `'project'` to load `.claude/settings.json` and
 * CLAUDE.md (per the SDK type docs); `'local'` adds `.claude/settings.local.json`.
 */
export function buildAthenaOptions(opts: BuildOptions = {}): Options {
  const { includeProgrammaticHook = false, overrides = {} } = opts;
  const base: Options = {
    cwd: FIXTURE_PROJECT_DIR,
    settingSources: ['project', 'local'],
    skills: ['hello'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    ...(includeProgrammaticHook
      ? { hooks: { SessionStart: [{ hooks: [sessionStartInjector] }] } }
      : {}),
  };
  return { ...base, ...overrides };
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
