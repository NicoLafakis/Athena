import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from './loader.js'
import { SemanticMemoryRecordSchema, type SemanticMemoryRecord, type SourceRef, type SpeechAct } from '../continuity/schemas.js'
import { atomicWriteFileSync } from '../tools/files.js'

const SEMANTIC_RECORD_KEY = 'athena-semantic-record'

export interface SemanticMemoryCreateInput {
  description: string
  content: string
  sourceRefs: SourceRef[]
  supportingEpisodeIds?: string[]
  observedAt?: string
  validFrom?: string
  validUntil?: string
  scope?: 'global' | 'project'
  projectId?: string
  speechAct: SpeechAct
  captureMode: 'explicit' | 'inferred'
  confidence: number
  sensitivity: 'ordinary' | 'sensitive'
}

export interface ManagedSemanticMemory extends SemanticMemoryRecord {
  content: string
  file: string
}

export interface MemoryHygieneStoreOptions {
  now?: () => Date
  onWarn?: (warning: string) => void
}

function isTerminal(status: SemanticMemoryRecord['status']): boolean {
  return status === 'rejected' || status === 'superseded' || status === 'tombstoned'
}

function serialize(memory: SemanticMemoryRecord, content: string): string {
  return `---\n${SEMANTIC_RECORD_KEY}: ${JSON.stringify(memory)}\n---\n${content}`
}

function normalizedCandidateContent(content: string): string {
  return content.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? ''
}

export function semanticSourceIdentity(source: SourceRef): string {
  return `${source.kind}\0${source.projectId ?? ''}\0${source.sessionId ?? ''}\0${source.recordId}`
}

export type CandidateUpsertOutcome = 'created' | 'updated' | 'unchanged'

/**
 * Stores source-linked semantic memories alongside the existing free-text memory tree.
 * It deliberately does not add these records to MEMORY.md or any prompt context.
 */
export class MemoryHygieneStore {
  private readonly semanticDir: string
  private readonly now: () => Date
  private readonly onWarn: (warning: string) => void

  constructor(memoryDir: string, options: MemoryHygieneStoreOptions = {}) {
    this.semanticDir = join(memoryDir, 'semantic')
    this.now = options.now ?? (() => new Date())
    this.onWarn = options.onWarn ?? ((warning) => console.error(warning))
  }

  create(input: SemanticMemoryCreateInput): ManagedSemanticMemory {
    const { content, ...recordInput } = input
    if (!content.trim()) throw new Error('Semantic memory content must not be empty')
    if (content.length > 2_000) throw new Error('Semantic memory content cannot exceed 2000 characters')
    const now = this.now().toISOString()
    const memory = SemanticMemoryRecordSchema.parse({
      schemaVersion: 1,
      memoryId: randomUUID(),
      description: recordInput.description,
      sourceRefs: recordInput.sourceRefs,
      supportingEpisodeIds: recordInput.supportingEpisodeIds ?? [],
      observedAt: recordInput.observedAt ?? now,
      ...(recordInput.validFrom ? { validFrom: recordInput.validFrom } : {}),
      ...(recordInput.validUntil ? { validUntil: recordInput.validUntil } : {}),
      scope: recordInput.scope ?? 'global',
      ...(recordInput.projectId ? { projectId: recordInput.projectId } : {}),
      status: recordInput.captureMode === 'explicit' ? 'active' : 'candidate',
      confidence: recordInput.confidence,
      speechAct: recordInput.speechAct,
      captureMode: recordInput.captureMode,
      supersedes: [],
      sensitivity: recordInput.sensitivity,
      createdAt: now,
      updatedAt: now,
    })
    return this.write(memory, content)
  }

  upsertInferredCandidate(input: SemanticMemoryCreateInput): {
    memory: ManagedSemanticMemory
    outcome: CandidateUpsertOutcome
  } {
    if (input.captureMode !== 'inferred') throw new Error('Candidate upsert requires inferred capture mode')
    const normalized = normalizedCandidateContent(input.content)
    const matches = this.readAll().filter(
      (memory) =>
        memory.speechAct === input.speechAct &&
        normalizedCandidateContent(memory.content) === normalized,
    )
    // Preserve explicit lifecycle decisions even if an older duplicate candidate exists.
    const matching = matches.find((memory) => memory.status !== 'candidate') ?? matches[0]
    if (!matching) return { memory: this.create(input), outcome: 'created' }
    if (matching.status !== 'candidate') return { memory: matching, outcome: 'unchanged' }

    const sourceRefs = [...new Map(
      [...matching.sourceRefs, ...input.sourceRefs].map((source) => [
        `${source.kind}\0${source.projectId ?? ''}\0${source.sessionId ?? ''}\0${source.recordId}`,
        source,
      ]),
    ).values()].slice(0, 256)
    const supportingEpisodeIds = [...new Set([
      ...matching.supportingEpisodeIds,
      ...(input.supportingEpisodeIds ?? []),
    ])].slice(0, 32)
    const scope = matching.scope === 'global' || input.scope === 'global' ? 'global' : 'project'
    const projectId = scope === 'project' ? input.projectId ?? matching.projectId : undefined
    const observedAt = input.observedAt && input.observedAt > matching.observedAt
      ? input.observedAt
      : matching.observedAt
    const incomingIsNewer = observedAt === input.observedAt
    const current = this.recordOf(matching)
    const { projectId: _currentProjectId, ...withoutProject } = current
    void _currentProjectId
    const now = this.now().toISOString()
    const next = SemanticMemoryRecordSchema.parse({
      ...withoutProject,
      description: incomingIsNewer ? input.description : matching.description,
      sourceRefs,
      supportingEpisodeIds,
      observedAt,
      scope,
      ...(projectId ? { projectId } : {}),
      confidence: Math.max(matching.confidence, input.confidence),
      sensitivity: matching.sensitivity === 'sensitive' || input.sensitivity === 'sensitive'
        ? 'sensitive'
        : 'ordinary',
      updatedAt: now,
    })
    if (
      next.description === matching.description &&
      next.observedAt === matching.observedAt &&
      next.scope === matching.scope &&
      next.projectId === matching.projectId &&
      next.confidence === matching.confidence &&
      next.sensitivity === matching.sensitivity &&
      JSON.stringify(next.sourceRefs) === JSON.stringify(matching.sourceRefs) &&
      JSON.stringify(next.supportingEpisodeIds) === JSON.stringify(matching.supportingEpisodeIds)
    ) {
      return { memory: matching, outcome: 'unchanged' }
    }
    return { memory: this.write(next, incomingIsNewer ? input.content : matching.content), outcome: 'updated' }
  }

  listActive(): ManagedSemanticMemory[] {
    const now = this.now().getTime()
    return this.listAll().filter(
      (memory) =>
        memory.status === 'active' &&
        (memory.validFrom === undefined || Date.parse(memory.validFrom) <= now) &&
        (memory.validUntil === undefined || now < Date.parse(memory.validUntil)),
    )
  }

  /** Return every validated lifecycle state so historical queries can resolve validity windows. */
  listAll(): ManagedSemanticMemory[] {
    return this.readAll()
  }

  get(memoryId: string): ManagedSemanticMemory | null {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memoryId)) {
      return null
    }
    return this.readFile(join(this.semanticDir, `${memoryId}.md`))
  }

  promote(memoryId: string): ManagedSemanticMemory {
    const current = this.require(memoryId)
    if (isTerminal(current.status)) throw new Error(`Memory ${memoryId} is terminal and cannot be promoted`)
    if (current.status !== 'candidate') throw new Error(`Only candidate memories can be promoted: ${memoryId}`)
    if (current.sensitivity === 'sensitive') {
      throw new Error('Sensitive inferred memories cannot be promoted')
    }
    const now = this.now().toISOString()
    return this.write(
      { ...this.recordOf(current), status: 'active', updatedAt: now, reviewedAt: now },
      current.content,
    )
  }

  reject(memoryId: string): ManagedSemanticMemory {
    const current = this.require(memoryId)
    if (isTerminal(current.status)) throw new Error(`Memory ${memoryId} is terminal and cannot be rejected again`)
    if (current.status !== 'candidate') throw new Error(`Only candidate memories can be rejected: ${memoryId}`)
    const now = this.now().toISOString()
    return this.write(
      { ...this.recordOf(current), status: 'rejected', updatedAt: now, reviewedAt: now },
      current.content,
    )
  }

  supersede(memoryId: string, replacementInput: SemanticMemoryCreateInput): ManagedSemanticMemory {
    const previous = this.require(memoryId)
    if (previous.status !== 'active') throw new Error(`Only active memories can be superseded: ${memoryId}`)
    if (replacementInput.captureMode !== 'explicit') {
      throw new Error('An inferred candidate must be reviewed before it can supersede active memory')
    }

    const replacement = this.create(replacementInput)
    try {
      const now = this.now().toISOString()
      const linkedReplacement = this.write(
        { ...this.recordOf(replacement), supersedes: [memoryId], updatedAt: now },
        replacement.content,
      )
      this.write(
        { ...this.recordOf(previous), status: 'superseded', supersededBy: replacement.memoryId, updatedAt: now },
        previous.content,
      )
      return { ...linkedReplacement, supersedes: [memoryId], file: replacement.file }
    } catch (error) {
      // The new file is newly allocated and can be removed if the reciprocal link fails.
      rmSync(replacement.file, { force: true })
      throw error
    }
  }

  tombstone(memoryId: string): ManagedSemanticMemory {
    const current = this.require(memoryId)
    if (isTerminal(current.status)) throw new Error(`Memory ${memoryId} is terminal and cannot be tombstoned again`)
    const now = this.now().toISOString()
    return this.write(
      { ...this.recordOf(current), status: 'tombstoned', updatedAt: now, reviewedAt: now },
      current.content,
    )
  }

  /** Remove derived semantic text but keep source identities so scans cannot re-create it. */
  forget(memoryId: string): ManagedSemanticMemory {
    const current = this.require(memoryId)
    if (
      current.forgottenAt && current.content === '' &&
      current.description === 'Forgotten semantic memory'
    ) return current
    const now = current.forgottenAt ?? this.now().toISOString()
    const { projectId: _projectId, validFrom: _validFrom, validUntil: _validUntil, supersededBy: _supersededBy, ...record } = this.recordOf(current)
    void _projectId
    void _validFrom
    void _validUntil
    void _supersededBy
    const sourceRefs = current.sourceRefs.map(({ lineDigest: _lineDigest, timeZone: _timeZone, ...source }) => {
      void _lineDigest
      void _timeZone
      return source
    })
    return this.write(
      {
        ...record,
        description: 'Forgotten semantic memory',
        sourceRefs,
        supportingEpisodeIds: [],
        observedAt: now,
        scope: 'global',
        status: 'tombstoned',
        confidence: 0,
        speechAct: 'retracted',
        supersedes: [],
        createdAt: now,
        updatedAt: now,
        reviewedAt: now,
        forgottenAt: now,
      },
      '',
    )
  }

  /** Content-free source identities retained by forgotten records for rebuild suppression. */
  forgottenSourceKeys(): Set<string> {
    const scan = this.scanAll()
    if (scan.malformedCount > 0) {
      throw new Error(
        `Cannot safely generate semantic candidates while ${scan.malformedCount} managed semantic record(s) are malformed; repair or remove them first.`,
      )
    }
    return new Set(scan.records
      .filter((memory) => memory.forgottenAt !== undefined)
      .flatMap((memory) => memory.sourceRefs.map(semanticSourceIdentity)))
  }

  private require(memoryId: string): ManagedSemanticMemory {
    const memory = this.get(memoryId)
    if (!memory) throw new Error(`No valid semantic memory ${memoryId}`)
    return memory
  }

  private recordOf(memory: ManagedSemanticMemory): SemanticMemoryRecord {
    const { content, file, ...record } = memory
    void content
    void file
    return record
  }

  private write(record: SemanticMemoryRecord, content: string): ManagedSemanticMemory {
    const memory = SemanticMemoryRecordSchema.parse(record)
    mkdirSync(this.semanticDir, { recursive: true })
    const file = join(this.semanticDir, `${memory.memoryId}.md`)
    const replacement = serialize(memory, content)
    atomicWriteFileSync(file, replacement, (readBack) => {
      if (readBack !== replacement) throw new Error(`Semantic memory replacement verification failed: ${memory.memoryId}`)
    })
    return { ...memory, content, file }
  }

  private readAll(): ManagedSemanticMemory[] {
    return this.scanAll().records
  }

  private scanAll(): { records: ManagedSemanticMemory[]; malformedCount: number } {
    if (!existsSync(this.semanticDir)) return { records: [], malformedCount: 0 }
    const files: string[] = []
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) visit(file)
        else if (entry.isFile() && entry.name.endsWith('.md')) files.push(file)
      }
    }
    visit(this.semanticDir)
    const records: ManagedSemanticMemory[] = []
    let malformedCount = 0
    for (const file of files) {
      const memory = this.readFile(file)
      if (memory) records.push(memory)
      else malformedCount++
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.memoryId.localeCompare(b.memoryId))
    return { records, malformedCount }
  }

  private readFile(file: string): ManagedSemanticMemory | null {
    if (!existsSync(file)) return null
    try {
      const { attrs, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      const serialized = attrs[SEMANTIC_RECORD_KEY]
      if (!serialized) throw new Error('missing semantic record metadata')
      const record = SemanticMemoryRecordSchema.parse(JSON.parse(serialized))
      if (file.toLowerCase() !== join(this.semanticDir, `${record.memoryId}.md`).toLowerCase()) {
        throw new Error('memory ID does not match its managed file name')
      }
      return { ...record, content: body, file }
    } catch (error) {
      this.onWarn(
        `Skipped malformed semantic memory ${file}: ${(error as Error).message}. Repair or remove it before running \`athena memory candidates\`; run \`athena memory rebuild\` to refresh the linked session index.`,
      )
      return null
    }
  }
}
