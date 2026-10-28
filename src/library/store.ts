import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, realpathSync, lstatSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { NoteSchema, assertSafe, digest, type LibraryNote, type SensitivityCheck } from './core.js'

const RecoverySchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), runId: z.string().uuid(), turn: z.number().int().positive(), status: z.enum(['active', 'completed', 'interrupted']) }).strict()
export type RecoveryCheckpoint = z.infer<typeof RecoverySchema>
const SnapshotSchema = z.object({ schemaVersion: z.literal(1), notes: z.array(NoteSchema).max(1000), recoveries: z.array(RecoverySchema).max(64).default([]) }).strict()
const MAX_BYTES = 8_000_000
export interface LibrarySnapshot { revision: string; notes: LibraryNote[]; recoveries: RecoveryCheckpoint[] }
/** Explicitly supplied project/test root only; no personal-brain default or startup
 * side effect. Optimistic revision checks and an exclusive lock protect writers. */
export class LibraryStore {
  readonly root: string
  constructor(root: string, private readonly sensitive: SensitivityCheck) { this.root = resolve(root) }
  private owned(file: string): void {
    let ancestor = this.root
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
    if (existsSync(ancestor) && realpathSync(ancestor).toLowerCase() !== ancestor.toLowerCase()) throw new Error('Library root ancestor is redirected')
    if (existsSync(this.root) && (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root).toLowerCase() !== this.root.toLowerCase())) throw new Error('Library root is redirected')
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Library file is redirected')
  }
  read(): LibrarySnapshot {
    const file = join(this.root, 'library.json')
    this.owned(file)
    if (existsSync(file) && statSync(file).size > MAX_BYTES) throw new Error('Library storage budget exceeded')
    const raw = existsSync(file) ? readFileSync(file) : Buffer.from('{"schemaVersion":1,"notes":[]}\n')
    if (raw.length > MAX_BYTES) throw new Error('Library storage budget exceeded')
    const data = SnapshotSchema.parse(JSON.parse(raw.toString('utf8')))
    if (new Set(data.notes.map(note => note.id)).size !== data.notes.length) throw new Error('Duplicate library note ID')
    return { revision: digest(raw.toString('utf8')), notes: data.notes, recoveries: data.recoveries }
  }
  save(notes: LibraryNote[], expectedRevision: string, recoveries = this.read().recoveries): LibrarySnapshot {
    // Safety and validation run before mkdir, lock or file writes.
    assertSafe(notes, this.sensitive)
    const snapshot = SnapshotSchema.parse({ schemaVersion: 1, notes, recoveries })
    if (new Set(notes.map(note => note.id)).size !== notes.length) throw new Error('Duplicate library note ID')
    const content = JSON.stringify(snapshot) + '\n'
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Library storage budget exceeded')
    const file = join(this.root, 'library.json')
    this.owned(file)
    mkdirSync(this.root, { recursive: true })
    this.owned(file)
    const lock = join(this.root, 'writer.lock')
    const lockFd = openSync(lock, 'wx', 0o600)
    const temp = join(this.root, `${randomUUID()}.tmp`)
    try {
      if (this.read().revision !== expectedRevision) throw new Error('Library changed since read')
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
      if (readFileSync(temp, 'utf8') !== content) throw new Error('Library write readback failed')
      this.owned(file)
      renameSync(temp, file)
      return this.read()
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
      closeSync(lockFd)
      unlinkSync(lock)
    }
  }
  /** Revision-checked rollback cannot overwrite unrelated later changes. */
  restore(previous: LibrarySnapshot, expectedRevision: string): LibrarySnapshot {
    return this.save(previous.notes, expectedRevision, previous.recoveries)
  }
}
