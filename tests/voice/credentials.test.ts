import { describe, expect, it, vi } from 'vitest'
import type { CredentialVault, CredentialVaultStatus } from '../../src/brain/credential-vault.js'
import {
  OPENAI_VOICE_VAULT_REF,
  ensureVoiceKey,
  resolveVoiceKey,
  saveVoiceKey,
} from '../../src/voice/credentials.js'

class FakeVault implements CredentialVault {
  readonly values = new Map<string, string>()
  failReadback = false
  private mismatches = 0
  statusValue: CredentialVaultStatus = {
    backend: 'windows-dpapi', available: true, detail: 'ok',
  }
  status(): CredentialVaultStatus { return this.statusValue }
  get(reference: string): string | null {
    if (this.mismatches > 0 && reference === OPENAI_VOICE_VAULT_REF) {
      this.mismatches--
      return 'mismatch'
    }
    return this.values.get(reference) ?? null
  }
  set(reference: string, value: string): void {
    this.values.set(reference, value)
    if (this.failReadback && value === 'new-key') this.mismatches = 1
  }
  delete(reference: string): void { this.values.delete(reference) }
}

describe('OpenAI voice credentials', () => {
  it('prefers the environment and otherwise resolves the per-machine vault entry', () => {
    const vault = new FakeVault()
    vault.values.set(OPENAI_VOICE_VAULT_REF, 'vault-key')
    expect(resolveVoiceKey({ OPENAI_API_KEY: 'env-key' }, vault)).toEqual({
      key: 'env-key', source: 'env',
    })
    expect(resolveVoiceKey({}, vault)).toEqual({ key: 'vault-key', source: 'vault' })
  })

  it('requires real vault availability and verifies saved secrets by readback', () => {
    const vault = new FakeVault()
    saveVoiceKey(vault, 'new-key')
    expect(vault.values.get(OPENAI_VOICE_VAULT_REF)).toBe('new-key')
    vault.statusValue = { backend: 'unavailable', available: false, detail: 'no backend' }
    expect(() => saveVoiceKey(vault, 'other')).toThrow(/OPENAI_API_KEY/)
  })

  it('attempts to restore the prior working secret when replacement verification fails', () => {
    const vault = new FakeVault()
    vault.values.set(OPENAI_VOICE_VAULT_REF, 'old-key')
    vault.failReadback = true
    expect(() => saveVoiceKey(vault, 'new-key')).toThrow(/not saved/)
    expect(vault.values.get(OPENAI_VOICE_VAULT_REF)).toBe('old-key')
  })

  describe('ensureVoiceKey inline setup', () => {
    it('returns env/vault keys without prompting or validating', async () => {
      const vault = new FakeVault()
      vault.values.set(OPENAI_VOICE_VAULT_REF, 'vault-key')
      const prompt = vi.fn(async () => 'unused')
      const validate = vi.fn(async () => {})
      await expect(ensureVoiceKey({ env: { OPENAI_API_KEY: 'env-key' }, vault, prompt, validate }))
        .resolves.toEqual({ key: 'env-key', source: 'env' })
      await expect(ensureVoiceKey({ env: {}, vault, prompt, validate }))
        .resolves.toEqual({ key: 'vault-key', source: 'vault' })
      expect(prompt).not.toHaveBeenCalled()
      expect(validate).not.toHaveBeenCalled()
    })

    it('pastes, validates, then saves in one step', async () => {
      const vault = new FakeVault()
      const order: string[] = []
      const resolved = await ensureVoiceKey({
        env: {},
        vault,
        prompt: async () => {
          order.push('prompt')
          return '  pasted-key  '
        },
        validate: async (key) => {
          order.push(`validate:${key}`)
        },
      })
      expect(resolved).toEqual({ key: 'pasted-key', source: 'prompt' })
      expect(order).toEqual(['prompt', 'validate:pasted-key'])
      expect(vault.values.get(OPENAI_VOICE_VAULT_REF)).toBe('pasted-key')
    })

    it('warns but keeps the working session key when the vault save fails', async () => {
      const vault = new FakeVault()
      vault.statusValue = { backend: 'unavailable', available: false, detail: 'no backend' }
      const warnings: string[] = []
      const resolved = await ensureVoiceKey({
        env: {},
        vault,
        prompt: async () => 'pasted-key',
        validate: async () => {},
        onWarn: (message) => warnings.push(message),
      })
      expect(resolved).toEqual({ key: 'pasted-key', source: 'prompt' })
      expect(warnings.some((message) => message.includes('session only'))).toBe(true)
    })

    it('returns null without a prompt seam and rejects an empty paste', async () => {
      await expect(ensureVoiceKey({ env: {}, validate: async () => {} })).resolves.toBeNull()
      const validate = vi.fn(async () => {})
      await expect(ensureVoiceKey({
        env: {},
        prompt: async () => '   ',
        validate,
      })).rejects.toThrow(/No OpenAI voice key entered/)
      expect(validate).not.toHaveBeenCalled()
    })

    it('propagates provider validation failure without saving anything', async () => {
      const vault = new FakeVault()
      await expect(ensureVoiceKey({
        env: {},
        vault,
        prompt: async () => 'bad-key',
        validate: async () => {
          throw new Error('provider rejected the key')
        },
      })).rejects.toThrow(/provider rejected the key/)
      expect(vault.values.get(OPENAI_VOICE_VAULT_REF)).toBeUndefined()
    })
  })
})
