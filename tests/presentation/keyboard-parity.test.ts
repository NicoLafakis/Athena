import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  handleScreenReaderInterrupt,
  pickSessionLine,
  screenReaderCommandRoute,
} from '../../src/cli.js'
import type { SessionInfo } from '../../src/harness/sessions.js'
import type { LineInput } from '../../src/presentation/line-input.js'
import { BUILTIN_SLASH_COMMANDS } from '../../src/tui/slashMenu.js'
import { parseSlash } from '../../src/tui/slash.js'

const RouteSchema = z.enum([
  'shared-handler',
  'append-only-clear',
  'presentation-change',
  'exit',
])

const FixtureSchema = z.object({
  schemaVersion: z.literal(1),
  claim: z.string().includes('human assistive-technology validation remains open'),
  commands: z.array(z.object({
    name: z.string().min(1),
    invocation: z.string().startsWith('/'),
    route: RouteSchema,
  }).strict()),
  controls: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
  }).strict()),
}).strict()

function fixture() {
  const file = join(process.cwd(), 'tests', 'fixtures', 'interaction', 'presentation-parity.json')
  return FixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

class ScriptedInput implements LineInput {
  readonly prompts: string[] = []
  constructor(private readonly answers: string[]) {}
  async readLine(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    return this.answers.shift() ?? ''
  }
  close(): void {}
}

function session(id: string): SessionInfo {
  return {
    id,
    file: `${id}.jsonl`,
    startedAt: new Date('2026-07-29T12:00:00.000Z'),
    updatedAt: new Date('2026-07-29T12:30:00.000Z'),
    title: `Session ${id}`,
  }
}

describe('screen-reader presentation parity', () => {
  it('gives every visible built-in command an executable nonvisual route', () => {
    const matrix = fixture()
    expect(matrix.commands.map((entry) => entry.name).sort()).toEqual(
      BUILTIN_SLASH_COMMANDS.map((entry) => entry.name).sort(),
    )
    for (const entry of matrix.commands) {
      const parsed = parseSlash(entry.invocation)
      expect(parsed, entry.invocation).not.toBeNull()
      expect(parsed?.kind, entry.invocation).not.toBe('error')
      expect(screenReaderCommandRoute(parsed!), entry.invocation).toBe(entry.route)
    }
  })

  it('records prompt, permission, resume, and interruption controls without a visual-only path', () => {
    expect(fixture().controls.map((entry) => entry.id).sort()).toEqual([
      'custom-command',
      'interrupt-busy',
      'interrupt-idle',
      'interrupt-permission',
      'permission-allow-always',
      'permission-allow-once',
      'permission-deny',
      'session-resume',
      'submit-prompt',
    ])
  })
})

describe('screen-reader interruption and resume', () => {
  it('aborts active work, cancels a permission read, and acknowledges the interrupt', () => {
    const abort = vi.fn()
    const cancelInput = vi.fn(() => true)
    const acknowledge = vi.fn()
    const closeInput = vi.fn()
    expect(handleScreenReaderInterrupt(true, { abort, cancelInput, acknowledge, closeInput }))
      .toBe('turn-cancelled')
    expect(abort).toHaveBeenCalledOnce()
    expect(cancelInput).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledWith(true)
    expect(closeInput).not.toHaveBeenCalled()
  })

  it('closes idle line input cleanly instead of claiming an active cancellation', () => {
    const deps = {
      abort: vi.fn(),
      cancelInput: vi.fn(() => false),
      acknowledge: vi.fn(),
      closeInput: vi.fn(),
    }
    expect(handleScreenReaderInterrupt(false, deps)).toBe('session-exit')
    expect(deps.closeInput).toHaveBeenCalledOnce()
    expect(deps.abort).not.toHaveBeenCalled()
    expect(deps.acknowledge).not.toHaveBeenCalled()
  })

  it('selects a numbered session after an invalid choice and supports fresh-session cancel', async () => {
    const lines: string[] = []
    const input = new ScriptedInput(['9', '2'])
    await expect(pickSessionLine([session('one'), session('two')], input, (line) => lines.push(line)))
      .resolves.toMatchObject({ id: 'two' })
    expect(lines.join('\n')).toContain('Enter a number from 1 to 2')

    await expect(pickSessionLine([session('one')], new ScriptedInput(['']), () => {}))
      .resolves.toBeNull()
    await expect(pickSessionLine([], new ScriptedInput([]), () => {})).resolves.toBeNull()
  })
})
