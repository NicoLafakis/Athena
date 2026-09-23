import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  readSessionLineRecords,
  readSessionLineRecordsDetailed,
  stableSessionLineId,
  type SessionLineRecord,
} from '../harness/sessions.js'

export { readSessionLineRecords }
export { readSessionLineRecordsDetailed }
export { stableSessionLineId }
export type { SessionLineRecord }

export interface ProjectSessionSource {
  projectId: string
  sessionId: string
  /** Ephemeral path for source reads; never persist it in a continuity record. */
  file: string
}

export interface CanonicalSessionLine extends SessionLineRecord {
  sourceLineId: string
}

export interface ResolvedLineageSegment {
  projectId: string
  sessionId: string
  throughLineId: string
  records: CanonicalSessionLine[]
}

export interface SessionLineageResolution {
  ancestors: ResolvedLineageSegment[]
  complete: boolean
  issues: string[]
}

const ProjectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
const SessionIdPattern = /^([A-Za-z0-9][A-Za-z0-9._-]{0,255})\.jsonl$/

/** Enumerate direct, regular session files without following links or entering trash. */
export function listAllProjectSessions(sessionsRoot: string): ProjectSessionSource[] {
  if (!existsSync(sessionsRoot)) return []
  const sources: ProjectSessionSource[] = []

  for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory() || !ProjectIdPattern.test(project.name)) continue
    const projectDir = join(sessionsRoot, project.name)
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const match = SessionIdPattern.exec(entry.name)
      if (!match) continue
      sources.push({
        projectId: project.name,
        sessionId: match[1]!,
        file: join(projectDir, entry.name),
      })
    }
  }

  return sources.sort(
    (left, right) =>
      left.projectId.localeCompare(right.projectId) || left.sessionId.localeCompare(right.sessionId),
  )
}

/** Only original message and event lines are source material; state snapshots duplicate text. */
export function canonicalSessionRecords(records: SessionLineRecord[]): CanonicalSessionLine[] {
  return records
    .filter(({ line }) => line.kind === 'message' || line.kind === 'event')
    .map((record) => ({ ...record, sourceLineId: stableSessionLineId(record) }))
}

interface SessionForkEvent {
  type: 'session-fork'
  sourceProjectId?: unknown
  sourceSessionId?: unknown
  sourceLineId?: unknown
}

function isSessionFork(line: SessionLineRecord['line']): line is SessionLineRecord['line'] & { data: SessionForkEvent } {
  return (
    line.kind === 'event' &&
    typeof line.data === 'object' &&
    line.data !== null &&
    (line.data as { type?: unknown }).type === 'session-fork'
  )
}

/** Resolve inherited source context by immutable fork boundaries, never by copied snapshots. */
export function resolveSessionLineage(
  sessionsRoot: string,
  source: ProjectSessionSource,
  maxDepth = 32,
): SessionLineageResolution {
  const sources = new Map(
    listAllProjectSessions(sessionsRoot).map((item) => [`${item.projectId}\0${item.sessionId}`, item]),
  )
  const ancestors: ResolvedLineageSegment[] = []
  const issues: string[] = []
  const visited = new Set([`${source.projectId}\0${source.sessionId}`])
  let current = source

  for (let depth = 0; depth < maxDepth; depth++) {
    let records: SessionLineRecord[]
    try {
      records = readSessionLineRecords(current.file)
    } catch {
      issues.push(`Could not read session ${current.projectId}/${current.sessionId}`)
      break
    }

    const forkRecord = records.find(({ line }) => isSessionFork(line))
    if (!forkRecord || !isSessionFork(forkRecord.line)) break
    const fork = forkRecord.line.data
    if (
      typeof fork.sourceProjectId !== 'string' ||
      typeof fork.sourceSessionId !== 'string' ||
      typeof fork.sourceLineId !== 'string'
    ) {
      issues.push('Fork source does not include a stable project and line boundary')
      break
    }

    const parentKey = `${fork.sourceProjectId}\0${fork.sourceSessionId}`
    if (visited.has(parentKey)) {
      issues.push('Fork lineage contains a cycle')
      break
    }
    visited.add(parentKey)
    const parent = sources.get(parentKey)
    if (!parent) {
      issues.push(`Fork source ${fork.sourceProjectId}/${fork.sourceSessionId} is unavailable`)
      break
    }

    let parentRecords: SessionLineRecord[]
    try {
      parentRecords = readSessionLineRecords(parent.file)
    } catch {
      issues.push(`Could not read fork source ${parent.projectId}/${parent.sessionId}`)
      break
    }
    const boundaryIndex = parentRecords.findIndex(
      (record) => stableSessionLineId(record) === fork.sourceLineId,
    )
    if (boundaryIndex < 0) {
      issues.push(`Fork boundary ${fork.sourceLineId} is unavailable in ${parent.projectId}/${parent.sessionId}`)
      break
    }

    ancestors.push({
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      throughLineId: fork.sourceLineId,
      records: canonicalSessionRecords(parentRecords.slice(0, boundaryIndex + 1)),
    })
    current = parent
    // Fork events describe the session's origin, not a conversational turn. A child
    // can name its parent's initial checkpoint, which precedes that metadata line.
  }

  if (ancestors.length >= maxDepth) issues.push(`Fork lineage exceeds the maximum depth of ${maxDepth}`)
  return { ancestors, complete: issues.length === 0, issues }
}
