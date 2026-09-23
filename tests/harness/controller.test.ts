import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessSessionController } from '../../src/harness/controller.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'
import type { Settings } from '../../src/brain/settings.js'
import type { BrainPaths } from '../../src/brain/paths.js'
import { MemoryHygieneStore } from '../../src/brain/hygiene.js'
import { readSessionLineRecords, sessionLineDigest } from '../../src/harness/sessions.js'
import type { RecallIntentRouter } from '../../src/decision/jev.js'

import { resolveBrainPaths } from '../../src/brain/paths.js'

let root: string
let paths: BrainPaths

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-controller-test-'))
  paths = resolveBrainPaths({ cwd: root, homeOverride: root })
  mkdirSync(paths.brainDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const defaultSettings: Settings = {
  permissionMode: 'normal',
  sandboxMode: 'workspace-write',
  model: 'sonnet',
  effort: 'high',
  allow: [],
  deny: [],
  protectedPaths: [],
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
}

describe('HarnessSessionController', () => {
  it('creates a harness session controller and submits a turn', async () => {
    const client = new MockAnthropicClient([
      { blocks: [textBlock('Hello from Athena harness!')], stopReason: 'end_turn' },
    ])

    const controller = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd: root,
      provider: 'anthropic',
      client,
      settings: defaultSettings,
      projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
    })

    expect(controller.session.id).toBeDefined()
    const result = await controller.submitTurn('Hello Athena')

    expect(result.status).toBe('completed')
    expect(result.output).toBe('Hello from Athena harness!')
    expect(result.sessionId).toBe(controller.session.id)
    expect(controller.continuityStore.status().state).toBe('partial')
    expect(controller.continuityStore.listEpisodes()[0]!.summary).toContain('Hello Athena')

    await controller.close()
  })

  it('submits multiple turns in the same session', async () => {
    const client = new MockAnthropicClient([
      { blocks: [textBlock('Response 1')], stopReason: 'end_turn' },
      { blocks: [textBlock('Response 2')], stopReason: 'end_turn' },
    ])

    const controller = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd: root,
      provider: 'anthropic',
      client,
      settings: defaultSettings,
      projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
    })

    const initialSessionId = controller.session.id

    const res1 = await controller.submitTurn('Turn 1')
    expect(res1.output).toBe('Response 1')
    expect(res1.sessionId).toBe(initialSessionId)

    const res2 = await controller.submitTurn('Turn 2')
    expect(res2.output).toBe('Response 2')
    expect(res2.sessionId).toBe(initialSessionId)
    expect(controller.continuityStore.listEpisodes()).toHaveLength(2)

    await controller.close()
  })

  it('persists a source-digested Jev speech-act event and indexes it in continuity', async () => {
    const client = new MockAnthropicClient([
      { blocks: [textBlock('I will use concise paragraphs by default.')], stopReason: 'end_turn' },
    ])
    const recallRouter: RecallIntentRouter = {
      configured: true,
      classify: async () => ({
        status: 'decision',
        value: {
          route: 'none',
          confidence: 0.98,
          probabilities: {
            none: 0.98, 'continue-current': 0.003, 'temporal-recall': 0.003, 'topic-recall': 0.003,
            'preference-or-fact': 0.003, 'historical-decision': 0.003, 'similar-work': 0.003,
          },
          speechAct: {
            act: 'preferred', confidence: 0.96,
            probabilities: { none: 0.005, asked: 0.005, stated: 0.005, considered: 0.005, preferred: 0.96, decided: 0.005, promised: 0.005, corrected: 0.005, retracted: 0.005 },
          },
        },
      }),
    }
    const controller = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd: root,
      provider: 'anthropic',
      client,
      settings: defaultSettings,
      projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
      recallRouter,
    })

    await controller.submitTurn('I would like concise paragraphs as my default.')

    const records = readSessionLineRecords(controller.session.file)
    const sourceMessage = records.find((record) =>
      record.line.kind === 'message' &&
      (record.line.data as { role?: string; content?: string }).role === 'user',
    )!
    const classification = records.find((record) =>
      record.line.kind === 'event' &&
      (record.line.data as { type?: string }).type === 'jev-speech-act-classification',
    )
    expect(classification?.line.data).toMatchObject({
      type: 'jev-speech-act-classification',
      model: 'jev-1.13.0',
      speechAct: 'preferred',
      confidence: 0.96,
      sourceRef: {
        kind: 'session-message',
        projectId: controller.sessionStore.projectId,
        sessionId: controller.session.id,
        recordId: sourceMessage.line.id,
        lineDigest: sessionLineDigest(sourceMessage),
      },
    })
    expect(controller.continuityStore.listEpisodes()[0]?.speechActs).toContain('preferred')

    await controller.close()
  })

  it('does not persist continuity data for sessions explicitly marked non-persistent', async () => {
    const client = new MockAnthropicClient([
      { blocks: [textBlock('ephemeral response')], stopReason: 'end_turn' },
    ])
    const controller = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd: root,
      provider: 'anthropic',
      client,
      settings: defaultSettings,
      projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
      persistSession: false,
    })

    await controller.submitTurn('Do not store this conversation.')
    expect(controller.continuityStore.status().state).toBe('missing')
    await controller.close()
  })

  it('links explicit semantic memory to the persisted user prompt through the real harness tool path', async () => {
    const client = new MockAnthropicClient([
      {
        blocks: [
          toolUseBlock('remember-1', 'Memory', {
            op: 'remember',
            description: 'Continuity preference',
            content: 'I prefer linked episodes across projects.',
            speechAct: 'preferred',
            scope: 'global',
            sensitivity: 'ordinary',
          }),
        ],
        stopReason: 'tool_use',
      },
      { blocks: [textBlock('I will remember that preference.')], stopReason: 'end_turn' },
    ])
    const controller = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd: root,
      provider: 'anthropic',
      client,
      settings: defaultSettings,
      projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
      persistSession: true,
      askUser: async () => 'allow-once',
    })

    const result = await controller.submitTurn('Please remember that I prefer linked episodes across projects.')
    const memory = new MemoryHygieneStore(paths.memoryDir).listActive()[0]
    const sourceMessage = readSessionLineRecords(controller.session.file).find(
      (record) => record.line.id === memory?.sourceRefs[0]?.recordId,
    )

    expect(result.status).toBe('completed')
    expect(memory?.content).toBe('I prefer linked episodes across projects.')
    expect(memory?.sourceRefs[0]).toMatchObject({
      kind: 'session-message',
      projectId: controller.sessionStore.projectId,
      sessionId: controller.session.id,
    })
    expect((sourceMessage?.line.data as { content?: string }).content).toContain('Please remember')
    await controller.close()
  })

  it('routes an ask decision to a wired approver, and an allow actually runs the tool', async () => {
    const client = new MockAnthropicClient([
      {
        blocks: [toolUseBlock('write-1', 'Write', { file_path: 'approved.txt', content: 'ok' })],
        stopReason: 'tool_use',
      },
      { blocks: [textBlock('wrote it')], stopReason: 'end_turn' },
    ])
    const asked: Array<{ id: string; toolName: string }> = []
    const askUser = vi.fn(async (request: { id: string; toolName: string }) => {
      asked.push({ id: request.id, toolName: request.toolName })
      return 'allow-once' as const
    })

    const controller = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd: root,
      provider: 'anthropic',
      client,
      settings: defaultSettings,
      projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
      askUser,
    })
    const result = await controller.submitTurn('write the file')

    expect(askUser).toHaveBeenCalledOnce()
    // The stable request identity the voice/keyboard answer has to match.
    expect(asked).toEqual([{ id: 'permission:write-1', toolName: 'Write' }])
    expect(result.status).toBe('completed')
    expect(existsSync(join(root, 'approved.txt'))).toBe(true)

    await controller.close()
  })

  it('keeps the headless auto-deny when no approver is wired (the athena exec contract)', async () => {
    const client = new MockAnthropicClient([
      {
        blocks: [toolUseBlock('write-2', 'Write', { file_path: 'denied.txt', content: 'no' })],
        stopReason: 'tool_use',
      },
      { blocks: [textBlock('could not write')], stopReason: 'end_turn' },
    ])

    const controller = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd: root,
      provider: 'anthropic',
      client,
      settings: defaultSettings,
      projectTrust: { trusted: true, allowProjectHooks: true, allowProjectMcp: true },
    })
    await controller.submitTurn('write the file')

    expect(existsSync(join(root, 'denied.txt'))).toBe(false)
    expect(JSON.stringify(client.calls.at(-1))).toContain('no approver wired')

    await controller.close()
  })
})
