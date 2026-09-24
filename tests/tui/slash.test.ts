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
    ['/memory status', { kind: 'memory', action: 'status' }],
    ['/memory timeline last week', { kind: 'memory', action: 'timeline', value: 'last week' }],
    ['/memory search what did we decide --project alpha-123', {
      kind: 'memory', action: 'search', value: 'what did we decide', projectId: 'alpha-123',
    }],
    ['/memory rank what did we decide --project alpha-123', {
      kind: 'memory', action: 'rank', value: 'what did we decide', projectId: 'alpha-123',
    }],
    ['/memory candidates', { kind: 'memory', action: 'candidates' }],
    ['/memory review 123e4567-e89b-42d3-a456-426614174000 promote', {
      kind: 'memory', action: 'review', value: '123e4567-e89b-42d3-a456-426614174000 promote',
    }],
    ['/memory review 123e4567-e89b-42d3-a456-426614174000 reject', {
      kind: 'memory', action: 'review', value: '123e4567-e89b-42d3-a456-426614174000 reject',
    }],
    ['/memory forget 123e4567-e89b-42d3-a456-426614174000', {
      kind: 'memory', action: 'forget', value: '123e4567-e89b-42d3-a456-426614174000',
    }],
    ['/memory forget not-an-id', {
      kind: 'error', value: 'Usage: /memory forget <memory-id>',
    }],
    ['/memory review 123e4567-e89b-42d3-a456-426614174000 forget', {
      kind: 'error', value: 'Usage: /memory review <memory-id> <promote|reject>',
    }],
    ['/memory show episode-123', { kind: 'memory', action: 'show', value: 'episode-123' }],
    ['/memory rollup', { kind: 'memory', action: 'rollup' }],
    ['/memory rollup month', { kind: 'memory', action: 'rollup', value: 'month' }],
    ['/memory rollup decade', { kind: 'error', value: 'Usage: /memory rollup [day|week|month|quarter|year]' }],
    ['/memory rollup day week', { kind: 'error', value: 'Usage: /memory rollup [day|week|month|quarter|year]' }],
    ['/memory search', { kind: 'error', value: 'Usage: /memory search <query>' }],
    ['/memory rank', { kind: 'error', value: 'Usage: /memory rank <query>' }],
    ['/skills', { kind: 'skills' }],
    ['/agents', { kind: 'agents' }],
    ['/status', { kind: 'status' }],
    ['/repeat', { kind: 'repeat' }],
    ['/details', { kind: 'details', value: '' }],
    ['/details permission permission:tu_1', { kind: 'details', value: 'permission permission:tu_1' }],
    ['/verbosity concise', { kind: 'verbosity', value: 'concise' }],
    ['/verbosity balanced', { kind: 'verbosity', value: 'balanced' }],
    ['/verbosity detailed', { kind: 'verbosity', value: 'detailed' }],
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

  it('rejects an absent or unknown verbosity value', () => {
    expect(parseSlash('/verbosity')).toEqual({
      kind: 'error',
      value: 'Usage: /verbosity <concise|balanced|detailed>',
    })
    expect(parseSlash('/verbosity noisy')).toEqual({
      kind: 'error',
      value: 'Usage: /verbosity <concise|balanced|detailed>',
    })
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
