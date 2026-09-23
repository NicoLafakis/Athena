import { describe, it, expect } from 'vitest'
import { parseArgs, resolveAuthPresentation } from '../../src/cli.js'
import { PROVIDER_IDS } from '../../src/brain/models.js'

// Derived exactly the way cli.ts derives it, so a new provider updates both in lockstep.
const AUTH_USAGE =
  `Usage: athena auth [status] [--provider <${PROVIDER_IDS.join('|')}>] ` +
  '[--accessibility screen-reader|standard]'
const PROVIDER_NEEDS = `--provider needs one of: ${PROVIDER_IDS.join(', ')}`

describe('parseArgs — auth and --provider', () => {
  it('parses athena auth and athena auth status', () => {
    expect(parseArgs(['auth'])).toEqual({ command: 'auth', sub: 'wizard' })
    expect(parseArgs(['auth', 'status'])).toEqual({ command: 'auth', sub: 'status' })
  })

  it('rejects stray positional args after auth', () => {
    expect(parseArgs(['auth', 'bogus'])).toEqual({
      command: 'error',
      message: AUTH_USAGE,
    })
  })

  it('auth usage names all four providers', () => {
    expect(AUTH_USAGE).toBe(
      'Usage: athena auth [status] [--provider <openai|anthropic|kimi|kimi-code>] ' +
      '[--accessibility screen-reader|standard]',
    )
  })

  it('parses auth with --provider flag (wizard only, not status)', () => {
    expect(parseArgs(['auth', '--provider', 'kimi'])).toEqual({
      command: 'auth',
      sub: 'wizard',
      provider: 'kimi',
    })
  })

  it('rejects --provider on auth status', () => {
    expect(parseArgs(['auth', 'status', '--provider', 'anthropic'])).toEqual({
      command: 'error',
      message: AUTH_USAGE,
    })
  })

  it('rejects auth with unknown --provider value', () => {
    expect(parseArgs(['auth', '--provider', 'azure'])).toEqual({
      command: 'error',
      message: PROVIDER_NEEDS,
    })
  })

  it('rejects auth --provider without a value', () => {
    expect(parseArgs(['auth', '--provider'])).toEqual({
      command: 'error',
      message: AUTH_USAGE,
    })
  })

  it('selects silent screen-reader auth before the TUI exists', () => {
    expect(parseArgs(['auth', '--accessibility', 'screen-reader'])).toEqual({
      command: 'auth',
      sub: 'wizard',
      accessibility: 'screen-reader',
    })
    expect(parseArgs(['auth', 'status', '--accessibility', 'screen-reader'])).toEqual({
      command: 'error',
      message: AUTH_USAGE,
    })
  })

  it('parses --provider on run/continue/resume (moonshot aliases to kimi)', () => {
    expect(parseArgs(['--provider', 'kimi'])).toEqual({ command: 'run', provider: 'kimi' })
    expect(parseArgs(['--provider', 'kimi-code'])).toEqual({ command: 'run', provider: 'kimi-code' })
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

  it('parses a per-invocation accessibility presentation override', () => {
    expect(parseArgs(['--accessibility', 'screen-reader'])).toEqual({
      command: 'run',
      provider: undefined,
      accessibility: 'screen-reader',
    })
    expect(parseArgs(['--continue', '--accessibility', 'standard'])).toEqual({
      command: 'continue',
      provider: undefined,
      accessibility: 'standard',
    })
    expect(parseArgs(['--accessibility', 'screen-reader', '--resume'])).toEqual({
      command: 'resume',
      provider: undefined,
      accessibility: 'screen-reader',
    })
  })

  it('uses the persisted screen-reader presentation for cold-start auth unless overridden', () => {
    const ordinary = parseArgs([])
    const overridden = parseArgs(['--accessibility', 'standard'])
    if (ordinary.command !== 'run' || overridden.command !== 'run') throw new Error('expected run')
    expect(resolveAuthPresentation(ordinary, 'screen-reader')).toBe('screen-reader')
    expect(resolveAuthPresentation(overridden, 'screen-reader')).toBe('standard')
  })

  it('rejects a missing or unknown accessibility presentation', () => {
    expect(parseArgs(['--accessibility'])).toEqual({
      command: 'error',
      message: '--accessibility needs screen-reader or standard',
    })
    expect(parseArgs(['--accessibility', 'visual'])).toEqual({
      command: 'error',
      message: '--accessibility needs screen-reader or standard',
    })
  })

  it('rejects a missing or unknown --provider value', () => {
    expect(parseArgs(['--provider'])).toEqual({
      command: 'error',
      message: PROVIDER_NEEDS,
    })
    expect(parseArgs(['--provider', 'azure'])).toEqual({
      command: 'error',
      message: PROVIDER_NEEDS,
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

  it('parses --version and its -v short flag', () => {
    expect(parseArgs(['--version'])).toEqual({ command: 'version' })
    expect(parseArgs(['-v'])).toEqual({ command: 'version' })
  })

  it('parses explicit project trust and capability approvals', () => {
    expect(parseArgs(['trust'])).toEqual({ command: 'trust', revoke: false, capabilities: [] })
    expect(parseArgs(['trust', '--hooks'])).toEqual({
      command: 'trust',
      revoke: false,
      capabilities: ['hooks'],
    })
    expect(parseArgs(['trust', '--all'])).toEqual({
      command: 'trust',
      revoke: false,
      capabilities: ['hooks', 'mcp'],
    })
    expect(parseArgs(['trust', '--revoke'])).toEqual({
      command: 'trust',
      revoke: true,
      capabilities: [],
    })
  })

  it('parses headless exec prompts, output modes, policy, and budgets', () => {
    const parsed = parseArgs([
      'exec',
      'fix',
      'the bug',
      '--output',
      'jsonl',
      '--provider',
      'kimi',
      '--permission-mode',
      'trusted',
      '--sandbox',
      'workspace-write',
      '--max-turns',
      '7',
      '--max-tool-calls',
      '0',
      '--max-cost-usd',
      '1.5',
      '--session',
    ])
    expect(parsed).toMatchObject({
      command: 'exec',
      provider: 'kimi',
      options: {
        prompt: 'fix the bug',
        output: 'jsonl',
        persistSession: true,
        permissionMode: 'trusted',
        sandboxMode: 'workspace-write',
        limits: {
          maxModelCalls: 7,
          maxToolCalls: 0,
          maxCostUsd: 1.5,
        },
      },
    })
  })

  it('treats exec help as a successful help command', () => {
    expect(parseArgs(['exec', '--help'])).toEqual({ command: 'exec-help' })
    expect(parseArgs(['exec', '-h'])).toEqual({ command: 'exec-help' })
  })

  it('accepts stdin mode and rejects malformed exec options', () => {
    expect(parseArgs(['exec'])).toMatchObject({
      command: 'exec',
      options: { prompt: null, output: 'text' },
    })
    expect(parseArgs(['exec', '--output', 'xml'])).toEqual({
      command: 'error',
      message: '--output needs text, json, or jsonl',
    })
    expect(parseArgs(['exec', '--max-turns', '0'])).toEqual({
      command: 'error',
      message: '--max-turns requires a positive number',
    })
  })
})

describe('parseArgs — memory continuity commands', () => {
  it('parses status, rebuild, timeline, search, and show actions', () => {
    expect(parseArgs(['memory'])).toEqual({ command: 'memory', action: 'status', args: [] })
    expect(parseArgs(['memory', 'rebuild'])).toEqual({ command: 'memory', action: 'rebuild', args: [] })
    expect(parseArgs(['memory', 'timeline', 'last', 'week'])).toEqual({
      command: 'memory', action: 'timeline', args: ['last', 'week'],
    })
    expect(parseArgs(['memory', 'search', 'what', 'did', 'we', 'decide', '--project', 'alpha-123'])).toEqual({
      command: 'memory', action: 'search', args: ['what', 'did', 'we', 'decide'], projectId: 'alpha-123',
    })
    expect(parseArgs(['memory', 'rank', 'what', 'did', 'we', 'decide', '--project', 'alpha-123'])).toEqual({
      command: 'memory', action: 'rank', args: ['what', 'did', 'we', 'decide'], projectId: 'alpha-123',
    })
    expect(parseArgs(['memory', 'show', 'episode-123'])).toEqual({
      command: 'memory', action: 'show', args: ['episode-123'],
    })
    expect(parseArgs(['memory', 'rollup'])).toEqual({
      command: 'memory', action: 'rollup', args: [],
    })
    expect(parseArgs(['memory', 'rollup', 'quarter'])).toEqual({
      command: 'memory', action: 'rollup', args: ['quarter'],
    })
  })

  it('rejects invalid memory arguments and missing required values', () => {
    expect(parseArgs(['memory', 'search'])).toMatchObject({ command: 'error' })
    expect(parseArgs(['memory', 'rank'])).toMatchObject({ command: 'error' })
    expect(parseArgs(['memory', 'show'])).toMatchObject({ command: 'error' })
    expect(parseArgs(['memory', 'rebuild', '--unexpected'])).toMatchObject({ command: 'error' })
    expect(parseArgs(['memory', 'search', 'recent', '--project'])).toEqual({
      command: 'error', message: '--project requires a project ID',
    })
    expect(parseArgs(['memory', 'rollup', 'decade'])).toMatchObject({ command: 'error' })
    expect(parseArgs(['memory', 'rollup', 'day', 'week'])).toMatchObject({ command: 'error' })
    expect(parseArgs(['memory', 'rollup', '--project', 'alpha-123'])).toMatchObject({ command: 'error' })
  })
})

describe('parseArgs — voice', () => {
  it('parses microphone, keyboard, probe, auth, and quality model paths', () => {
    expect(parseArgs(['voice'])).toEqual({
      command: 'voice', action: 'start', model: 'gpt-realtime-2.1-mini', keyboard: false,
    })
    expect(parseArgs(['voice', '--keyboard'])).toMatchObject({ command: 'voice', keyboard: true })
    expect(parseArgs(['voice', 'probe', '--model', 'gpt-realtime-2.1'])).toEqual({
      command: 'voice', action: 'probe', model: 'gpt-realtime-2.1', keyboard: false,
    })
    expect(parseArgs(['voice', 'auth'])).toMatchObject({ command: 'voice', action: 'auth' })
  })

  it('rejects unknown voice models and flags', () => {
    expect(parseArgs(['voice', '--model', 'old-model'])).toMatchObject({ command: 'error' })
    expect(parseArgs(['voice', 'probe', '--keyboard'])).toMatchObject({ command: 'error' })
  })
})

describe('parseArgs - diagnostics', () => {
  it('parses text and JSON doctor output', () => {
    expect(parseArgs(['doctor'])).toEqual({ command: 'doctor', json: false })
    expect(parseArgs(['doctor', '--json'])).toEqual({ command: 'doctor', json: true })
    expect(parseArgs(['doctor', '--bad'])).toEqual({
      command: 'error',
      message: 'Unknown doctor argument: --bad',
    })
  })
})

describe('parseArgs - governed learning', () => {
  it('parses evaluation and explicit promotion approval', () => {
    expect(parseArgs(['learn', 'evaluate', 'candidate', 'suite.json'])).toEqual({
      command: 'learn',
      action: 'evaluate',
      args: ['candidate', 'suite.json'],
      approved: false,
    })
    expect(parseArgs(['learn', 'promote', 'candidate', '--approve'])).toEqual({
      command: 'learn',
      action: 'promote',
      args: ['candidate'],
      approved: true,
    })
    expect(parseArgs(['learn', 'promote', 'candidate', '--force'])).toMatchObject({
      command: 'error',
    })
  })
})

describe('parseArgs — managed plugins', () => {
  it('parses lifecycle commands and signature policy', () => {
    expect(parseArgs(['plugin'])).toEqual({
      command: 'plugin',
      action: 'list',
      args: [],
      requireSignature: false,
    })
    expect(parseArgs(['plugin', 'install', './bundle', '--require-signature'])).toEqual({
      command: 'plugin',
      action: 'install',
      args: ['./bundle'],
      requireSignature: true,
    })
    expect(parseArgs(['plugin', 'disable', 'acme'])).toEqual({
      command: 'plugin',
      action: 'disable',
      args: ['acme'],
      requireSignature: false,
    })
  })
})
