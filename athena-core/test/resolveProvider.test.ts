import { afterEach, describe, expect, it } from 'vitest';
import {
  SIDECAR_PLACEHOLDER_KEY,
  UnknownModelError,
  UnknownProviderError,
  descriptors,
  getKnownModels,
  resetKnownModels,
  resolveProvider,
  setKnownModels,
} from '../src/providers/index.js';

afterEach(() => resetKnownModels());

/** A keyless env — no provider secrets present. Proves resolution is testable without keys. */
const KEYLESS = {} as Record<string, string | undefined>;

describe('resolveProvider — env selection per provider (keyless)', () => {
  it('anthropic: base_url + x-api-key var + no tool-search flag + compact window', () => {
    const r = resolveProvider('anthropic', undefined, { env: KEYLESS });
    expect(r.sessionEnv.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(r.sessionEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(descriptors.anthropic.contextWindow));
    expect(r.sessionEnv.ANTHROPIC_MODEL).toBe(descriptors.anthropic.defaultModel);
    // anthropic supports web tools -> flag must NOT be set
    expect(r.sessionEnv.ENABLE_TOOL_SEARCH).toBeUndefined();
    // anthropic hosts a haiku small-model -> do not alias
    expect(r.sessionEnv.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    // keyless: secret absent, but full non-secret config returned
    expect(r.missingKeyEnvVar).toBe('ANTHROPIC_API_KEY');
    expect(r.sessionEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('kimi: moonshot base_url + bearer var + ENABLE_TOOL_SEARCH=false + small-fast alias', () => {
    const r = resolveProvider('kimi', undefined, { env: KEYLESS });
    expect(r.sessionEnv.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(r.sessionEnv.ENABLE_TOOL_SEARCH).toBe('false');
    expect(r.sessionEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
    expect(r.sessionEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe(r.model);
    expect(r.missingKeyEnvVar).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  it('minimax: minimax base_url + x-api-key var + tool-search off', () => {
    const r = resolveProvider('minimax', undefined, { env: KEYLESS });
    expect(r.sessionEnv.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(r.sessionEnv.ENABLE_TOOL_SEARCH).toBe('false');
    expect(r.missingKeyEnvVar).toBe('ANTHROPIC_API_KEY');
  });

  it('openai: sidecar base_url + placeholder SDK key; OPENAI_API_KEY is the missing secret', () => {
    const r = resolveProvider('openai', undefined, { env: KEYLESS });
    expect(r.sessionEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4000');
    // SDK talks to the LOCAL sidecar with the placeholder master key, not a real secret
    expect(r.sessionEnv.ANTHROPIC_API_KEY).toBe(SIDECAR_PLACEHOLDER_KEY);
    // the real secret the SIDECAR needs is OPENAI_API_KEY
    expect(r.missingKeyEnvVar).toBe('OPENAI_API_KEY');
  });
});

describe('resolveProvider — reads secret VALUES from env at call time (never hardcoded)', () => {
  it('injects the anthropic key value under ANTHROPIC_API_KEY when present', () => {
    const r = resolveProvider('anthropic', undefined, { env: { ANTHROPIC_API_KEY: 'sk-ant-XYZ' } });
    expect(r.sessionEnv.ANTHROPIC_API_KEY).toBe('sk-ant-XYZ');
    expect(r.missingKeyEnvVar).toBeUndefined();
  });

  it('injects the kimi token value under ANTHROPIC_AUTH_TOKEN when present', () => {
    const r = resolveProvider('kimi', undefined, { env: { ANTHROPIC_AUTH_TOKEN: 'moonshot-TOK' } });
    expect(r.sessionEnv.ANTHROPIC_AUTH_TOKEN).toBe('moonshot-TOK');
    expect(r.missingKeyEnvVar).toBeUndefined();
  });

  it('openai: LITELLM_MASTER_KEY (when set) becomes the SDK->sidecar auth', () => {
    const r = resolveProvider('openai', undefined, {
      env: { OPENAI_API_KEY: 'sk-openai', LITELLM_MASTER_KEY: 'sk-master' },
    });
    expect(r.sessionEnv.ANTHROPIC_API_KEY).toBe('sk-master');
    expect(r.missingKeyEnvVar).toBeUndefined();
  });

  it('does not read from the ambient process.env when an env is injected', () => {
    // Even if the runner had a key, injecting KEYLESS proves values come from `env`.
    const r = resolveProvider('anthropic', undefined, { env: KEYLESS });
    expect(r.sessionEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('resolveProvider — model selection + validation', () => {
  it('accepts a known model', () => {
    const r = resolveProvider('kimi', 'kimi-k2.7-code', { env: KEYLESS });
    expect(r.model).toBe('kimi-k2.7-code');
    expect(r.sessionEnv.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
  });

  it('rejects an unknown model with a clear error', () => {
    expect(() => resolveProvider('kimi', 'kimi-k99-nope', { env: KEYLESS })).toThrow(UnknownModelError);
  });

  it('rejects an unknown provider with a clear error', () => {
    // @ts-expect-error — exercising the runtime guard with a bad name
    expect(() => resolveProvider('bard', undefined, { env: KEYLESS })).toThrow(UnknownProviderError);
  });

  it('a runtime-refreshed model list is honored by validation', () => {
    // A brand-new id absent from the descriptor snapshot is rejected...
    expect(() => resolveProvider('minimax', 'MiniMax-M9', { env: KEYLESS })).toThrow(UnknownModelError);
    // ...until the registry is refreshed (what fetchModels does).
    setKnownModels('minimax', ['MiniMax-M9']);
    expect(getKnownModels('minimax')).toContain('MiniMax-M9');
    const r = resolveProvider('minimax', 'MiniMax-M9', { env: KEYLESS });
    expect(r.model).toBe('MiniMax-M9');
  });
});
