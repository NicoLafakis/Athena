import type { CredentialVault } from '../brain/credential-vault.js'

export const OPENAI_VOICE_ENV = 'OPENAI_API_KEY'
export const OPENAI_VOICE_VAULT_REF = 'voice/openai'

export interface ResolvedVoiceKey {
  key: string
  source: 'env' | 'vault'
}

export function resolveVoiceKey(
  env: NodeJS.ProcessEnv = process.env,
  vault?: CredentialVault,
  onWarn?: (message: string) => void,
): ResolvedVoiceKey | null {
  const fromEnv = env[OPENAI_VOICE_ENV]
  if (fromEnv) return { key: fromEnv, source: 'env' }
  if (!vault) return null
  try {
    const status = vault.status()
    if (!status.available) {
      onWarn?.(
        `OpenAI voice credential is unavailable from ${status.backend}: ${status.detail}. ` +
        `Run \`athena voice auth\` or set ${OPENAI_VOICE_ENV}.`,
      )
      return null
    }
    const key = vault.get(OPENAI_VOICE_VAULT_REF)
    return key ? { key, source: 'vault' } : null
  } catch (error) {
    onWarn?.(
      `OpenAI voice credential could not be read from the OS credential vault: ` +
      `${(error as Error).message}. Run \`athena voice auth\` or set ${OPENAI_VOICE_ENV}.`,
    )
    return null
  }
}

/** Replace only after a validated key is known; restore the prior entry on failed readback. */
export function saveVoiceKey(vault: CredentialVault, key: string): void {
  const status = vault.status()
  if (!status.available) {
    throw new Error(
      `The ${status.backend} credential backend is unavailable: ${status.detail}. ` +
      `Set ${OPENAI_VOICE_ENV} instead.`,
    )
  }
  const prior = vault.get(OPENAI_VOICE_VAULT_REF)
  try {
    vault.set(OPENAI_VOICE_VAULT_REF, key)
    if (vault.get(OPENAI_VOICE_VAULT_REF) !== key) {
      throw new Error('credential readback did not match')
    }
  } catch (error) {
    try {
      if (prior === null) vault.delete(OPENAI_VOICE_VAULT_REF)
      else vault.set(OPENAI_VOICE_VAULT_REF, prior)
    } catch {
      // The original error is more actionable; the next auth run can recover the entry.
    }
    throw new Error(
      `OpenAI voice key was not saved to ${status.backend}: ${(error as Error).message}. ` +
      `Run \`athena voice auth\` to recover.`,
    )
  }
}
