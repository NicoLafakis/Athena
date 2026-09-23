import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryTool } from '../../src/tools/memory.js'
import { MemoryHygieneStore } from '../../src/brain/hygiene.js'
import { ContinuityStore } from '../../src/continuity/store.js'
import { SessionStore } from '../../src/harness/sessions.js'
import { generateSemanticCandidates } from '../../src/continuity/candidates.js'
import { makeCtx } from '../helpers/tool-ctx.js'

const sourceRef = {
  kind: 'session-message' as const,
  projectId: 'project-one',
  sessionId: 'session-one',
  recordId: 'line-one',
  timestamp: '2026-09-23T15:00:00.000Z',
  timeZone: 'America/New_York',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-memory-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const memFile = (rel: string) => join(dir, 'memory', rel)
const indexFile = () => join(dir, 'memory', 'MEMORY.md')

describe('memoryTool', () => {
  it('write creates the file and appends an index line to MEMORY.md', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute(
      { op: 'write', path: 'facts/x.md', content: 'fact body', description: 'a fact' },
      ctx,
    )
    expect(res.isError).toBe(false)
    expect(existsSync(memFile(join('facts', 'x.md')))).toBe(true)
    const idx = readFileSync(indexFile(), 'utf8')
    expect(idx).toContain('[facts/x.md]')
    expect(idx).toContain('a fact')
  })

  it('list returns relative paths, read returns content, delete removes file and index line', async () => {
    const ctx = makeCtx(dir)
    await memoryTool.execute({ op: 'write', path: 'facts/x.md', content: 'fact body' }, ctx)
    await memoryTool.execute({ op: 'write', path: 'top.md', content: 'top fact' }, ctx)

    const listRes = await memoryTool.execute({ op: 'list' }, ctx)
    expect(listRes.isError).toBe(false)
    expect(listRes.output).toContain('facts/x.md')
    expect(listRes.output).toContain('top.md')

    const readRes = await memoryTool.execute({ op: 'read', path: 'facts/x.md' }, ctx)
    expect(readRes.isError).toBe(false)
    expect(readRes.output).toBe('fact body')

    const delRes = await memoryTool.execute({ op: 'delete', path: 'facts/x.md' }, ctx)
    expect(delRes.isError).toBe(false)
    expect(existsSync(memFile(join('facts', 'x.md')))).toBe(false)
    expect(readFileSync(indexFile(), 'utf8')).not.toContain('[facts/x.md]')
  })

  it('write without description uses the first content line for the index', async () => {
    const ctx = makeCtx(dir)
    await memoryTool.execute({ op: 'write', path: 'y.md', content: 'first line\nsecond' }, ctx)
    expect(readFileSync(indexFile(), 'utf8')).toContain('first line')
  })

  it('rejects paths escaping the memory dir', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'read', path: '../settings.json' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/escapes/i)
  })

  it('read of a missing file errors', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'read', path: 'nope.md' }, ctx)
    expect(res.isError).toBe(true)
  })

  it('read/write/delete without path errors', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'read' }, ctx)
    expect(res.isError).toBe(true)
  })

  it('rejects write and delete of the reserved MEMORY.md index (any case)', async () => {
    const ctx = makeCtx(dir)
    for (const name of ['MEMORY.md', 'memory.md', 'Memory.MD', './MEMORY.md']) {
      const res = await memoryTool.execute({ op: 'write', path: name, content: 'x' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.output).toMatch(/reserved/i)
    }
    const del = await memoryTool.execute({ op: 'delete', path: 'MEMORY.md' }, ctx)
    expect(del.isError).toBe(true)
    expect(del.output).toMatch(/reserved/i)
  })

  it('still allows reading MEMORY.md', async () => {
    const ctx = makeCtx(dir)
    await memoryTool.execute({ op: 'write', path: 'x.md', content: 'fact' }, ctx)
    const res = await memoryTool.execute({ op: 'read', path: 'MEMORY.md' }, ctx)
    expect(res.isError).toBe(false)
    expect(res.output).toContain('[x.md]')
  })

  it('list on empty memory reports empty', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute({ op: 'list' }, ctx)
    expect(res.isError).toBe(false)
    expect(res.output).toBe('(memory is empty)')
  })

  it('requires a persisted current-user source before remembering a semantic fact', async () => {
    const ctx = makeCtx(dir)
    const res = await memoryTool.execute(
      { op: 'remember', content: 'I prefer linked episodes.', speechAct: 'preferred' },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/persisted user message/i)
    expect(existsSync(join(dir, 'memory', 'semantic'))).toBe(false)
  })

  it('stores explicit memories with server-authored source references outside the injected index', async () => {
    const ctx = makeCtx(dir, { getCurrentUserSourceRef: () => sourceRef })
    const res = await memoryTool.execute(
      {
        op: 'remember',
        description: 'Continuity preference',
        content: 'I prefer linked episodes across projects.',
        speechAct: 'preferred',
        scope: 'global',
        sensitivity: 'ordinary',
      },
      ctx,
    )

    expect(res.isError).toBe(false)
    expect(res.output).toMatch(/active semantic memory/i)
    const files = await memoryTool.execute({ op: 'list' }, ctx)
    expect(files.output).toContain('semantic/')
    expect(existsSync(indexFile())).toBe(false)
    const semanticDir = join(dir, 'memory', 'semantic')
    const file = readdirSync(semanticDir).find((name) => name.endsWith('.md'))!
    const saved = readFileSync(join(semanticDir, file), 'utf8')
    expect(saved).toContain('I prefer linked episodes across projects.')
    expect(saved).toContain('"recordId":"line-one"')
  })

  it('prevents generic memory writes and deletes from bypassing semantic lifecycle metadata', async () => {
    const ctx = makeCtx(dir, { getCurrentUserSourceRef: () => sourceRef })
    const remembered = await memoryTool.execute(
      { op: 'remember', content: 'I prefer citations.', speechAct: 'preferred' },
      ctx,
    )
    expect(remembered.isError).toBe(false)
    const listed = await memoryTool.execute({ op: 'list' }, ctx)
    const path = listed.output.split('\n').find((line) => line.startsWith('semantic/'))!
    const write = await memoryTool.execute({ op: 'write', path, content: 'untracked replacement' }, ctx)
    const remove = await memoryTool.execute({ op: 'delete', path }, ctx)
    expect(write.isError).toBe(true)
    expect(remove.isError).toBe(true)
  })

  it('renders managed semantic memory without exposing its internal source identifiers', async () => {
    const ctx = makeCtx(dir, { getCurrentUserSourceRef: () => sourceRef })
    const created = new MemoryHygieneStore(join(dir, 'memory')).create({
      description: 'A remembered preference',
      content: 'I prefer linked episodes.',
      sourceRefs: [sourceRef],
      speechAct: 'preferred',
      captureMode: 'explicit',
      confidence: 1,
      sensitivity: 'ordinary',
    })
    const res = await memoryTool.execute({ op: 'read', path: `semantic/${created.memoryId}.md` }, ctx)
    expect(res.isError).toBe(false)
    expect(res.output).toContain('I prefer linked episodes.')
    expect(res.output).not.toContain('line-one')
  })

  it('reviews only source-backed inferred candidates', async () => {
    const ctx = makeCtx(dir)
    const store = new MemoryHygieneStore(join(dir, 'memory'))
    const sessionsRoot = join(dir, 'sessions')
    for (let index = 0; index < 2; index++) {
      const session = new SessionStore(sessionsRoot, 'C:/projects/memory-tool-review').create()
      session.appendMessage({ role: 'user', content: 'I prefer linked episodes across projects.' })
      session.appendMessage({ role: 'assistant', content: 'The source can be verified.' })
      session.appendEvent({ type: 'turn-done' })
    }
    const continuityStore = new ContinuityStore(join(dir, 'continuity'))
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, store)
    const candidate = store.listAll()[0]!

    const res = await memoryTool.execute({ op: 'review', memoryId: candidate.memoryId, decision: 'promote' }, ctx)
    expect(res.isError).toBe(false)
    expect(store.get(candidate.memoryId)?.status).toBe('active')
    expect(store.get(candidate.memoryId)?.content).toBe(candidate.content)
  })

  it('refuses Memory tool promotion when a candidate source changed after generation', async () => {
    const ctx = makeCtx(dir)
    const store = new MemoryHygieneStore(join(dir, 'memory'))
    const sessionsRoot = join(dir, 'sessions')
    const sourceSessions: Array<ReturnType<SessionStore['create']>> = []
    for (let index = 0; index < 2; index++) {
      const session = new SessionStore(sessionsRoot, `C:/projects/memory-tool-stale-${index}`).create()
      session.appendMessage({ role: 'user', content: 'I prefer current evidence for memory review.' })
      session.appendMessage({ role: 'assistant', content: 'This statement has a source.' })
      session.appendEvent({ type: 'turn-done' })
      sourceSessions.push(session)
    }
    const continuityStore = new ContinuityStore(join(dir, 'continuity'))
    continuityStore.rebuild(sessionsRoot)
    generateSemanticCandidates(continuityStore, sessionsRoot, store)
    const candidate = store.listAll()[0]!
    const sourceRef = candidate.sourceRefs.find((source) => source.sessionId === sourceSessions[1]!.id)!
    const records = readFileSync(sourceSessions[1]!.file, 'utf8').trimEnd().split('\n')
    const lineIndex = records.findIndex((line) => line.includes(sourceRef.recordId))
    const source = JSON.parse(records[lineIndex]!) as { data: { content: string } }
    source.data.content = 'This is no longer the supporting claim.'
    records[lineIndex] = JSON.stringify(source)
    writeFileSync(sourceSessions[1]!.file, `${records.join('\n')}\n`, 'utf8')

    const result = await memoryTool.execute(
      { op: 'review', memoryId: candidate.memoryId, decision: 'promote' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/source verification/i)
    expect(store.get(candidate.memoryId)?.status).toBe('candidate')
  })

  it('supersedes an active semantic memory with the current correction source', async () => {
    const ctx = makeCtx(dir, { getCurrentUserSourceRef: () => sourceRef })
    const store = new MemoryHygieneStore(join(dir, 'memory'))
    const prior = store.create({
      description: 'Theme preference',
      content: 'The user prefers dark mode.',
      sourceRefs: [{ ...sourceRef, recordId: 'old-line' }],
      speechAct: 'preferred',
      captureMode: 'explicit',
      confidence: 1,
      sensitivity: 'ordinary',
    })

    const res = await memoryTool.execute(
      { op: 'supersede', memoryId: prior.memoryId, content: 'The user now prefers light mode.' },
      ctx,
    )
    const updated = store.get(prior.memoryId)!
    expect(res.isError).toBe(false)
    expect(updated.status).toBe('superseded')
    expect(updated.content).toBe('The user prefers dark mode.')
    expect(store.get(updated.supersededBy!)?.sourceRefs).toEqual([sourceRef])
  })
})
