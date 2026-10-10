import { z } from 'zod'
import { MemoryClaimSchema } from '../learning/types.js'

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Id = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/)
const Text = z.string().min(1).max(2000)
const EvidenceIds = z.array(Hash).max(64)
const Provider = z.enum(['source-text', 'unit', 'runtime', 'external'])
const Status = z.enum(['passed', 'failed', 'unknown', 'unsupported', 'stale', 'contradicted'])

export const SourceRevisionSchema = z.object({
  id: Hash,
  gitHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  files: z.array(z.object({ path: Text, hash: Hash.nullable(), problem: Text.nullable() }).strict()).min(1).max(16),
}).strict()
export type SourceRevision = z.infer<typeof SourceRevisionSchema>

export const ObservationSchema = z.object({
  id: Hash,
  kind: z.enum(['observed', 'derived', 'inferred']),
  sourceRevision: Hash,
  tool: z.object({ name: Text, version: Text }).strict(),
  runId: Text,
  toolCallId: Text,
  location: z.object({ path: Text, firstLine: z.number().int().positive(), lastLine: z.number().int().nonnegative(), fileHash: Hash }).strict().nullable(),
  text: z.string().max(20_000),
  usable: z.boolean(),
  parents: EvidenceIds,
  independentIds: EvidenceIds,
  limitations: z.array(Text).min(1).max(16),
}).strict()
export type Observation = z.infer<typeof ObservationSchema>

// Reuse the governed claim's statement contract; evidence and proof scope are
// local to this investigation and never silently promoted into brain memory.
export const InvestigationDraftSchema = z.object({
  hypotheses: z.array(z.object({
    id: Id, statement: MemoryClaimSchema.shape.statement.max(2000), supports: EvidenceIds, counterevidence: EvidenceIds,
  }).strict()).min(2).max(8),
  claims: z.array(z.object({
    id: Id, statement: MemoryClaimSchema.shape.statement.max(2000),
    scope: z.enum(['source-text', 'source-behavior', 'runtime', 'external']),
    evidenceIds: EvidenceIds, counterevidenceIds: EvidenceIds, testIds: z.array(Id).min(1).max(16),
  }).strict()).min(1).max(16),
  tests: z.array(z.object({
    id: Id, hypothesisId: Id, provider: Provider, observationId: Hash.optional(),
    contains: z.string().min(1).max(1000), expect: z.enum(['present', 'absent']),
  }).strict()).min(2).max(32),
  unknowns: z.array(z.object({
    id: Id, question: Text, requiredProvider: Text, evidenceIds: EvidenceIds,
  }).strict()).max(16),
}).strict()
export type InvestigationDraft = z.infer<typeof InvestigationDraftSchema>

export const VerificationSchema = z.object({
  complete: z.boolean(), currentRevision: SourceRevisionSchema,
  hypotheses: z.array(z.object({
    id: Id, status: z.enum(['supported', 'refuted', 'unresolved', 'stale']), reason: Text,
  }).strict()).max(8),
  tests: z.array(z.object({ id: Id, status: Status, reason: Text, evidenceIds: EvidenceIds }).strict()).max(32),
  claims: z.array(z.object({
    id: Id, status: Status, reason: Text, independentEvidenceCount: z.number().int().nonnegative(),
  }).strict()).max(16),
  remainingUnknowns: InvestigationDraftSchema.shape.unknowns,
}).strict()
export type Verification = z.infer<typeof VerificationSchema>

export const InvestigationSnapshotSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), version: z.number().int().positive(),
  target: z.object({ question: Text, cwd: Text, revision: SourceRevisionSchema }).strict(),
  observations: z.array(ObservationSchema).max(64),
  result: InvestigationDraftSchema.nullable(), verification: VerificationSchema.nullable(),
}).strict()
export type InvestigationSnapshot = z.infer<typeof InvestigationSnapshotSchema>
export interface InvestigationReport extends Omit<InvestigationSnapshot, 'verification'> {
  verification: Verification
  ledgerFile: string
  ledgerIntegrity: 'valid'
  limitations: string[]
}

const Reference = { id: z.string().uuid() }
export const InvestigationInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), question: Text, files: z.array(Text).min(1).max(16) }).strict(),
  z.object({ op: z.literal('read'), ...Reference, file_path: Text, offset: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).optional() }).strict(),
  z.object({ op: z.literal('note'), ...Reference, expectedVersion: z.number().int().positive(), kind: z.enum(['derived', 'inferred']), statement: Text, evidenceIds: EvidenceIds.min(1), limitations: z.array(Text).min(1).max(8) }).strict(),
  z.object({ op: z.literal('submit'), ...Reference, expectedVersion: z.number().int().positive(), result: InvestigationDraftSchema }).strict(),
  z.object({ op: z.literal('complete'), ...Reference }).strict(),
  z.object({ op: z.literal('result'), ...Reference }).strict(),
])

/** Referential validation is also applied when loading disk history. */
export function validateLinks(snapshot: InvestigationSnapshot): void {
  const observations = new Map<string, Observation>()
  for (const observation of snapshot.observations) {
    if (observations.has(observation.id)) throw new Error('Duplicate observation ID')
    if (observation.sourceRevision !== snapshot.target.revision.id) throw new Error('Observation revision mismatch')
    for (const parent of observation.parents) if (!observations.has(parent)) throw new Error(`Unknown parent evidence ${parent}`)
    if (observation.kind === 'observed' && (observation.tool.name !== 'Read' || !observation.location || observation.parents.length)) throw new Error('Invalid observed source evidence')
    observations.set(observation.id, observation)
  }
  if (!snapshot.result) return
  const result = snapshot.result
  const unique = (ids: string[]) => {
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate result ID')
  }
  unique(result.hypotheses.map(h => h.id))
  unique(result.claims.map(c => c.id))
  unique(result.tests.map(t => t.id))
  unique(result.unknowns.map(u => u.id))
  const evidence = (ids: string[]) => {
    for (const id of ids) if (!observations.has(id)) throw new Error(`Unknown evidence ${id}`)
  }
  for (const h of result.hypotheses) {
    evidence([...h.supports, ...h.counterevidence])
    if (!result.tests.some(t => t.hypothesisId === h.id)) throw new Error(`Hypothesis ${h.id} has no discriminating test`)
  }
  for (const t of result.tests) {
    if (!result.hypotheses.some(h => h.id === t.hypothesisId)) throw new Error('Unknown test hypothesis')
    if (t.observationId) evidence([t.observationId])
    if (t.provider === 'source-text' && !t.observationId) throw new Error('Source test requires an observation ID')
  }
  for (const c of result.claims) {
    evidence([...c.evidenceIds, ...c.counterevidenceIds])
    for (const id of c.testIds) if (!result.tests.some(t => t.id === id)) throw new Error('Unknown claim test')
  }
  for (const u of result.unknowns) evidence(u.evidenceIds)
}
