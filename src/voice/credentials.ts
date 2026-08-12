import type { CredentialVault } from '../brain/credential-vault.js'

export const OPENAI_VOICE_ENV = 'OPENAI_API_KEY'
export const OPENAI_VOICE_VAULT_REF = 'voice/openai'

export interface ResolvedVoiceKey {
  key: string
  source: 'env' | 'vault' | 'prompt'
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

export interface EnsureVoiceKeyOptions {
  env?: NodeJS.ProcessEnv
  vault?: CredentialVault
  /** Visible paste prompt, invoked at most once and only when env/vault miss. */
  prompt?: () => Promise<string>
  /** Round-trip the pasted key against the provider before saving; throws on rejection. */
  validate: (key: string) => Promise<void>
  onWarn?: (message: string) => void
}

/**
 * Resolve the voice key, and if nothing is configured, ask once and set it up inline:
 * paste -> validate -> best-effort vault save. A failed save only warns (the vault is
 * hardening, not a boot precondition); the validated key still drives the session.
 */
export async function ensureVoiceKey(options: EnsureVoiceKeyOptions): Promise<ResolvedVoiceKey | null> {
  const existing = resolveVoiceKey(options.env ?? process.env, options.vault, options.onWarn)
  if (existing) return existing
  if (!options.prompt) return null
  const key = (await options.prompt()).trim()
  if (!key) {
    throw new Error(`No OpenAI voice key entered. Set ${OPENAI_VOICE_ENV} or paste a key when prompted.`)
  }
  await options.validate(key)
  if (!options.vault) return { key, source: 'prompt' }
  try {
    saveVoiceKey(options.vault, key)
  } catch (error) {
    options.onWarn?.(
      `The key works but was not stored: ${(error as Error).message} ` +
      `It will be used for this session only; set ${OPENAI_VOICE_ENV} to skip the prompt next time.`,
    )
  }
  return { key, source: 'prompt' }
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
