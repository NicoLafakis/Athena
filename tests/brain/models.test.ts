import { describe, it, expect } from 'vitest'
import {
  MODEL_FAMILIES,
  EFFORTS,
  modelId,
  modelLabel,
  supportsEffort,
  normalizeModel,
  resolveModelRequest,
} from '../../src/brain/models.js'

describe('normalizeModel', () => {
  it.each([
    ['haiku', 'haiku'],
    ['sonnet', 'sonnet'],
    ['opus', 'opus'],
    ['fable', 'fable'],
    ['  OPUS  ', 'opus'], // trimmed + case-insensitive
    ['Sonnet', 'sonnet'],
  ] as const)('maps family name %s -> %s', (input, expected) => {
    expect(normalizeModel(input)).toBe(expected)
  })

  it.each([
    ['claude-opus-4-8', 'opus'],
    ['claude-sonnet-4-5', 'sonnet'], // legacy id still resolves (non-breaking)
    ['claude-sonnet-5', 'sonnet'],
    ['claude-haiku-4-5', 'haiku'],
    ['claude-fable-5', 'fable'],
  ] as const)('maps legacy/full id %s -> %s', (input, expected) => {
    expect(normalizeModel(input)).toBe(expected)
  })

  it.each(['', '   ', 'gpt-4', 'gemini', 'bogus'])('returns null for unrecognized %j', (input) => {
    expect(normalizeModel(input)).toBeNull()
  })
})

describe('modelId / modelLabel / supportsEffort', () => {
  it('exposes exactly four families', () => {
    expect([...MODEL_FAMILIES]).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect([...EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('maps each family to its current id and label', () => {
    expect(modelId('haiku')).toBe('claude-haiku-4-5')
    expect(modelId('sonnet')).toBe('claude-sonnet-5')
    expect(modelId('opus')).toBe('claude-opus-4-8')
    expect(modelId('fable')).toBe('claude-fable-5')
    expect(modelLabel('opus')).toBe('Opus 4.8')
    expect(modelLabel('haiku')).toBe('Haiku 4.5')
  })

  it('flags effort support per family (haiku is the only one without)', () => {
    expect(supportsEffort('haiku')).toBe(false)
    expect(supportsEffort('sonnet')).toBe(true)
    expect(supportsEffort('opus')).toBe(true)
    expect(supportsEffort('fable')).toBe(true)
  })
})

describe('resolveModelRequest', () => {
  it('haiku carries NO effort and NO thinking (both 400 on it)', () => {
    const req = resolveModelRequest('haiku', 'high')
    expect(req).toEqual({ model: 'claude-haiku-4-5' })
    expect('effort' in req).toBe(false)
    expect('thinking' in req).toBe(false)
  })

  it.each(['sonnet', 'opus', 'fable'] as const)(
    '%s carries the effort dial + adaptive thinking',
    (family) => {
      const req = resolveModelRequest(family, 'xhigh')
      expect(req.model).toBe(modelId(family))
      expect(req.effort).toBe('xhigh')
      expect(req.thinking).toEqual({ type: 'adaptive' })
      expect(req.thinking?.type).toBe('adaptive')
    },
  )
})
