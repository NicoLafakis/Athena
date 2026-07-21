import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATHENA_CORE_ROOT } from '../src/config/loadConfig.js';
import type { SessionSnapshot } from '../src/rsi/sessions.js';
import {
  buildDigest,
  buildPrompt,
  PROMPT_HEADER,
  runReflection,
  shortPath,
  writeReflection,
  ymd,
} from '../src/rsi/reflect.js';

const RSI_HOME = join(ATHENA_CORE_ROOT, 'fixtures', 'rsi-home');
const WIDE_NOW = new Date(Date.UTC(2026, 6, 21, 12, 0));

/** Two hand-built snapshots with fixed timestamps — deterministic digest input. */
function fixtureSnapshots(): SessionSnapshot[] {
  return [
    {
      sessionId: 's-athena',
      project: 'athena',
      date: '2026-07-21 09:00',
      intent: 'Wire the RSI loop',
      toolCalls: 6,
      files: ['C:/code/athena/src/rsi/reflect.ts', 'C:/code/athena/src/rsi/sessions.ts'],
      commits: ['feat(rsi): loop A reflection'],
      lastActive: Date.UTC(2026, 6, 21, 9, 0),
    },
    {
      sessionId: 's-hub',
      project: 'hub',
      date: '2026-07-20 18:00',
      intent: 'Reflect over the week',
      toolCalls: 1,
      files: [],
      commits: [],
      lastActive: Date.UTC(2026, 6, 20, 18, 0),
    },
  ];
}

describe('shortPath', () => {
  it('trims to the last 3 segments', () => {
    expect(shortPath('C:\\code\\athena\\src\\rsi\\reflect.ts')).toBe('src/rsi/reflect.ts');
    expect(shortPath('/a/b')).toBe('/a/b');
  });
});

describe('buildDigest (Stage 1, keyless, pure)', () => {
  it('groups by project (most-recent first) with intent + meta lines', () => {
    const digest = buildDigest(fixtureSnapshots());
    // athena is more recent -> comes first
    expect(digest.indexOf('## athena')).toBeLessThan(digest.indexOf('## hub'));
    expect(digest).toContain('## athena  (1 session)');
    expect(digest).toContain('- [2026-07-21 09:00] Wire the RSI loop');
    expect(digest).toContain('6 tool calls');
    expect(digest).toContain('files: src/rsi/reflect.ts, src/rsi/sessions.ts');
    expect(digest).toContain('commits: feat(rsi): loop A reflection');
  });

  it('empty window -> sentinel line', () => {
    expect(buildDigest([])).toBe('(no sessions found in the window)');
  });
});

describe('buildPrompt', () => {
  it('wraps the digest and REQUIRES the propose-only promotions section', () => {
    const prompt = buildPrompt(buildDigest(fixtureSnapshots()));
    expect(prompt.startsWith(PROMPT_HEADER)).toBe(true);
    expect(prompt).toContain('## Proposed promotions (for Nico to approve)');
    expect(prompt).toContain('PROPOSE ONLY');
    expect(prompt).toContain('=== END DIGEST ===');
  });
});

describe('writeReflection (the SCRIPT owns disk, not the model)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'athena-reflect-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes <date>.md + latest.md with the propose-only header and body', () => {
    const written = writeReflection(
      'A reflection.\n\n## Proposed promotions (for Nico to approve)\nnone this round.',
      { days: 7, count: 3, model: 'sonnet' },
      { root: tmp, now: WIDE_NOW },
    );
    expect(written.dated).toContain(join('journal', 'reflections', `${ymd(WIDE_NOW)}.md`));
    const dated = readFileSync(written.dated, 'utf8');
    const latest = readFileSync(written.latest, 'utf8');
    expect(dated).toBe(latest);
    expect(dated).toContain('READ-ONLY toward long-term memory: promotions below are PROPOSALS');
    expect(dated).toContain('window: 7d');
    expect(dated).toContain('## Proposed promotions (for Nico to approve)');
  });
});

describe('runReflection (Loop A orchestration)', () => {
  it('harvest-only: builds the digest keyless, no model, no write', async () => {
    const res = await runReflection({ root: RSI_HOME, days: 36_500, now: WIDE_NOW, harvestOnly: true });
    expect(res.status).toBe('harvest-only');
    expect(res.digest).toContain('## athena');
    expect(res.digest).toContain('## hub');
    expect(res.written).toBeUndefined();
  });

  it('dry-run: returns the full prompt, no model, no write', async () => {
    const res = await runReflection({ root: RSI_HOME, days: 36_500, now: WIDE_NOW, dryRun: true });
    expect(res.status).toBe('dry-run');
    expect(res.prompt).toContain('## Proposed promotions (for Nico to approve)');
    expect(res.written).toBeUndefined();
  });

  it('no sessions -> no-sessions status, no write (quiet window is not an error)', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'athena-empty-'));
    try {
      const res = await runReflection({ root: emptyHome, days: 7, now: WIDE_NOW });
      expect(res.status).toBe('no-sessions');
      expect(res.written).toBeUndefined();
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('ok: injected mock model -> reflection written via writeReflection (propose-only preserved)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'athena-run-'));
    try {
      // minimal one-session projects tree
      const slug = join(home, 'projects', 'C--code--demo');
      mkdirSync(slug, { recursive: true });
      writeFileSync(
        join(slug, 'sess.jsonl'),
        [
          '{"type":"user","cwd":"C:\\\\code\\\\demo","message":{"role":"user","content":[{"type":"text","text":"Do the thing"}]}}',
          '{"type":"assistant","cwd":"C:\\\\code\\\\demo","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"C:\\\\code\\\\demo\\\\x.ts"}}]}}',
          '',
        ].join('\n'),
        'utf8',
      );

      const mockModel = async (prompt: string) => {
        expect(prompt).toContain('=== DIGEST ===');
        return 'My first-person reflection.\n\n## Proposed promotions (for Nico to approve)\nnone this round.';
      };

      const res = await runReflection({
        root: home,
        days: 36_500,
        now: WIDE_NOW,
        modelCall: mockModel,
      });

      expect(res.status).toBe('ok');
      expect(res.sessions).toBe(1);
      expect(res.reflection).toContain('My first-person reflection');
      const written = readFileSync(res.written!.dated, 'utf8');
      expect(written).toContain('My first-person reflection');
      expect(written).toContain('## Proposed promotions (for Nico to approve)');
      expect(written).toContain('PROPOSALS for Nico to approve');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('model returns null -> model-failed, no write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'athena-null-'));
    try {
      const slug = join(home, 'projects', 'C--code--demo');
      mkdirSync(slug, { recursive: true });
      writeFileSync(
        join(slug, 'sess.jsonl'),
        '{"type":"user","cwd":"C:\\\\code\\\\demo","message":{"role":"user","content":[{"type":"text","text":"hi there friend"}]}}\n{"type":"assistant","cwd":"C:\\\\code\\\\demo","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x"}}]}}\n',
        'utf8',
      );
      const res = await runReflection({
        root: home,
        days: 36_500,
        now: WIDE_NOW,
        modelCall: async () => null,
      });
      expect(res.status).toBe('model-failed');
      expect(res.written).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
