import { describe, it, expect } from 'vitest'
import {
  PROVIDERS,
  PROVIDER_IDS,
  MODELS,
  EFFORTS,
  modelKeys,
  modelId,
  modelLabel,
  supportsEffort,
  normalizeProvider,
  normalizeModel,
  resolveModelRequest,
} from '../../src/brain/models.js'

describe('provider registry', () => {
  it('exposes exactly two providers and five efforts', () => {
    expect([...PROVIDER_IDS]).toEqual(['anthropic', 'kimi'])
    expect([...EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('anthropic uses the SDK default URL; kimi uses the Moonshot Anthropic-compatible endpoint', () => {
    expect(PROVIDERS.anthropic.baseURL).toBeNull()
    expect(PROVIDERS.kimi.baseURL).toBe('https://api.moonshot.ai/anthropic')
    expect(PROVIDERS.anthropic.envVar).toBe('ANTHROPIC_API_KEY')
    expect(PROVIDERS.kimi.envVar).toBe('MOONSHOT_API_KEY')
  })

  it('per-provider default and validation models exist in that provider registry', () => {
    for (const p of PROVIDER_IDS) {
      expect(modelKeys(p)).toContain(PROVIDERS[p].defaultModel)
      expect(modelKeys(p)).toContain(PROVIDERS[p].validationModel)
    }
  })

  it('normalizeProvider maps names (moonshot alias included), null otherwise', () => {
    expect(normalizeProvider('anthropic')).toBe('anthropic')
    expect(normalizeProvider(' KIMI ')).toBe('kimi')
    expect(normalizeProvider('moonshot')).toBe('kimi')
    expect(normalizeProvider('openai')).toBeNull()
    expect(normalizeProvider('')).toBeNull()
  })
})

describe('provider-scoped model registry', () => {
  it('keeps the four Anthropic families with their current ids and labels', () => {
    expect(modelKeys('anthropic')).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(modelId('anthropic', 'haiku')).toBe('claude-haiku-4-5')
    expect(modelId('anthropic', 'sonnet')).toBe('claude-sonnet-5')
    expect(modelId('anthropic', 'opus')).toBe('claude-opus-4-8')
    expect(modelId('anthropic', 'fable')).toBe('claude-fable-5')
    expect(modelLabel('anthropic', 'opus')).toBe('Opus 4.8')
  })

  it('anthropic effort/thinking flags: haiku has neither, the other three have both', () => {
    expect(supportsEffort('anthropic', 'haiku')).toBe(false)
    expect(MODELS.anthropic['haiku']!.supportsThinking).toBe(false)
    for (const k of ['sonnet', 'opus', 'fable']) {
      expect(supportsEffort('anthropic', k)).toBe(true)
      expect(MODELS.anthropic[k]!.supportsThinking).toBe(true)
    }
  })

  it('kimi models never support effort or thinking', () => {
    expect(modelKeys('kimi').length).toBeGreaterThan(0)
    for (const k of modelKeys('kimi')) {
      expect(MODELS.kimi[k]!.supportsEffort).toBe(false)
      expect(MODELS.kimi[k]!.supportsThinking).toBe(false)
    }
  })

  it('modelId throws a clear error for a cross-provider key', () => {
    expect(() => modelId('kimi', 'sonnet')).toThrow(/Unknown model 'sonnet' for provider 'kimi'/)
    expect(() => modelId('anthropic', 'kimi-k2')).toThrow(/Unknown model 'kimi-k2'/)
  })
})

describe('normalizeModel (scoped to the active provider)', () => {
  it.each([
    ['haiku', 'haiku'],
    ['sonnet', 'sonnet'],
    ['opus', 'opus'],
    ['fable', 'fable'],
    ['  OPUS  ', 'opus'],
    ['Sonnet', 'sonnet'],
  ] as const)('anthropic: maps family name %s -> %s', (input, expected) => {
    expect(normalizeModel('anthropic', input)).toBe(expected)
  })

  it.each([
    ['claude-opus-4-8', 'opus'],
    ['claude-sonnet-4-5', 'sonnet'], // legacy id still resolves (non-breaking)
    ['claude-sonnet-5', 'sonnet'],
    ['claude-haiku-4-5', 'haiku'],
    ['claude-fable-5', 'fable'],
  ] as const)('anthropic: maps legacy/full id %s -> %s', (input, expected) => {
    expect(normalizeModel('anthropic', input)).toBe(expected)
  })

  it('kimi: resolves keys and full ids, preferring the longest key on substrings', () => {
    expect(normalizeModel('kimi', 'kimi-k2')).toBe('kimi-k2')
    expect(normalizeModel('kimi', 'kimi-k2-0711-preview')).toBe('kimi-k2')
    expect(normalizeModel('kimi', 'kimi-k2-turbo')).toBe('kimi-k2-turbo')
    expect(normalizeModel('kimi', 'kimi-k2-turbo-preview')).toBe('kimi-k2-turbo')
  })

  it('does NOT resolve cross-provider names', () => {
    expect(normalizeModel('kimi', 'sonnet')).toBeNull()
    expect(normalizeModel('kimi', 'claude-opus-4-8')).toBeNull()
    expect(normalizeModel('anthropic', 'kimi-k2')).toBeNull()
  })

  it.each(['', '   ', 'gpt-4', 'gemini', 'bogus'])('returns null for unrecognized %j', (input) => {
    expect(normalizeModel('anthropic', input)).toBeNull()
    expect(normalizeModel('kimi', input)).toBeNull()
  })
})

describe('resolveModelRequest (capability gating lives HERE, nowhere else)', () => {
  it('anthropic haiku carries NO effort and NO thinking (both 400 on it)', () => {
    const req = resolveModelRequest('anthropic', 'haiku', 'high')
    expect(req).toEqual({ model: 'claude-haiku-4-5' })
    expect('effort' in req).toBe(false)
    expect('thinking' in req).toBe(false)
  })

  it.each(['sonnet', 'opus', 'fable'] as const)(
    'anthropic %s carries the effort dial + adaptive thinking',
    (key) => {
      const req = resolveModelRequest('anthropic', key, 'xhigh')
      expect(req.model).toBe(modelId('anthropic', key))
      expect(req.effort).toBe('xhigh')
      expect(req.thinking).toEqual({ type: 'adaptive' })
    },
  )

  it('every kimi model carries NEITHER effort nor thinking (would 400 on Moonshot)', () => {
    for (const k of modelKeys('kimi')) {
      const req = resolveModelRequest('kimi', k, 'high')
      expect(req).toEqual({ model: MODELS.kimi[k]!.id })
    }
  })
})
