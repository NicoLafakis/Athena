import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_CLAUDE_DIR,
  FIXTURE_HOOK_PATH,
  FIXTURE_PROJECT_DIR,
  FIXTURE_SKILL_PATH,
  buildAthenaOptions,
  resolveAthenaSettings,
} from '../src/config/loadConfig.js';

describe('fixture .claude config is well-formed', () => {
  it('settings.json parses and wires the inject hook on both events', () => {
    const raw = readFileSync(`${FIXTURE_CLAUDE_DIR}/settings.json`, 'utf8');
    const parsed = JSON.parse(raw) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    expect(parsed.hooks).toHaveProperty('SessionStart');
    expect(parsed.hooks).toHaveProperty('UserPromptSubmit');
    const cmd = parsed.hooks.SessionStart[0].hooks[0];
    expect(cmd.type).toBe('command');
    expect(cmd.command).toContain('inject.mjs');
    expect(cmd.command).toContain('$CLAUDE_PROJECT_DIR');
  });

  it('SKILL.md declares name: hello with a description', () => {
    const md = readFileSync(FIXTURE_SKILL_PATH, 'utf8');
    expect(md).toMatch(/^---/);
    expect(md).toMatch(/name:\s*hello/);
    expect(md).toMatch(/description:\s*\S+/);
  });

  it('the portable hook exists', () => {
    const src = readFileSync(FIXTURE_HOOK_PATH, 'utf8');
    expect(src).toContain('additionalContext');
  });
});

describe('buildAthenaOptions wires the SDK at the fixture config', () => {
  it('sets cwd, settingSources incl. project, and the hello skill', () => {
    const opts = buildAthenaOptions();
    expect(opts.cwd).toBe(FIXTURE_PROJECT_DIR);
    expect(opts.settingSources).toContain('project');
    expect(opts.skills).toEqual(['hello']);
    // default: rely on the FILE hook, not a programmatic one
    expect(opts.hooks).toBeUndefined();
  });

  it('can additionally register the programmatic hook', () => {
    const opts = buildAthenaOptions({ includeProgrammaticHook: true });
    expect(opts.hooks?.SessionStart?.[0]?.hooks?.length).toBe(1);
  });
});

describe('SDK discovers the fixture hook without a model turn (resolveSettings)', () => {
  it('effective hooks include the inject.mjs command on SessionStart + UserPromptSubmit', async () => {
    const resolved = await resolveAthenaSettings();
    const hooksJson = JSON.stringify(resolved.effective.hooks ?? {});
    expect(hooksJson).toContain('SessionStart');
    expect(hooksJson).toContain('UserPromptSubmit');
    expect(hooksJson).toContain('inject.mjs');
  });

  it('attributes a settings source to the fixture settings.json path', async () => {
    const resolved = await resolveAthenaSettings();
    const paths = resolved.sources.map((s) => s.path).filter((p): p is string => Boolean(p));
    expect(paths.some((p) => p.includes('fixtures') && p.endsWith('settings.json'))).toBe(true);
  });
});
