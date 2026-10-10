import { createHash } from 'node:crypto'
import { z } from 'zod'

export const JOURNAL_VERSION = 1
export const JOURNAL_LIMITS = {
  ledgerBytes: 8_000_000, transactions: 4096, traceBytes: 2_000_000, traceEvents: 4096,
  sourceBatch: 24, captureBatch: 64, recoveryFiles: 32, directoryFiles: 2048,
  inputChars: 16_000, outputChars: 12_000, outputTokens: 1400, callMs: 30_000,
  dailyAttempts: 2, memoriesPerPass: 8, retrievalChars: 4000, retrievalItems: 4,
} as const
export function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}
export function normalize(text: string): string { return text.trim().toLowerCase().replace(/\s+/g, ' ') }
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const short = z.string().trim().min(1).max(2000)
const ids = z.array(hash).max(24)
const time = z.string().datetime()
const scope = z.union([hash, z.literal('global')])

export const JournalConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1), enabled: z.boolean().default(false),
  modelSynthesis: z.boolean().default(true), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  timezone: z.string().max(80).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true } catch { return false }
  }, 'Expected an IANA timezone').default('America/New_York'),
  captureSince: time.optional(),
}).strict()
export type JournalConfig = z.infer<typeof JournalConfigSchema>

export const JournalSourceSchema = z.object({
  schemaVersion: z.literal(1), id: hash, originId: hash, scopeId: scope,
  kind: z.enum(['trace', 'memory-file']), evidenceKind: z.enum(['observed', 'derived', 'inferred']),
  file: z.string().max(512), revision: hash, runId: z.string().uuid().optional(), sequence: z.number().int().positive().optional(),
  timestamp: time, summary: z.string().max(280), toolVersion: z.literal('athena-journal-v1'),
  provider: z.string().max(120).optional(), model: z.string().max(120).optional(),
  captureSince: time.optional(),
  limitations: z.array(short).max(8),
  operation: z.object({ name: z.string().max(80), inputHash: hash, failed: z.boolean() }).strict().optional(),
}).strict()
export type JournalSource = z.infer<typeof JournalSourceSchema>

const entryBase = {
  schemaVersion: z.literal(1), id: hash, timestamp: time, scopeId: scope, runId: z.string().uuid().optional(),
  author: z.enum(['system', 'model']), subjective: z.boolean(), evidenceKind: z.enum(['observed', 'derived', 'inferred']),
  sourceIds: ids, text: short,
}
export const JournalEntrySchema = z.discriminatedUnion('type', [
  z.object({ ...entryBase, type: z.literal('trace') }).strict(),
  z.object({ ...entryBase, type: z.literal('prediction'), basis: short, falsifiableBy: short }).strict(),
  z.object({ ...entryBase, type: z.literal('resolution'), predictionId: hash, outcome: z.enum(['confirmed', 'refuted', 'partial', 'unresolved']) }).strict(),
  z.object({ ...entryBase, type: z.literal('surprise'), expected: short, whyItMatters: short }).strict(),
  z.object({ ...entryBase, type: z.literal('reflection') }).strict(),
])
export type JournalEntry = z.infer<typeof JournalEntrySchema>

export const JournalMemorySchema = z.object({
  schemaVersion: z.literal(1), id: hash, version: z.number().int().positive(), scopeId: scope,
  statement: short, topic: z.string().trim().min(1).max(120), subjective: z.literal(true),
  evidenceKind: z.enum(['derived', 'inferred']), status: z.enum(['provisional', 'contradicted', 'rejected']),
  confidence: z.literal(0.25), sourceIds: ids.min(1), originIds: ids.min(1),
  contradictions: ids, limitations: z.array(short).min(1).max(8), createdAt: time, updatedAt: time,
}).strict()
export type JournalMemory = z.infer<typeof JournalMemorySchema>
export const JournalRelationshipSchema = z.object({
  schemaVersion: z.literal(1), id: hash, from: hash, to: hash,
  kind: z.enum(['repeats', 'recovered-after', 'may-contradict', 'revises-source', 'related']),
  evidenceKind: z.enum(['derived', 'inferred']), sourceIds: ids.min(1), limitations: z.array(short).min(1).max(8),
}).strict()
export type JournalRelationship = z.infer<typeof JournalRelationshipSchema>

export const JournalJobSchema = z.object({
  key: z.string().max(120), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), attempts: z.number().int().min(0).max(2),
  status: z.enum(['running', 'failed', 'complete']), sourceIds: ids, timestamp: time,
  mode: z.enum(['pending', 'model', 'metadata-only', 'provider-unavailable', 'budget-exhausted']),
  limitation: z.string().max(280).optional(), model: z.string().max(120).optional(),
}).strict()
export type JournalJob = z.infer<typeof JournalJobSchema>
export const JournalTransactionSchema = z.object({
  schemaVersion: z.literal(1), sequence: z.number().int().positive(), previousHash: hash.nullable(),
  idempotencyKey: z.string().min(1).max(180), timestamp: time,
  sources: z.array(JournalSourceSchema).max(64), entries: z.array(JournalEntrySchema).max(64),
  memories: z.array(JournalMemorySchema).max(24), relationships: z.array(JournalRelationshipSchema).max(32),
  consumedSourceIds: ids, job: JournalJobSchema.optional(), recoveryCursor: z.object({ scopeId: hash, file: z.string().max(100) }).strict().optional(),
  hash,
}).strict()
export type JournalTransaction = z.infer<typeof JournalTransactionSchema>
export type JournalChange = Pick<JournalTransaction, 'sources' | 'entries' | 'memories' | 'relationships' | 'consumedSourceIds' | 'job' | 'recoveryCursor'>
export function emptyChange(): JournalChange { return { sources: [], entries: [], memories: [], relationships: [], consumedSourceIds: [] } }
export interface JournalState {
  transactions: JournalTransaction[]; sources: Map<string, JournalSource>; entries: Map<string, JournalEntry>;
  memories: Map<string, JournalMemory>; relationships: Map<string, JournalRelationship>; consumed: Set<string>;
  jobs: Map<string, JournalJob>; cursors: Map<string, string>;
}

/** Model authors content/links only; identity, scope, provenance, confidence and status are server-owned. */
export const SynthesisSchema = z.object({
  reflection: short,
  memories: z.array(z.object({
    statement: short, topic: z.string().trim().min(1).max(120), sourceIds: ids.min(1), contradicts: ids.max(1),
    limitations: z.array(short).min(1).max(4),
  }).strict()).max(8),
  relationships: z.array(z.object({ from: hash, to: hash, kind: z.enum(['related', 'may-contradict']), sourceIds: ids.min(1) }).strict()).max(8),
}).strict()
export type Synthesis = z.infer<typeof SynthesisSchema>
