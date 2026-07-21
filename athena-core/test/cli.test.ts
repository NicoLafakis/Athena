import { describe, expect, it, vi } from 'vitest';
import { buildSession } from '../src/config/loadConfig.js';
import {
  CliUsageError,
  DEFAULT_PROVIDER,
  PROVIDER_NAMES,
  bannerText,
  helpText,
  isProviderName,
  parseCliArgs,
  versionText,
} from '../src/cli/args.js';
import { dryRunConfig, formatDryRun } from '../src/cli/format.js';
import { packageVersion, runCli, type RunTurn } from '../src/cli/index.js';

/** Keyless env, keep PATH so buildSession's env spread is realistic. */
const KEYLESS = { PATH: '/usr/bin', HOME: '/home/user' } as Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// parseCliArgs — pure
// ---------------------------------------------------------------------------
describe('parseCliArgs — defaults', () => {
  it('no args => anthropic default, all booleans false, no prompt (REPL)', () => {
    const a = parseCliArgs([]);
    expect(a.provider).toBe(DEFAULT_PROVIDER);
    expect(a.provider).toBe('anthropic');
    expect(a.model).toBeUndefined();
    expect(a.rideAres).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.help).toBe(false);
    expect(a.version).toBe(false);
    expect(a.prompt).toBeUndefined();
  });
});

describe('parseCliArgs — each flag', () => {
  it('--provider selects a known provider', () => {
    expect(parseCliArgs(['--provider', 'kimi']).provider).toBe('kimi');
    expect(parseCliArgs(['--provider', 'minimax']).provider).toBe('minimax');
    expect(parseCliArgs(['--provider', 'openai']).provider).toBe('openai');
  });

  it('--model, --ares-home, --cwd capture their values', () => {
    const a = parseCliArgs(['--model', 'kimi-k3', '--ares-home', '/ares', '--cwd', '/proj']);
    expect(a.model).toBe('kimi-k3');
    expect(a.aresHome).toBe('/ares');
    expect(a.cwd).toBe('/proj');
  });

  it('--ride-ares / --dry-run / --help / --version are boolean', () => {
    expect(parseCliArgs(['--ride-ares']).rideAres).toBe(true);
    expect(parseCliArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['--version']).version).toBe(true);
  });

  it('short -h / -v map to help / version', () => {
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['-v']).version).toBe(true);
  });

  it('a positional becomes the one-shot prompt; multiple positionals join', () => {
    expect(parseCliArgs(['explain this repo']).prompt).toBe('explain this repo');
    expect(parseCliArgs(['write', 'a', 'test']).prompt).toBe('write a test');
  });

  it('flags + a trailing prompt coexist', () => {
    const a = parseCliArgs(['--provider', 'kimi', '--model', 'kimi-k3', 'do a thing']);
    expect(a.provider).toBe('kimi');
    expect(a.model).toBe('kimi-k3');
    expect(a.prompt).toBe('do a thing');
  });
});

describe('parseCliArgs — errors', () => {
  it('an unknown provider throws CliUsageError listing the valid ones', () => {
    expect(() => parseCliArgs(['--provider', 'bogus'])).toThrow(CliUsageError);
    try {
      parseCliArgs(['--provider', 'bogus']);
    } catch (err) {
      expect((err as Error).message).toContain('bogus');
      for (const p of PROVIDER_NAMES) expect((err as Error).message).toContain(p);
    }
  });

  it('an unknown flag throws CliUsageError (not a raw crash)', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(CliUsageError);
  });
});

describe('isProviderName', () => {
  it('narrows only known names', () => {
    expect(isProviderName('anthropic')).toBe(true);
    expect(isProviderName('kimi')).toBe(true);
    expect(isProviderName('bogus')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// help / version text — branded Athena, never "claude" as the tool identity
// ---------------------------------------------------------------------------
describe('help / version / banner text', () => {
  it('versionText is "athena <version>" and contains no "claude"', () => {
    expect(versionText('1.2.3')).toBe('athena 1.2.3');
    expect(versionText('1.2.3').toLowerCase()).not.toContain('claude');
  });

  it('helpText says Athena, lists usage + providers, and never says "claude"', () => {
    const h = helpText('1.2.3');
    expect(h).toContain('Athena');
    expect(h).toContain('Usage: athena');
    for (const p of PROVIDER_NAMES) expect(h).toContain(p);
    expect(h.toLowerCase()).not.toContain('claude');
  });

  it('bannerText is Athena-identity and never says "claude"', () => {
    const b = bannerText('9.9.9');
    expect(b).toContain('Athena v9.9.9');
    expect(b.toLowerCase()).not.toContain('claude');
  });
});

// ---------------------------------------------------------------------------
// dry-run config formatting — pure, keyless
// ---------------------------------------------------------------------------
describe('dryRunConfig / formatDryRun — keyless', () => {
  it('anthropic default reports the right provider/base_url/cwd + missing key', () => {
    const args = parseCliArgs(['--dry-run']);
    const session = buildSession({ provider: args.provider, cwd: '/proj', env: KEYLESS });
    const c = dryRunConfig(session, args);
    expect(c.provider).toBe('anthropic');
    expect(c.model).toBe('claude-sonnet-5');
    expect(c.baseUrl).toBe('https://api.anthropic.com');
    expect(c.cwd).toBe('/proj');
    expect(c.rideAres).toBe(false);
    expect(c.missingKeyEnvVar).toBe('ANTHROPIC_API_KEY');

    const text = formatDryRun(session, args);
    expect(text).toContain('provider:  anthropic');
    expect(text).toContain('base_url:  https://api.anthropic.com');
    expect(text).toContain('cwd:       /proj');
    expect(text).toContain('set ANTHROPIC_API_KEY to run live');
  });

  it('kimi selection surfaces the moonshot base_url and its auth var', () => {
    const args = parseCliArgs(['--provider', 'kimi', '--dry-run']);
    const session = buildSession({ provider: 'kimi', cwd: '/proj', env: KEYLESS });
    const text = formatDryRun(session, args);
    expect(text).toContain('provider:  kimi');
    expect(text).toContain('base_url:  https://api.moonshot.ai/anthropic');
    expect(text).toContain('set ANTHROPIC_AUTH_TOKEN to run live');
  });

  it('a present key reports "present" (no missing-key var)', () => {
    const args = parseCliArgs(['--dry-run']);
    const session = buildSession({
      provider: 'anthropic',
      cwd: '/proj',
      env: { ...KEYLESS, ANTHROPIC_API_KEY: 'sk-ant' },
    });
    const c = dryRunConfig(session, args);
    expect(c.missingKeyEnvVar).toBeUndefined();
    expect(formatDryRun(session, args)).toContain('api key:   present');
  });

  it('ride-ares surfaces the resolved ares-home', () => {
    const args = parseCliArgs(['--ride-ares', '--dry-run']);
    const session = buildSession({
      rideAres: true,
      aresHome: '/home/user/Ares',
      cwd: '/proj',
      env: KEYLESS,
    });
    const text = formatDryRun(session, args);
    expect(text).toContain('ride-ares: true');
    expect(text).toContain('ares-home: /home/user/Ares');
  });
});

// ---------------------------------------------------------------------------
// runCli — keyless via injected deps (returns exit codes, no process.exit)
// ---------------------------------------------------------------------------
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (s: string) => out.push(s), errLog: (s: string) => err.push(s) };
}

describe('runCli — exit codes and branding, keyless', () => {
  it('--version prints "athena <version>" and returns 0', async () => {
    const s = sink();
    const code = await runCli(['--version'], { ...s, env: KEYLESS, version: '3.1.4' });
    expect(code).toBe(0);
    expect(s.out.join('\n')).toBe('athena 3.1.4');
  });

  it('--help prints Athena help and returns 0', async () => {
    const s = sink();
    const code = await runCli(['--help'], { ...s, env: KEYLESS, version: '3.1.4' });
    expect(code).toBe(0);
    expect(s.out.join('\n')).toContain('Usage: athena');
  });

  it('--dry-run prints the config, returns 0, and makes NO model call', async () => {
    const s = sink();
    const runTurn = vi.fn<RunTurn>();
    const code = await runCli(['--dry-run'], { ...s, env: KEYLESS, runTurn });
    expect(code).toBe(0);
    expect(s.out.join('\n')).toContain('dry run — no model call');
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('keyless one-shot degrades: prints "set <VAR>" to stderr and returns 1', async () => {
    const s = sink();
    const runTurn = vi.fn<RunTurn>();
    const code = await runCli(['hello there'], { ...s, env: KEYLESS, runTurn });
    expect(code).toBe(1);
    expect(s.err.join('\n')).toContain('Set ANTHROPIC_API_KEY to run live');
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('an unknown provider returns the usage exit code 2', async () => {
    const s = sink();
    const code = await runCli(['--provider', 'bogus'], { ...s, env: KEYLESS });
    expect(code).toBe(2);
    expect(s.err.join('\n')).toContain('unknown provider');
  });

  it('with a key present, a one-shot runs the injected turn and prints its reply', async () => {
    const s = sink();
    let seenPrompt = '';
    const runTurn: RunTurn = async (prompt) => {
      seenPrompt = prompt;
      return 'MOCK REPLY';
    };
    const code = await runCli(['do a thing'], {
      ...s,
      env: { ...KEYLESS, ANTHROPIC_API_KEY: 'sk-ant' },
      runTurn,
    });
    expect(code).toBe(0);
    expect(seenPrompt).toBe('do a thing');
    expect(s.out.join('\n')).toContain('MOCK REPLY');
  });

  it('a failing live turn is caught and returns 1', async () => {
    const s = sink();
    const runTurn: RunTurn = async () => {
      throw new Error('boom');
    };
    const code = await runCli(['do a thing'], {
      ...s,
      env: { ...KEYLESS, ANTHROPIC_API_KEY: 'sk-ant' },
      runTurn,
    });
    expect(code).toBe(1);
    expect(s.err.join('\n')).toContain('Athena run failed: boom');
  });
});

describe('packageVersion', () => {
  it('reads the real package.json version', () => {
    expect(packageVersion()).toBe('0.0.0');
  });
});
