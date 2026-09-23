import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSlashHandler } from '../../src/cli.js'
import { EngineEventBus } from '../../src/engine/events.js'
import type { EngineEvent } from '../../src/engine/types.js'
import { InteractionService } from '../../src/interaction/service.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
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
})
