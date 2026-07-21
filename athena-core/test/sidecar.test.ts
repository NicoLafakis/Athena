import { afterEach, describe, expect, it } from 'vitest';
import {
  LITELLM_KNOWN_BAD_VERSIONS,
  LITELLM_PINNED_VERSION,
  MockSidecar,
  SidecarManager,
  canSpawnSidecar,
  resolveProvider,
} from '../src/providers/index.js';

let mock: MockSidecar | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

describe('OpenAI selection routes end-to-end through the sidecar base_url (mock)', () => {
  it('ANTHROPIC_BASE_URL points at the sidecar and /v1/messages returns an Anthropic-shaped reply', async () => {
    mock = new MockSidecar({ text: 'ATHENA_SIDECAR_MOCK_OK' });
    const baseUrl = await mock.start();

    // resolveProvider aims ANTHROPIC_BASE_URL at the (mock) sidecar.
    const r = resolveProvider('openai', 'gpt-4o', {
      env: { OPENAI_API_KEY: 'sk-openai' },
      baseUrl,
    });
    expect(r.sessionEnv.ANTHROPIC_BASE_URL).toBe(baseUrl);

    // The SDK would POST /v1/messages at that base_url. Do it against the mock.
    const res = await fetch(`${r.sessionEnv.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // exactly what buildSession would inject for the SDK->sidecar hop
        'x-api-key': r.sessionEnv.ANTHROPIC_API_KEY ?? '',
      },
      body: JSON.stringify({ model: r.model, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      role: string;
      model: string;
      content: Array<{ type: string; text: string }>;
    };
    // Anthropic Messages response shape
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('gpt-4o');
    expect(body.content[0].text).toBe('ATHENA_SIDECAR_MOCK_OK');

    // the mock actually received the routed POST
    const posted = mock.requests.find((q) => q.method === 'POST' && q.url.startsWith('/v1/messages'));
    expect(posted).toBeTruthy();
  });

  it('SidecarManager.health() is true against a live (mock) liveliness probe', async () => {
    mock = new MockSidecar();
    const baseUrl = await mock.start();
    const port = Number(new URL(baseUrl).port);
    const mgr = new SidecarManager({ port });
    expect(await mgr.health()).toBe(true);
  });
});

describe('SidecarManager — guarded spawn + pinned clean version', () => {
  it('does NOT spawn in this Linux authoring container', () => {
    expect(canSpawnSidecar({})).toBe(false);
  });

  it('canSpawnSidecar opts in via ATHENA_ENABLE_SIDECAR_SPAWN=1', () => {
    expect(canSpawnSidecar({ ATHENA_ENABLE_SIDECAR_SPAWN: '1' })).toBe(true);
  });

  it('start() throws a clear deferral error instead of spawning', async () => {
    const mgr = new SidecarManager({ env: {} });
    await expect(mgr.start()).rejects.toThrow(/disabled here|deferred|Windows/i);
  });

  it('buildSpawnCommand documents the litellm invocation (no spawn)', () => {
    const mgr = new SidecarManager({ port: 4000, model: 'gpt-4o', env: { OPENAI_API_KEY: 'sk-x' } });
    const cmd = mgr.buildSpawnCommand();
    expect(cmd.command).toBe('litellm');
    expect(cmd.args).toEqual(['--model', 'openai/gpt-4o', '--port', '4000', '--host', '127.0.0.1']);
    expect(cmd.env.OPENAI_API_KEY).toBe('sk-x');
  });

  it('buildSpawnCommand uses --config when a config.yaml is supplied', () => {
    const mgr = new SidecarManager({ configPath: '/etc/litellm.yaml', port: 4100 });
    expect(mgr.buildSpawnCommand().args).toEqual([
      '--config',
      '/etc/litellm.yaml',
      '--port',
      '4100',
      '--host',
      '127.0.0.1',
    ]);
  });

  it('refuses to build a command for a known-compromised version', () => {
    const bad = LITELLM_KNOWN_BAD_VERSIONS[0];
    const mgr = new SidecarManager({ version: bad });
    expect(() => mgr.buildSpawnCommand()).toThrow(/credential-stealing|known/i);
  });

  it('the pinned version is not one of the compromised releases', () => {
    expect(LITELLM_KNOWN_BAD_VERSIONS).not.toContain(LITELLM_PINNED_VERSION);
  });

  it('baseUrl is the unified route; /v1/messages is appended for the SDK', () => {
    const mgr = new SidecarManager({ port: 4000 });
    expect(mgr.baseUrl).toBe('http://127.0.0.1:4000');
    expect(mgr.anthropicMessagesUrl).toBe('http://127.0.0.1:4000/v1/messages');
  });
});

describe('SidecarManager — env allowlist + installed-version verification (hardening)', () => {
  it('forwards ONLY allowlisted vars + the proxy secret; drops ANTHROPIC_* and cloud tokens', () => {
    const mgr = new SidecarManager({
      env: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-openai',
        LITELLM_MASTER_KEY: 'sk-athena-litellm-local',
        ANTHROPIC_API_KEY: 'sk-ant-SECRET',
        ANTHROPIC_AUTH_TOKEN: 'kimi-SECRET',
        AWS_SECRET_ACCESS_KEY: 'aws-SECRET',
        GITHUB_TOKEN: 'gh-SECRET',
      },
    });
    const env = mgr.buildSpawnCommand().env;
    // allowed through
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OPENAI_API_KEY).toBe('sk-openai');
    expect(env.LITELLM_MASTER_KEY).toBe('sk-athena-litellm-local');
    // secrets the proxy has no business seeing
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('extraEnvAllowlist opts specific extra vars through without re-spreading everything', () => {
    const mgr = new SidecarManager({
      env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:8080', ANTHROPIC_API_KEY: 'sk-ant-SECRET' },
      extraEnvAllowlist: ['HTTPS_PROXY'],
    });
    const env = mgr.buildSpawnCommand().env;
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('refuses a non-pinned version even if not-yet-known-bad (allowlist, not denylist)', () => {
    const mgr = new SidecarManager({ version: '1.90.0' });
    expect(() => mgr.buildSpawnCommand()).toThrow(/only the vetted pin|1\.93\.0/i);
  });

  it('assertInstalledVersionMatches passes when the installed binary is the pin', async () => {
    const mgr = new SidecarManager({ versionProbe: async () => LITELLM_PINNED_VERSION });
    await expect(mgr.assertInstalledVersionMatches()).resolves.toBeUndefined();
  });

  it('assertInstalledVersionMatches throws on a mismatched installed binary (PATH hijack / downgrade)', async () => {
    const mgr = new SidecarManager({ versionProbe: async () => '1.90.0' });
    await expect(mgr.assertInstalledVersionMatches()).rejects.toThrow(/does not match|hijack|downgrade/i);
  });

  it('assertInstalledVersionMatches throws when the installed binary is a compromised release', async () => {
    const mgr = new SidecarManager({ versionProbe: async () => LITELLM_KNOWN_BAD_VERSIONS[0] });
    await expect(mgr.assertInstalledVersionMatches()).rejects.toThrow(/credential-stealing/i);
  });
});
