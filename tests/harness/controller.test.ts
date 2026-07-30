import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessSessionController } from '../../src/harness/controller.js'
import { MockAnthropicClient, textBlock } from '../helpers/mock-client.js'
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

    await controller.close()
  })
})
