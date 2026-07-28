// tests/cli/provider-vault-warn.test.ts — the /provider slash command resolves a key the
// same way boot does, so it must also carry boot's warning sink. Without one, an
// unreadable vault entry (a DPAPI blob encrypted on another machine) is silently swallowed
// and the user is told the provider is "not configured" — sending them to add a key they
// already have instead of re-running `athena auth` on this machine.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSlashHandler } from '../../src/cli.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { saveCredentials, CredentialsSchema } from '../../src/brain/credentials.js'
import {
  vaultUndecryptableError,
  type CredentialVault,
} from '../../src/brain/credential-vault.js'

let home: string
let project: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-slash-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-slash-proj-'))
  // Env vars win over the vault in resolveApiKey; the vault path is what is under test.
  for (const key of ['ANTHROPIC_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_CODE_API_KEY']) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Only the fields the `/provider` branch reaches before it gives up on a missing key. */
function makeHandler(vault: CredentialVault): { run: (value: string) => void; messages: string[] } {
  const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
  saveCredentials(
    paths,
    CredentialsSchema.parse({
      providers: { kimi: { vaultRef: 'provider/kimi' } },
      activeProvider: 'anthropic',
    }),
  )
  const bus = new EngineEventBus()
  const messages: string[] = []
  bus.on((event) => {
    if (event.type === 'info') messages.push(event.message)
  })
  const handler = makeSlashHandler({
    bus,
    engine: { getProvider: () => 'anthropic' },
    paths,
    credentialVault: vault,
  } as unknown as Parameters<typeof makeSlashHandler>[0])
  return { run: (value) => handler({ kind: 'provider', value } as never), messages }
}

const undecryptableVault: CredentialVault = {
  status: () => ({ backend: 'windows-dpapi', available: true, detail: 'available' }),
  get: (reference) => {
    throw vaultUndecryptableError(reference, 'Key not valid for use in specified state.')
  },
  set: () => {},
  delete: () => {},
}

describe('/provider — credential vault warnings', () => {
  it('surfaces the undecryptable-vault guidance instead of "not configured"', () => {
    const { run, messages } = makeHandler(undecryptableVault)
    run('kimi')
    const joined = messages.join('\n')
    expect(joined).toContain('could not decrypt the stored secret for provider/kimi')
    expect(joined).toContain('encrypted on a different machine')
    expect(joined).toContain('athena auth')
    // The generic line would contradict the warning by implying no key exists at all.
    expect(joined).not.toContain('No API key configured')
  })

  it('still reports "not configured" when the vault genuinely has no entry', () => {
    const emptyVault: CredentialVault = {
      status: () => ({ backend: 'windows-dpapi', available: true, detail: 'available' }),
      get: () => null,
      set: () => {},
      delete: () => {},
    }
    const { run, messages } = makeHandler(emptyVault)
    run('kimi')
    expect(messages.join('\n')).toContain('No API key configured')
  })
})
