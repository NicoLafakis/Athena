import { describe, it, expect } from 'vitest'
import { parseSlash, type CustomCommandDef } from '../../src/tui/slash.js'

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
    ['/tui fullscreen', { kind: 'tui', value: 'fullscreen' }],
    ['/tui classic', { kind: 'tui', value: 'classic' }],
    ['/tui bogus', { kind: 'error', value: 'Usage: /tui <fullscreen|classic>' }],
    ['/tui', { kind: 'error', value: 'Usage: /tui <fullscreen|classic>' }],
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

describe('custom commands (directory-backed registry)', () => {
  function registry(entries: Record<string, string>): Map<string, CustomCommandDef> {
    return new Map(Object.entries(entries).map(([name, template]) => [name, { template, description: '' }]))
  }

  it('matches a registered custom command not in the built-in set', () => {
    const commands = registry({ standup: 'Write a standup update.' })
    expect(parseSlash('/standup', commands)).toEqual({
      kind: 'custom',
      name: 'standup',
      expandedPrompt: 'Write a standup update.',
    })
  })

  it('substitutes $0/$1 positional args and $ARGUMENTS', () => {
    const commands = registry({
      review: 'Review PR #$0 for $ARGUMENTS. Second word: $1.',
    })
    expect(parseSlash('/review 42 alice bob', commands)).toEqual({
      kind: 'custom',
      name: 'review',
      expandedPrompt: 'Review PR #42 for 42 alice bob. Second word: alice.',
    })
  })

  it('leaves unmatched positional placeholders blank', () => {
    const commands = registry({ greet: 'Hello $0, $1!' })
    expect(parseSlash('/greet world', commands)).toEqual({
      kind: 'custom',
      name: 'greet',
      expandedPrompt: 'Hello world, !',
    })
  })

  it('a built-in name always wins over a same-named registry entry (reserved-name collision)', () => {
    const commands = registry({ help: 'this must never be reached' })
    expect(parseSlash('/help', commands)).toEqual({ kind: 'help' })
  })

  it('falls back to the unknown-command error when the registry has no match', () => {
    const commands = registry({ standup: 'x' })
    expect(parseSlash('/nope', commands)).toEqual({
      kind: 'error',
      value: 'Unknown command: /nope',
    })
  })

  it('with no registry passed at all, behaves exactly as before', () => {
    expect(parseSlash('/standup')).toEqual({
      kind: 'error',
      value: 'Unknown command: /standup',
    })
  })
})
