import { describe, expect, it } from 'vitest'
import type { CredentialVault, CredentialVaultStatus } from '../../src/brain/credential-vault.js'
import {
  OPENAI_VOICE_VAULT_REF,
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
})
