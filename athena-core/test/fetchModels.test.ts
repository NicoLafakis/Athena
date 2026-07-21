import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MockSidecar,
  descriptors,
  fetchModels,
  getKnownModels,
  resetKnownModels,
  resolveProvider,
} from '../src/providers/index.js';
import type { FetchTransport, TransportResponse } from '../src/providers/index.js';

afterEach(() => resetKnownModels());

/** Build a mock transport returning a canned `/models` body. */
function mockTransport(body: unknown, ok = true, status = 200): FetchTransport {
  return vi.fn(async (): Promise<TransportResponse> => ({
    ok,
    status,
    json: async () => body,
  }));
}

describe('fetchModels — mocked transport (no network)', () => {
  it('parses data[].id from an Anthropic/OpenAI-shaped /models body', async () => {
    const transport = mockTransport({
      data: [{ id: 'kimi-k3' }, { id: 'kimi-k4-preview' }],
    });
    const res = await fetchModels('kimi', { transport, env: {} });
    expect(res.provider).toBe('kimi');
    expect(res.models).toEqual(['kimi-k3', 'kimi-k4-preview']);
    expect(res.url).toBe('https://api.moonshot.ai/anthropic/v1/models');
  });

  it('hits the descriptor base_url + modelsPath and sends the right auth header', async () => {
    const transport = vi.fn<FetchTransport>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'claude-sonnet-5' }] }),
    }));
    await fetchModels('anthropic', { transport, env: { ANTHROPIC_API_KEY: 'sk-ant' } });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    // anthropic -> x-api-key style
    expect(init?.headers?.['x-api-key']).toBe('sk-ant');
    expect(init?.headers?.['anthropic-version']).toBeTruthy();
  });

  it('kimi uses bearer auth when its token is present', async () => {
    const transport = vi.fn<FetchTransport>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }));
    await fetchModels('kimi', { transport, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
    expect(transport.mock.calls[0][1]?.headers?.authorization).toBe('Bearer tok');
  });

  it('refreshes the runtime registry so resolveProvider accepts a fresh id', async () => {
    // A new id is unknown at first...
    expect(() => resolveProvider('minimax', 'MiniMax-M4', { env: {} })).toThrow();
    // ...fetchModels refreshes the registry...
    const transport = mockTransport({ data: [{ id: 'MiniMax-M4' }, { id: 'MiniMax-M2' }] });
    const res = await fetchModels('minimax', { transport, env: {} });
    expect(res.updatedRegistry).toBe(true);
    expect(getKnownModels('minimax')).toContain('MiniMax-M4');
    // ...and now selection of the fresh id succeeds.
    expect(resolveProvider('minimax', 'MiniMax-M4', { env: {} }).model).toBe('MiniMax-M4');
  });

  it('does not clobber the registry when updateRegistry:false', async () => {
    const transport = mockTransport({ data: [{ id: 'whatever' }] });
    await fetchModels('anthropic', { transport, env: {}, updateRegistry: false });
    expect(getKnownModels('anthropic')).toEqual(descriptors.anthropic.models);
  });

  it('throws a clear error on a non-2xx response', async () => {
    const transport = mockTransport({}, false, 401);
    await expect(fetchModels('anthropic', { transport, env: {} })).rejects.toThrow(/HTTP 401/);
  });
});

describe('fetchModels — against the mock sidecar /v1/models (OpenAI refresh)', () => {
  it('reads the OpenAI model list via the sidecar base_url', async () => {
    const mock = new MockSidecar({ modelsList: ['gpt-4o', 'gpt-5-preview'] });
    const baseUrl = await mock.start();
    try {
      const res = await fetchModels('openai', { baseUrl, env: { OPENAI_API_KEY: 'sk-openai' } });
      expect(res.models).toEqual(['gpt-4o', 'gpt-5-preview']);
      expect(res.url).toBe(`${baseUrl}/v1/models`);
      // the fresh id is now selectable
      expect(resolveProvider('openai', 'gpt-5-preview', { env: { OPENAI_API_KEY: 'x' }, baseUrl }).model).toBe(
        'gpt-5-preview',
      );
    } finally {
      await mock.stop();
    }
  });
});
