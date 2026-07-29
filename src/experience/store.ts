import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../tools/files.js'
import { ExperienceRecordSchema, GuidanceRecordSchema } from './schemas.js'
import type { ExperienceRecord, GuidanceRecord } from './types.js'

export interface ExperienceStoreOptions {
  onWarn?: (warning: string) => void
  maxRecords?: number
  maxFileChars?: number
}

export class ExperienceStore {
  private readonly experienceFile: string
  private readonly guidanceFile: string
  private readonly warned = new Set<string>()

  constructor(root: string, private readonly options: ExperienceStoreOptions = {}) {
    this.experienceFile = join(root, 'experiences.jsonl')
    this.guidanceFile = join(root, 'guidance.jsonl')
  }

  listExperiences(): ExperienceRecord[] {
    return this.readLatest(this.experienceFile, ExperienceRecordSchema)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  listGuidance(): GuidanceRecord[] {
    return this.readLatest(this.guidanceFile, GuidanceRecordSchema)
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  appendExperience(input: ExperienceRecord): void {
    const record = ExperienceRecordSchema.parse(input)
    const records = this.listExperiences()
    const existing = records.find((item) => item.id === record.id)
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(record)) return
      throw new Error(`Experience ${record.id} already exists with different content`)
    }
    this.assertRecordCapacity(records.length, 'experience')
    this.append(this.experienceFile, record)
  }

  appendGuidance(input: GuidanceRecord): void {
    const record = GuidanceRecordSchema.parse(input)
    const records = this.listGuidance()
    if (records.some((item) => item.id === record.id)) {
      throw new Error(`Guidance ${record.id} already exists`)
    }
    this.assertRecordCapacity(records.length, 'guidance')
    this.append(this.guidanceFile, record)
  }

  reviewGuidance(
    id: string,
    status: GuidanceRecord['status'],
    confidence: number,
    reviewedAt = new Date().toISOString(),
  ): GuidanceRecord {
    const current = this.listGuidance().find((item) => item.id === id)
    if (!current) throw new Error(`Unknown guidance ${id}`)
    const allowed = current.status === 'provisional'
      ? ['active', 'retired']
      : current.status === 'active'
        ? ['retired']
        : []
    if (!allowed.includes(status)) {
      throw new Error(`Invalid guidance transition ${current.status} -> ${status}`)
    }
    const updated = GuidanceRecordSchema.parse({
      ...current,
      status,
      confidence,
      reviewedAt,
    })
    this.append(this.guidanceFile, updated)
    return updated
  }

  private readLatest<T extends { id: string }>(
    file: string,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  ): T[] {
    if (!existsSync(file)) return []
    const latest = new Map<string, T>()
    let lines: string[]
    try {
      if (statSync(file).size > this.maxFileChars()) {
        this.warnFile(file, 'exceeds its configured size limit')
        return []
      }
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      this.warnFile(file, 'could not be read')
      return []
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (!line.trim()) continue
      try {
        const parsedJson = JSON.parse(line) as unknown
        const parsed = schema.safeParse(parsedJson)
        if (!parsed.success || !parsed.data) throw new Error('schema rejected record')
        latest.set(parsed.data.id, parsed.data)
      } catch {
        this.warn(file, index + 1)
      }
    }
    return [...latest.values()]
  }

  private append(file: string, record: ExperienceRecord | GuidanceRecord): void {
    let previous = ''
    try {
      previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
    } catch {
      throw new Error(`Experience index ${file} could not be read; existing data was left unchanged`)
    }
    const next = previous + JSON.stringify(record) + '\n'
    if (next.length > this.maxFileChars()) {
      throw new Error(`Experience index ${file} reached its configured size limit; existing data was left unchanged`)
    }
    atomicWriteFileSync(file, next)
  }

  private assertRecordCapacity(count: number, kind: string): void {
    if (count >= (this.options.maxRecords ?? 1_000)) {
      throw new Error(`Experience ${kind} index reached its configured record limit`)
    }
  }

  private maxFileChars(): number {
    return this.options.maxFileChars ?? 5_000_000
  }

  private warn(file: string, line: number): void {
    const key = `${file}:${line}`
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.options.onWarn?.(
      `Experience index ${file} has an invalid record at line ${line}; valid records remain available. Run \`athena experience rebuild\` to recover the optional index.`,
    )
  }

  private warnFile(file: string, reason: string): void {
    const key = `${file}:${reason}`
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.options.onWarn?.(
      `Experience index ${file} ${reason}; no guidance was loaded. Run \`athena experience rebuild\` to recover the optional index.`,
    )
  }
}
