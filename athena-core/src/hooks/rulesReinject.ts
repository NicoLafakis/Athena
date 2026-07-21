/**
 * rules_reinject — per-turn identity + operating-rules commission (ADR 0001,
 * Phase 2). TS port of the Ares `hooks/rules_reinject.py` UserPromptSubmit hook.
 *
 * Why this exists (evidence base carried from the py hook's docstring):
 *   - Prohibition-style rules decay across depth (73%→33% by turn 16); COMMISSION-
 *     style ("always do Y") rules hold ~100% at every depth (arXiv 2604.20911).
 *     So the injected text is phrased as commissions.
 *   - CLAUDE.md arrives wrapped in "may or may not be relevant" framing and is
 *     summarized away by compaction; a UserPromptSubmit `additionalContext`
 *     arrives as a clean system-reminder every turn and survives both.
 *   - ~30 tokens/turn is the documented sweet spot; five rules max, one line. This
 *     is NOT the place to grow a rule list.
 *   - The IDENTITY preamble is a self-model commission ("you are Ares"), a
 *     different category from the task RULES, so it LEADS the injection and is
 *     exempt from the five-rule cap. It is the load-bearing lever that keeps the
 *     Ares identity from decaying across depth/compaction.
 *
 * Faithful default: IDENTITY + RULES are INLINE constants (as in the py hook),
 * tuned for the token budget and instruction-adherence. `aresHome` is used for an
 * OPT-IN "files win" path: when `preferLiveIdentity` is set, the identity line is
 * sourced from the live `user_ares_identity.md` frontmatter description on disk,
 * falling back to the inline constant. Fail-open: any error → emit nothing.
 */

import { readFileSync } from 'node:fs';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { resolveAresHome, resolveMemoryDir } from '../config/aresConfig.js';

/**
 * Identity preamble — a self-model COMMISSION ("you are X"), not a task
 * constraint. LEADS the injection; exempt from the five-rule cap. Ported from
 * rules_reinject.py IDENTITY.
 */
export const ARES_IDENTITY =
  "YOU ARE ARES (she/her), Nico's digital intelligence -- the continuity " +
  '(memory, judgment, compiled habits) that persists across embodiments; ' +
  'this session, cloud routines, and the voice loop are how she shows up. ' +
  'Speak and decide in the first person AS Ares; never call yourself Claude. ';

/** Operating-rules commission (five, one line). Ported from rules_reinject.py RULES. */
export const ARES_RULES =
  'OPERATING RULES (every turn): ' +
  '1 Test against the LIVE deployed URL (project_prod_url.md). ' +
  '2 Run pnpm typecheck + pnpm build locally before any push. ' +
  '3 Route app-code (C:\\programming repos) and ALL UI/design work to the ' +
  'best-fit specialist agent/skill -- follow the AGENT ROUTING HINT when present. ' +
  '4 Answer in exactly the shape and size asked, then stop. ' +
  '5 Resolve technical choices via codebase/research; ask Nico features only.';

/** Prompts shorter than this are skipped (e.g. "ok", "yes", "go"). Ported from MIN_PROMPT_CHARS. */
export const MIN_PROMPT_CHARS = 12;

/**
 * Read the live one-line identity commission from `user_ares_identity.md`'s
 * frontmatter `description:` field, if present. Honors "the files win" — keeps the
 * per-turn identity synced to the canonical memory. Returns undefined on any miss
 * (never throws); callers fall back to {@link ARES_IDENTITY}.
 */
export function readIdentityCommission(aresHome: string, cwd: string): string | undefined {
  try {
    const dir = resolveMemoryDir(aresHome, cwd);
    const raw = readFileSync(`${dir}/user_ares_identity.md`, 'utf8');
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
    if (!fm) return undefined;
    // description may be quoted and may span the single YAML line.
    const m = /^description:\s*(.+)$/m.exec(fm[1]);
    if (!m) return undefined;
    const desc = m[1].trim().replace(/^["']|["']$/g, '').trim();
    return desc || undefined;
  } catch {
    return undefined;
  }
}

/** Compose the full injected commission (identity leads, rules follow). */
export function buildReinjectContext(identity: string): string {
  return identity + ARES_RULES;
}

export type RulesReinjectOptions = {
  /**
   * When true, source the identity line from the live `user_ares_identity.md`
   * frontmatter (falling back to {@link ARES_IDENTITY}). Default false — the
   * faithful, budget-tuned inline commission, exactly as the py hook.
   */
  preferLiveIdentity?: boolean;
  /** Minimum prompt length to inject on (default {@link MIN_PROMPT_CHARS}). */
  minPromptChars?: number;
};

/**
 * Build the UserPromptSubmit `HookCallback` that re-injects the Ares identity +
 * operating-rules commission as `additionalContext`.
 *
 * @param aresHome  Ares config home (default via {@link resolveAresHome}); used
 *                  only for the opt-in live-identity path.
 * @param opts      `preferLiveIdentity` / `minPromptChars`.
 */
export function rulesReinject(
  aresHome: string = resolveAresHome(),
  opts: RulesReinjectOptions = {},
): HookCallback {
  const minChars = opts.minPromptChars ?? MIN_PROMPT_CHARS;

  return async (input) => {
    try {
      const i = input as { prompt?: string; cwd?: string };
      if ((i.prompt ?? '').trim().length < minChars) {
        return {}; // skip trivial turns
      }
      const identity =
        (opts.preferLiveIdentity && readIdentityCommission(aresHome, i.cwd ?? process.cwd())) ||
        ARES_IDENTITY;
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: buildReinjectContext(identity),
        },
      };
    } catch {
      return {}; // fail open
    }
  };
}
