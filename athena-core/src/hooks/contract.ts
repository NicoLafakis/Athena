/**
 * Hook I/O contract (seam 2).
 *
 * Mirrors the Claude Code command-hook stdin/stdout contract so it can be
 * exercised in-process and kept in sync with the portable file hook at
 * `fixtures/.claude/hooks/inject.mjs`. The marker below is the single source of
 * truth; `inject.mjs` hardcodes the same literal (it must stay dependency-free
 * for portability), and a unit test asserts the two agree.
 */

/** The string a hook injects via `additionalContext` to prove injection end-to-end. */
export const HOOK_MARKER = 'ATHENA_PHASE0_HOOK_OK::additionalContext-injected';

/** The `hello` fixture skill's expected response marker (skill-discovery proof, keyed). */
export const SKILL_MARKER = 'ATHENA_HELLO_SKILL_OK';

/** Stdin JSON a Claude Code command hook receives (subset; fields are event-specific). */
export type CommandHookStdin = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  /** UserPromptSubmit */
  prompt?: string;
  /** SessionStart */
  source?: string;
  permission_mode?: string;
};

/** Stdout JSON a command hook prints to inject `additionalContext`. */
export type CommandHookStdout = {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
};

/** Build the stdout payload a command hook prints. Pure; used by the programmatic mirror and tests. */
export function buildCommandHookOutput(
  hookEventName: string,
  marker: string = HOOK_MARKER,
): CommandHookStdout {
  return { hookSpecificOutput: { hookEventName, additionalContext: marker } };
}
