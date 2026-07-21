import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_HOOK_PATH, sessionStartInjector } from '../src/config/loadConfig.js';
import { HOOK_MARKER, buildCommandHookOutput } from '../src/hooks/contract.js';
import type { CommandHookStdin, CommandHookStdout } from '../src/hooks/contract.js';

/** Invoke the portable inject.mjs hook exactly as Claude Code would: pipe stdin JSON, read stdout. */
function runInjectHook(stdin: CommandHookStdin): Promise<CommandHookStdout> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`inject.mjs exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as CommandHookStdout);
      } catch (e) {
        reject(new Error(`inject.mjs stdout not JSON: ${JSON.stringify(out)} (${String(e)})`));
      }
    });
    child.stdin.write(JSON.stringify(stdin));
    child.stdin.end();
  });
}

describe('inject.mjs I/O contract (independent of a live turn)', () => {
  it('injects HOOK_MARKER as additionalContext for SessionStart', async () => {
    const res = await runInjectHook({
      session_id: 'test-session',
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(res.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(res.hookSpecificOutput.additionalContext).toBe(HOOK_MARKER);
  });

  it('echoes the event name for UserPromptSubmit', async () => {
    const res = await runInjectHook({
      session_id: 'test-session',
      cwd: '/tmp',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello world',
    });
    expect(res.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(res.hookSpecificOutput.additionalContext).toBe(HOOK_MARKER);
  });

  it('the file hook marker matches the contract constant (no drift)', () => {
    const src = readFileSync(FIXTURE_HOOK_PATH, 'utf8');
    expect(src).toContain(HOOK_MARKER);
  });
});

describe('programmatic SDK hook mirror', () => {
  it('sessionStartInjector returns SessionStart additionalContext=HOOK_MARKER', async () => {
    const controller = new AbortController();
    const out = (await sessionStartInjector(
      { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' } as never,
      undefined,
      { signal: controller.signal },
    )) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput?.additionalContext).toBe(HOOK_MARKER);
  });

  it('buildCommandHookOutput produces the documented stdout shape', () => {
    expect(buildCommandHookOutput('UserPromptSubmit')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: HOOK_MARKER,
      },
    });
  });
});
