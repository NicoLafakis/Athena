import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUnderTrustRoot } from '../../src/harness/trust.js'
import { loadSettings } from '../../src/brain/settings.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { parseArgs } from '../../src/cli/args.js'
import { runVoiceSession, type VoiceCommandInput, type VoiceRealtimeClient } from '../../src/voice/daemon.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-voice-switch-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('trustRoots standing grant', () => {
  it('matches canonical descendants with segment-boundary safety and rejects sibling prefix spoofing', () => {
    const trustedRoot = join(root, 'nico-apps')
    const childRepo = join(trustedRoot, 'Athena')
    const spoofedSibling = join(root, 'nico-apps-evil')
    mkdirSync(childRepo, { recursive: true })
    mkdirSync(spoofedSibling, { recursive: true })

    expect(isUnderTrustRoot(trustedRoot, [trustedRoot])).toBe(true)
    expect(isUnderTrustRoot(childRepo, [trustedRoot])).toBe(true)
    expect(isUnderTrustRoot(spoofedSibling, [trustedRoot])).toBe(false)
    expect(isUnderTrustRoot(childRepo, [])).toBe(false)
  })

  it('keeps trustRoots global-only so project settings cannot widen it', () => {
    const home = join(root, 'home')
    const proj = join(root, 'proj')
    mkdirSync(join(proj, '.athena'), { recursive: true })
    const paths = resolveBrainPaths({ cwd: proj, homeOverride: home })
    const warnings: string[] = []
    const settings = loadSettings(paths, 'anthropic', (w) => warnings.push(w), { projectTrusted: true })
    expect(settings.trustRoots ?? []).toEqual([])
  })
})

describe('voice switch_project local_control and --tui CLI flag', () => {
  it('parses athena voice --tui flag cleanly', () => {
    const parsed = parseArgs(['voice', '--tui'])
    expect(parsed).toMatchObject({ command: 'voice', action: 'start', tui: true })
  })

  it('handles local_control switch_project by invoking host switchProject callback and returning spoken confirmation', async () => {
    const targetDir = join(root, 'other-project')
    mkdirSync(targetDir, { recursive: true })
    const switchedTo: string[] = []
    let toolOutput: unknown

    const client: VoiceRealtimeClient = {
      async connect() {},
      close() {},
      async ask(_text, handler) {
        toolOutput = await handler({
          callId: 'call-switch-1',
          name: 'local_control',
          arguments: { action: 'switch_project', path: targetDir },
        })
        return { text: 'Switched to other-project.', transcript: '', audio: Buffer.alloc(0), usage: undefined }
      },
      async askAudio() {
        return { text: '', transcript: '', audio: Buffer.alloc(0), usage: undefined }
      },
    }

    let step = 0
    const input: VoiceCommandInput = {
      async next() {
        step++
        if (step === 1) return { kind: 'text', text: `switch to ${targetDir}` }
        return null
      },
      close() {},
    }

    await runVoiceSession({
      apiKey: 'test-key',
      model: 'gpt-realtime-2.1-mini',
      client,
      input,
      maxCommands: 1,
      switchProject: async (requestedPath) => {
        switchedTo.push(requestedPath)
        return { ok: true, cwd: requestedPath, projectName: 'other-project' }
      },
    })

    expect(switchedTo).toEqual([targetDir])
    expect(toolOutput).toMatchObject({
      status: 'switched',
      cwd: targetDir,
      project_name: 'other-project',
    })
  })
})
