import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { BrainPaths } from '../brain/paths.js'
import { ProtectedPaths } from '../harness/protected-paths.js'
import { realPathForAccess } from '../harness/resource-policy.js'
import { JOURNAL_LIMITS, JournalConfigSchema, JournalTransactionSchema, digest, emptyChange, type JournalChange, type JournalConfig, type JournalState, type JournalTransaction } from './types.js'

const LockSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict()
export class JournalBusy extends Error { constructor() { super('Journal writer is busy; capture will be recovered on a later pass.') } }

/** Atomic, versioned transactions; a chain is an integrity check, never a truth check. */
export class JournalStore {
  readonly root: string
  readonly file: string
  readonly memoryRoot: string
  private readonly brain: string
  constructor(readonly paths: BrainPaths, private readonly protectedPaths = ProtectedPaths.defaults()) {
    this.brain = realPathForAccess(paths.brainDir, paths.brainDir)
    this.root = join(this.brain, 'journal')
    this.file = join(this.root, 'ledger.jsonl')
    this.memoryRoot = join(this.brain, 'memory', 'journal')
  }
  assertOwned(file: string): void {
    const rel = relative(this.brain, file)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || realPathForAccess(file, this.brain) !== file) throw new Error('Journal storage path redirected outside its owned location')
    const fenced = this.protectedPaths.deniedRoot(file, this.brain)
    if (fenced) throw new Error(`Journal storage is inside protected system directory ${fenced}`)
  }
  readBounded(file: string, maxBytes: number): string {
    this.assertOwned(file)
    const fd = openSync(file, 'r')
    try {
      if (fstatSync(fd).size > maxBytes) throw new Error(`Journal input exceeds ${maxBytes} bytes`)
      return readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
  }
  private writeAtomic(file: string, content: string): void {
    this.assertOwned(file)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.assertOwned(file)
    const temp = `${file}.${randomUUID()}.tmp`
    this.assertOwned(temp)
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      if (this.readBounded(temp, Math.max(JOURNAL_LIMITS.ledgerBytes, Buffer.byteLength(content))) !== content) throw new Error('Journal replacement readback mismatch')
      this.assertOwned(file)
      renameSync(temp, file)
      if (this.readBounded(file, Math.max(JOURNAL_LIMITS.ledgerBytes, Buffer.byteLength(content))) !== content) throw new Error('Journal write readback mismatch')
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
  config(): JournalConfig {
    const file = join(this.root, 'config.json')
    this.assertOwned(file)
    return JournalConfigSchema.parse(existsSync(file) ? JSON.parse(this.readBounded(file, 4096)) : {})
  }
  /** Human CLI control only; model tools and consolidation never call this. */
  configure(change: Partial<JournalConfig>, now = new Date()): JournalConfig {
    const release = this.acquire('write')
    try {
      const current = this.config()
      const next = JournalConfigSchema.parse({ ...current, ...change,
        ...(change.enabled === true && (!current.enabled || !current.captureSince) ? { captureSince: now.toISOString() } : {}),
      })
      this.writeAtomic(join(this.root, 'config.json'), JSON.stringify(next, null, 2) + '\n')
      return next
    } finally { release() }
  }
  acquire(name: 'write' | 'consolidate'): () => void {
    const file = join(this.root, `${name}.lock`)
    this.assertOwned(file)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const token = randomUUID()
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token }) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
        return () => {
          this.assertOwned(file)
          if (existsSync(file) && LockSchema.parse(JSON.parse(this.readBounded(file, 1024))).token === token) unlinkSync(file)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const raw = this.readBounded(file, 1024)
        const owner = LockSchema.parse(JSON.parse(raw))
        let dead = false
        try { process.kill(owner.pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        if (!dead || attempt === 1) throw new JournalBusy()
        // Recover only a proven dead owner, and never delete a replacement lock.
        if (this.readBounded(file, 1024) === raw) unlinkSync(file)
      }
    }
    throw new JournalBusy()
  }
  load(): JournalState {
    const state: JournalState = { transactions: [], sources: new Map(), entries: new Map(), memories: new Map(), relationships: new Map(), consumed: new Set(), jobs: new Map(), cursors: new Map() }
    this.assertOwned(this.file)
    if (!existsSync(this.file)) return state
    const content = this.readBounded(this.file, JOURNAL_LIMITS.ledgerBytes)
    if (!content.endsWith('\n')) throw new Error('Incomplete journal ledger; preserve it for recovery')
    const lines = content.trimEnd().split('\n')
    if (lines.length > JOURNAL_LIMITS.transactions) throw new Error('Journal transaction bound reached; archive before continuing')
    const keys = new Set<string>()
    for (const line of lines) {
      const tx = JournalTransactionSchema.parse(JSON.parse(line))
      const { hash, ...base } = tx
      if (tx.sequence !== state.transactions.length + 1 || tx.previousHash !== (state.transactions.at(-1)?.hash ?? null) || digest(base) !== hash || keys.has(tx.idempotencyKey)) throw new Error('Invalid journal chain or duplicate transaction')
      this.reduce(state, tx)
      state.transactions.push(tx)
      keys.add(tx.idempotencyKey)
    }
    return state
  }
  private reduce(state: JournalState, tx: JournalTransaction): void {
    for (const source of tx.sources) {
      const before = state.sources.get(source.id)
      if (before && digest(before) !== digest(source)) throw new Error('Journal source identity was rewritten')
      state.sources.set(source.id, source)
    }
    for (const entry of tx.entries) {
      if (entry.sourceIds.some(id => !state.sources.has(id) || state.sources.get(id)!.scopeId !== entry.scopeId)) throw new Error('Unknown or cross-project journal entry source')
      if (entry.type !== 'trace' && (!entry.subjective || entry.evidenceKind !== 'inferred' || entry.author !== 'model')) throw new Error('Reflection cannot become observed truth')
      if (entry.type === 'trace' && (entry.author !== 'system' || entry.evidenceKind !== 'observed' || entry.subjective)) throw new Error('Trace metadata must be server-authored')
      if ((entry.type === 'resolution' || entry.type === 'surprise') && entry.sourceIds.length === 0) throw new Error('Resolution/surprise requires evidence')
      if (entry.type === 'resolution' && (state.entries.get(entry.predictionId)?.type !== 'prediction' || state.entries.get(entry.predictionId)?.scopeId !== entry.scopeId)) throw new Error('Resolution requires an existing same-scope prediction')
      const before = state.entries.get(entry.id)
      if (before && digest(before) !== digest(entry)) throw new Error('Journal entry was rewritten')
      state.entries.set(entry.id, entry)
    }
    for (const memory of tx.memories) {
      if (memory.sourceIds.some(id => !state.sources.has(id) || state.sources.get(id)!.scopeId !== memory.scopeId)) throw new Error('Unknown or cross-project memory provenance')
      const origins = [...new Set(memory.sourceIds.map(id => state.sources.get(id)!.originId))].sort()
      if (digest(origins) !== digest([...memory.originIds].sort())) throw new Error('Independent origins must come from original sources')
      const before = state.memories.get(memory.id)
      if (memory.version !== (before?.version ?? 0) + 1 || (memory.contradictions.length > 0 && memory.status === 'provisional') || (before && (before.statement !== memory.statement || before.topic !== memory.topic || before.scopeId !== memory.scopeId || before.createdAt !== memory.createdAt || (before.status === 'rejected' && memory.status !== 'rejected') || (before.status === 'contradicted' && memory.status === 'provisional') || before.sourceIds.some(id => !memory.sourceIds.includes(id)) || before.contradictions.some(id => !memory.contradictions.includes(id)) || before.limitations.some(text => !memory.limitations.includes(text))))) throw new Error('Invalid memory revision or discarded provenance/uncertainty/rejection')
      state.memories.set(memory.id, memory)
    }
    for (const link of tx.relationships) {
      const scopeOf = (id: string) => state.sources.get(id)?.scopeId ?? state.memories.get(id)?.scopeId
      if (!scopeOf(link.from) || scopeOf(link.from) !== scopeOf(link.to) || link.sourceIds.some(id => !state.sources.has(id) || state.sources.get(id)!.scopeId !== scopeOf(link.from))) throw new Error('Unknown or cross-project relationship endpoint/provenance')
      const before = state.relationships.get(link.id)
      if (before && digest(before) !== digest(link)) throw new Error('Relationship identity rewritten')
      state.relationships.set(link.id, link)
    }
    for (const memory of tx.memories) if (memory.contradictions.some(id => !state.memories.has(id) || state.memories.get(id)!.scopeId !== memory.scopeId)) throw new Error('Unknown or cross-project contradictory memory')
    for (const id of tx.consumedSourceIds) {
      if (!state.sources.has(id)) throw new Error('Unknown consumed source')
      state.consumed.add(id)
    }
    if (tx.job) {
      const previous = state.jobs.get(tx.job.key)
      if (previous && (tx.job.attempts < previous.attempts || (previous.status === 'complete' && digest(previous) !== digest(tx.job)))) throw new Error('Daily checkpoint cannot be rewound')
      if (tx.job.sourceIds.some(id => !state.sources.has(id))) throw new Error('Unknown job input')
      state.jobs.set(tx.job.key, tx.job)
    }
    if (tx.recoveryCursor) state.cursors.set(tx.recoveryCursor.scopeId, tx.recoveryCursor.file)
  }
  commit(key: string, change: JournalChange, now = new Date()): JournalState {
    const release = this.acquire('write')
    try {
      const state = this.load()
      if (state.transactions.some(tx => tx.idempotencyKey === key)) return state
      const base = { schemaVersion: 1 as const, sequence: state.transactions.length + 1, previousHash: state.transactions.at(-1)?.hash ?? null,
        idempotencyKey: key, timestamp: now.toISOString(), ...change }
      const normalized = JournalTransactionSchema.omit({ hash: true }).parse(base)
      const tx = { ...normalized, hash: digest(normalized) }
      if (tx.sequence > JOURNAL_LIMITS.transactions) throw new Error('Journal transaction bound reached; archive before continuing')
      this.reduce(state, tx)
      const text = state.transactions.map(item => JSON.stringify(item) + '\n').join('') + JSON.stringify(tx) + '\n'
      if (Buffer.byteLength(text) > JOURNAL_LIMITS.ledgerBytes) throw new Error('Journal size bound reached; archive before continuing')
      this.writeAtomic(this.file, text)
      state.transactions.push(tx)
      return state
    } finally { release() }
  }
  reject(id: string, now = new Date()): void {
    const before = this.load().memories.get(id)
    if (!before) throw new Error('Unknown journal memory')
    if (before.status === 'rejected') return
    this.commit(`reject:${id}`, { ...emptyChange(), memories: [{ ...before, version: before.version + 1, status: 'rejected', updatedAt: now.toISOString() }] }, now)
    this.materialize()
  }
  /** Rebuildable data files, deliberately absent from the system-prompt MEMORY.md index. */
  materialize(): void {
    const state = this.load()
    const index = ['# Journal memory (untrusted, provisional interpretations)', '', 'Hashes identify original records; they do not establish truth.', '']
    for (const memory of state.memories.values()) {
      const text = JSON.stringify(memory, null, 2)
      this.writeAtomic(join(this.memoryRoot, `${memory.id}.json`), text + '\n')
      index.push(`- ${memory.id}: ${memory.status}, ${memory.evidenceKind}, scope ${memory.scopeId}, version ${memory.version}`)
    }
    this.writeAtomic(join(this.memoryRoot, 'INDEX.md'), index.join('\n') + '\n')
  }
}
