// src/brain/credentials.ts — ~/.athena/credentials.json: per-provider API keys plus the
// persisted default provider. Resolution order per provider: explicit env var overrides
// the file (existing env-var setups keep working); the file is the documented path.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { PROVIDERS, type ProviderId } from './models.js'
import type { BrainPaths } from './paths.js'

const ProviderCredSchema = z.object({ apiKey: z.string().min(1) })

export const CredentialsSchema = z.object({
  providers: z
    .object({
      anthropic: ProviderCredSchema.optional(),
      kimi: ProviderCredSchema.optional(),
    })
    .strict() // unknown providers are rejected, not silently kept
    .default({}),
  activeProvider: z.enum(['anthropic', 'kimi']).default('anthropic'),
})
export type Credentials = z.infer<typeof CredentialsSchema>

/** Missing file -> defaults. Malformed/invalid file -> actionable error (never a raw
 *  parse stack): names the file and offers `athena auth` to regenerate. */
export function loadCredentials(paths: BrainPaths): Credentials {
  if (!existsSync(paths.credentialsFile)) return CredentialsSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(paths.credentialsFile, 'utf8'))
  } catch {
    throw new Error(
      `Malformed credentials file ${paths.credentialsFile} — run \`athena auth\` to regenerate it.`,
    )
  }
  const result = CredentialsSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(
      `Invalid credentials file ${paths.credentialsFile} (${issues}) — run \`athena auth\` to regenerate it.`,
    )
  }
  return result.data
}

/** Owner-only permissions are best-effort: 0o600 on POSIX; chmod is a no-op on
 *  Windows/NTFS, where the file relies on the user-profile directory ACL. */
export function saveCredentials(paths: BrainPaths, creds: Credentials): void {
  mkdirSync(dirname(paths.credentialsFile), { recursive: true })
  writeFileSync(paths.credentialsFile, JSON.stringify(creds, null, 2) + '\n', 'utf8')
  try {
    chmodSync(paths.credentialsFile, 0o600)
  } catch {
    /* best-effort */
  }
}

/** Merge one provider's key in and make it the active provider. Tolerates a malformed
 *  existing file (this IS the regeneration path `athena auth` promises). */
export function setProviderKey(paths: BrainPaths, provider: ProviderId, key: string): Credentials {
  let creds: Credentials
  try {
    creds = loadCredentials(paths)
  } catch {
    creds = CredentialsSchema.parse({})
  }
  const next: Credentials = {
    providers: { ...creds.providers, [provider]: { apiKey: key } },
    activeProvider: provider,
  }
  saveCredentials(paths, next)
  return next
}

export interface ResolvedKey {
  key: string
  source: 'env' | 'file'
}

export function resolveApiKey(
  provider: ProviderId,
  creds: Credentials,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKey | null {
  const envKey = env[PROVIDERS[provider].envVar]
  if (envKey) return { key: envKey, source: 'env' }
  const fileKey = creds.providers[provider]?.apiKey
  if (fileKey) return { key: fileKey, source: 'file' }
  return null
}

/** `sk-ant-api03-...abc4` -> `sk-ant...abc4`. Short keys collapse to '***' so a
 *  redacted rendering can never reconstruct the key. */
export function redactKey(key: string): string {
  if (key.length <= 10) return '***'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}
