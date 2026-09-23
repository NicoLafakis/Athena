import { z } from 'zod'

const validatedTimeZones = new Map<string, true>()
const MAX_VALIDATED_TIME_ZONES = 256

function isIanaTimeZone(value: string): boolean {
  if (validatedTimeZones.has(value)) return true
  try {
    // Use the runtime's timezone database instead of maintaining a stale hand-written list.
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    const valid = !/^[+-]\d{2}(?::?\d{2})?$/.test(value)
    if (valid) {
      if (validatedTimeZones.size >= MAX_VALIDATED_TIME_ZONES) {
        const oldest = validatedTimeZones.keys().next().value as string | undefined
        if (oldest) validatedTimeZones.delete(oldest)
      }
      validatedTimeZones.set(value, true)
    }
    return valid
  } catch {
    return false
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isSafeProjectId(value: string): boolean {
  return value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value)
}

function isSafeRecordId(value: string): boolean {
  if (value.includes('\0') || value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return !value.split(/[\\/]/).some((part) => part === '..')
}

const IdSchema = z.string().min(1).max(256)
const SessionIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/)
const ProjectIdSchema = z.string().min(1).max(256).refine(isSafeProjectId)
const UtcInstantSchema = z.string().datetime({ offset: true })
const CalendarDateSchema = z.string().refine(isCalendarDate, 'Expected a valid YYYY-MM-DD date')

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isIanaTimeZone, 'Expected a valid IANA timezone supported by this runtime')

export const SpeechActSchema = z.enum([
  'asked',
  'stated',
  'considered',
  'preferred',
  'decided',
  'promised',
  'corrected',
  'retracted',
])

export const JevPersistedSpeechActSchema = z.enum([
  'preferred',
  'decided',
  'promised',
  'corrected',
  'retracted',
])

export const JEV_SPEECH_ACT_PERSISTENCE_CONFIDENCE = 0.85

export const SourceRefSchema = z
  .object({
    kind: z.enum(['session-message', 'session-event', 'run-event', 'memory-file', 'experience']),
    projectId: ProjectIdSchema.nullable(),
    sessionId: SessionIdSchema.optional(),
    recordId: z.string().min(1).max(512).refine(isSafeRecordId, 'Source identity must be local and path-safe'),
    lineDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    timestamp: UtcInstantSchema,
    timeZone: TimeZoneSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (
      (source.kind === 'session-message' || source.kind === 'session-event') &&
      (!source.projectId || !source.sessionId)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Session sources require project and session IDs' })
    }
    if ((source.kind === 'run-event' || source.kind === 'experience') && !source.projectId) {
      ctx.addIssue({ code: 'custom', message: `${source.kind} sources require a project ID` })
    }
    if (
      source.lineDigest !== undefined &&
      source.kind !== 'session-message' &&
      source.kind !== 'session-event'
    ) {
      ctx.addIssue({ code: 'custom', path: ['lineDigest'], message: 'Line digests require a session source' })
    }
  })

/** Content-free, high-confidence Jev label linked to the exact persisted user line. */
export const JevSpeechActEventSchema = z
  .object({
    type: z.literal('jev-speech-act-classification'),
    schemaVersion: z.literal(1),
    model: z.string().min(1).max(128),
    sourceRef: SourceRefSchema,
    speechAct: JevPersistedSpeechActSchema,
    confidence: z.number().min(JEV_SPEECH_ACT_PERSISTENCE_CONFIDENCE).max(1),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.sourceRef.kind !== 'session-message' || !event.sourceRef.lineDigest) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceRef'],
        message: 'Jev speech-act labels require a content-digested user-message source',
      })
    }
  })

export const ContinuityEpisodeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    sourceRefs: z.array(SourceRefSchema).min(1).max(256),
    projectId: ProjectIdSchema.nullable(),
    sessionId: SessionIdSchema,
    observedAt: UtcInstantSchema,
    localDate: CalendarDateSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
    participants: z.array(z.enum(['user', 'assistant', 'runtime'])).min(1).max(3),
    topics: z.array(z.string().min(1).max(64)).max(64),
    summary: z.string().min(1).max(1_200),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    speechActs: z.array(SpeechActSchema).max(7),
    completion: z.enum(['completed', 'interrupted', 'uncertain']),
    createdAt: UtcInstantSchema,
  })
  .strict()
  .superRefine((episode, ctx) => {
    const refs = new Set<string>()
    for (const source of episode.sourceRefs) {
      const key = `${source.kind}\0${source.projectId ?? ''}\0${source.sessionId ?? ''}\0${source.recordId}`
      if (refs.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['sourceRefs'], message: 'Source references must be unique' })
        break
      }
      refs.add(key)
      if (
        (source.kind === 'session-message' || source.kind === 'session-event') &&
        (source.projectId !== episode.projectId || source.sessionId !== episode.sessionId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['sourceRefs'],
          message: 'Session source references must match the episode project and session',
        })
      }
      if (source.kind === 'run-event' && source.projectId !== episode.projectId) {
        ctx.addIssue({
          code: 'custom',
          path: ['sourceRefs'],
          message: 'Run source references must match the episode project',
        })
      }
    }
  })

export const ContinuityIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: UtcInstantSchema,
    catalogComplete: z.boolean(),
    sessions: z.array(
      z.object({
        projectId: ProjectIdSchema,
        sessionId: SessionIdSchema,
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        canonicalLineCount: z.number().int().nonnegative(),
      }).strict(),
    ).max(100_000),
    episodes: z.array(ContinuityEpisodeSchema).max(100_000),
  })
  .strict()
  .superRefine((index, ctx) => {
    const ids = new Set<string>()
    for (const episode of index.episodes) {
      if (ids.has(episode.id)) {
        ctx.addIssue({ code: 'custom', path: ['episodes'], message: 'Episode IDs must be unique' })
        break
      }
      ids.add(episode.id)
    }
    const sessions = new Set<string>()
    for (const source of index.sessions) {
      const key = `${source.projectId}\0${source.sessionId}`
      if (sessions.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['sessions'], message: 'Session coverage IDs must be unique' })
        break
      }
      sessions.add(key)
    }
  })

export const SemanticMemoryLinkSchema = z
  .object({
    memoryId: IdSchema,
    sourceRefs: z.array(SourceRefSchema).min(1).max(256),
    observedAt: UtcInstantSchema,
    validFrom: UtcInstantSchema.optional(),
    validUntil: UtcInstantSchema.optional(),
    scope: z.enum(['global', 'project']),
    projectId: ProjectIdSchema.optional(),
    status: z.enum(['candidate', 'active', 'flagged', 'superseded', 'rejected', 'tombstoned']),
    confidence: z.number().min(0).max(1),
    speechAct: SpeechActSchema,
    captureMode: z.enum(['explicit', 'inferred']),
    supersedes: z.array(IdSchema).max(256).optional(),
    sensitivity: z.enum(['ordinary', 'sensitive']),
  })
  .strict()
  .superRefine((memory, ctx) => {
    if (memory.scope === 'project' && !memory.projectId) {
      ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Project-scoped memory requires a project ID' })
    }
    if (memory.scope === 'global' && memory.projectId) {
      ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Global memory cannot carry a project ID' })
    }
    if (memory.validFrom && memory.validUntil && Date.parse(memory.validUntil) <= Date.parse(memory.validFrom)) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validUntil must be later than validFrom' })
    }
  })

export const SemanticMemoryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    memoryId: z.string().uuid(),
    description: z.string().trim().min(1).max(256),
    sourceRefs: z.array(SourceRefSchema).min(1).max(256),
    supportingEpisodeIds: z.array(IdSchema).max(32),
    observedAt: UtcInstantSchema,
    validFrom: UtcInstantSchema.optional(),
    validUntil: UtcInstantSchema.optional(),
    scope: z.enum(['global', 'project']),
    projectId: ProjectIdSchema.optional(),
    status: z.enum(['candidate', 'active', 'flagged', 'superseded', 'rejected', 'tombstoned']),
    confidence: z.number().min(0).max(1),
    speechAct: SpeechActSchema,
    captureMode: z.enum(['explicit', 'inferred']),
    supersedes: z.array(z.string().uuid()).max(256),
    supersededBy: z.string().uuid().optional(),
    sensitivity: z.enum(['ordinary', 'sensitive']),
    createdAt: UtcInstantSchema,
    updatedAt: UtcInstantSchema,
    reviewedAt: UtcInstantSchema.optional(),
  })
  .strict()
  .superRefine((memory, ctx) => {
    if (memory.scope === 'project' && !memory.projectId) {
      ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Project-scoped memory requires a project ID' })
    }
    if (memory.scope === 'global' && memory.projectId) {
      ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Global memory cannot carry a project ID' })
    }
    if (memory.validFrom && memory.validUntil && Date.parse(memory.validUntil) <= Date.parse(memory.validFrom)) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validUntil must be later than validFrom' })
    }
    if (memory.captureMode === 'inferred') {
      if (new Set(memory.supportingEpisodeIds).size < 2) {
        ctx.addIssue({
          code: 'custom',
          path: ['supportingEpisodeIds'],
          message: 'Inferred memory requires support from at least two independent episodes',
        })
      }
      if (memory.sourceRefs.length < 2) {
        ctx.addIssue({
          code: 'custom',
          path: ['sourceRefs'],
          message: 'Inferred memory requires at least two source references',
        })
      }
      if (memory.sensitivity === 'sensitive' && memory.status === 'active') {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'Sensitive inferred memories cannot be active',
        })
      }
    }
    if (new Set(memory.supportingEpisodeIds).size !== memory.supportingEpisodeIds.length) {
      ctx.addIssue({ code: 'custom', path: ['supportingEpisodeIds'], message: 'Supporting episode IDs must be unique' })
    }
    if (memory.supersedes.includes(memory.memoryId)) {
      ctx.addIssue({ code: 'custom', path: ['supersedes'], message: 'A memory cannot supersede itself' })
    }
    if (new Set(memory.supersedes).size !== memory.supersedes.length) {
      ctx.addIssue({ code: 'custom', path: ['supersedes'], message: 'Superseded memory IDs must be unique' })
    }
    if (memory.status === 'superseded' && !memory.supersededBy) {
      ctx.addIssue({ code: 'custom', path: ['supersededBy'], message: 'Superseded memory requires a replacement ID' })
    }
    if (memory.status !== 'superseded' && memory.supersededBy) {
      ctx.addIssue({ code: 'custom', path: ['supersededBy'], message: 'Only superseded memory can link to a replacement' })
    }
    const sourceIds = new Set<string>()
    for (const source of memory.sourceRefs) {
      const sourceId = `${source.kind}\0${source.projectId ?? ''}\0${source.sessionId ?? ''}\0${source.recordId}`
      if (sourceIds.has(sourceId)) {
        ctx.addIssue({ code: 'custom', path: ['sourceRefs'], message: 'Source references must be unique' })
        break
      }
      sourceIds.add(sourceId)
    }
  })

export const TimeRollupSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']),
    periodStart: CalendarDateSchema,
    periodEnd: CalendarDateSchema,
    timeZone: TimeZoneSchema,
    summary: z.string().min(1).max(4_000),
    sourceEpisodeIds: z.array(IdSchema).min(1).max(100_000),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    generator: z.string().min(1).max(128),
    createdAt: UtcInstantSchema,
  })
  .strict()
  .superRefine((rollup, ctx) => {
    if (!isCalendarDate(rollup.periodStart) || !isCalendarDate(rollup.periodEnd)) return
    if (rollup.periodEnd <= rollup.periodStart) {
      ctx.addIssue({ code: 'custom', path: ['periodEnd'], message: 'periodEnd must be after periodStart' })
    }
    if (new Set(rollup.sourceEpisodeIds).size !== rollup.sourceEpisodeIds.length) {
      ctx.addIssue({ code: 'custom', path: ['sourceEpisodeIds'], message: 'Source episode IDs must be unique' })
    }
  })

export const TemporalWindowSchema = z
  .object({
    start: UtcInstantSchema,
    end: UtcInstantSchema,
    timeZone: TimeZoneSchema,
    kind: z.enum(['calendar', 'rolling', 'explicit']),
    label: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (Date.parse(window.end) <= Date.parse(window.start)) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'Window end must be after start' })
    }
  })

export type SourceRef = z.infer<typeof SourceRefSchema>
export type SpeechAct = z.infer<typeof SpeechActSchema>
export type ContinuityEpisode = z.infer<typeof ContinuityEpisodeSchema>
export type ContinuityIndex = z.infer<typeof ContinuityIndexSchema>
export type SemanticMemoryLink = z.infer<typeof SemanticMemoryLinkSchema>
export type SemanticMemoryRecord = z.infer<typeof SemanticMemoryRecordSchema>
export type TimeRollup = z.infer<typeof TimeRollupSchema>
export type TemporalWindow = z.infer<typeof TemporalWindowSchema>

const validatedEpisodes = new WeakSet<object>()

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function freezeValidatedEpisode(episode: ContinuityEpisode): ContinuityEpisode {
  deepFreeze(episode)
  validatedEpisodes.add(episode)
  return episode
}

/** Parse once at the trust boundary, then safely reuse this immutable episode in read paths. */
export function parseContinuityEpisode(input: unknown): ContinuityEpisode {
  if (typeof input === 'object' && input !== null && validatedEpisodes.has(input)) {
    return input as ContinuityEpisode
  }
  return freezeValidatedEpisode(ContinuityEpisodeSchema.parse(input))
}

/** Validate and freeze an index so its episode values can be reused without reparsing. */
export function parseContinuityIndex(input: unknown): ContinuityIndex {
  const index = ContinuityIndexSchema.parse(input)
  for (const episode of index.episodes) freezeValidatedEpisode(episode)
  return deepFreeze(index)
}
