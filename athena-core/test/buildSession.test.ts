import { describe, expect, it } from 'vitest';
import { FIXTURE_PROJECT_DIR, buildSession } from '../src/config/loadConfig.js';

/** Keyless env, but keep PATH so we can prove Options.env spreads the base env. */
const KEYLESS = { PATH: '/usr/bin', HOME: '/home/user' } as Record<string, string | undefined>;

describe('buildSession — keeps the Phase 0 fixture wiring', () => {
  it('keeps settingSources incl. project and the hello skill', () => {
    const { options } = buildSession({ env: KEYLESS });
    expect(options.settingSources).toContain('project');
    expect(options.skills).toEqual(['hello']);
  });

  it('can also register the programmatic hook', () => {
    const { options } = buildSession({ includeProgrammaticHook: true, env: KEYLESS });
    expect(options.hooks?.SessionStart?.[0]?.hooks?.length).toBe(1);
  });
});

describe('buildSession — cwd is the user project, not the fixture/Ares dir', () => {
  it('defaults cwd to process.cwd() (the user project), not the fixture project dir', () => {
    const { options } = buildSession({ env: KEYLESS });
    expect(options.cwd).toBe(process.cwd());
    // Regression guard: buildSession must not default to the fixture dir the way
    // the Phase 0 buildAthenaOptions helper still does.
    expect(options.cwd).not.toBe(FIXTURE_PROJECT_DIR);
  });

  it('honors an injected cwd', () => {
    const { options } = buildSession({ cwd: '/work/project', env: KEYLESS });
    expect(options.cwd).toBe('/work/project');
  });
});

describe('buildSession — Options.env replaces subprocess env, so we spread the base env', () => {
  it('preserves inherited vars (PATH/HOME) AND overlays provider selection', () => {
    const { options } = buildSession({ provider: 'kimi', env: KEYLESS });
    // inherited (would be lost if we forgot to spread — the step-0 gotcha)
    expect(options.env?.PATH).toBe('/usr/bin');
    expect(options.env?.HOME).toBe('/home/user');
    // provider overlay
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
  });
});

describe('buildSession — provider=kimi vs anthropic vs minimax yield the right base_url/auth/flags', () => {
  it('anthropic', () => {
    const { options, resolved } = buildSession({
      provider: 'anthropic',
      env: { ...KEYLESS, ANTHROPIC_API_KEY: 'sk-ant' },
    });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(options.env?.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(options.env?.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(options.model).toBe(resolved.model);
    expect(resolved.missingKeyEnvVar).toBeUndefined();
  });

  it('kimi (bearer auth token + tool-search off + compact window)', () => {
    const { options } = buildSession({
      provider: 'kimi',
      env: { ...KEYLESS, ANTHROPIC_AUTH_TOKEN: 'moonshot-tok' },
    });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe('moonshot-tok');
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.ENABLE_TOOL_SEARCH).toBe('false');
    expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
  });

  it('minimax (x-api-key + tool-search off)', () => {
    const { options } = buildSession({
      provider: 'minimax',
      env: { ...KEYLESS, ANTHROPIC_API_KEY: 'sk-minimax' },
    });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(options.env?.ANTHROPIC_API_KEY).toBe('sk-minimax');
    expect(options.env?.ENABLE_TOOL_SEARCH).toBe('false');
    // minimax uses bearer? no -> x-api-key; auth token var must be absent
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('the three providers produce distinct base_urls from one call site', () => {
    const urls = (['anthropic', 'kimi', 'minimax'] as const).map(
      (p) => buildSession({ provider: p, env: KEYLESS }).options.env?.ANTHROPIC_BASE_URL,
    );
    expect(new Set(urls).size).toBe(3);
  });
});

describe('buildSession — openai points ANTHROPIC_BASE_URL at the sidecar', () => {
  it('uses a supplied sidecar baseUrl override', () => {
    const { options, resolved } = buildSession({
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:55555',
      env: { ...KEYLESS, OPENAI_API_KEY: 'sk-openai' },
    });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:55555');
    expect(resolved.descriptor.dispatch).toBe('sidecar');
    expect(resolved.missingKeyEnvVar).toBeUndefined();
  });
});
