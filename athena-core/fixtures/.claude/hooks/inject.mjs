#!/usr/bin/env node
/*
 * Athena Phase 0 portable hook fixture.
 *
 * Stands in for the Windows `py` hooks (which use C:\ paths + the `py` launcher
 * and cannot run in the Linux authoring container). Reads the Claude Code hook
 * stdin JSON and injects a marker via `hookSpecificOutput.additionalContext`,
 * echoing back the event name it was fired for. Self-contained (zero imports)
 * so it runs identically on Linux authoring and the Windows host.
 *
 * The marker literal MUST match HOOK_MARKER in src/hooks/contract.ts — a unit
 * test asserts they agree.
 */

const MARKER = 'ATHENA_PHASE0_HOOK_OK::additionalContext-injected';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

const raw = await readStdin();

let input = {};
try {
  input = raw ? JSON.parse(raw) : {};
} catch {
  input = {};
}

const hookEventName =
  typeof input.hook_event_name === 'string' && input.hook_event_name.length > 0
    ? input.hook_event_name
    : 'SessionStart';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: MARKER,
    },
  }),
);
process.exit(0);
