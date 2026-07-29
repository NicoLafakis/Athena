import { describe, expect, it } from 'vitest'
import { makeSlashHandler } from '../../src/cli.js'
import { EngineEventBus } from '../../src/engine/events.js'
import type { EngineEvent } from '../../src/engine/types.js'
import { InteractionService } from '../../src/interaction/service.js'

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
})
