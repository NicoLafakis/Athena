// src/brain/credentials.ts — ~/.athena/credentials.json: per-provider API keys plus the
// persisted default provider. Resolution order per provider: explicit env var overrides
// the file (existing env-var setups keep working); the file is the documented path.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from './models.js'
import type { BrainPaths } from './paths.js'
import type { CredentialVault } from './credential-vault.js'

const ProviderCredSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    vaultRef: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.apiKey || value.vaultRef), {
    message: 'apiKey or vaultRef is required',
  })

export const CredentialsSchema = z
  .object({
    providers: z
      .object({
        anthropic: ProviderCredSchema.optional(),
        kimi: ProviderCredSchema.optional(),
        'kimi-code': ProviderCredSchema.optional(),
      })
      .strict() // unknown providers are rejected, not silently kept
      .default({}),
    activeProvider: z.enum(['anthropic', 'kimi', 'kimi-code']).default('anthropic'),
  })
  .strict() // unknown top-level keys are rejected, not silently kept
export type Credentials = z.infer<typeof CredentialsSchema>

/** Missing file -> defaults. Malformed/invalid file -> actionable error (never a raw
 *  parse stack): names the file and offers `athena auth` to regenerate. */
export function loadCredentials(paths: BrainPaths): Credentials {
  if (!existsSync(paths.credentialsFile)) return CredentialsSchema.parse({})
  // Read failures (EPERM/EACCES/locks) propagate untagged: they are NOT regeneration
  // cases, and setProviderKey must rethrow them rather than clobber a valid file.
  const text = readFileSync(paths.credentialsFile, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw Object.assign(
      new Error(
        `Malformed credentials file ${paths.credentialsFile} - run \`athena auth\` to regenerate it.`,
      ),
      { code: 'ATHENA_CREDENTIALS_INVALID' },
    )
  }
  const result = CredentialsSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw Object.assign(
      new Error(
        `Invalid credentials file ${paths.credentialsFile} (${issues}) - run \`athena auth\` to regenerate it.`,
      ),
      { code: 'ATHENA_CREDENTIALS_INVALID' },
    )
  }
  return result.data
}

/** Owner-only permissions are best-effort: 0o600 on POSIX; chmod is a no-op on
 *  Windows/NTFS, where the file relies on the user-profile directory ACL.
 *  Atomic: write to a temp file then rename over the target (same pattern as
 *  session rewrite) so a crash mid-write can never leave a truncated/corrupt
 *  credentials file behind. */
export function saveCredentials(paths: BrainPaths, creds: Credentials): void {
  mkdirSync(dirname(paths.credentialsFile), { recursive: true })
  const tmp = `${paths.credentialsFile}.tmp`
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', {
    mode: 0o600,
    encoding: 'utf8',
  })
  try {
    renameSync(tmp, paths.credentialsFile)
  } catch (err) {
    // Never orphan the temp file; the original stays intact.
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw err
  }
  try {
    chmodSync(paths.credentialsFile, 0o600)
  } catch {
    /* best-effort */
  }
}

/** Merge one provider's key in and make it the active provider. Tolerates a malformed
 *  existing file (this IS the regeneration path `athena auth` promises). */
export function setProviderKey(
  paths: BrainPaths,
  provider: ProviderId,
  key: string,
  options: { vault?: CredentialVault; onWarn?: (message: string) => void } = {},
): Credentials {
  let creds: Credentials
  try {
    creds = loadCredentials(paths)
  } catch (err) {
    if ((err as { code?: string }).code !== 'ATHENA_CREDENTIALS_INVALID') throw err
    creds = CredentialsSchema.parse({})
  }
  let providerCredential: { apiKey?: string; vaultRef?: string } = { apiKey: key }
  if (options.vault) {
    const reference = `provider/${provider}`
    let unavailable: string | null = null
    try {
      const status = options.vault.status()
      unavailable = status.available ? null : status.detail
      if (status.available) {
        options.vault.set(reference, key)
        providerCredential = { vaultRef: reference }
      }
    } catch (error) {
      unavailable = (error as Error).message
    }
    // Silently degrading to plaintext is how a user ends up believing their key is
    // encrypted when it is not. Whenever the vault is skipped, say so, in one line,
    // at the moment it happens.
    if (unavailable !== null) {
      options.onWarn?.(
        `WARNING: the OS credential vault is unavailable, so this key is stored UNENCRYPTED in ${paths.credentialsFile} (${unavailable})`,
      )
    }
  }
  const next: Credentials = {
    providers: { ...creds.providers, [provider]: providerCredential },
    activeProvider: provider,
  }
  saveCredentials(paths, next)
  return next
}

export interface ResolvedKey {
  key: string
  source: 'env' | 'file' | 'vault'
}

/** Never throws. A vault that cannot be read (blob from another machine, reset Windows
 *  profile, broken interpreter) resolves as "no key from the vault" plus a warning the
 *  caller can print, so the failure is loud but non-fatal. */
export function resolveApiKey(
  provider: ProviderId,
  creds: Credentials,
  env: NodeJS.ProcessEnv = process.env,
  vault?: CredentialVault,
  onWarn?: (message: string) => void,
): ResolvedKey | null {
  const envKey = env[PROVIDERS[provider].envVar]
  if (envKey) return { key: envKey, source: 'env' }
  const fileKey = creds.providers[provider]?.apiKey
  if (fileKey) return { key: fileKey, source: 'file' }
  const reference = creds.providers[provider]?.vaultRef
  if (reference && vault) {
    try {
      const key = vault.get(reference)
      if (key) return { key, source: 'vault' }
    } catch (error) {
      onWarn?.((error as Error).message)
    }
  }
  return null
}

/** Best-effort, one-way migration of legacy plaintext entries into the active OS vault.
 * NEVER fatal: this is an optional hardening step layered on top of an already-working
 * plaintext store, so any vault failure leaves that working state untouched and warns.
 * A provider's plaintext key is only dropped after the freshly written vault entry has
 * been read back and matched, so an unreadable blob can never replace a usable key. */
export function migrateCredentialsToVault(
  paths: BrainPaths,
  creds: Credentials,
  vault: CredentialVault,
  options: { onWarn?: (message: string) => void } = {},
): Credentials {
  const pending = PROVIDER_IDS.filter((provider) => Boolean(creds.providers[provider]?.apiKey))
  // Nothing to migrate: do not even ask the vault for its status, so a normal boot pays
  // no capability probe (and cannot be broken by one).
  if (pending.length === 0) return creds
  let available: boolean
  try {
    const status = vault.status()
    available = status.available
    if (!available) {
      options.onWarn?.(
        `WARNING: the OS credential vault is unavailable, so your API key(s) remain UNENCRYPTED in ${paths.credentialsFile} (${status.detail})`,
      )
    }
  } catch (error) {
    options.onWarn?.(
      `WARNING: the OS credential vault could not be checked, so your API key(s) remain UNENCRYPTED in ${paths.credentialsFile} (${(error as Error).message})`,
    )
    available = false
  }
  if (!available) return creds
  const next = structuredClone(creds)
  let changed = false
  for (const provider of pending) {
    const apiKey = next.providers[provider]?.apiKey
    if (!apiKey) continue
    const reference = `provider/${provider}`
    try {
      vault.set(reference, apiKey)
      if (vault.get(reference) !== apiKey) throw new Error('vault read-back did not match')
      next.providers[provider] = { vaultRef: reference }
      changed = true
    } catch (error) {
      options.onWarn?.(
        `WARNING: could not move the ${provider} key into the OS credential vault, so it remains UNENCRYPTED in ${paths.credentialsFile} (${(error as Error).message})`,
      )
    }
  }
  if (changed) saveCredentials(paths, next)
  return changed ? next : creds
}

/** `sk-ant-api03-abcdefabc4` -> `sk-ant...abc4`: prefix (6 chars) + ellipsis + last 4.
 *  At least 8 characters are always hidden; anything shorter than 18 collapses to '***'
 *  so a redacted rendering can never reconstruct the key. */
export function redactKey(key: string): string {
  if (key.length < 18) return '***'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

/** One line per known provider: label, redacted key + source, env-override flag,
 *  [active] marker. Full keys never appear — everything goes through redactKey. */
export function formatAuthStatus(
  creds: Credentials,
  activeProvider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
  vault?: CredentialVault,
): string {
  const pad = Math.max(...PROVIDER_IDS.map((p) => PROVIDERS[p].label.length)) + 1
  return PROVIDER_IDS.map((p) => {
    const info = PROVIDERS[p]
    const envKey = env[info.envVar]
    const fileKey = creds.providers[p]?.apiKey
    const vaultRef = creds.providers[p]?.vaultRef
    let detail: string
    if (envKey && (fileKey || vaultRef)) {
      detail = `${redactKey(envKey)} (env ${info.envVar}, overrides ${vaultRef ? 'vault' : 'file'})`
    }
    else if (envKey) detail = `${redactKey(envKey)} (env ${info.envVar})`
    else if (fileKey) detail = `${redactKey(fileKey)} (file)`
    else if (vaultRef) {
      let stored: string | null = null
      let unreadable = false
      try {
        stored = vault?.get(vaultRef) ?? null
      } catch {
        // Never expose the raw exception (or a secret) here, but never claim health
        // either: an unreadable blob is a real, actionable state.
        unreadable = true
      }
      detail = unreadable
        ? 'UNREADABLE on this machine (encrypted elsewhere?) - run `athena auth`'
        : `${stored ? redactKey(stored) : 'configured'} (OS vault)`
    }
    else detail = 'not configured'
    const active = p === activeProvider ? ' [active]' : ''
    return `${info.label.padEnd(pad)} ${detail}${active}`
  }).join('\n')
}
