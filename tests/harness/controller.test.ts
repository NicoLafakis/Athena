import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessSessionController } from '../../src/harness/controller.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'
import type { Settings } from '../../src/brain/settings.js'
import type { BrainPaths } from '../../src/brain/paths.js'

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
