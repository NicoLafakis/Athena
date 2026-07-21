import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATHENA_CORE_ROOT } from '../src/config/loadConfig.js';
import {
  formatSnapshotDate,
  getSessions,
  projectFromCwd,
  projectFromSlug,
  readSessionSnapshot,
} from '../src/rsi/sessions.js';

const RSI_HOME = join(ATHENA_CORE_ROOT, 'fixtures', 'rsi-home');
const ATHENA_TRANSCRIPT = join(
  RSI_HOME,
  'projects',
  'C--code--athena',
  'build-session.jsonl',
);
/** A window wide enough that fixture mtimes always fall inside it, regardless of checkout time. */
const WIDE = { root: RSI_HOME, days: 36_500, now: Date.UTC(2026, 6, 21) };

describe('project label derivation', () => {
  it('projectFromSlug: tail segment, hub for the .claude home', () => {
    expect(projectFromSlug('C--programming--ProvenLabs-src-ProvenContacts')).toBe('ProvenContacts');
    expect(projectFromSlug('C--Users-nico--claude')).toBe('hub');
  });
  it('projectFromCwd: basename cross-platform, .claude -> hub', () => {
    expect(projectFromCwd('C:\\code\\athena')).toBe('athena');
    expect(projectFromCwd('/home/user/thing/')).toBe('thing');
    expect(projectFromCwd('C:\\Users\\nico\\.claude')).toBe('hub');
  });
});

describe('formatSnapshotDate', () => {
  it('renders YYYY-MM-DD HH:MM', () => {
    expect(formatSnapshotDate(new Date(2026, 6, 21, 9, 5).getTime())).toBe('2026-07-21 09:05');
  });
});

describe('readSessionSnapshot — distills one transcript (Seam 1)', () => {
  it('extracts intent, cwd, tool calls, edited files, and clean commits', async () => {
    const snap = await readSessionSnapshot(ATHENA_TRANSCRIPT, { lastActive: 0 });
    expect(snap.project).toBe('athena');
    expect(snap.cwd).toBe('C:\\code\\athena');
    expect(snap.intent).toMatch(/^Wire up the RSI reflection loop/);
    expect(snap.toolCalls).toBe(6);
    // Edit reflect.ts + Write sessions.ts -> 2 deduped files
    expect(snap.files).toHaveLength(2);
    expect(snap.files.some((f) => f.endsWith('reflect.ts'))).toBe(true);
    expect(snap.files.some((f) => f.endsWith('sessions.ts'))).toBe(true);
  });

  it('captures the clean commit and drops the $()-substitution noise commit', async () => {
    const snap = await readSessionSnapshot(ATHENA_TRANSCRIPT, { lastActive: 0 });
    expect(snap.commits).toEqual(['feat(rsi): loop A reflection']);
  });

  it('missing/garbage transcript -> mostly-empty snapshot, never throws', async () => {
    const snap = await readSessionSnapshot('/no/such/transcript.jsonl', { lastActive: 0 });
    expect(snap.toolCalls).toBe(0);
    expect(snap.intent).toBe('');
    expect(snap.files).toEqual([]);
  });
});

describe('getSessions — enumerates the projects tree (Seam 1)', () => {
  it('returns real sessions and filters the trivial (no intent, no tools) one', async () => {
    const sessions = await getSessions(WIDE);
    const projects = sessions.map((s) => s.project).sort();
    expect(projects).toContain('athena');
    expect(projects).toContain('hub');
    expect(projects).not.toContain('empty'); // trivial session dropped
  });

  it('respects the days window (nothing when the cutoff is past the fixtures)', async () => {
    // now far in the future + a 1-day window -> cutoff is after every fixture mtime -> excluded.
    const sessions = await getSessions({ root: RSI_HOME, days: 1, now: Date.UTC(2100, 0, 1) });
    expect(sessions).toEqual([]);
  });

  it('honors the exclude filter (by project or slug substring)', async () => {
    const sessions = await getSessions({ ...WIDE, exclude: ['athena'] });
    expect(sessions.some((s) => s.project === 'athena')).toBe(false);
    expect(sessions.some((s) => s.project === 'hub')).toBe(true);
  });

  it('caps the result set (maxSessions)', async () => {
    const sessions = await getSessions({ ...WIDE, maxSessions: 1 });
    expect(sessions).toHaveLength(1);
  });

  it('missing projects dir -> [] (never throws)', async () => {
    const sessions = await getSessions({ root: '/no/such/home', days: 9999 });
    expect(sessions).toEqual([]);
  });
});
