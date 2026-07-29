import { z } from 'zod'

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

export const WatchDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  projectScope: z.string().length(64).regex(/^[a-f0-9]+$/),
  backend: z.literal('node-fs-watch'),
  resource: z.object({
    kind: z.literal('filesystem'),
    path: z.string().min(1).max(4_096),
    type: z.enum(['file', 'directory']),
  }).strict(),
  lifecycle: z.enum(['enabled', 'disabled', 'unavailable']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const WatchDatabaseSchema = z.object({
  schemaVersion: z.literal(1),
  watches: z.array(WatchDefinitionSchema).max(1_000),
}).strict()

export const WatchObservationSchema = z.object({
  schemaVersion: z.literal(1),
  watchId: IdSchema,
  kind: z.literal('changed'),
  summary: z.literal('Filesystem resource changed.'),
  observedAt: z.string().datetime(),
}).strict()
