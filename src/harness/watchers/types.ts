import type { z } from 'zod'
import type {
  WatchDatabaseSchema,
  WatchDefinitionSchema,
  WatchObservationSchema,
} from './schemas.js'

export type WatchDefinition = z.infer<typeof WatchDefinitionSchema>
export type WatchDatabase = z.infer<typeof WatchDatabaseSchema>
export type WatchObservation = z.infer<typeof WatchObservationSchema>

export interface WatchBackendStatus {
  backend: 'node-fs-watch'
  available: boolean
  detail: string
  recoveryCommand: 'athena watch --status'
  probedAt: string
}
