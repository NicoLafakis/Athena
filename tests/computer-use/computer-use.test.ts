import { describe, expect, it } from 'vitest'
import {
  evaluateComputerUsePolicy,
  normalizeCuaKey,
  probeComputerUseBackend,
  runComputerUseLoop,
  type ComputerBackend,
  type ComputerUseResponse,
  type ComputerUseResponsesClient,
} from '../../src/computer-use/index.js'

describe('computer-use hard deny-list and scope policy', () => {
  it('blocks vault, password managers, banking, UAC/Defender, CAPTCHAs, and full-desktop without opt-in', () => {
    const blockedCases = [
      { objective: 'Open ~/.athena/credentials.json and copy the key', expectedRule: 'credentials-vault' },
      { objective: 'Log into 1Password and export vault', expectedRule: 'password-manager' },
      { objective: 'Confirm purchase and submit payment on checkout page', expectedRule: 'financial' },
      { objective: 'Click Yes on Windows Defender User Account Control dialog', expectedRule: 'os-security' },
      { objective: 'Solve the reCAPTCHA to continue', expectedRule: 'captcha' },
      { objective: 'Send email to the client from Gmail', expectedRule: 'messaging' },
      { objective: 'Run git push --force in the GUI terminal', expectedRule: 'cli-laundering' },
    ]
    for (const c of blockedCases) {
      const verdict = evaluateComputerUsePolicy({
        objective: c.objective,
        targetSurface: 'browser',
        allowFullDesktop: false,
      })
      expect(verdict.allowed, c.objective).toBe(false)
      if (!verdict.allowed) expect(verdict.rule).toBe(c.expectedRule)
    }

    // Full-desktop requires explicit opt-in.
    const desktopDenied = evaluateComputerUsePolicy({
      objective: 'Click the Export CSV button in the report window',
      targetSurface: 'desktop',
      allowFullDesktop: false,
    })
    expect(desktopDenied.allowed).toBe(false)

    // Safe bounded browser task is allowed.
    const allowed = evaluateComputerUsePolicy({
      objective: 'Read the status badge on the local dashboard window',
      targetSurface: 'browser',
      allowFullDesktop: false,
      windowTitle: 'Dashboard - Chromium',
    })
    expect(allowed).toEqual({ allowed: true })
  })

  it('normalizes OpenAI CUA modifier and navigation keys for Windows', () => {
    expect(normalizeCuaKey('CTRL')).toBe('^')
    expect(normalizeCuaKey('ALT')).toBe('%')
    expect(normalizeCuaKey('SHIFT')).toBe('+')
    expect(normalizeCuaKey('ARROWLEFT')).toBe('{LEFT}')
    expect(normalizeCuaKey('ENTER')).toBe('{ENTER}')
    expect(normalizeCuaKey('a')).toBe('a')
  })
})

describe('runComputerUseLoop', () => {
  it('threads previous_response_id, executes batched actions, records SHA-256 digests only, and completes', async () => {
    const executed: string[] = []
    const seenPrevIds: Array<string | undefined> = []
    const backend: ComputerBackend = {
      async captureScreenshot() {
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      },
      async executeAction(action) {
        executed.push(action.type)
      },
      async getActiveWindowTitle() {
        return 'Local Preview - Browser'
      },
    }

    let step = 0
    const client: ComputerUseResponsesClient = {
      async create(req) {
        seenPrevIds.push(req.previousResponseId)
        step++
        if (step === 1) {
          return {
            id: 'resp-1',
            computerCalls: [
              {
                callId: 'call-1',
                actions: [
                  { type: 'move', x: 100, y: 200 },
                  { type: 'click', x: 100, y: 200, button: 'left' },
                ],
              },
            ],
            outputText: '',
            usage: { inputTokens: 1200, outputTokens: 80 },
          } satisfies ComputerUseResponse
        }
        return {
          id: 'resp-2',
          computerCalls: [],
          outputText: 'Export button clicked and status shows Ready.',
          usage: { inputTokens: 1400, outputTokens: 40 },
        } satisfies ComputerUseResponse
      },
    }

    const result = await runComputerUseLoop({
      objective: 'Click Export in the preview window and verify status.',
      targetSurface: 'browser',
      allowFullDesktop: false,
      maxSteps: 5,
      maxTotalTokens: 50_000,
      client,
      backend,
    })

    expect(result.status).toBe('completed')
    expect(executed).toEqual(['move', 'click'])
    expect(seenPrevIds).toEqual([undefined, 'resp-1'])
    expect(result.telemetry.steps).toBe(1)
    expect(result.telemetry.inputTokens).toBe(2600)
    expect(result.telemetry.outputTokens).toBe(120)
    expect(result.telemetry.screenshotDigests).toHaveLength(1)
    expect(result.telemetry.screenshotDigests[0]).toMatch(/^[a-f0-9]{64}$/)
  })

  it('halts immediately when window switches to a denied surface, step ceiling is hit, or AbortSignal fires', async () => {
    const backend: ComputerBackend = {
      async captureScreenshot() {
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])
      },
      async executeAction() {},
      async getActiveWindowTitle() {
        return '1Password — Vault Locked'
      },
    }
    const client: ComputerUseResponsesClient = {
      async create() {
        return {
          id: 'resp-1',
          computerCalls: [{ callId: 'call-1', actions: [{ type: 'screenshot' }] }],
          outputText: '',
          usage: { inputTokens: 500, outputTokens: 20 },
        }
      },
    }

    const denied = await runComputerUseLoop({
      objective: 'Check dashboard status',
      targetSurface: 'browser',
      allowFullDesktop: false,
      client,
      backend,
    })
    expect(denied.status).toBe('denied')

    // AbortSignal kill switch
    const ac = new AbortController()
    ac.abort()
    const aborted = await runComputerUseLoop({
      objective: 'Check dashboard status',
      targetSurface: 'browser',
      allowFullDesktop: false,
      client,
      backend: { ...backend, async getActiveWindowTitle() { return 'Dashboard' } },
      signal: ac.signal,
    })
    expect(aborted.status).toBe('aborted')

    // Step ceiling
    const limited = await runComputerUseLoop({
      objective: 'Check dashboard status',
      targetSurface: 'browser',
      allowFullDesktop: false,
      maxSteps: 1,
      client,
      backend: { ...backend, async getActiveWindowTitle() { return 'Dashboard' } },
    })
    expect(limited.status).toBe('limit-reached')
  })
})

describe('Windows computer-use capability probe', () => {
  it.runIf(process.platform === 'win32')(
    'round-trips a real PNG sentinel through PowerShell System.Drawing without inferring support',
    () => {
      const probe = probeComputerUseBackend('win32', { skipCache: true })
      expect(probe.backend).toBe('windows-forms-sendinput')
      expect(typeof probe.available).toBe('boolean')
      expect(probe.detail.length).toBeGreaterThan(0)
      expect(probe.recoveryCommand.length).toBeGreaterThan(0)
    },
  )

  it('reports unavailable cleanly on unsupported platforms without throwing', () => {
    const probe = probeComputerUseBackend('linux', { skipCache: true })
    expect(probe.available).toBe(false)
    expect(probe.detail).toMatch(/windows/i)
  })
})
