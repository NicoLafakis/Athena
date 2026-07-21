import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATHENA_CORE_ROOT, buildSession } from '../src/config/loadConfig.js';
import { CLAUDE_CONFIG_DIR_ENV } from '../src/config/aresConfig.js';

const FIXTURE_ARES_HOME = join(ATHENA_CORE_ROOT, 'fixtures', 'ares-home');
const KEYLESS = { PATH: '/usr/bin', HOME: '/home/user' } as Record<string, string | undefined>;

describe('buildSession — Phase 2 Ares wiring is additive (Phase 0/1 defaults intact)', () => {
  it('default (no Ares args) keeps fixture wiring and does not add hooks or CLAUDE_CONFIG_DIR', () => {
    const { options } = buildSession({ env: KEYLESS });
    expect(options.settingSources).toEqual(['project', 'local']);
    expect(options.env?.[CLAUDE_CONFIG_DIR_ENV]).toBeUndefined();
    expect(options.hooks).toBeUndefined();
  });
});

describe('buildSession — rideAres loads the live Ares brain natively', () => {
  it("adds 'user' to settingSources and points CLAUDE_CONFIG_DIR at the Ares home", () => {
    const { options } = buildSession({
      rideAres: true,
      aresHome: FIXTURE_ARES_HOME,
      env: KEYLESS,
    });
    expect(options.settingSources).toContain('user');
    expect(options.settingSources).toContain('project'); // keep CLAUDE.md loading
    expect(options.env?.[CLAUDE_CONFIG_DIR_ENV]).toBe(FIXTURE_ARES_HOME);
  });

  it('rideAres does NOT relocate cwd into the Ares home (runs in the user project)', () => {
    const { options } = buildSession({
      rideAres: true,
      aresHome: FIXTURE_ARES_HOME,
      env: KEYLESS,
    });
    // The CONFIG dir is the Ares home; the WORKING dir stays the user's project.
    expect(options.cwd).not.toBe(FIXTURE_ARES_HOME);
    expect(options.cwd).toBe(process.cwd());
  });

  it('an injected cwd is honored while riding Ares (config dir still the Ares home)', () => {
    const { options } = buildSession({
      rideAres: true,
      aresHome: FIXTURE_ARES_HOME,
      cwd: '/work/project',
      env: KEYLESS,
    });
    expect(options.cwd).toBe('/work/project');
    expect(options.env?.[CLAUDE_CONFIG_DIR_ENV]).toBe(FIXTURE_ARES_HOME);
  });

  it('gates the TS-port hooks OFF while riding live Ares (no double-fire with py hooks)', () => {
    const { options } = buildSession({
      rideAres: true,
      aresHome: FIXTURE_ARES_HOME,
      aresHooks: { memory: true, reflection: true, rules: true },
      env: KEYLESS,
    });
    // Requested ports are suppressed because the native py hooks cover them.
    expect(options.hooks).toBeUndefined();
  });

  it('allowDoubleFire escape hatch wires the ports even while riding live Ares', () => {
    const { options } = buildSession({
      rideAres: true,
      aresHome: FIXTURE_ARES_HOME,
      aresHooks: { memory: true, reflection: true, rules: true },
      allowDoubleFire: true,
      env: KEYLESS,
    });
    expect(options.hooks?.SessionStart?.length).toBe(1);
    expect(options.hooks?.UserPromptSubmit?.length).toBe(1);
    expect(options.hooks?.Stop?.length).toBe(1);
  });
});

describe('buildSession — off the Ares-riding path, the TS ports are the vehicle', () => {
  it('wires the selected programmatic ports (cross-platform / no-py future)', () => {
    const { options } = buildSession({
      aresHome: FIXTURE_ARES_HOME,
      aresHooks: { memory: true, rules: true },
      env: KEYLESS,
    });
    expect(options.hooks?.SessionStart?.length).toBe(1);
    expect(options.hooks?.UserPromptSubmit?.length).toBe(1);
    expect(options.hooks?.Stop).toBeUndefined(); // reflection not requested
    // still the plain fixture settingSources (not riding live Ares)
    expect(options.settingSources).toEqual(['project', 'local']);
  });

  it('provider selection still works alongside the Ares hooks', () => {
    const { options } = buildSession({
      provider: 'kimi',
      aresHooks: { reflection: true },
      env: { ...KEYLESS, ANTHROPIC_AUTH_TOKEN: 'tok' },
    });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(options.env?.PATH).toBe('/usr/bin'); // base env still spread
    expect(options.hooks?.Stop?.length).toBe(1);
  });
});
