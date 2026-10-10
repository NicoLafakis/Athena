import { describe, it, expect } from 'vitest'
import {
  PROVIDERS,
  PROVIDER_IDS,
  MODELS,
  EFFORTS,
  effortLevels,
  defaultEffort,
  modelKeys,
  modelId,
  modelLabel,
  supportsEffort,
  supportsThinking,
  normalizeProvider,
  normalizeModel,
  resolveModelRequest,
  usageCostUsd,
} from '../../src/brain/models.js'

describe('provider registry', () => {
  it('exposes exactly four providers and the union of supported efforts', () => {
    expect([...PROVIDER_IDS]).toEqual(['openai', 'anthropic', 'kimi', 'kimi-code'])
    expect([...EFFORTS]).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('openai uses the platform default URL, bearer auth, and the verified GPT-6 lineup', () => {
    expect(PROVIDERS.openai.baseURL).toBeNull()
    expect(PROVIDERS.openai.envVar).toBe('OPENAI_API_KEY')
    expect(PROVIDERS.openai.authMode).toBe('bearer')
    expect(PROVIDERS.openai.defaultModel).toBe('sol-6.1')
    expect(defaultEffort('openai')).toBe('medium')
    expect(defaultEffort('anthropic')).toBe('high')
    expect(PROVIDERS.openai.validationModel).toBe('luna')
    expect(modelKeys('openai')).toEqual(['luna', 'sol', 'astra', 'sol-6.1'])
    expect(modelId('openai', 'luna')).toBe('gpt-6-luna')
    expect(modelId('openai', 'sol')).toBe('gpt-6-sol')
    expect(modelId('openai', 'astra')).toBe('gpt-6-astra')
    expect(modelId('openai', 'sol-6.1')).toBe('gpt-6.1-sol')
    expect(normalizeModel('openai', ' GPT-6.1-SOL ')).toBe('sol-6.1')
    expect(normalizeModel('openai', 'gpt-6-astra')).toBe('astra')
    // Effort maps to reasoning.effort; thinking stays off (Anthropic-only param).
    expect(supportsEffort('openai', 'sol')).toBe(true)
    expect(supportsThinking('openai', 'sol')).toBe(false)
  })

  it('anthropic uses the SDK default URL; kimi uses the Moonshot Anthropic-compatible endpoint', () => {
    expect(PROVIDERS.anthropic.baseURL).toBeNull()
    expect(PROVIDERS.kimi.baseURL).toBe('https://api.moonshot.ai/anthropic')
    expect(PROVIDERS.anthropic.envVar).toBe('ANTHROPIC_API_KEY')
    expect(PROVIDERS.kimi.envVar).toBe('MOONSHOT_API_KEY')
  })

  it('anthropic authenticates via x-api-key; kimi via Authorization: Bearer', () => {
    expect(PROVIDERS.anthropic.authMode).toBe('x-api-key')
    expect(PROVIDERS.kimi.authMode).toBe('bearer')
  })

  it('kimi carries the .ai/.cn platform-split key hint and points subscription keys at kimi-code', () => {
    expect(PROVIDERS.kimi.keyHint).toContain('platform.kimi.ai')
    expect(PROVIDERS.kimi.keyHint).toContain('kimi-code')
  })

  it('kimi-code uses the subscription endpoint with x-api-key auth', () => {
    expect(PROVIDERS['kimi-code'].baseURL).toBe('https://api.kimi.com/coding/')
    expect(PROVIDERS['kimi-code'].envVar).toBe('KIMI_CODE_API_KEY')
    expect(PROVIDERS['kimi-code'].authMode).toBe('x-api-key')
    expect(PROVIDERS['kimi-code'].defaultModel).toBe('kimi-for-coding')
    expect(PROVIDERS['kimi-code'].validationModel).toBe('kimi-for-coding')
  })

  it('kimi-code keyHint disambiguates subscription vs pay-per-token keys', () => {
    expect(PROVIDERS['kimi-code'].keyHint).toContain('kimi.com/code/console')
  })

  it('per-provider default and validation models exist in that provider registry', () => {
    for (const p of PROVIDER_IDS) {
      expect(modelKeys(p)).toContain(PROVIDERS[p].defaultModel)
      expect(modelKeys(p)).toContain(PROVIDERS[p].validationModel)
    }
  })

  it('normalizeProvider maps names (moonshot alias included), null otherwise', () => {
    expect(normalizeProvider('anthropic')).toBe('anthropic')
    expect(normalizeProvider('openai')).toBe('openai')
    expect(normalizeProvider('gpt')).toBe('openai')
    expect(normalizeProvider(' KIMI ')).toBe('kimi')
    expect(normalizeProvider('moonshot')).toBe('kimi')
    expect(normalizeProvider('azure')).toBeNull()
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

  it.each(['kimi', 'kimi-code'] as const)('%s models never support effort or thinking', (p) => {
    expect(modelKeys(p).length).toBeGreaterThan(0)
    for (const k of modelKeys(p)) {
      expect(MODELS[p][k]!.supportsEffort).toBe(false)
      expect(MODELS[p][k]!.supportsThinking).toBe(false)
    }
  })

  it('kimi-code exposes the subscription model set', () => {
    expect(modelKeys('kimi-code')).toEqual(['kimi-for-coding', 'k3', 'k3[1m]'])
    expect(modelId('kimi-code', 'kimi-for-coding')).toBe('kimi-for-coding')
    expect(modelId('kimi-code', 'k3')).toBe('k3')
    // k3[1m] is a local capability alias; the API wire id remains k3.
    expect(modelId('kimi-code', 'k3[1m]')).toBe('k3')
    expect(modelLabel('kimi-code', 'k3')).toBe('Kimi K3 (256K)')
  })

  it('modelId throws a clear error for a cross-provider key', () => {
    expect(() => modelId('kimi', 'sonnet')).toThrow(/Unknown model 'sonnet' for provider 'kimi'/)
    expect(() => modelId('anthropic', 'kimi-k3')).toThrow(/Unknown model 'kimi-k3'/)
    expect(() => modelId('kimi', 'k3')).toThrow(/Unknown model 'k3' for provider 'kimi'/)
  })

  it('accounts for cache reads and cache creation in metered cost', () => {
    expect(
      usageCostUsd('anthropic', 'haiku', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(7.35)
  })
})

describe('normalizeModel (scoped to the active provider)', () => {
  it.each(['gpt-6.2-sol', 'gpt-6.1-astra', 'sol-unknown', 'gpt-6-sol-unknown'])(
    'rejects unknown OpenAI versions instead of selecting a model by substring: %s', input => {
      expect(normalizeModel('openai', input)).toBeNull()
    },
  )
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

  it('kimi: resolves keys case-insensitively, including the [1m] suffix form', () => {
    expect(normalizeModel('kimi', 'kimi-k3')).toBe('kimi-k3')
    expect(normalizeModel('kimi', 'KIMI-K3 ')).toBe('kimi-k3')
    expect(normalizeModel('kimi', 'kimi-k2.7-code')).toBe('kimi-k2.7-code')
    expect(normalizeModel('kimi', 'kimi-k3[1m]')).toBe('kimi-k3') // Moonshot's 1M-context suffix form still resolves
  })

  it('kimi-code: exact `k3[1m]` key wins over the `k3` substring; case-insensitive keys resolve', () => {
    expect(normalizeModel('kimi-code', 'k3[1m]')).toBe('k3[1m]')
    expect(normalizeModel('kimi-code', 'K3')).toBe('k3')
    expect(normalizeModel('kimi-code', 'kimi-for-coding')).toBe('kimi-for-coding')
  })

  it('does NOT resolve cross-provider names', () => {
    expect(normalizeModel('kimi', 'sonnet')).toBeNull()
    expect(normalizeModel('kimi', 'claude-opus-4-8')).toBeNull()
    expect(normalizeModel('anthropic', 'kimi-k3')).toBeNull()
    expect(normalizeModel('anthropic', 'k3')).toBeNull()
  })

  it.each(['', '   ', 'gpt-4', 'gemini', 'bogus'])('returns null for unrecognized %j', (input) => {
    expect(normalizeModel('anthropic', input)).toBeNull()
    expect(normalizeModel('kimi', input)).toBeNull()
    expect(normalizeModel('kimi-code', input)).toBeNull()
  })
})

describe('resolveModelRequest (capability gating lives HERE, nowhere else)', () => {
  const matrix = [
    ['luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['astra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['sol-6.1', ['low', 'medium', 'high', 'xhigh', 'max']],
  ] as const
  it.each(matrix)('OpenAI %s exposes and resolves only its documented effort set', (key, levels) => {
    expect(effortLevels('openai', key)).toEqual(levels)
    for (const effort of levels) {
      expect(resolveModelRequest('openai', key, effort)).toEqual({ model: modelId('openai', key), effort })
    }
    for (const invalid of ['none', 'minimal', 'ultra'] as const) {
      if (!(levels as readonly string[]).includes(invalid)) {
        expect(() => resolveModelRequest('openai', key, invalid as never)).toThrow(/Unsupported effort/)
      }
    }
  })

  it('keeps Anthropic non-none levels and rejects OpenAI-only none on reasoning models', () => {
    expect(effortLevels('anthropic', 'sonnet')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(() => resolveModelRequest('anthropic', 'sonnet', 'none')).toThrow(/Unsupported effort/)
  })

  it('uses the GPT-6.1 Sol base tariff, including the distinct 5% cached-input rate', () => {
    expect(usageCostUsd('openai', 'sol-6.1', {
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    })).toBeCloseTo(14.6)
  })
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

  it.each(['kimi', 'kimi-code'] as const)(
    'every %s model carries NEITHER effort nor thinking (would 400 upstream)',
    (p) => {
      for (const k of modelKeys(p)) {
        const req = resolveModelRequest(p, k, 'high')
        expect(req).toEqual({ model: MODELS[p][k]!.id })
      }
    },
  )
})
