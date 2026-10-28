import { createHash } from 'node:crypto'
import { z } from 'zod'

const text = z.string().trim().min(1).max(32_000)
const label = z.string().trim().min(1).max(120)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const SourceSchema = z.object({ id: label, revision: hash }).strict()
export const NoteSchema = z.object({
  schemaVersion: z.literal(1), id: hash, scope: label, detail: text,
  summary: z.string().trim().min(1).max(2000), categories: z.array(label).min(1).max(32),
  sources: z.array(SourceSchema).min(1).max(32),
  status: z.enum(['quarantined', 'candidate', 'durable', 'rejected', 'superseded']),
  reviews: z.array(z.object({
    stage: z.enum(['request', 'implementation', 'verification', 'librarian']),
    evidence: hash, reviewer: label, path: label.optional(),
  }).strict()).max(4),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  supersedes: hash.optional(),
  checkedTree: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  checks: z.array(z.object({ id: label, passed: z.literal(true), outputHash: hash, definitionHash: hash.optional() }).strict()).min(1).max(8).optional(),
}).strict().superRefine((note, ctx) => {
  const normalized = { scope: note.scope, detail: note.detail, summary: note.summary,
    categories: [...new Set(note.categories)].sort(),
    sources: [...note.sources].sort((a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision)) }
  if (digest(JSON.stringify(normalized)) !== note.id) ctx.addIssue({ code: 'custom', message: 'Note content does not match its identity' })
  if (new Set(note.sources.map(source => source.id)).size !== note.sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate source identity' })
  if (note.status === 'durable' && (!note.commit || note.reviews.length !== 4 || new Set(note.reviews.map(review => review.stage)).size !== 4 || new Set(note.reviews.map(review => review.evidence)).size !== 4)) ctx.addIssue({ code: 'custom', message: 'Durable note lacks complete review and commit evidence' })
})
export type LibraryNote = z.infer<typeof NoteSchema>
export type NoteInput = Pick<LibraryNote, 'scope' | 'detail' | 'summary' | 'categories' | 'sources'>
export type Review = LibraryNote['reviews'][number]
export type SourceCheck = (source: LibraryNote['sources'][number]) => boolean
export type SensitivityCheck = (content: string) => boolean
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A second, application-specific sensitive-data policy is mandatory. This built-in
 * guard catches common credentials, not every possible personal or sensitive fact. */
export function containsCredential(content: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|\b(?:password|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/i.test(content)
}
export function assertSafe(value: unknown, sensitive: SensitivityCheck): void {
  const content = JSON.stringify(value)
  if (containsCredential(content) || sensitive(content)) throw new Error('Library submission rejected by sensitive-data policy')
}
export function createNote(input: NoteInput, sensitive: SensitivityCheck, recovery = false): LibraryNote {
  // Reject before callers may persist content; no rejected payload is retained.
  assertSafe(input, sensitive)
  const normalized = { scope: input.scope.trim(), detail: input.detail.trim(), summary: input.summary.trim(), categories: [...new Set(input.categories.map(category => category.trim()))].sort(),
    sources: input.sources.map(source => SourceSchema.parse(source)).sort((a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision)) }
  const id = digest(JSON.stringify(normalized))
  return NoteSchema.parse({ schemaVersion: 1, ...normalized, id,
    status: recovery ? 'quarantined' : 'candidate', reviews: [] })
}
function current(note: LibraryNote, check: SourceCheck): void {
  if (!note.sources.every(source => check(source))) throw new Error('Library source is unavailable or stale')
}
export function reviewNote(note: LibraryNote, review: Review, check: SourceCheck): LibraryNote {
  note = NoteSchema.parse(note)
  if (note.status !== 'candidate') throw new Error('Only candidates can be reviewed')
  current(note, check)
  if (note.reviews.some(item => item.stage === review.stage)) throw new Error('Review stage already recorded')
  if (note.reviews.some(item => item.evidence === review.evidence)) throw new Error('Review requires distinct evidence')
  return NoteSchema.parse({ ...note, reviews: [...note.reviews, review] })
}
/** Caller supplies an independently implemented commit/check verifier. A commit ID
 * or a reviewer assertion alone is never sufficient for promotion. */
export function promoteNote(note: LibraryNote, commit: string, check: SourceCheck,
  verifyCommit: (commit: string, note: LibraryNote) => boolean): LibraryNote {
  note = NoteSchema.parse(note)
  if (note.status !== 'candidate' || note.reviews.length !== 4 || new Set(note.reviews.map(review => review.stage)).size !== 4 || new Set(note.reviews.map(review => review.evidence)).size !== 4) throw new Error('Four distinct review stages required')
  current(note, check)
  if (!verifyCommit(commit, note)) throw new Error('Committed implementation and checks not verified')
  return NoteSchema.parse({ ...note, status: 'durable', commit })
}
export function releaseRecovery(note: LibraryNote, check: SourceCheck): LibraryNote {
  note = NoteSchema.parse(note)
  if (note.status !== 'quarantined') throw new Error('Only recovery records can be released')
  current(note, check)
  return { ...note, status: 'candidate', reviews: [], commit: undefined }
}
export function rejectNote(note: LibraryNote): LibraryNote {
  return { ...NoteSchema.parse(note), status: 'rejected' }
}
export interface LibraryQuery {
  scope: string; keys: string[]; shape?: 'detail' | 'summary'; maxChars?: number; maxItems?: number
}
export interface LibraryResult { id: string; content: string; sources: LibraryNote['sources'] }
/** Locks are exact normalized category keys, not authorization or fuzzy semantics.
 * Detailed notes are the default; whole records that exceed the budget are omitted. */
export function retrieveNotes(notes: LibraryNote[], query: LibraryQuery, check: SourceCheck): LibraryResult[] {
  const keys = new Set(query.keys.map(key => key.trim().toLowerCase()).filter(Boolean))
  const maxChars = Math.max(0, Math.min(32_000, query.maxChars ?? 12_000))
  const maxItems = Math.max(0, Math.min(16, query.maxItems ?? 4))
  const result: LibraryResult[] = []
  if (!keys.size || !maxItems) return result
  for (const raw of [...notes].sort((a, b) => a.id.localeCompare(b.id))) {
    const note = NoteSchema.parse(raw)
    if (note.status !== 'durable' || note.scope !== query.scope || !note.commit) continue
    if (!note.categories.some(category => keys.has(category.toLowerCase()))) continue
    if (!note.sources.every(source => check(source))) continue
    const item = { id: note.id, content: query.shape === 'summary' ? note.summary : note.detail, sources: note.sources }
    if (JSON.stringify([...result, item]).length > maxChars) continue
    result.push(item)
    if (result.length >= maxItems) break
  }
  return result
}
