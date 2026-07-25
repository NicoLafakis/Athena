import { createHash, randomUUID, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { BrainPaths } from '../brain/paths.js'
import {
  loadPluginState,
  savePluginState,
  type InstalledPluginRecord,
  type PluginState,
} from '../brain/plugin-state.js'

const PluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    name: z.string().min(1).optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    description: z.string().optional(),
    apiVersion: z.literal('1').default('1'),
    dependencies: z.record(z.string(), z.string()).default({}),
    contributes: z
      .object({
        skills: z.string().default('skills'),
        agents: z.string().default('agents'),
        commands: z.string().default('commands'),
        hooks: z.string().optional(),
        mcp: z.string().optional(),
        apps: z.array(z.string()).default([]),
      })
      .default({}),
    signature: z
      .object({
        algorithm: z.literal('ed25519'),
        publicKey: z.string().min(1),
        value: z.string().min(1),
      })
      .optional(),
  })
  .passthrough()

export type ManagedPluginManifest = z.infer<typeof PluginManifestSchema>

export interface ManagedPluginInfo {
  id: string
  version: string
  enabled: boolean
  source: string
  digest: string
  signatureVerified: boolean
  directory: string
}

const MAX_PLUGIN_FILES = 10_000
const MAX_PLUGIN_FILE_BYTES = 10 * 1024 * 1024
const MAX_PLUGIN_TOTAL_BYTES = 100 * 1024 * 1024

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function walkFiles(root: string): string[] {
  const out: string[] = []
  let totalBytes = 0
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name)
      const info = lstatSync(file)
      if (info.isSymbolicLink()) throw new Error(`Plugin packages may not contain symlinks: ${relative(root, file)}`)
      if (info.isDirectory()) visit(file)
      else if (info.isFile()) {
        if (info.size > MAX_PLUGIN_FILE_BYTES) {
          throw new Error(`Plugin file exceeds ${MAX_PLUGIN_FILE_BYTES} bytes: ${relative(root, file)}`)
        }
        totalBytes += info.size
        if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
          throw new Error(`Plugin package exceeds ${MAX_PLUGIN_TOTAL_BYTES} bytes`)
        }
        out.push(file)
        if (out.length > MAX_PLUGIN_FILES) {
          throw new Error(`Plugin package exceeds ${MAX_PLUGIN_FILES} files`)
        }
      }
    }
  }
  visit(root)
  return out
}

/** Content digest includes canonical relative paths and contents. The signature
 * field itself is omitted so an Ed25519 signature can cover the digest. */
export function digestPluginDirectory(root: string): string {
  const hash = createHash('sha256')
  for (const file of walkFiles(root)) {
    const name = relative(root, file).replaceAll('\\', '/')
    hash.update(name)
    hash.update('\0')
    if (name === 'plugin.json') {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      delete parsed['signature']
      hash.update(stable(parsed))
    } else {
      hash.update(readFileSync(file))
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readManifest(root: string): ManagedPluginManifest {
  const file = join(root, 'plugin.json')
  if (!existsSync(file)) throw new Error('Managed plugins require plugin.json')
  try {
    return PluginManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error(`Invalid plugin manifest ${file}: ${(error as Error).message}`)
  }
}

function versionSatisfies(actual: string, requested: string): boolean {
  if (requested === '*' || requested === '') return true
  if (requested.startsWith('^')) {
    return actual.split('.')[0] === requested.slice(1).split('.')[0]
  }
  if (requested.startsWith('~')) {
    return actual.split('.').slice(0, 2).join('.') === requested.slice(1).split('.').slice(0, 2).join('.')
  }
  return actual === requested
}

function verifyManifestSignature(
  manifest: ManagedPluginManifest,
  digest: string,
): boolean {
  if (!manifest.signature) return false
  return verify(
    null,
    Buffer.from(digest, 'hex'),
    manifest.signature.publicKey,
    Buffer.from(manifest.signature.value, 'base64'),
  )
}

function resolveContained(root: string, entry: string): string {
  const target = resolve(root, entry)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Plugin contribution escapes package root: ${entry}`)
  }
  return target
}

function validateContributions(root: string, manifest: ManagedPluginManifest): void {
  const entries = [
    manifest.contributes.skills,
    manifest.contributes.agents,
    manifest.contributes.commands,
    manifest.contributes.hooks,
    manifest.contributes.mcp,
    ...manifest.contributes.apps,
  ].filter((value): value is string => Boolean(value))
  for (const entry of entries) {
    const target = resolveContained(root, entry)
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`Plugin contribution may not be a symlink: ${entry}`)
    }
  }
}

function sourceDirectory(source: string): { directory: string; provenance: string; cleanup: () => void } {
  if (/^(https?|ssh|git):\/\//.test(source) || source.startsWith('git@')) {
    const temp = mkdtempSync(join(tmpdir(), 'athena-plugin-git-'))
    const checkout = join(temp, 'checkout')
    try {
      execFileSync('git', ['clone', '--depth', '1', '--', source, checkout], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch (error) {
      rmSync(temp, { recursive: true, force: true })
      throw new Error(`Could not clone plugin ${source}: ${(error as Error).message}`)
    }
    return {
      directory: checkout,
      provenance: source,
      cleanup: () => rmSync(temp, { recursive: true, force: true }),
    }
  }
  const directory = realpathSync.native(resolve(source))
  if (!statSync(directory).isDirectory()) throw new Error(`Plugin source is not a directory: ${source}`)
  return { directory, provenance: directory, cleanup: () => {} }
}

export class PluginManager {
  constructor(private readonly paths: BrainPaths) {}

  list(): ManagedPluginInfo[] {
    const state = loadPluginState(this.paths)
    return Object.entries(state.plugins)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, record]) => ({
        id,
        version: record.version,
        enabled: record.enabled,
        source: record.source,
        digest: record.digest,
        signatureVerified: record.signatureVerified,
        directory: join(this.paths.pluginsDir, id),
      }))
  }

  install(
    source: string,
    options: { requireSignature?: boolean; replace?: boolean; expectedId?: string } = {},
  ): ManagedPluginInfo {
    mkdirSync(this.paths.pluginsDir, { recursive: true })
    const resolvedSource = sourceDirectory(source)
    const stage = join(this.paths.pluginsDir, `.staging-${randomUUID()}`)
    let backup: string | null = null
    try {
      walkFiles(resolvedSource.directory)
      cpSync(resolvedSource.directory, stage, { recursive: true, errorOnExist: true })
      const manifest = readManifest(stage)
      if (options.expectedId && manifest.id !== options.expectedId) {
        throw new Error(
          `Update source changed plugin id from ${options.expectedId} to ${manifest.id}`,
        )
      }
      validateContributions(stage, manifest)
      const state = loadPluginState(this.paths)
      for (const [dependency, range] of Object.entries(manifest.dependencies)) {
        const installed = state.plugins[dependency]
        if (!installed || !installed.enabled || !versionSatisfies(installed.version, range)) {
          throw new Error(`Plugin ${manifest.id} requires enabled ${dependency}@${range}`)
        }
      }
      const digest = digestPluginDirectory(stage)
      const signatureVerified = verifyManifestSignature(manifest, digest)
      if (manifest.signature && !signatureVerified) throw new Error(`Plugin ${manifest.id} has an invalid signature`)
      if (options.requireSignature && !signatureVerified) {
        throw new Error(`Plugin ${manifest.id} is unsigned; --require-signature was requested`)
      }
      const target = join(this.paths.pluginsDir, manifest.id)
      if (existsSync(target)) {
        if (!options.replace) throw new Error(`Plugin ${manifest.id} is already installed`)
        backup = join(this.paths.pluginsDir, `.backup-${manifest.id}-${randomUUID()}`)
        renameSync(target, backup)
      }
      try {
        renameSync(stage, target)
      } catch (error) {
        if (backup) renameSync(backup, target)
        throw error
      }
      const now = new Date().toISOString()
      const previous = state.plugins[manifest.id]
      const record: InstalledPluginRecord = {
        enabled: previous?.enabled ?? true,
        source: resolvedSource.provenance,
        digest,
        version: manifest.version,
        installedAt: previous?.installedAt ?? now,
        updatedAt: now,
        signatureVerified,
      }
      state.plugins[manifest.id] = record
      try {
        savePluginState(this.paths, state)
      } catch (error) {
        rmSync(target, { recursive: true, force: true })
        if (backup) renameSync(backup, target)
        throw error
      }
      if (backup) rmSync(backup, { recursive: true, force: true })
      return {
        id: manifest.id,
        version: record.version,
        enabled: record.enabled,
        source: record.source,
        digest: record.digest,
        signatureVerified,
        directory: target,
      }
    } finally {
      resolvedSource.cleanup()
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
    }
  }

  update(id: string, options: { requireSignature?: boolean } = {}): ManagedPluginInfo {
    const record = loadPluginState(this.paths).plugins[id]
    if (!record) throw new Error(`Plugin ${id} is not managed`)
    return this.install(record.source, { ...options, replace: true, expectedId: id })
  }

  setEnabled(id: string, enabled: boolean): void {
    const state = loadPluginState(this.paths)
    const record = state.plugins[id]
    if (!record) throw new Error(`Plugin ${id} is not managed`)
    record.enabled = enabled
    record.updatedAt = new Date().toISOString()
    savePluginState(this.paths, state)
  }

  remove(id: string): string {
    const state = loadPluginState(this.paths)
    if (!state.plugins[id]) throw new Error(`Plugin ${id} is not managed`)
    const target = join(this.paths.pluginsDir, id)
    const trashRoot = join(this.paths.pluginsDir, '.trash')
    mkdirSync(trashRoot, { recursive: true })
    const destination = join(
      trashRoot,
      `${basename(id)}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
    )
    const moved = existsSync(target)
    if (moved) renameSync(target, destination)
    delete state.plugins[id]
    try {
      savePluginState(this.paths, state)
    } catch (error) {
      if (moved) renameSync(destination, target)
      throw error
    }
    return destination
  }

  verify(id: string): boolean {
    const state = loadPluginState(this.paths)
    const record = state.plugins[id]
    if (!record) throw new Error(`Plugin ${id} is not managed`)
    const directory = join(this.paths.pluginsDir, id)
    return existsSync(directory) && digestPluginDirectory(directory) === record.digest
  }
}

export function emptyPluginState(): PluginState {
  return { schemaVersion: 1, plugins: {} }
}
