import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATHENA_CORE_ROOT } from '../src/config/loadConfig.js';
import { mainReflectCli, parseReflectArgs } from '../src/rsi/reflectCli.js';

const RSI_HOME = join(ATHENA_CORE_ROOT, 'fixtures', 'rsi-home');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (s: string) => out.push(s), errLog: (s: string) => err.push(s) };
}

describe('parseReflectArgs', () => {
  it('parses flags and repeats --exclude, ignores unknowns', () => {
    const a = parseReflectArgs([
      '--days', '14', '--model', 'opus', '--max-sessions', '10',
      '--exclude', 'Hanover', '--exclude', 'client', '--root', '/x', '--dry-run', '--nope',
    ]);
    expect(a).toMatchObject({
      days: 14, model: 'opus', maxSessions: 10, exclude: ['Hanover', 'client'], root: '/x', dryRun: true,
      harvestOnly: false,
    });
  });
  it('falls back to defaults on bad numbers / empty argv', () => {
    const a = parseReflectArgs(['--days', 'abc']);
    expect(a.days).toBe(7);
    expect(a.model).toBe('sonnet');
    const b = parseReflectArgs([]);
    expect(b.harvestOnly).toBe(false);
  });
});

describe('mainReflectCli — keyless paths (no model call)', () => {
  it('--harvest-only prints the digest and exits 0', async () => {
    const cap = capture();
    const code = await mainReflectCli(['--harvest-only', '--root', RSI_HOME, '--days', '36500'], cap);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('# Harvest:');
    expect(cap.out.join('\n')).toContain('## athena');
  });

  it('--dry-run prints the full prompt and exits 0', async () => {
    const cap = capture();
    const code = await mainReflectCli(['--dry-run', '--root', RSI_HOME, '--days', '36500'], cap);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('## Proposed promotions (for Nico to approve)');
  });

  it('ok path via injected mock model exits 0 and reports the written file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'athena-cli-'));
    try {
      const slug = join(home, 'projects', 'C--code--demo');
      mkdirSync(slug, { recursive: true });
      writeFileSync(
        join(slug, 'sess.jsonl'),
        '{"type":"user","cwd":"C:\\\\code\\\\demo","message":{"role":"user","content":[{"type":"text","text":"build the widget"}]}}\n{"type":"assistant","cwd":"C:\\\\code\\\\demo","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x"}}]}}\n',
        'utf8',
      );
      const cap = capture();
      const code = await mainReflectCli(['--root', home, '--days', '36500'], {
        ...cap,
        modelCall: async () => 'ok\n\n## Proposed promotions (for Nico to approve)\nnone this round.',
      });
      expect(code).toBe(0);
      expect(cap.out.join('\n')).toContain('wrote ');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
