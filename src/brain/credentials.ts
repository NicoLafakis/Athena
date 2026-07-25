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
  if (options.vault?.status().available) {
    const reference = `provider/${provider}`
    try {
      options.vault.set(reference, key)
      providerCredential = { vaultRef: reference }
    } catch (error) {
      options.onWarn?.(
        `OS credential vault write failed; retaining protected local-file fallback: ${(error as Error).message}`,
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

export function resolveApiKey(
  provider: ProviderId,
  creds: Credentials,
  env: NodeJS.ProcessEnv = process.env,
  vault?: CredentialVault,
): ResolvedKey | null {
  const envKey = env[PROVIDERS[provider].envVar]
  if (envKey) return { key: envKey, source: 'env' }
  const fileKey = creds.providers[provider]?.apiKey
  if (fileKey) return { key: fileKey, source: 'file' }
  const reference = creds.providers[provider]?.vaultRef
  if (reference && vault) {
    const key = vault.get(reference)
    if (key) return { key, source: 'vault' }
  }
  return null
}

/** One-way migration of legacy plaintext entries into the active OS vault.
 * The credentials file is only rewritten after every selected vault write
 * succeeds, so failed migrations retain the usable original keys. */
export function migrateCredentialsToVault(
  paths: BrainPaths,
  creds: Credentials,
  vault: CredentialVault,
): Credentials {
  if (!vault.status().available) return creds
  const next = structuredClone(creds)
  let changed = false
  for (const provider of PROVIDER_IDS) {
    const apiKey = next.providers[provider]?.apiKey
    if (!apiKey) continue
    const reference = `provider/${provider}`
    vault.set(reference, apiKey)
    next.providers[provider] = { vaultRef: reference }
    changed = true
  }
  if (changed) saveCredentials(paths, next)
  return next
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
      try {
        stored = vault?.get(vaultRef) ?? null
      } catch {
        // Status must never expose a vault exception or secret.
      }
      detail = `${stored ? redactKey(stored) : 'configured'} (OS vault)`
    }
    else detail = 'not configured'
    const active = p === activeProvider ? ' [active]' : ''
    return `${info.label.padEnd(pad)} ${detail}${active}`
  }).join('\n')
}
