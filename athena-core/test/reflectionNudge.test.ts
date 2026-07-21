import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ATHENA_CORE_ROOT } from '../src/config/loadConfig.js';
import {
  countToolUseBlocks,
  reflectionNudge,
  resetReflectionState,
} from '../src/hooks/reflectionNudge.js';

const SUBSTANTIVE = join(ATHENA_CORE_ROOT, 'fixtures', 'transcripts', 'substantive.jsonl');
const LIGHT = join(ATHENA_CORE_ROOT, 'fixtures', 'transcripts', 'light.jsonl');
const OPTS = { signal: new AbortController().signal };

/** Minimal StopHookInput. */
function stopInput(over: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'Stop',
    session_id: 'sess-A',
    transcript_path: SUBSTANTIVE,
    stop_hook_active: false,
    ...over,
  } as never;
}

beforeEach(() => resetReflectionState());

describe('countToolUseBlocks — streams the JSONL transcript', () => {
  it('counts >= threshold in a substantive transcript', async () => {
    expect(await countToolUseBlocks(SUBSTANTIVE)).toBeGreaterThanOrEqual(5);
  });
  it('counts < threshold in a light transcript', async () => {
    expect(await countToolUseBlocks(LIGHT)).toBeLessThan(5);
  });
  it('missing transcript -> 0 (never throws)', async () => {
    expect(await countToolUseBlocks(undefined)).toBe(0);
    expect(await countToolUseBlocks('/no/such/file.jsonl')).toBe(0);
  });
});

describe('reflectionNudge — RSI Loop B Stop hook', () => {
  it('>= 5 tool calls -> blocks once with the recursive-learning nudge', async () => {
    const cb = reflectionNudge();
    const out = (await cb(stopInput(), undefined, OPTS)) as {
      decision?: string;
      reason?: string;
      systemMessage?: string;
    };
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/RECURSIVE-LEARNING CHECK/);
    expect(out.reason).toMatch(/SKILL\.md patch|feedback memory/);
    expect(out.systemMessage).toBeTruthy();
  });

  it('< 5 tool calls -> allows (no nudge)', async () => {
    const cb = reflectionNudge();
    const out = (await cb(
      stopInput({ transcript_path: LIGHT, session_id: 'sess-light' }),
      undefined,
      OPTS,
    )) as { decision?: string };
    expect(out.decision).toBeUndefined();
  });

  it('second call in the same session -> no double-nudge', async () => {
    const cb = reflectionNudge();
    const first = (await cb(stopInput(), undefined, OPTS)) as { decision?: string };
    const second = (await cb(stopInput(), undefined, OPTS)) as { decision?: string };
    expect(first.decision).toBe('block');
    expect(second.decision).toBeUndefined();
  });

  it('stop_hook_active guard -> never re-blocks (loop guard)', async () => {
    const cb = reflectionNudge();
    const out = (await cb(
      stopInput({ stop_hook_active: true, session_id: 'sess-loop' }),
      undefined,
      OPTS,
    )) as { decision?: string };
    expect(out.decision).toBeUndefined();
  });

  it('distinct sessions each get their own single nudge', async () => {
    const cb = reflectionNudge();
    const a = (await cb(stopInput({ session_id: 'A' }), undefined, OPTS)) as { decision?: string };
    const b = (await cb(stopInput({ session_id: 'B' }), undefined, OPTS)) as { decision?: string };
    expect(a.decision).toBe('block');
    expect(b.decision).toBe('block');
  });
});
