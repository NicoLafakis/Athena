/**
 * Ares config discovery + path resolution (ADR 0001, Phase 2 — "Brain port").
 *
 * Athena is Nico's personal tool: it rides the LIVE Ares harness in place rather
 * than copying it. Concretely, the Claude Agent SDK's config directory is pointed
 * at the Ares home (`~/.claude` on the Windows host) via `CLAUDE_CONFIG_DIR`, and
 * `settingSources` includes `'user'` so the run merges the real Ares
 * `settings.json` — its 14 `py` hooks, permissions, model, plugins — natively.
 *
 * STEP-0 finding (verified keyless against the installed SDK, see PHASE2.md):
 *   - `resolveSettings({ cwd, settingSources:['user'] })` reads the `user`-tier
 *     `settings.json` from `CLAUDE_CONFIG_DIR`. Pointing that env var at the real
 *     `/home/user/Ares` discovers ALL its hooks (PreToolUse/SessionStart/
 *     UserPromptSubmit/PostToolUse/Stop, incl. `reflection.py`, `rules_reinject.py`)
 *     with NO key and NO model turn.
 *   - Claude Code's NATIVE auto-memory directory defaults to
 *     `~/.claude/projects/<sanitized-cwd>/memory/` — EXACTLY where Ares stores its
 *     `MEMORY.md` index + `*.md` memory files. So the Ares memory store IS Claude
 *     Code's auto-memory directory. `sanitizeCwd` below reproduces that slug.
 *
 * Everything here is filesystem + env only — no network, no key, no model turn.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedSettings, SettingSource } from '@anthropic-ai/claude-agent-sdk';

/**
 * Environment variable the Claude Agent SDK / Claude Code CLI reads to override
 * the config directory (normally `~/.claude`). Verified present in the SDK
 * bundle. `discoverAresConfig` sets this to `aresHome` around the
 * `resolveSettings` call so the merge engine reads the Ares `settings.json`.
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Env var a caller can set to override the Ares home (takes precedence over the OS default). */
export const ARES_HOME_ENV = 'ATHENA_ARES_HOME';

/**
 * Resolve the Ares home (the `.claude`-style config dir Athena rides).
 * Precedence: explicit arg → `ATHENA_ARES_HOME` env → OS home `.claude`.
 *
 * On the Windows host this resolves to `C:\Users\<user>\.claude` (the live Ares).
 * In this Linux authoring container it is overridden to `/home/user/Ares` (the
 * authentic-format Ares REPO) via the env var or an explicit arg.
 */
export function resolveAresHome(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return explicit ?? env[ARES_HOME_ENV] ?? join(homedir(), '.claude');
}

/**
 * Reproduce Claude Code's `projects/<slug>` sanitization: every non-alphanumeric
 * character in the working directory becomes `-`. Verified against the real Ares
 * hub slug (`C:\Users\lafak\.claude` → `C--Users-lafak--claude`) and siblings.
 *
 * VOLATILE detail: this mirrors Claude Code's OBSERVED scheme; callers that know
 * their memory dir should pass it explicitly rather than depend on derivation.
 */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The Ares/Claude-Code auto-memory directory for a given working dir:
 * `<aresHome>/projects/<sanitizeCwd(cwd)>/memory`. An explicit `override` wins
 * (deterministic — used by tests and by callers who know their dir).
 */
export function resolveMemoryDir(aresHome: string, cwd: string, override?: string): string {
  if (override) return override;
  return join(aresHome, 'projects', sanitizeCwd(cwd), 'memory');
}

/** One discovered hook command (from the merged Ares `settings.json`). */
export type DiscoveredHook = {
  event: string;
  matcher?: string;
  type: string;
  command?: string;
  timeout?: number;
};

/** What `discoverAresConfig` returns — a keyless snapshot of the live Ares brain's wiring. */
export type AresConfig = {
  /** The resolved Ares home that was inspected. */
  aresHome: string;
  /** Whether `<aresHome>/settings.json` was found + merged by the SDK. */
  found: boolean;
  /** Path the `user`-tier settings were attributed to (proof of discovery), if any. */
  settingsPath?: string;
  /** Hook events present in the merged settings (e.g. SessionStart, Stop, ...). */
  hookEvents: string[];
  /** Flattened list of every discovered hook command, tagged by event. */
  hooks: DiscoveredHook[];
  /** Agent names discovered under `<aresHome>/agents/*.md` (index files excluded). */
  agents: string[];
  /** Skill names discovered under `<aresHome>/skills/<name>/SKILL.md`. */
  skills: string[];
  /** The raw SDK settings resolution (for callers that need provenance/full detail). */
  resolved: ResolvedSettings;
};

/** Non-agent index files that live in `agents/` but are not themselves agents. */
const AGENT_INDEX_FILES = new Set(['MANIFEST.md', 'ROUTING-INDEX.md', 'README.md', 'INDEX.md']);

function listAgents(aresHome: string): string[] {
  const dir = join(aresHome, 'agents');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !AGENT_INDEX_FILES.has(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function listSkills(aresHome: string): string[] {
  const dir = join(aresHome, 'skills');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => {
        try {
          return (
            statSync(join(dir, name)).isDirectory() &&
            existsSync(join(dir, name, 'SKILL.md'))
          );
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Flatten `effective.hooks` (a `{ [event]: [{matcher?, hooks:[...]}] }` record) into a tagged list. */
function flattenHooks(hooks: unknown): DiscoveredHook[] {
  const out: DiscoveredHook[] = [];
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      const matcher = (m as { matcher?: string }).matcher;
      const inner = (m as { hooks?: unknown }).hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const hook = h as { type?: string; command?: string; timeout?: number };
        out.push({
          event,
          matcher,
          type: hook.type ?? 'command',
          command: hook.command,
          timeout: hook.timeout,
        });
      }
    }
  }
  return out;
}

export type DiscoverAresConfigOptions = {
  /** Setting sources to merge. Default `['user']` — the tier Ares' `settings.json` occupies. */
  settingSources?: SettingSource[];
};

/**
 * Discover the live Ares config KEYLESS: point the SDK's settings-merge engine at
 * `aresHome` (via `CLAUDE_CONFIG_DIR`) and read back its hooks, plus scan the
 * agents/ and skills/ trees.
 *
 * The SDK `Settings` schema does NOT enumerate agents or skills (those are
 * filesystem-discovered at runtime, not part of `settings.json`), so this uses
 * `resolveSettings` for the authoritative hook wiring and a directory scan for
 * agents/skills.
 *
 * `resolveSettings` reads the REAL `process.env.CLAUDE_CONFIG_DIR` at call time
 * (it takes no env argument), so this sets that global env var for the duration
 * of the call and RESTORES it afterward (try/finally) — `process.env` is never
 * left mutated. Caveat: because the config-dir is a process-global, concurrent
 * discoveries against DIFFERENT homes can race; run them sequentially.
 */
export async function discoverAresConfig(
  aresHome: string = resolveAresHome(),
  opts: DiscoverAresConfigOptions = {},
): Promise<AresConfig> {
  const settingSources = opts.settingSources ?? (['user'] as SettingSource[]);

  const prev = process.env[CLAUDE_CONFIG_DIR_ENV];
  process.env[CLAUDE_CONFIG_DIR_ENV] = aresHome;
  let resolved: ResolvedSettings;
  try {
    resolved = await resolveSettings({ cwd: aresHome, settingSources });
  } finally {
    if (prev === undefined) delete process.env[CLAUDE_CONFIG_DIR_ENV];
    else process.env[CLAUDE_CONFIG_DIR_ENV] = prev;
  }

  const hooks = flattenHooks(resolved.effective.hooks);
  const settingsPath = resolved.sources.find(
    (s) => s.source === 'user' && s.path,
  )?.path;

  return {
    aresHome,
    found: Boolean(settingsPath) || hooks.length > 0,
    settingsPath,
    hookEvents: Object.keys(resolved.effective.hooks ?? {}),
    hooks,
    agents: listAgents(aresHome),
    skills: listSkills(aresHome),
    resolved,
  };
}
