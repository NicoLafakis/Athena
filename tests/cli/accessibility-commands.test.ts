import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSlashHandler } from '../../src/cli.js'
import { EngineEventBus } from '../../src/engine/events.js'
import type { EngineEvent } from '../../src/engine/types.js'
import { InteractionService } from '../../src/interaction/service.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { MemoryHygieneStore } from '../../src/brain/hygiene.js'
import { SessionStore } from '../../src/harness/sessions.js'
import { ContinuityStore } from '../../src/continuity/store.js'
import { parseSlash } from '../../src/tui/slash.js'

let temp: string
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true })
})

describe('local accessibility commands', () => {
  it('serves status, repeat, details, and verbosity without touching the model', () => {
    const bus = new EngineEventBus()
    const events: EngineEvent[] = []
    bus.on((event) => events.push(event))
    const forbiddenEngine = new Proxy({}, {
      get: (_target, key) => {
        throw new Error(`local command accessed engine.${String(key)}`)
      },
    })
    const handler = makeSlashHandler({
      bus,
      engine: forbiddenEngine,
      gate: {},
      contextManager: {},
      client: {},
      store: {},
      session: null,
      paths: {},
      credentialVault: {},
      interactionService: new InteractionService(),
      runId: 'run-local',
      permissionDetails: (id: string) => id === 'permission:one' ? '+ bounded detail' : null,
    } as unknown as Parameters<typeof makeSlashHandler>[0])

    handler({ kind: 'status' })
    handler({ kind: 'repeat' })
    handler({ kind: 'details', value: '' })
    handler({ kind: 'details', value: 'permission permission:one' })
    handler({ kind: 'verbosity', value: 'detailed' })

    const messages = events
      .filter((event): event is Extract<EngineEvent, { type: 'info' }> => event.type === 'info')
      .map((event) => event.message)
    expect(messages).toEqual([
      'Status: no semantic state is available for this run.',
      'No material announcement is available. Use /status.',
      'No material detail is available. Use /status.',
      '+ bounded detail',
      'Status: Announcement verbosity is detailed for this session.',
    ])
  })

  it('serves memory timeline, search, status, rebuild, show, and rollup through the shared slash handler', () => {
    temp = mkdtempSync(join(tmpdir(), 'athena-slash-memory-'))
    const paths = resolveBrainPaths({ cwd: temp, homeOverride: temp })
    const session = new SessionStore(paths.sessionsDir, 'C:/project/memory').create()
    session.appendMessage({ role: 'user', content: 'Earlier we were comparing memory approaches.' })
    session.appendMessage({ role: 'assistant', content: 'No choice had been made yet.' })
    session.appendEvent({ type: 'turn-done' })
    session.appendMessage({ role: 'user', content: 'We decided to keep the memory index local.' })
    session.appendMessage({ role: 'assistant', content: 'Each result remains linked to its session.' })
    session.appendEvent({ type: 'turn-done' })
    session.appendMessage({ role: 'user', content: 'One further detail about memory context.' })
    session.appendMessage({ role: 'assistant', content: 'Those adjacent turns stay source-linked.' })
    session.appendEvent({ type: 'turn-done' })
    const continuityStore = new ContinuityStore(paths.continuityDir)
    continuityStore.rebuild(paths.sessionsDir)
    const episode = continuityStore.listEpisodes().find((item) => item.summary.includes('We decided'))!
    const episodeId = episode.id

    const bus = new EngineEventBus()
    const events: EngineEvent[] = []
    bus.on((event) => events.push(event))
    const handler = makeSlashHandler({
      bus,
      engine: {},
      gate: {},
      contextManager: {},
      client: {},
      store: new SessionStore(paths.sessionsDir, 'C:/project/memory'),
      session: null,
      paths,
      credentialVault: {},
      continuityStore,
      interactionService: new InteractionService(),
      runId: 'run-memory',
    } as unknown as Parameters<typeof makeSlashHandler>[0])

    handler(parseSlash('/memory status')!)
    handler(parseSlash('/memory search memory')!)
    handler(parseSlash('/memory timeline today')!)
    handler(parseSlash(`/memory show ${episodeId}`)!)
    handler(parseSlash('/memory rollup year')!)

    const messages = events
      .filter((event): event is Extract<EngineEvent, { type: 'info' }> => event.type === 'info')
      .map((event) => event.message)
    expect(messages[0]).toContain('Continuity index: ready')
    expect(messages[1]).toContain(episodeId)
    expect(messages[2]).toMatch(/No source-verified|\d{4}-\d{2}-\d{2}/)
    expect(messages[3]).toContain('Each result remains linked')
    expect(messages[3]).toContain(episode.sourceRefs[0]!.recordId)
    expect(messages[3]).toContain('Adjacent conversation context:')
    expect(messages[3]).toContain('No choice had been made yet.')
    expect(messages[4]).toContain('Source-linked time rollups (')
    expect(messages[4]).toContain(episodeId)
    expect(messages[4]).toContain('YEAR [')
    expect(messages[4]).toContain(') (')
    expect(messages[3]).toContain('One further detail about memory context.')
    expect(messages.join('\n')).not.toContain(session.file)
  })

  it('previews ranked working, episodic, and semantic candidates without returning their text', () => {
    temp = mkdtempSync(join(tmpdir(), 'athena-slash-rank-'))
    const paths = resolveBrainPaths({ cwd: temp, homeOverride: temp })
    const sessionStore = new SessionStore(paths.sessionsDir, 'C:/project/rank')
    const session = sessionStore.create()
    session.appendMessage({ role: 'user', content: 'The user prefers source-linked continuity for later conversations.' })
    session.appendMessage({ role: 'assistant', content: 'The continuity catalog will retain the source context.' })
    session.appendEvent({ type: 'turn-done' })
    const continuityStore = new ContinuityStore(paths.continuityDir)
    continuityStore.rebuild(paths.sessionsDir)
    const episode = continuityStore.listEpisodes()[0]!
    const semanticStore = new MemoryHygieneStore(paths.memoryDir)
    const semanticMemory = semanticStore.create({
      description: 'Continuity preference',
      content: 'I prefer a private semantic phrase about continuity.',
      sourceRefs: episode.sourceRefs,
      supportingEpisodeIds: [episode.id],
      observedAt: episode.observedAt,
      scope: 'global',
      speechAct: 'preferred',
      captureMode: 'explicit',
      confidence: 1,
      sensitivity: 'ordinary',
    })

    const bus = new EngineEventBus()
    const events: EngineEvent[] = []
    bus.on((event) => events.push(event))
    const handler = makeSlashHandler({
      bus,
      engine: {
        getMessages: () => [
          { role: 'user', content: 'Current working discussion about continuity preferences.' },
          { role: 'assistant', content: 'This private working phrase should stay local.' },
        ],
      },
      gate: {},
      contextManager: {},
      client: {},
      store: sessionStore,
      session,
      paths,
      credentialVault: {},
      continuityStore,
      timeZone: 'UTC',
    } as unknown as Parameters<typeof makeSlashHandler>[0])

    handler(parseSlash('/memory rank What do I prefer about continuity?')!)

    const output = events
      .filter((event): event is Extract<EngineEvent, { type: 'info' }> => event.type === 'info')
      .map((event) => event.message)
      .join('\n')
    expect(output).toContain('Local recall ranking (intent: preference')
    expect(output).toContain('working working:')
    expect(output).toContain(`semantic ${semanticMemory.memoryId}`)
    expect(output).toContain(`episodic ${episode.id}`)
    expect(output).toContain(session.id)
    expect(output).not.toContain('What do I prefer')
    expect(output).not.toContain('private semantic phrase')
    expect(output).not.toContain('private working phrase')
    expect(output).not.toContain(session.file)
  })

  it('generates and reviews semantic candidates through local slash commands', () => {
    temp = mkdtempSync(join(tmpdir(), 'athena-slash-candidates-'))
    const paths = resolveBrainPaths({ cwd: temp, homeOverride: temp })
    const sessions = new SessionStore(paths.sessionsDir, 'C:/project/candidate-review')
    const sourceSessions: Array<ReturnType<SessionStore['create']>> = []
    for (let index = 0; index < 2; index++) {
      const session = sessions.create()
      sourceSessions.push(session)
      session.appendMessage({ role: 'user', content: 'I prefer local review for inferred continuity.' })
      session.appendMessage({ role: 'assistant', content: 'This can be reviewed as a candidate.' })
      session.appendEvent({ type: 'turn-done' })
    }
    const continuityStore = new ContinuityStore(paths.continuityDir)
    continuityStore.rebuild(paths.sessionsDir)

    const bus = new EngineEventBus()
    const events: EngineEvent[] = []
    bus.on((event) => events.push(event))
    const handler = makeSlashHandler({
      bus,
      engine: new Proxy({}, {
        get: (_target, key) => { throw new Error(`local memory command accessed engine.${String(key)}`) },
      }),
      gate: {},
      contextManager: {},
      client: {},
      store: sessions,
      session: null,
      paths,
      credentialVault: {},
      continuityStore,
    } as unknown as Parameters<typeof makeSlashHandler>[0])

    handler(parseSlash('/memory candidates')!)
    const candidateOutput = events
      .filter((event): event is Extract<EngineEvent, { type: 'info' }> => event.type === 'info')
      .map((event) => event.message)
      .join('\n')
    expect(candidateOutput).toContain('I prefer local review for inferred continuity.')
    const memoryId = candidateOutput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0]
    expect(memoryId).toBeDefined()

    const candidate = new MemoryHygieneStore(paths.memoryDir).get(memoryId!)!
    const sourceRef = candidate.sourceRefs.find((source) => source.sessionId === sourceSessions[1]!.id)!
    const records = readFileSync(sourceSessions[1]!.file, 'utf8').trimEnd().split('\n')
    const lineIndex = records.findIndex((line) => line.includes(sourceRef.recordId))
    const source = JSON.parse(records[lineIndex]!) as { data: { content: string } }
    source.data.content = 'The original support has changed since candidate generation.'
    records[lineIndex] = JSON.stringify(source)
    writeFileSync(sourceSessions[1]!.file, `${records.join('\n')}\n`, 'utf8')

    expect(() => handler(parseSlash(`/memory review ${memoryId} promote`)!)).not.toThrow()
    const staleReview = events
      .filter((event): event is Extract<EngineEvent, { type: 'info' }> => event.type === 'info')
      .map((event) => event.message)
      .join('\n')
    expect(staleReview).toContain('Could not review semantic memory:')
    expect(staleReview).toContain('source verification failed')
    expect(new MemoryHygieneStore(paths.memoryDir).get(memoryId!)?.status).toBe('candidate')

    handler(parseSlash(`/memory review ${memoryId} reject`)!)
    const output = events
      .filter((event): event is Extract<EngineEvent, { type: 'info' }> => event.type === 'info')
      .map((event) => event.message)
      .join('\n')
    expect(output).toContain(`Semantic memory ${memoryId} rejected.`)
    expect(new MemoryHygieneStore(paths.memoryDir).get(memoryId!)?.status).toBe('rejected')
  })
})
