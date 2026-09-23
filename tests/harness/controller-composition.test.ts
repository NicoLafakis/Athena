import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HarnessSessionController,
  type HarnessSessionControllerOptions,
} from '../../src/harness/controller.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { MockAnthropicClient, textBlock } from '../helpers/mock-client.js'
import type { BrainPaths } from '../../src/brain/paths.js'
import type { Settings } from '../../src/brain/settings.js'
import type { PermissionRequest } from '../../src/engine/types.js'

// `athena voice` and the Ink TUI reach the harness through two different call shapes in
// src/cli.ts. They must still land on one session composition: the same permission gate,
// the same sandbox policy, and the same protected-paths fence. These tests pin that, so a
// future caller that re-forks the composition fails here rather than in production.

let root: string
let paths: BrainPaths
/** An extra fenced root inside the workspace: portable across win32, darwin, and linux. */
let fenced: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-composition-'))
  outside = mkdtempSync(join(tmpdir(), 'athena-outside-'))
  paths = resolveBrainPaths({ cwd: root, homeOverride: root })
  mkdirSync(paths.brainDir, { recursive: true })
  fenced = join(root, 'fake-os')
  mkdirSync(fenced, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function settingsFor(overrides: Partial<Settings> = {}): Settings {
  return {
    permissionMode: 'normal',
    sandboxMode: 'workspace-write',
    model: 'sonnet',
    effort: 'high',
    allow: ['Write(allowed/**)'],
    deny: ['Write(secret/**)'],
    protectedPaths: [fenced],
    accessibility: {
      presentation: 'standard',
      verbosity: 'balanced',
      progressAnnouncements: 'milestones',
      progressIntervalMs: 15_000,
      directSpeech: 'off',
    },
    hooks: [],
    mcpServers: {},
    jev: { enabled: true },
    vmp: { enabled: false },
    ...overrides,
  }
}

function baseOptions(settings: Settings): HarnessSessionControllerOptions {
  return {
    paths,
    effectivePaths: paths,
    cwd: root,
    provider: 'anthropic',
    client: new MockAnthropicClient([{ blocks: [textBlock('ok')], stopReason: 'end_turn' }]),
    settings,
    projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
  }
}

/** The option shape the `athena voice` branch of src/cli.ts builds. */
function voiceOptions(settings: Settings): HarnessSessionControllerOptions {
  return {
    ...baseOptions(settings),
    persistSession: true,
    askUser: async () => 'allow-once' as const,
    onAnnouncement: () => {},
  }
}

/** The option shape the interactive Ink TUI path of src/cli.ts builds. */
function tuiOptions(settings: Settings): HarnessSessionControllerOptions {
  return {
    ...baseOptions(settings),
    limits: undefined,
    outputSchema: null,
    persistSession: true,
    askUser: async () => 'allow-once' as const,
    onAnnouncement: () => {},
    onEnvelope: () => {},
  }
}

/** Every tier of the gate, in one list: fence, sandbox, deny rule, allow rule, mode. */
function probes(): PermissionRequest[] {
  return [
    {
      toolName: 'Write',
      input: { file_path: join(root, 'notes.txt') },
      readOnly: false,
      summary: 'write inside the workspace',
    },
    {
      toolName: 'Write',
      input: { file_path: join(fenced, 'x.txt') },
      readOnly: false,
      summary: 'write inside a protected root',
    },
    {
      toolName: 'Read',
      input: { file_path: join(fenced, 'x.txt') },
      readOnly: true,
      summary: 'read inside a protected root',
    },
    {
      toolName: 'Write',
      input: { file_path: join(outside, 'x.txt') },
      readOnly: false,
      summary: 'write outside the sandbox',
    },
    {
      toolName: 'Bash',
      input: { command: `rm -rf ${join(fenced, 'x.txt')}` },
      readOnly: false,
      summary: 'shell mutation aimed inside a protected root',
    },
    {
      toolName: 'Write',
      input: { file_path: join(root, 'secret', 'a.txt') },
      readOnly: false,
      summary: 'write matched by a deny rule',
    },
    {
      toolName: 'Write',
      input: { file_path: join(root, 'allowed', 'a.txt') },
      readOnly: false,
      summary: 'write matched by an allow rule',
    },
  ]
}

describe('one session composition for voice and the TUI', () => {
  it('produces the same gate, sandbox, and fence decisions from the same inputs', async () => {
    const settings = settingsFor()
    const voice = await HarnessSessionController.create(voiceOptions(settings))
    const tui = await HarnessSessionController.create(tuiOptions(settings))

    const voiceDecisions = probes().map((req) => voice.gate.check(req))
    const tuiDecisions = probes().map((req) => tui.gate.check(req))

    expect(tuiDecisions).toEqual(voiceDecisions)
    expect(voiceDecisions.map((decision) => decision.decision)).toEqual([
      'ask', // mutating tool, no rule matched, normal mode
      'deny', // protected root
      'allow', // reads fall through the fence
      'deny', // outside the workspace-write sandbox
      'deny', // shell mutation aimed inside the fence
      'deny', // deny rule
      'allow', // allow rule
    ])
    expect(voiceDecisions[1]?.reason).toContain('Protected system directory')
    expect(voiceDecisions[3]?.reason).toContain('sandbox')

    expect(tui.gate.getMode()).toBe(voice.gate.getMode())
    expect(tui.cwd).toBe(voice.cwd)
    expect(tui.provider).toBe(voice.provider)

    await voice.close()
    await tui.close()
  })

  it('keeps the fence above trusted mode and an unrestricted sandbox in both compositions', async () => {
    const settings = settingsFor({ permissionMode: 'trusted', sandboxMode: 'unrestricted' })
    const voice = await HarnessSessionController.create(voiceOptions(settings))
    const tui = await HarnessSessionController.create(tuiOptions(settings))

    const write: PermissionRequest = {
      toolName: 'Write',
      input: { file_path: join(fenced, 'x.txt') },
      readOnly: false,
      summary: 'write inside a protected root',
    }
    for (const controller of [voice, tui]) {
      expect(controller.gate.getMode()).toBe('trusted')
      const decision = controller.gate.check(write)
      expect(decision.decision).toBe('deny')
      expect(decision.reason).toContain('Protected system directory')
    }
    // An unfenced write is allowed outright in trusted mode: the fence is the only refusal.
    expect(voice.gate.check({
      toolName: 'Write',
      input: { file_path: join(root, 'notes.txt') },
      readOnly: false,
      summary: 'write inside the workspace',
    }).decision).toBe('allow')

    await voice.close()
    await tui.close()
  })

  it('resolves a caller-selected session at the resume seam and writes it back', async () => {
    const first = await HarnessSessionController.create(voiceOptions(settingsFor()))
    await first.submitTurn('remember this')
    await first.close()

    const selected = {
      id: first.session.id,
      file: first.session.file,
      messages: first.sessionStore.resume(first.session.id),
    }
    const resumed = await HarnessSessionController.create({
      ...tuiOptions(settingsFor()),
      selectSession: async () => selected,
    })

    expect(resumed.session.id).toBe(first.session.id)
    expect(resumed.initialMessages).toEqual(selected.messages)
    expect(resumed.initialMessages.length).toBeGreaterThan(0)
    expect(resumed.sessionPersisted).toBe(true)

    await resumed.close()
  })

  it('mints but never writes a session when the caller opts out (the exec default)', async () => {
    const ephemeral = await HarnessSessionController.create({
      ...baseOptions(settingsFor()),
      persistSession: false,
    })

    expect(ephemeral.sessionPersisted).toBe(false)
    await ephemeral.submitTurn('do work')
    await ephemeral.close()

    expect(existsSync(ephemeral.session.file)).toBe(false)
    expect(ephemeral.sessionStore.list()).toEqual([])
  })
})
