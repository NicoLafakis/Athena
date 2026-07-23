import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { loadCredentials } from '../../src/brain/credentials.js'
import { runAuthWizard, type WizardIO } from '../../src/auth/wizard.js'
import type { ProviderId } from '../../src/brain/models.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-proj-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

function fakeIO(
  provider: ProviderId,
  keys: string[],
  said: string[],
  picks?: ProviderId[],
): WizardIO {
  let i = 0
  return {
    say: (m) => said.push(m),
    pickProvider: async () => {
      picks?.push(provider)
      return provider
    },
    readKey: async () => keys[i++] ?? '',
  }
}

describe('runAuthWizard', () => {
  it('saves the key, sets activeProvider, and returns provider+key on first valid entry', async () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const said: string[] = []
    const picks: ProviderId[] = []
    const result = await runAuthWizard({
      paths,
      io: fakeIO('kimi', ['sk-kimi-valid'], said, picks),
      validate: async () => null,
    })
    // Unscoped call (no `provider`): the wizard MUST run the provider pick.
    expect(picks).toEqual(['kimi'])
    expect(result).toEqual({ provider: 'kimi', key: 'sk-kimi-valid' })
    const creds = loadCredentials(paths)
    expect(creds.activeProvider).toBe('kimi')
    expect(creds.providers.kimi?.apiKey).toBe('sk-kimi-valid')
  })

  it('loops back on a rejected key, surfacing the provider error, then saves the good one', async () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const said: string[] = []
    const validated: string[] = []
    const result = await runAuthWizard({
      paths,
      provider: 'anthropic', // scoped: pickProvider must NOT be called
      io: {
        say: (m) => said.push(m),
        pickProvider: async () => {
          throw new Error('pickProvider must not be called when provider is scoped')
        },
        readKey: (() => {
          const keys = ['sk-bad', 'sk-good']
          let i = 0
          return async () => keys[i++] ?? ''
        })(),
      },
      validate: async (_p, key) => {
        validated.push(key)
        return key === 'sk-bad' ? 'invalid x-api-key' : null
      },
    })
    expect(validated).toEqual(['sk-bad', 'sk-good'])
    expect(result.key).toBe('sk-good')
    expect(said.join('\n')).toMatch(/invalid x-api-key/)
    expect(loadCredentials(paths).providers.anthropic?.apiKey).toBe('sk-good')
  })

  it('re-prompts on an empty key without calling validate', async () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const said: string[] = []
    const validated: string[] = []
    await runAuthWizard({
      paths,
      io: fakeIO('anthropic', ['', '  ', 'sk-ok'], said),
      validate: async (_p, key) => {
        validated.push(key)
        return null
      },
    })
    expect(validated).toEqual(['sk-ok'])
  })
})
