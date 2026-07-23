import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../src/cli.js'

describe('parseArgs — auth and --provider', () => {
  it('parses athena auth and athena auth status', () => {
    expect(parseArgs(['auth'])).toEqual({ command: 'auth', sub: 'wizard' })
    expect(parseArgs(['auth', 'status'])).toEqual({ command: 'auth', sub: 'status' })
    expect(parseArgs(['auth', 'bogus'])).toEqual({
      command: 'error',
      message: 'Usage: athena auth [status]',
    })
  })

  it('parses --provider on run/continue/resume (moonshot aliases to kimi)', () => {
    expect(parseArgs(['--provider', 'kimi'])).toEqual({ command: 'run', provider: 'kimi' })
    expect(parseArgs(['--provider', 'moonshot'])).toEqual({ command: 'run', provider: 'kimi' })
    expect(parseArgs(['--continue', '--provider', 'anthropic'])).toEqual({
      command: 'continue',
      provider: 'anthropic',
    })
    expect(parseArgs(['--provider', 'kimi', '--resume'])).toEqual({
      command: 'resume',
      provider: 'kimi',
    })
  })

  it('rejects a missing or unknown --provider value', () => {
    expect(parseArgs(['--provider'])).toEqual({
      command: 'error',
      message: '--provider needs one of: anthropic, kimi',
    })
    expect(parseArgs(['--provider', 'openai'])).toEqual({
      command: 'error',
      message: '--provider needs one of: anthropic, kimi',
    })
  })

  it('existing commands still parse (no provider key when the flag is absent)', () => {
    expect(parseArgs([])).toEqual({ command: 'run', provider: undefined })
    expect(parseArgs(['--help'])).toEqual({ command: 'help' })
    expect(parseArgs(['import', 'x'])).toEqual({ command: 'import', sourceDir: 'x', force: false })
    expect(parseArgs(['bogus'])).toEqual({
      command: 'error',
      message: 'Unknown argument: bogus (try --help)',
    })
  })
})
