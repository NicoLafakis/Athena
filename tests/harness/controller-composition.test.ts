import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HarnessSessionController,
  type HarnessSessionControllerOptions,
} from '../../src/harness/controller.js'
import { projectId } from '../../src/harness/trust.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { ExperienceStore } from '../../src/experience/index.js'
import { backgroundTasks } from '../../src/tools/index.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'
import type { BrainPaths } from '../../src/brain/paths.js'
import type { Settings } from '../../src/brain/settings.js'
import type { PermissionRequest } from '../../src/engine/types.js'
import type { InteractionEventEnvelope } from '../../src/interaction/index.js'
import { prepareSessionEnvironment } from '../../src/cli/session-bootstrap.js'

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

  it('records user objective on submitTurn and triggers guidanceForRepeatedFailure', async () => {
    const expStore = new ExperienceStore(join(paths.brainDir, 'experience'))
    const now = new Date().toISOString()
    expStore.appendExperience({
      schemaVersion: 1,
      id: 'exp-read-retry-1',
      projectScope: projectId(root),
      situation: 'read missing config file in workspace',
      actions: ['Read failed.'],
      outcome: 'failed',
      evidenceRefs: ['trace:00000000-0000-4000-8000-000000000001:' + 'a'.repeat(64)],
      tags: ['read', 'failed'],
      createdAt: now,
    })
    expStore.appendGuidance({
      schemaVersion: 1,
      id: 'guide-read-retry-1',
      experienceIds: ['exp-read-retry-1'],
      signal: 'avoid',
      text: 'Verify the path exists with Glob before retrying Read.',
      status: 'active',
      confidence: 0.9,
      reviewedAt: now,
    })

    const envelopes: InteractionEventEnvelope[] = []
    const client = new MockAnthropicClient([
      {
        blocks: [toolUseBlock('r1', 'Read', { file_path: 'does-not-exist.txt' })],
        stopReason: 'tool_use',
      },
      {
        blocks: [toolUseBlock('r2', 'Read', { file_path: 'does-not-exist.txt' })],
        stopReason: 'tool_use',
      },
      { blocks: [textBlock('stopped retrying')], stopReason: 'end_turn' },
    ])
    const controller = await HarnessSessionController.create({
      ...voiceOptions(settingsFor()),
      client,
      onEnvelope: (e) => envelopes.push(e),
    })

    await controller.submitTurn('read missing config file in workspace')

    expect(controller.interactionService.snapshot(controller.trace.runId)?.objective.value).toBe(
      'read missing config file in workspace',
    )
    expect(envelopes.some((e) => e.kind === 'guidance-qualified')).toBe(true)
    // §2.2: The next model call (call 2, after 2 identical failures) receives the bounded
    // <experience-guidance> hint ephemerally without persisting it to history or session.
    expect(JSON.stringify(client.calls[1])).not.toContain('<experience-guidance')
    expect(JSON.stringify(client.calls[2])).toContain('<experience-guidance')
    expect(JSON.stringify(client.calls[2])).toContain(
      'Verify the path exists with Glob before retrying Read.',
    )
    expect(JSON.stringify(controller.engine.getMessages())).not.toContain('<experience-guidance')

    // §2.3: Opt-in watch observation seam feeds InteractionEventAdapter as a polite attention envelope.
    controller.recordWatchObservation({
      schemaVersion: 1,
      watchId: 'watch:demo',
      kind: 'changed',
      summary: 'Filesystem resource changed.',
      observedAt: new Date().toISOString(),
    })
    expect(
      envelopes.some(
        (e) =>
          e.kind === 'attention-added' &&
          'attention' in e.payload &&
          e.payload.attention.id === 'watch:watch:demo',
      ),
    ).toBe(true)

    await controller.close()
  })

  it('tears down background tasks, interaction, session, MCP, trace, and experience in order on close()', async () => {
    const controller = await HarnessSessionController.create(voiceOptions(settingsFor()))
    await controller.submitTurn('complete work and capture experience')

    const order: string[] = []
    let killedBg = false
    const fakeTaskId = 'bg-task-close-test'
    backgroundTasks.set(fakeTaskId, {
      id: fakeTaskId,
      owner: controller.trace.runId,
      command: 'sleep 60',
      status: 'running',
      output: '',
      child: {
        kill: () => {
          killedBg = true
          order.push('bg')
          return true
        },
      } as never,
    })

    const detachSpy = vi.spyOn(controller.interaction, 'detach').mockImplementation(() => {
      order.push('detach')
    })
    const endSpy = vi.spyOn(controller, 'endSession').mockImplementation(async () => {
      order.push('endSession')
    })
    const mcpSpy = vi.spyOn(controller.mcp, 'closeAll').mockImplementation(async () => {
      order.push('mcp')
    })
    const traceSpy = vi.spyOn(controller.trace, 'close').mockImplementation(async (res) => {
      order.push('trace')
      await Object.getPrototypeOf(controller.trace).close.call(controller.trace, res)
    })

    await controller.close({
      reason: 'shutdown',
      beforeTraceClose: () => {
        order.push('beforeTraceClose')
      },
    })
    // Idempotent second close must not re-run teardown steps.
    await controller.close('shutdown')

    expect(killedBg).toBe(true)
    expect(backgroundTasks.has(fakeTaskId)).toBe(false)
    expect(detachSpy).toHaveBeenCalledTimes(1)
    expect(endSpy).toHaveBeenCalledTimes(1)
    expect(mcpSpy).toHaveBeenCalledTimes(1)
    expect(traceSpy).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['bg', 'detach', 'endSession', 'mcp', 'beforeTraceClose', 'trace'])
    expect(controller.experienceStore.listExperiences().length).toBeGreaterThan(0)
  })

  it('shares the in-flight teardown promise across concurrent close() callers', async () => {
    const controller = await HarnessSessionController.create(voiceOptions(settingsFor()))
    let releaseMcp!: () => void
    const mcpGate = new Promise<void>((resolve) => {
      releaseMcp = resolve
    })
    let mcpClosed = false
    vi.spyOn(controller.mcp, 'closeAll').mockImplementation(async () => {
      await mcpGate
      mcpClosed = true
    })

    const first = controller.close('shutdown')
    let secondResolved = false
    const second = controller.close('crash').then(() => {
      secondResolved = true
    })

    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(secondResolved).toBe(false)
    releaseMcp()
    await Promise.all([first, second])
    expect(mcpClosed).toBe(true)
    expect(secondResolved).toBe(true)
  })

  it('prepareSessionEnvironment loads plugin extensions and enforces untrusted effectivePaths', async () => {
    const projectBrain = join(root, '.athena')
    mkdirSync(projectBrain, { recursive: true })
    const pathsWithProject = resolveBrainPaths({ cwd: root, homeOverride: root })
    const pluginDir = join(pathsWithProject.pluginsDir, 'sample-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'sample-plugin',
        version: '1.0.0',
        contributes: { hooks: 'hooks.json', mcp: 'mcp.json' },
      }),
    )
    writeFileSync(
      join(pluginDir, 'hooks.json'),
      JSON.stringify([{ event: 'SessionStart', command: 'echo hi' }]),
    )
    writeFileSync(
      join(pluginDir, 'mcp.json'),
      JSON.stringify({ demo: { command: 'node', args: ['-e', 'process.exit(0)'] } }),
    )
    const warnings: string[] = []
    const env = await prepareSessionEnvironment({
      paths: pathsWithProject,
      cwd: root,
      provider: 'anthropic',
      interactiveTrust: false,
      applyTrust: false,
      warn: (msg) => warnings.push(msg),
    })

    expect(env.projectTrust.trusted).toBe(false)
    expect(env.effectivePaths.projectBrainDir).toBeNull()
    expect(env.settings.hooks.some((h) => h.event === 'SessionStart')).toBe(true)
    expect(env.settings.mcpServers['sample-plugin:demo']).toBeDefined()
  })

  it('rolls sub-agent token usage into the parent RunBudget and trips parent limit', async () => {
    const agentsDir = join(paths.brainDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'worker.md'),
      '---\nname: worker\ndescription: worker\ntools: Read\n---\nWork concisely.\n',
    )
    const client = new MockAnthropicClient([
      {
        blocks: [toolUseBlock('a1', 'Agent', { agent: 'worker', prompt: 'run' })],
        stopReason: 'tool_use',
        inputTokens: 1_000,
        outputTokens: 500,
      },
      {
        blocks: [textBlock('child reply')],
        stopReason: 'end_turn',
        inputTokens: 8_000,
        outputTokens: 2_000,
      },
      {
        blocks: [textBlock('should not run after parent limit trips')],
        stopReason: 'end_turn',
      },
    ])
    const events: string[] = []
    const controller = await HarnessSessionController.create({
      ...voiceOptions(settingsFor({ permissionMode: 'trusted' })),
      client,
      limits: { maxTokens: 10_000 },
    })
    controller.bus.on((e) => {
      if (e.type === 'run-limit') events.push(e.limit)
    })

    const runResult = await controller.runTurn('delegate work')

    expect(runResult.status).toBe('limit')
    expect(runResult.reason).toBe('maxTokens')
    expect(events).toContain('maxTokens')
    expect(runResult.usage.inputTokens).toBe(9_000)
    expect(runResult.usage.outputTokens).toBe(2_500)
    expect(client.calls).toHaveLength(2)

    await controller.close()
  })

  it('skips remaining tools in a sequential batch once a child exhausts the parent RunBudget', async () => {
    const agentsDir = join(paths.brainDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'worker.md'),
      '---\nname: worker\ndescription: worker\ntools: Read\n---\nWork concisely.\n',
    )
    const shouldNotExist = join(root, 'after-limit.txt')
    const client = new MockAnthropicClient([
      {
        blocks: [
          toolUseBlock('a1', 'Agent', { agent: 'worker', prompt: 'run' }),
          toolUseBlock('w1', 'Write', { file_path: shouldNotExist, content: 'blocked' }),
        ],
        stopReason: 'tool_use',
        inputTokens: 1_000,
        outputTokens: 500,
      },
      {
        blocks: [textBlock('child reply')],
        stopReason: 'end_turn',
        inputTokens: 8_000,
        outputTokens: 2_000,
      },
    ])
    const controller = await HarnessSessionController.create({
      ...voiceOptions(settingsFor({ permissionMode: 'trusted' })),
      client,
      limits: { maxTokens: 10_000 },
    })

    const runResult = await controller.runTurn('delegate then write')

    expect(runResult.status).toBe('limit')
    expect(runResult.reason).toBe('maxTokens')
    expect(existsSync(shouldNotExist)).toBe(false)
    expect(JSON.stringify(controller.engine.getMessages())).toContain(
      'Tool not executed: run limit reached (maxTokens)',
    )

    await controller.close()
  })
})
