import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

export type ProjectCapability = 'hooks' | 'mcp'

const CapabilityGrantSchema = z.object({
  digest: z.string(),
  approvedAt: z.string().datetime(),
})

const TrustRecordSchema = z.object({
  projectId: z.string(),
  canonicalPath: z.string(),
  trustedAt: z.string().datetime(),
  capabilities: z.object({
    hooks: CapabilityGrantSchema.optional(),
    mcp: CapabilityGrantSchema.optional(),
  }).default({}),
})

const TrustDatabaseSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), TrustRecordSchema).default({}),
})

type TrustDatabase = z.infer<typeof TrustDatabaseSchema>
export type TrustRecord = z.infer<typeof TrustRecordSchema>

function normalizedCase(path: string): string {
  const slashed = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** Canonical project identity. Existing paths are resolved through symlinks and
 * Windows aliases before hashing so one repository cannot acquire multiple trust
 * identities through alternate spellings. */
export function canonicalProjectPath(projectPath: string): string {
  const portable =
    /^[A-Za-z]:[\\/]/.test(projectPath) ? projectPath.replaceAll('\\', '/') : projectPath
  const absolute = resolve(portable)
  const canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute
  return normalizedCase(canonical)
}

export function projectId(projectPath: string): string {
  return createHash('sha256').update(canonicalProjectPath(projectPath)).digest('hex')
}

export function capabilityDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function emptyDatabase(): TrustDatabase {
  return { version: 1, projects: {} }
}

export class ProjectTrustStore {
  constructor(private readonly file: string) {}

  private read(): TrustDatabase {
    if (!existsSync(this.file)) return emptyDatabase()
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      throw new Error(`Malformed trust registry ${this.file}: ${(err as Error).message}`)
    }
    const parsed = TrustDatabaseSchema.safeParse(raw)
    if (!parsed.success) throw new Error(`Invalid trust registry ${this.file}: ${parsed.error.message}`)
    return parsed.data
  }

  private write(database: TrustDatabase): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(database, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, this.file)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        // best effort
      }
      throw err
    }
  }

  get(projectPath: string): TrustRecord | null {
    return this.read().projects[projectId(projectPath)] ?? null
  }

  isTrusted(projectPath: string): boolean {
    const record = this.get(projectPath)
    return record?.canonicalPath === canonicalProjectPath(projectPath)
  }

  trust(projectPath: string): TrustRecord {
    const database = this.read()
    const id = projectId(projectPath)
    const record: TrustRecord = {
      projectId: id,
      canonicalPath: canonicalProjectPath(projectPath),
      trustedAt: new Date().toISOString(),
      capabilities: {},
    }
    database.projects[id] = record
    this.write(database)
    return record
  }

  revoke(projectPath: string): boolean {
    const database = this.read()
    const id = projectId(projectPath)
    if (!database.projects[id]) return false
    delete database.projects[id]
    this.write(database)
    return true
  }

  approveCapability(
    projectPath: string,
    capability: ProjectCapability,
    digest: string,
  ): TrustRecord {
    const database = this.read()
    const id = projectId(projectPath)
    const record = database.projects[id]
    if (!record || record.canonicalPath !== canonicalProjectPath(projectPath)) {
      throw new Error(`Project must be trusted before approving ${capability}`)
    }
    record.capabilities[capability] = { digest, approvedAt: new Date().toISOString() }
    this.write(database)
    return record
  }

  isCapabilityApproved(
    projectPath: string,
    capability: ProjectCapability,
    digest: string,
  ): boolean {
    const record = this.get(projectPath)
    return (
      record?.canonicalPath === canonicalProjectPath(projectPath) &&
      record.capabilities[capability]?.digest === digest
    )
  }
}
