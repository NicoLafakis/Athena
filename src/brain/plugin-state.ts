import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { BrainPaths } from './paths.js'
import { atomicWriteFileSync } from '../tools/files.js'

const PluginRecordSchema = z.object({
  enabled: z.boolean().default(true),
  source: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string(),
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  signatureVerified: z.boolean().default(false),
})

export const PluginStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  plugins: z.record(z.string(), PluginRecordSchema).default({}),
})

export type PluginState = z.infer<typeof PluginStateSchema>
export type InstalledPluginRecord = z.infer<typeof PluginRecordSchema>

export function loadPluginState(paths: BrainPaths): PluginState {
  if (!existsSync(paths.pluginStateFile)) return PluginStateSchema.parse({})
  try {
    return PluginStateSchema.parse(JSON.parse(readFileSync(paths.pluginStateFile, 'utf8')))
  } catch (error) {
    throw new Error(`Invalid plugin state ${paths.pluginStateFile}: ${(error as Error).message}`)
  }
}

export function savePluginState(paths: BrainPaths, state: PluginState): void {
  atomicWriteFileSync(paths.pluginStateFile, JSON.stringify(PluginStateSchema.parse(state), null, 2) + '\n')
}

export function isPluginEnabled(paths: BrainPaths, id: string): boolean {
  return loadPluginState(paths).plugins[id]?.enabled !== false
}
