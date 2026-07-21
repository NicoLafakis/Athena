/**
 * RSI Loop B — reflection nudge (ADR 0001, Phase 2). TS port of the Ares
 * `hooks/reflection.py` Stop hook.
 *
 * Intent (unchanged from the py hook): after a SUBSTANTIVE session (>= THRESHOLD
 * tool calls) the model is prompted, once, to run the recursive-learning loop
 * (CLAUDE.md rule 9 / the `recursive-learning` skill) while context is still
 * fresh — so a correction or a non-obvious working strategy gets encoded as a
 * SKILL.md patch or feedback memory instead of evaporating.
 *
 * Mechanics, verified against the installed `sdk.d.ts` (see PHASE2.md):
 *   - `StopHookInput.stop_hook_active` is the loop guard: when Claude Code is
 *     already continuing BECAUSE a Stop hook blocked, this is true — we must NOT
 *     block again (that is the infinite-nudge trap). The py hook's once-per-session
 *     flag file plays the same role; we honor BOTH.
 *   - `SyncHookJSONOutput` exposes `decision:'block'` + `reason`; for a Stop hook
 *     that continues the conversation with `reason` fed back to the model. That is
 *     exactly the re-prompt vehicle (Phase 0 seam-2 confirmation).
 *   - The tool-call count is derived by streaming the JSONL transcript and
 *     counting assistant `tool_use` blocks — same approach as reflection.py /
 *     journal_capture.py, with an early exit once THRESHOLD is reached.
 *
 * Per-session marker: the py hook is a fresh process per fire, so it uses a flag
 * FILE. A programmatic `HookCallback` runs IN this host process, so a module-level
 * `Set<sessionId>` is the faithful equivalent (with an injectable store + a reset
 * for test isolation). Fail-open throughout: any error → allow the stop.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/** A session with at least this many tool calls is "substantive" (matches CLAUDE.md rule 9 / reflection.py). */
export const REFLECTION_THRESHOLD = 5;

/**
 * The recursive-learning nudge — ported verbatim in intent from reflection.py.
 * Delivered as the Stop `reason`, which continues the conversation once so the
 * model can act on it.
 */
export function reflectionNudgeText(toolCalls: number): string {
  return (
    `RECURSIVE-LEARNING CHECK: this was a substantive session (${toolCalls}+ tool ` +
    `calls). Before ending, run the recursive-learning loop (CLAUDE.md rule 9): did ` +
    `anything generalize? If a correction, a fail-then-recover, or a non-obvious ` +
    `working strategy surfaced, encode it now as a SKILL.md patch (multi-step ` +
    `procedure) or a feedback memory (shorter rule), with a trigger, the steps, and ` +
    `the why. Reuse before re-deriving next time. If nothing generalizes, ignore ` +
    `this and end.`
  );
}

const SYSTEM_MESSAGE =
  'Recursive-learning check: substantive session, consider encoding what generalized.';

/** Default in-process once-per-session marker store. */
const defaultNudged = new Set<string>();

/** Clear the default marker store (test isolation). */
export function resetReflectionState(): void {
  defaultNudged.clear();
}

/**
 * Stream a JSONL transcript and count assistant `tool_use` blocks, stopping early
 * once `threshold` is reached (we only need substantive-or-not, not the exact
 * total). Never throws — a missing/garbage transcript counts as 0.
 */
export async function countToolUseBlocks(
  transcriptPath: string | undefined,
  threshold: number = REFLECTION_THRESHOLD,
): Promise<number> {
  if (!transcriptPath) return 0;
  let n = 0;
  try {
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"tool_use"')) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const e = ev as { type?: string; message?: { content?: unknown } };
      if (e.type !== 'assistant') continue;
      const content = e.message?.content;
      if (Array.isArray(content)) {
        n += content.filter(
          (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use',
        ).length;
      }
      if (n >= threshold) {
        rl.close();
        return n;
      }
    }
  } catch {
    return n;
  }
  return n;
}

export type ReflectionNudgeOptions = {
  /** Tool-call threshold for "substantive" (default {@link REFLECTION_THRESHOLD}). */
  threshold?: number;
  /** Injectable once-per-session marker store (default a module-level Set). */
  nudged?: Set<string>;
};

/**
 * Build the RSI Loop B Stop `HookCallback`.
 *
 * Behavior:
 *   - `stop_hook_active === true`  → allow (loop guard; never re-block).
 *   - already nudged this session  → allow (once-per-session).
 *   - tool calls < threshold       → allow.
 *   - tool calls >= threshold      → `{ decision:'block', reason: <nudge> }` and
 *     mark the session nudged.
 */
export function reflectionNudge(opts: ReflectionNudgeOptions = {}): HookCallback {
  const threshold = opts.threshold ?? REFLECTION_THRESHOLD;
  const nudged = opts.nudged ?? defaultNudged;

  return async (input): Promise<HookJSONOutput> => {
    try {
      const stop = input as {
        stop_hook_active?: boolean;
        session_id?: string;
        transcript_path?: string;
      };

      // Loop guard: we are only here again because a prior Stop block continued
      // the run. Do not nudge again.
      if (stop.stop_hook_active) return { continue: true };

      const key = stop.session_id ?? 'default';
      if (nudged.has(key)) return { continue: true }; // once per session

      const n = await countToolUseBlocks(stop.transcript_path, threshold);
      if (n < threshold) return { continue: true };

      nudged.add(key);
      return {
        decision: 'block',
        reason: reflectionNudgeText(n),
        systemMessage: SYSTEM_MESSAGE,
      };
    } catch {
      return { continue: true }; // fail-open: never trap the session
    }
  };
}
