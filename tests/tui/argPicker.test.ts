import { describe, it, expect } from 'vitest'
import {
  PICKABLE_KINDS,
  pickerOptions,
  currentOptionIndex,
  pickerTitle,
  type PickableKind,
} from '../../src/tui/argPicker.js'
import { PROVIDER_IDS, PROVIDERS, modelKeys, modelLabel, EFFORTS, type ProviderId } from '../../src/brain/models.js'

describe('PICKABLE_KINDS', () => {
  it('contains exactly the 5 enumerable-argument commands', () => {
    expect([...PICKABLE_KINDS].sort()).toEqual(['effort', 'mode', 'model', 'provider', 'tui'].sort())
  })
})

describe('pickerOptions', () => {
  it('model: returns every model key for the given provider, labeled via modelLabel', () => {
    for (const provider of PROVIDER_IDS) {
      const options = pickerOptions('model', provider)
      expect(options.map((o) => o.value)).toEqual(modelKeys(provider))
      for (const o of options) expect(o.label).toBe(modelLabel(provider, o.value))
    }
  })

  it('provider: returns every provider id, labeled via PROVIDERS[p].label', () => {
    const options = pickerOptions('provider', 'anthropic')
    expect(options.map((o) => o.value)).toEqual(PROVIDER_IDS)
    for (const o of options) expect(o.label).toBe(PROVIDERS[o.value as ProviderId].label)
  })

  it('effort: returns EFFORTS, label equal to the value itself', () => {
    const options = pickerOptions('effort', 'anthropic')
    expect(options.map((o) => o.value)).toEqual(EFFORTS)
    for (const o of options) expect(o.label).toBe(o.value)
  })

  it('mode: returns the 4 permission modes, label equal to the value itself', () => {
    const options = pickerOptions('mode', 'anthropic')
    expect(options.map((o) => o.value)).toEqual(['normal', 'acceptEdits', 'plan', 'trusted'])
    for (const o of options) expect(o.label).toBe(o.value)
  })

  it('tui: returns classic/fullscreen, label equal to the value itself', () => {
    const options = pickerOptions('tui', 'anthropic')
    expect(options.map((o) => o.value)).toEqual(['classic', 'fullscreen'])
    for (const o of options) expect(o.label).toBe(o.value)
  })

  it('provider is irrelevant to non-model kinds (same result regardless of which is passed)', () => {
    for (const kind of ['provider', 'effort', 'mode', 'tui'] as PickableKind[]) {
      expect(pickerOptions(kind, 'anthropic')).toEqual(pickerOptions(kind, 'kimi'))
    }
  })
})

describe('currentOptionIndex', () => {
  const options = pickerOptions('mode', 'anthropic')

  it('returns the exact-match index', () => {
    expect(currentOptionIndex(options, 'plan')).toBe(2)
    expect(currentOptionIndex(options, 'normal')).toBe(0)
  })

  it('falls back to 0 (never -1) when the value is not found', () => {
    expect(currentOptionIndex(options, 'nonexistent')).toBe(0)
    expect(currentOptionIndex([], 'anything')).toBe(0)
  })
})

describe('pickerTitle', () => {
  it('returns a short header for each kind', () => {
    expect(pickerTitle('model')).toBe('Select model')
    expect(pickerTitle('provider')).toBe('Select provider')
    expect(pickerTitle('effort')).toBe('Select effort')
    expect(pickerTitle('mode')).toBe('Select permission mode')
    expect(pickerTitle('tui')).toBe('Select TUI mode')
  })
})
