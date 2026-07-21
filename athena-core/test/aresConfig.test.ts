import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARES_HOME_ENV,
  discoverAresConfig,
  resolveAresHome,
  resolveMemoryDir,
  sanitizeCwd,
} from '../src/config/aresConfig.js';

/** The authentic-format Ares REPO present in this Linux authoring container. */
const ARES_REPO = '/home/user/Ares';
const hasAresRepo = existsSync(join(ARES_REPO, 'settings.json'));

describe('resolveAresHome — precedence', () => {
  it('explicit arg wins over env and default', () => {
    expect(resolveAresHome('/x/.claude', { [ARES_HOME_ENV]: '/y/.claude' })).toBe('/x/.claude');
  });
  it('ATHENA_ARES_HOME env wins over the OS default', () => {
    expect(resolveAresHome(undefined, { [ARES_HOME_ENV]: '/y/.claude' })).toBe('/y/.claude');
  });
  it('falls back to OS home .claude', () => {
    const home = resolveAresHome(undefined, {});
    expect(home.endsWith('.claude')).toBe(true);
  });
});

describe('sanitizeCwd — reproduces Claude Code projects/<slug> scheme', () => {
  it('matches the real Ares hub slug', () => {
    // Verified against disk: C:\Users\lafak\.claude -> C--Users-lafak--claude
    expect(sanitizeCwd('C:\\Users\\lafak\\.claude')).toBe('C--Users-lafak--claude');
  });
  it('every non-alphanumeric char becomes a dash', () => {
    expect(sanitizeCwd('C:\\Users\\lafak')).toBe('C--Users-lafak');
    expect(sanitizeCwd('proj-fixture')).toBe('proj-fixture');
  });
});

describe('resolveMemoryDir', () => {
  it('derives <aresHome>/projects/<slug>/memory', () => {
    expect(resolveMemoryDir('/h/.claude', 'proj-fixture')).toBe(
      join('/h/.claude', 'projects', 'proj-fixture', 'memory'),
    );
  });
  it('an explicit override wins', () => {
    expect(resolveMemoryDir('/h/.claude', 'anything', '/custom/mem')).toBe('/custom/mem');
  });
});

describe('discoverAresConfig — keyless discovery of the REAL Ares config', () => {
  it.skipIf(!hasAresRepo)(
    'pointing at /home/user/Ares discovers its hooks (no key, no model turn)',
    async () => {
      const before = process.env.CLAUDE_CONFIG_DIR;
      const cfg = await discoverAresConfig(ARES_REPO);

      expect(cfg.found).toBe(true);
      expect(cfg.settingsPath).toBe(join(ARES_REPO, 'settings.json'));

      // The real Ares settings.json wires hooks on all five events.
      for (const ev of ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
        expect(cfg.hookEvents).toContain(ev);
      }

      // The two hooks this Phase 2 ports must be discovered among the py commands.
      const commands = cfg.hooks.map((h) => h.command ?? '').join('\n');
      expect(commands).toContain('reflection.py');
      expect(commands).toContain('rules_reinject.py');

      // process.env.CLAUDE_CONFIG_DIR is restored (never left mutated).
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
    },
  );

  it.skipIf(!hasAresRepo)('scans agents/ and skills/ trees (not in the settings schema)', async () => {
    const cfg = await discoverAresConfig(ARES_REPO);
    // The ADR records ~54 agents + 59 skills + 14 hooks.
    expect(cfg.agents.length).toBeGreaterThanOrEqual(50);
    expect(cfg.skills.length).toBeGreaterThanOrEqual(50);
    // index files are excluded from the agent list
    expect(cfg.agents).not.toContain('MANIFEST');
    expect(cfg.agents).not.toContain('ROUTING-INDEX');
    // a known skill exists
    expect(cfg.skills).toContain('recursive-learning');
  });
});
