import { describe, it, expect } from 'vitest'
import { parseSlash } from '../../src/tui/slash.js'

describe('parseSlash', () => {
  it.each([
    ['/help', { kind: 'help' }],
    ['/clear', { kind: 'clear' }],
    ['/resume', { kind: 'resume' }],
    ['/compact', { kind: 'compact' }],
    ['/model claude-opus-4-6', { kind: 'model', value: 'claude-opus-4-6' }],
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
    expect(parseSlash('/model')).toEqual({ kind: 'error', value: 'Usage: /model <model-id>' })
  })

  it('errors on /mode with no argument', () => {
    expect(parseSlash('/mode')).toEqual({ kind: 'error', value: 'Unknown mode: (none)' })
  })
})
