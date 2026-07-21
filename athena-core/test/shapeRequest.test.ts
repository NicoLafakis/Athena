import { describe, expect, it } from 'vitest';
import {
  anthropic,
  getProvider,
  kimi,
  minimax,
  openai,
  routeToSidecar,
  shapeRequest,
} from '../src/providers/index.js';
import type { MessagesRequest } from '../src/providers/index.js';

/** A rich base request exercising every shaping path. */
function baseRequest(overrides: Partial<MessagesRequest> = {}): MessagesRequest {
  return {
    model: 'test-model',
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      },
    ],
    temperature: 0.7,
    top_k: 40,
    stop_sequences: ['STOP'],
    mcp_servers: [{ name: 'x' }],
    thinking: undefined,
    tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'read_file', description: 'read a file', input_schema: { type: 'object' } },
    ],
    ...overrides,
  };
}

describe('shapeRequest — transport metadata', () => {
  it('sets baseUrl + x-api-key header for anthropic', () => {
    const out = shapeRequest(anthropic, baseRequest());
    expect(out.baseUrl).toBe('https://api.anthropic.com');
    expect(out.authHeaderName).toBe('x-api-key');
    expect(out.authScheme).toBe('x-api-key');
    expect(out.dispatch).toBe('direct');
  });

  it('sets bearer/authorization header + moonshot baseUrl for kimi', () => {
    const out = shapeRequest(kimi, baseRequest());
    expect(out.baseUrl).toBe('https://api.moonshot.ai/anthropic');
    expect(out.authHeaderName).toBe('authorization');
    expect(out.authScheme).toBe('bearer');
  });

  it('does not mutate the caller input (purity)', () => {
    const req = baseRequest();
    const snapshot = JSON.stringify(req);
    shapeRequest(minimax, req);
    expect(JSON.stringify(req)).toBe(snapshot);
  });
});

describe('shapeRequest — anthropic keeps cache_control', () => {
  it('retains cache_control on system + message blocks', () => {
    const out = shapeRequest(anthropic, baseRequest());
    const system = out.body.system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    const content = out.body.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(out.dropped).not.toContain('cache_control');
  });
});

describe('shapeRequest — kimi forces thinking + strips web tools', () => {
  const out = shapeRequest(kimi, baseRequest());

  it('forces thinking:{type:enabled}', () => {
    expect(out.body.thinking).toEqual({ type: 'enabled' });
  });

  it('strips web-tool declarations but keeps custom tools', () => {
    expect(out.dropped).toContain('web_tools');
    const names = (out.body.tools ?? []).map((t) => t.name);
    expect(names).toEqual(['read_file']);
  });

  it('also strips cache_control (kimi !supportsCacheControl)', () => {
    expect(out.dropped).toContain('cache_control');
  });
});

describe('shapeRequest — minimax clamps temp + drops ignored params', () => {
  it('clamps temperature into [0, 2]', () => {
    const hi = shapeRequest(minimax, baseRequest({ temperature: 3.5 }));
    expect(hi.body.temperature).toBe(2);
    const lo = shapeRequest(minimax, baseRequest({ temperature: -1 }));
    expect(lo.body.temperature).toBe(0);
    const mid = shapeRequest(minimax, baseRequest({ temperature: 1.3 }));
    expect(mid.body.temperature).toBe(1.3);
  });

  it('drops top_k, stop_sequences, and mcp_servers', () => {
    const out = shapeRequest(minimax, baseRequest());
    expect(out.body.top_k).toBeUndefined();
    expect(out.body.stop_sequences).toBeUndefined();
    expect(out.body.mcp_servers).toBeUndefined();
    expect(out.dropped).toEqual(expect.arrayContaining(['top_k', 'stop_sequences', 'mcp_servers']));
  });

  it('does not force thinking (minimax M2.x has no thinking blocks)', () => {
    const out = shapeRequest(minimax, baseRequest({ thinking: { type: 'enabled' } }));
    expect(out.body.thinking).toBeUndefined();
    expect(out.dropped).toContain('thinking');
  });
});

describe('shapeRequest — openai routes to the sidecar seam', () => {
  const out = shapeRequest(openai, baseRequest());

  it('marks dispatch as sidecar', () => {
    expect(out.dispatch).toBe('sidecar');
  });

  it('is handled by the LiteLLM sidecar stub (not reachable in Phase 0)', () => {
    const result = routeToSidecar(out);
    expect(result.handledBy).toBe('litellm-sidecar-stub');
    expect(result.reachable).toBe(false);
    expect(result.pinnedVersionRequired).toBe(true);
    expect(result.target).toBe('openai:chat.completions');
  });

  it('refuses to route a direct-dispatch (anthropic) request through the sidecar', () => {
    const direct = shapeRequest(anthropic, baseRequest());
    expect(() => routeToSidecar(direct)).toThrow();
  });
});

describe('provider registry', () => {
  it('resolves all four providers by name', () => {
    for (const name of ['anthropic', 'kimi', 'minimax', 'openai'] as const) {
      expect(getProvider(name).capabilities.name).toBe(name);
    }
  });
});
