import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryHygieneStore } from '../../src/brain/hygiene.js'
import { ContinuityStore } from '../../src/continuity/store.js'
import { generateSemanticCandidates, reviewSemanticCandidate } from '../../src/continuity/candidates.js'
import { formatSemanticCandidateReview } from '../../src/continuity/presentation.js'
import { latestUserMessageSourceRef, SessionStore } from '../../src/harness/sessions.js'

let root: string
let sessionsRoot: string
let continuityStore: ContinuityStore
let semanticStore: MemoryHygieneStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-continuity-candidates-'))
  sessionsRoot = join(root, 'sessions')
  continuityStore = new ContinuityStore(join(root, 'continuity'))
  semanticStore = new MemoryHygieneStore(join(root, 'memory'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function addTurn(project: string, text: string): ReturnType<SessionStore['create']> {
  const session = new SessionStore(sessionsRoot, project).create()
  session.appendMessage({ role: 'user', content: text })
  session.appendMessage({ role: 'assistant', content: 'The statement is preserved with its source.' })
  session.appendEvent({ type: 'turn-done' })
  return session
}

function addJevTurn(
  project: string,
  text: string,
  speechAct: 'preferred' | 'decided' | 'promised' | 'corrected' | 'retracted',
): ReturnType<SessionStore['create']> {
  const sessions = new SessionStore(sessionsRoot, project)
  const session = sessions.create()
  session.appendMessage({ role: 'user', content: text })
  const sourceRef = latestUserMessageSourceRef(session.file, sessions.projectId, session.id)
  if (!sourceRef) throw new Error('Expected a persisted user source reference in the fixture')
  session.appendEvent({
    type: 'jev-speech-act-classification',
    schemaVersion: 1,
    model: 'jev-1.13.0',
    sourceRef,
    speechAct,
    confidence: 0.99,
  })
  session.appendMessage({ role: 'assistant', content: 'The statement is preserved with its source.' })
  session.appendEvent({ type: 'turn-done' })
  return session
}

function mutateSemanticRecord(memoryId: string, update: (record: Record<string, unknown>) => void): void {
  const memory = semanticStore.get(memoryId)!
  const lines = readFileSync(memory.file, 'utf8').split('\n')
  const recordLine = lines.findIndex((line) => line.startsWith('athena-semantic-record: '))
  const record = JSON.parse(lines[recordLine]!.slice('athena-semantic-record: '.length)) as Record<string, unknown>
  update(record)
  lines[recordLine] = `athena-semantic-record: ${JSON.stringify(record)}`
  writeFileSync(memory.file, lines.join('\n'), 'utf8')
}

describe('source-verified semantic candidate generation', () => {
  it('uses high-confidence, message-linked Jev labels for indirect repeated preferences', () => {
    addJevTurn('C:/projects/jev-intake', 'I would like concise paragraphs as my default.', 'preferred')
    addJevTurn('C:/projects/jev-intake', 'I would like concise paragraphs as my default.', 'preferred')
    continuityStore.rebuild(sessionsRoot)

    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const [candidate] = semanticStore.listAll()

    expect(result.createdCount).toBe(1)
    expect(candidate).toMatchObject({
      status: 'candidate',
      speechAct: 'preferred',
      content: 'I would like concise paragraphs as my default.',
    })
    expect(semanticStore.listActive()).toEqual([])

    const promoted = reviewSemanticCandidate(
      semanticStore,
      continuityStore,
      sessionsRoot,
      candidate!.memoryId,
      'promote',
    )
    expect(promoted.status).toBe('active')
  })

  it('records corrections and retractions for continuity without inferring them as durable preferences', () => {
    addJevTurn('C:/projects/jev-corrections', 'Correction: concise paragraphs are not my default.', 'corrected')
    addJevTurn('C:/projects/jev-corrections', 'I retract the earlier concise-paragraph preference.', 'retracted')
    continuityStore.rebuild(sessionsRoot)

    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)

    expect(continuityStore.listEpisodes().flatMap((episode) => episode.speechActs)).toEqual(
      expect.arrayContaining(['corrected', 'retracted']),
    )
    expect(result.createdCount).toBe(0)
    expect(semanticStore.listAll()).toEqual([])
  })

  it('creates a reviewable project candidate from the same direct preference across distinct sessions', () => {
    addTurn('C:/projects/alpha', 'I prefer source-linked conversation memory.')
    addTurn('C:/projects/alpha', 'I prefer source-linked conversation memory!')
    continuityStore.rebuild(sessionsRoot)

    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const [candidate] = semanticStore.listAll()

    expect(result).toMatchObject({ state: 'ready', createdCount: 1, updatedCount: 0, unchangedCount: 0 })
    expect(candidate).toMatchObject({
      status: 'candidate',
      captureMode: 'inferred',
      scope: 'project',
      speechAct: 'preferred',
      sensitivity: 'ordinary',
      supportingEpisodeIds: expect.arrayContaining(continuityStore.listEpisodes().map((episode) => episode.id)),
    })
    expect(candidate?.sourceRefs).toHaveLength(2)
    expect(candidate?.sourceRefs.every((source) => source.projectId === candidate.projectId)).toBe(true)
    expect(candidate?.content.toLowerCase()).toContain('i prefer source-linked conversation memory')
    expect(semanticStore.listActive()).toEqual([])

    const manyCandidates = Array.from({ length: 25 }, (_, index) => ({
      ...candidate!,
      memoryId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    }))
    const review = formatSemanticCandidateReview(result, manyCandidates)
    expect(review).toContain('25 candidate(s); showing 20.')
    expect(review.match(/\| project /g)).toHaveLength(20)
    expect(review).not.toContain(manyCandidates[24]!.memoryId)
  })

  it('is idempotent and broadens scope only after repeated evidence crosses projects', () => {
    addTurn('C:/projects/alpha', 'I decided to keep continuity data source linked.')
    addTurn('C:/projects/alpha', 'I decided to keep continuity data source linked.')
    continuityStore.rebuild(sessionsRoot)
    const first = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const candidateId = semanticStore.listAll()[0]?.memoryId

    addTurn('C:/projects/beta', 'I decided to keep continuity data source linked.')
    continuityStore.rebuild(sessionsRoot)
    const second = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const third = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const [candidate] = semanticStore.listAll()

    expect(first.createdCount).toBe(1)
    expect(second).toMatchObject({ createdCount: 0, updatedCount: 1 })
    expect(third).toMatchObject({ createdCount: 0, updatedCount: 0, unchangedCount: 1 })
    expect(semanticStore.listAll()).toHaveLength(1)
    expect(candidate).toMatchObject({ memoryId: candidateId, scope: 'global' })
    expect(candidate).not.toHaveProperty('projectId')
    expect(candidate?.supportingEpisodeIds).toHaveLength(3)
    expect(new Set(candidate?.sourceRefs.map((source) => source.projectId)).size).toBe(2)
  })

  it('does not recreate an explicitly rejected claim during later candidate scans', () => {
    addTurn('C:/projects/review', 'I prefer memory decisions to stay reviewable.')
    addTurn('C:/projects/review', 'I prefer memory decisions to stay reviewable.')
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const candidate = semanticStore.listAll()[0]!
    semanticStore.reject(candidate.memoryId)

    addTurn('C:/projects/review', 'I prefer memory decisions to stay reviewable.')
    continuityStore.rebuild(sessionsRoot)
    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)

    expect(result).toMatchObject({ createdCount: 0, updatedCount: 0, unchangedCount: 1 })
    expect(semanticStore.listAll()).toHaveLength(1)
    expect(semanticStore.get(candidate.memoryId)).toMatchObject({ status: 'rejected' })
  })

  it('does not recreate a forgotten claim from the same source lines after rebuild', () => {
    addTurn('C:/projects/forgotten', 'I prefer memory decisions to stay source linked.')
    addTurn('C:/projects/forgotten', 'I prefer memory decisions to stay source linked.')
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const candidate = semanticStore.listAll()[0]!

    semanticStore.forget(candidate.memoryId)
    continuityStore.rebuild(sessionsRoot)
    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)

    expect(result).toMatchObject({ createdCount: 0, updatedCount: 0, unchangedCount: 0 })
    expect(semanticStore.listAll()).toHaveLength(1)
    expect(semanticStore.get(candidate.memoryId)).toMatchObject({
      status: 'tombstoned',
      content: '',
      supportingEpisodeIds: [],
      forgottenAt: expect.any(String),
    })
    expect(semanticStore.get(candidate.memoryId)?.sourceRefs.every((source) =>
      !('lineDigest' in source) && !('timeZone' in source),
    )).toBe(true)
  })

  it('fails closed when a semantic tombstone needed for forget suppression is malformed', () => {
    addTurn('C:/projects/corrupt-forget', 'I prefer corrupted forget records to fail closed.')
    addTurn('C:/projects/corrupt-forget', 'I prefer corrupted forget records to fail closed.')
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const candidate = semanticStore.listAll()[0]!
    semanticStore.forget(candidate.memoryId)
    writeFileSync(candidate.file, 'not a managed semantic record', 'utf8')
    continuityStore.rebuild(sessionsRoot)

    expect(() => generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore))
      .toThrow(/cannot safely generate semantic candidates.*malformed/i)
    expect(semanticStore.listAll()).toEqual([])
  })

  it('does not create an inferred duplicate when an explicit active memory already states the claim', () => {
    addTurn('C:/projects/explicit', 'I prefer explicit memory to stay local and source-linked.')
    addTurn('C:/projects/explicit', 'I prefer explicit memory to stay local and source-linked.')
    continuityStore.rebuild(sessionsRoot)
    const episodes = continuityStore.listEpisodes()
    const [latest] = episodes.slice(-1)
    const explicit = semanticStore.create({
      description: 'User-specified preference',
      content: 'I prefer explicit memory to stay local and source-linked.',
      sourceRefs: latest!.sourceRefs,
      supportingEpisodeIds: [latest!.id],
      observedAt: latest!.observedAt,
      scope: 'project',
      projectId: latest!.projectId!,
      speechAct: 'preferred',
      captureMode: 'explicit',
      confidence: 1,
      sensitivity: 'ordinary',
    })

    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)

    expect(result).toMatchObject({ createdCount: 0, updatedCount: 0, unchangedCount: 1 })
    expect(semanticStore.listAll()).toHaveLength(1)
    expect(semanticStore.get(explicit.memoryId)).toMatchObject({ status: 'active', captureMode: 'explicit' })
  })

  it('requires distinct sessions and excludes tentative, interrogative, assistant-authored, and stale evidence', () => {
    const sameSession = new SessionStore(sessionsRoot, 'C:/projects/one-session').create()
    for (let index = 0; index < 2; index++) {
      sameSession.appendMessage({ role: 'user', content: 'I prefer one source-linked memory.' })
      sameSession.appendEvent({ type: 'turn-done' })
    }
    addTurn('C:/projects/hypothetical', 'Maybe I prefer source-linked memory.')
    addTurn('C:/projects/question', 'Do I prefer source-linked memory?')
    const assistantOnly = new SessionStore(sessionsRoot, 'C:/projects/assistant').create()
    assistantOnly.appendMessage({ role: 'user', content: 'What is the preference?' })
    assistantOnly.appendMessage({ role: 'assistant', content: 'I prefer source-linked memory.' })
    assistantOnly.appendEvent({ type: 'turn-done' })
    addTurn('C:/projects/stale-a', 'I prefer linked episodes with context.')
    const stale = addTurn('C:/projects/stale-b', 'I prefer linked episodes with context.')
    continuityStore.rebuild(sessionsRoot)
    const records = readFileSync(stale.file, 'utf8').trimEnd().split('\n')
    const first = JSON.parse(records[0]!) as { data: { content: string } }
    first.data.content = 'I prefer a changed source that no longer matches the index.'
    records[0] = JSON.stringify(first)
    writeFileSync(stale.file, `${records.join('\n')}\n`, 'utf8')

    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)

    expect(result.createdCount).toBe(0)
    expect(semanticStore.listAll()).toEqual([])
  })

  it('skips claim episodes whose source context exceeds the verified message bound', () => {
    for (let index = 0; index < 2; index++) {
      const session = new SessionStore(sessionsRoot, `C:/projects/oversized-${index}`).create()
      session.appendMessage({ role: 'user', content: 'I prefer bounded source-linked claims.' })
      for (let message = 0; message < 9; message++) {
        session.appendMessage({ role: 'assistant', content: `Additional context ${message}.` })
      }
      session.appendEvent({ type: 'turn-done' })
    }
    continuityStore.rebuild(sessionsRoot)

    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)

    expect(result.createdCount).toBe(0)
    expect(semanticStore.listAll()).toEqual([])
  })

  it('refuses to promote a candidate after any supporting source has changed', () => {
    const first = addTurn('C:/projects/promotion', 'I prefer verifying a candidate again before promotion.')
    const second = addTurn('C:/projects/promotion', 'I prefer verifying a candidate again before promotion.')
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const candidate = semanticStore.listAll()[0]!

    const lines = readFileSync(second.file, 'utf8').trimEnd().split('\n')
    const sourceRef = candidate.sourceRefs.find((source) => source.sessionId === second.id)!
    const lineIndex = lines.findIndex((line) => line.includes(sourceRef.recordId))
    const sourceLine = JSON.parse(lines[lineIndex]!) as { data: { content: string } }
    sourceLine.data.content = 'I prefer different content than the candidate records.'
    lines[lineIndex] = JSON.stringify(sourceLine)
    writeFileSync(second.file, `${lines.join('\n')}\n`, 'utf8')

    expect(first.id).not.toBe(second.id)
    expect(() => reviewSemanticCandidate(
      semanticStore,
      continuityStore,
      sessionsRoot,
      candidate.memoryId,
      'promote',
    )).toThrow(/source verification/i)
    expect(semanticStore.get(candidate.memoryId)?.status).toBe('candidate')
  })

  it('rechecks inferred scope against the projects in its supporting sources', () => {
    addTurn('C:/projects/scope-a', 'I prefer continuity claims to stay source linked.')
    addTurn('C:/projects/scope-b', 'I prefer continuity claims to stay source linked.')
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const candidate = semanticStore.listAll()[0]!
    mutateSemanticRecord(candidate.memoryId, (record) => {
      record.scope = 'project'
      record.projectId = candidate.sourceRefs[0]!.projectId
    })

    expect(() => reviewSemanticCandidate(
      semanticStore,
      continuityStore,
      sessionsRoot,
      candidate.memoryId,
      'promote',
    )).toThrow(/source verification/i)
    expect(semanticStore.get(candidate.memoryId)?.status).toBe('candidate')
  })

  it('rechecks inferred observation time against the newest verified source', () => {
    addTurn('C:/projects/observation', 'I prefer observation times from the source record.')
    addTurn('C:/projects/observation', 'I prefer observation times from the source record.')
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    const candidate = semanticStore.listAll()[0]!
    mutateSemanticRecord(candidate.memoryId, (record) => { record.observedAt = '2025-01-01T00:00:00.000Z' })

    expect(() => reviewSemanticCandidate(
      semanticStore,
      continuityStore,
      sessionsRoot,
      candidate.memoryId,
      'promote',
    )).toThrow(/observation time/i)
    expect(semanticStore.get(candidate.memoryId)?.status).toBe('candidate')
  })

  it('keeps sensitive repeated claims source-only and keeps incomplete catalogs read-only', () => {
    addTurn('C:/projects/alpha', 'I prefer keeping my salary details private.')
    addTurn('C:/projects/beta', 'I prefer keeping my salary details private.')
    continuityStore.rebuild(sessionsRoot)
    const generated = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)
    expect(generated.createdCount).toBe(0)
    expect(semanticStore.listAll()).toEqual([])
    const review = formatSemanticCandidateReview(generated, [])
    expect(review).toContain('No repeated direct claims met the source-verification and independence rules.')
    expect(review).not.toContain('salary')

    const partialStore = new ContinuityStore(join(root, 'partial'))
    partialStore.indexSession(sessionsRoot, new SessionStore(sessionsRoot, 'C:/projects/alpha').projectId, 'missing-session')
    const result = generateSemanticCandidates(partialStore, sessionsRoot, semanticStore)
    expect(result.state).toBe('partial')
  })

  it('does not copy an unredacted credential-shaped source into inferred semantic memory', () => {
    const secret = 'sk-ant-api03-supersecretvalue123'
    const text = `I prefer source-linked memory. ${secret}`
    const first = addTurn('C:/projects/secret-a', text)
    const second = addTurn('C:/projects/secret-b', text)
    for (const session of [first, second]) {
      const lines = readFileSync(session.file, 'utf8').trimEnd().split('\n')
      const userLineIndex = lines.findIndex((line) => line.includes('"role":"user"'))
      const userLine = JSON.parse(lines[userLineIndex]!) as { data: { content: string } }
      userLine.data.content = userLine.data.content.replace('[REDACTED]', secret)
      lines[userLineIndex] = JSON.stringify(userLine)
      writeFileSync(session.file, `${lines.join('\n')}\n`, 'utf8')
    }
    continuityStore.rebuild(sessionsRoot)

    const result = generateSemanticCandidates(continuityStore, sessionsRoot, semanticStore)

    expect(result.createdCount).toBe(0)
    expect(semanticStore.listAll()).toEqual([])
    expect(continuityStore.listEpisodes().every((episode) => !episode.summary.includes(secret))).toBe(true)
  })
})
