import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { projectId } from '../trust.js'
import type { ResourcePolicy } from '../resource-policy.js'
import { WatchDatabaseSchema, WatchDefinitionSchema } from './schemas.js'
import type { WatchDatabase, WatchDefinition } from './types.js'

export interface WatchStoreOptions {
  onWarn?: (warning: string) => void
}

export interface ExplicitFilesystemWatchInput {
  requestedBy: 'user'
  projectRoot: string
  resource: string
  policy: ResourcePolicy
  now?: string
}

function emptyDatabase(): WatchDatabase {
  return { schemaVersion: 1, watches: [] }
}

export function createExplicitFilesystemWatch(
  input: ExplicitFilesystemWatchInput,
): WatchDefinition {
  if (input.requestedBy !== 'user') throw new Error('A watch requires an explicit user request')
  const resourcePath = input.policy.resolvePath(input.resource, 'read')
  const resourceType = statSync(resourcePath).isDirectory() ? 'directory' : 'file'
  const scope = projectId(input.projectRoot)
  const id = `watch-${createHash('sha256').update(`${scope}\0${resourcePath}`).digest('hex').slice(0, 48)}`
  const now = input.now ?? new Date().toISOString()
  return WatchDefinitionSchema.parse({
    schemaVersion: 1,
    id,
    projectScope: scope,
    backend: 'node-fs-watch',
    resource: { kind: 'filesystem', path: resourcePath, type: resourceType },
    lifecycle: 'enabled',
    createdAt: now,
    updatedAt: now,
  })
}

export class WatchStore {
  private warned = false

  constructor(
    private readonly file: string,
    private readonly options: WatchStoreOptions = {},
  ) {}

  list(): WatchDefinition[] {
    const database = this.read()
    return database?.watches.slice().sort((left, right) => left.id.localeCompare(right.id)) ?? []
  }

  upsert(input: WatchDefinition): WatchDefinition {
    const definition = WatchDefinitionSchema.parse(input)
    const database = this.readForMutation()
    const index = database.watches.findIndex((watch) => watch.id === definition.id)
    if (index >= 0) database.watches[index] = definition
    else database.watches.push(definition)
    database.watches.sort((left, right) => left.id.localeCompare(right.id))
    this.writeVerified(database)
    return definition
  }

  setLifecycle(
    id: string,
    lifecycle: WatchDefinition['lifecycle'],
    updatedAt = new Date().toISOString(),
  ): WatchDefinition {
    const database = this.readForMutation()
    const index = database.watches.findIndex((watch) => watch.id === id)
    if (index < 0) throw new Error(`Unknown watch ${id}`)
    const current = database.watches[index]!
    if (current.lifecycle === lifecycle) return current
    const updated = WatchDefinitionSchema.parse({ ...current, lifecycle, updatedAt })
    database.watches[index] = updated
    this.writeVerified(database)
    return updated
  }

  private readForMutation(): WatchDatabase {
    const database = this.read()
    if (!database) {
      throw new Error(`Watch index ${this.file} is invalid and was left unchanged`)
    }
    return database
  }

  private read(): WatchDatabase | null {
    if (!existsSync(this.file)) return emptyDatabase()
    try {
      return WatchDatabaseSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      this.warn()
      return null
    }
  }

  private writeVerified(database: WatchDatabase): void {
    const validated = WatchDatabaseSchema.parse(database)
    const content = JSON.stringify(validated, null, 2) + '\n'
    mkdirSync(dirname(this.file), { recursive: true })
    const candidate = `${this.file}.${process.pid}.${randomUUID()}.candidate`
    try {
      writeFileSync(candidate, content, { encoding: 'utf8', mode: 0o600 })
      const readBack = WatchDatabaseSchema.parse(JSON.parse(readFileSync(candidate, 'utf8')))
      if (JSON.stringify(readBack) !== JSON.stringify(validated)) {
        throw new Error('watch candidate verification mismatch')
      }
      renameSync(candidate, this.file)
    } finally {
      rmSync(candidate, { force: true })
    }
  }

  private warn(): void {
    if (this.warned) return
    this.warned = true
    this.options.onWarn?.(
      `Watch index ${this.file} could not be read using node-fs-watch; no watch was started. Move it aside and rerun \`athena watch <resource>\` to recover.`,
    )
  }
}
