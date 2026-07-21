import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATHENA_CORE_ROOT } from '../src/config/loadConfig.js';
import {
  buildMemoryContext,
  freshnessNote,
  memoryAgeDays,
  memoryInjector,
  readMemoryIndex,
} from '../src/hooks/memoryInjector.js';

const FIXTURE_ARES_HOME = join(ATHENA_CORE_ROOT, 'fixtures', 'ares-home');
/** cwd whose sanitized slug is `proj-fixture` (matches the fixture memory dir). */
const FIXTURE_CWD = 'proj-fixture';

/** Minimal SessionStart hook input. */
function sessionStartInput(cwd: string) {
  return { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', cwd } as never;
}
const OPTS = { signal: new AbortController().signal };

describe('memoryAgeDays / freshnessNote', () => {
  it('computes whole-day age from mtime', () => {
    const now = 10 * 86_400_000;
    expect(memoryAgeDays(0, now)).toBe(10);
    expect(memoryAgeDays(now, now)).toBe(0);
  });
  it('freshnessNote carries the "files win / verify on disk" doctrine', () => {
    expect(freshnessNote(0)).toContain('refreshed today');
    const note = freshnessNote(3);
    expect(note).toContain('3 days old');
    expect(note).toMatch(/files win/i);
    expect(note).toMatch(/verify against the live artifact on disk/i);
  });
});

describe('readMemoryIndex — reads the Ares MEMORY.md index for a cwd', () => {
  it('finds and reads the fixture index via slug derivation', () => {
    const read = readMemoryIndex(FIXTURE_ARES_HOME, FIXTURE_CWD);
    expect(read.found).toBe(true);
    expect(read.path.endsWith(join('proj-fixture', 'memory', 'MEMORY.md'))).toBe(true);
    expect(read.content).toContain('Ares identity');
    expect(read.content).toContain('Recursive learning loop');
  });
  it('honors an explicit memoryDir override', () => {
    const dir = join(FIXTURE_ARES_HOME, 'projects', 'proj-fixture', 'memory');
    const read = readMemoryIndex(FIXTURE_ARES_HOME, 'anything', { memoryDir: dir });
    expect(read.found).toBe(true);
  });
  it('missing index -> found:false (fail-open), never throws', () => {
    const read = readMemoryIndex(FIXTURE_ARES_HOME, 'no-such-project');
    expect(read.found).toBe(false);
    expect(read.content).toBe('');
  });
  it('truncates oversized indexes', () => {
    const read = readMemoryIndex(FIXTURE_ARES_HOME, FIXTURE_CWD, { maxChars: 40 });
    expect(read.truncated).toBe(true);
    expect(read.content).toContain('[...truncated]');
  });
});

describe('buildMemoryContext', () => {
  it('leads with the index header + freshness, then the body', () => {
    const read = readMemoryIndex(FIXTURE_ARES_HOME, FIXTURE_CWD, { now: 0 });
    const ctx = buildMemoryContext(read);
    expect(ctx).toMatch(/^ARES MEMORY INDEX/);
    expect(ctx).toMatch(/files win/i);
    expect(ctx).toContain('Ares identity');
  });
});

describe('memoryInjector — SessionStart HookCallback (seam 3)', () => {
  it('injects MEMORY.md as additionalContext for the session cwd', async () => {
    const cb = memoryInjector(FIXTURE_ARES_HOME);
    const out = (await cb(sessionStartInput(FIXTURE_CWD), undefined, OPTS)) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput?.additionalContext).toContain('ARES MEMORY INDEX');
    expect(out.hookSpecificOutput?.additionalContext).toContain('Verify state against disk');
  });

  it('no index for the cwd -> empty output (fail-open, does not break session start)', async () => {
    const cb = memoryInjector(FIXTURE_ARES_HOME);
    const out = await cb(sessionStartInput('project-with-no-memory'), undefined, OPTS);
    expect(out).toEqual({});
  });
});
