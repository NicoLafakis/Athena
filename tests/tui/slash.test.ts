import { describe, it, expect } from 'vitest'
import { parseSlash } from '../../src/tui/slash.js'

describe('parseSlash', () => {
  it.each([
    ['/help', { kind: 'help' }],
    ['/clear', { kind: 'clear' }],
    ['/resume', { kind: 'resume' }],
    ['/compact', { kind: 'compact' }],
    ['/model claude-opus-4-6', { kind: 'model', value: 'claude-opus-4-6' }],
    ['/effort xhigh', { kind: 'effort', value: 'xhigh' }],
    ['/effort bogus', { kind: 'error', value: 'Unknown effort: bogus' }],
    ['/mode plan', { kind: 'mode', value: 'plan' }],
    ['/memory', { kind: 'memory' }],
    ['/skills', { kind: 'skills' }],
    ['/agents', { kind: 'agents' }],
    ['/quit', { kind: 'quit' }],
    ['not a command', null],
    ['/mode yolo', { kind: 'error', value: 'Unknown mode: yolo' }],
    ['/bogus', { kind: 'error', value: 'Unknown command: /bogus' }],
  ] as const)('parseSlash(%s)', (input, expected) => {
    expect(parseSlash(input)).toEqual(expected)
  })

  it('errors on /model with no argument', () => {
    expect(parseSlash('/model')).toEqual({
      kind: 'error',
      value: 'Usage: /model <name>',
    })
  })

  it('errors on /effort with no argument', () => {
    expect(parseSlash('/effort')).toEqual({
      kind: 'error',
      value: 'Usage: /effort <low|medium|high|xhigh|max>',
    })
  })

  it('errors on /mode with no argument', () => {
    expect(parseSlash('/mode')).toEqual({ kind: 'error', value: 'Unknown mode: (none)' })
  })
})

describe('/provider', () => {
  it('parses /provider with a value', () => {
    expect(parseSlash('/provider kimi')).toEqual({ kind: 'provider', value: 'kimi' })
    expect(parseSlash('/provider anthropic')).toEqual({ kind: 'provider', value: 'anthropic' })
    expect(parseSlash('/provider kimi-code')).toEqual({ kind: 'provider', value: 'kimi-code' })
  })

  it('errors without a value (parse layer is provider-name generic, like /model)', () => {
    expect(parseSlash('/provider')).toEqual({
      kind: 'error',
      value: 'Usage: /provider <name>',
    })
  })
})
