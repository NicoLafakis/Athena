import { describe, expect, it } from 'vitest'
import type { Announcement } from '../../src/interaction/types.js'
import {
  VoiceAttentionBridge,
  parseVoicePermissionCommand,
  type VoiceAttentionSpeaker,
  type VoicePermissionNotice,
} from '../../src/voice/attention.js'

const CWD = process.cwd()

interface Presented { text: string; spoken: boolean }

function recorder(turn = () => 1): {
  speaker: VoiceAttentionSpeaker
  presented: Presented[]
  notices: VoicePermissionNotice[]
} {
  const presented: Presented[] = []
  const notices: VoicePermissionNotice[] = []
  return {
    presented,
    notices,
    speaker: {
      currentTurn: turn,
      present: (item) => {
        presented.push(item)
      },
      notify: (notice) => {
        notices.push(notice)
      },
    },
  }
}

function askWrite(bridge: VoiceAttentionBridge, id: string, file = 'notes.txt') {
  return bridge.askUser({
    id,
    toolName: 'Write',
    input: { file_path: file, content: 'x' },
    summary: `Write ${file}`,
    reason: 'Write is mutating; no rule matched in normal mode',
  })
}

function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    schemaVersion: 1,
    id: 'announcement:1',
    runId: 'run-1',
    priority: 'assertive',
    category: 'error',
    text: 'Attention: Athena encountered a recoverable error.',
    dedupeKey: 'run-1:error:1',
    requiresAcknowledgement: false,
    provenance: [],
    createdAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  }
}

describe('VoiceAttentionBridge permission matching', () => {
  it('speaks the canonical record and resolves an answer carrying the exact identity', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    const { speaker, presented } = recorder(() => 1)
    bridge.attach(speaker)

    const answer = askWrite(bridge, 'permission:write-1')
    expect(bridge.pendingIds()).toEqual(['permission:write-1'])
    expect(presented).toHaveLength(1)
    expect(presented[0]!.spoken).toBe(true)
    expect(presented[0]!.text).toContain('Permission needed: Write on notes.txt.')
    expect(presented[0]!.text).toContain('Say Athena allow')
    // Screen affordances are unusable by ear and must not be read out.
    expect(presented[0]!.text).not.toContain('/details permission')
    expect(presented[0]!.text).not.toContain('[y]')

    const outcome = bridge.resolve('allow', 'permission:write-1', 2)
    expect(outcome).toMatchObject({ ok: true, id: 'permission:write-1', answer: 'allow-once' })
    // Voice never reaches allow-always: one spoken word cannot mean "and everything after".
    await expect(answer).resolves.toBe('allow-once')
    expect(bridge.hasPending()).toBe(false)
  })

  it('maps a deny to the harness deny answer', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    bridge.attach(recorder().speaker)
    const answer = askWrite(bridge, 'permission:write-1')
    expect(bridge.resolve('deny', undefined, 2)).toMatchObject({ ok: true, answer: 'deny' })
    await expect(answer).resolves.toBe('deny')
  })

  it('refuses a stale identity and changes nothing', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    bridge.attach(recorder().speaker)
    const answer = askWrite(bridge, 'permission:write-1')
    bridge.resolve('deny', 'permission:write-1', 2)
    await expect(answer).resolves.toBe('deny')

    const replay = bridge.resolve('allow', 'permission:write-1', 3)
    expect(replay).toMatchObject({ ok: false, reason: 'stale' })
    expect(bridge.hasPending()).toBe(false)
  })

  it('refuses an identity it never issued', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    bridge.attach(recorder().speaker)
    const answer = askWrite(bridge, 'permission:write-1')

    expect(bridge.resolve('allow', 'permission:invented', 2)).toMatchObject({
      ok: false,
      reason: 'unknown',
      pendingIds: ['permission:write-1'],
    })
    expect(bridge.pendingIds()).toEqual(['permission:write-1'])
    bridge.close()
    await expect(answer).resolves.toBe('deny')
  })

  it('refuses an unqualified answer while more than one request is waiting', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    bridge.attach(recorder().speaker)
    const first = askWrite(bridge, 'permission:write-1', 'one.txt')
    const second = askWrite(bridge, 'permission:write-2', 'two.txt')

    const outcome = bridge.resolve('allow', undefined, 2)
    expect(outcome).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(outcome.ok === false && outcome.clarification).toContain('which one')
    expect(bridge.pendingIds()).toHaveLength(2)

    // Naming one of them still works; the other stays untouched.
    expect(bridge.resolve('allow', 'permission:write-2', 2)).toMatchObject({ ok: true })
    await expect(second).resolves.toBe('allow-once')
    expect(bridge.pendingIds()).toEqual(['permission:write-1'])
    bridge.close()
    await expect(first).resolves.toBe('deny')
  })

  it('authorizes nothing when no request is pending', () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    bridge.attach(recorder().speaker)
    expect(bridge.resolve('allow', undefined, 1)).toMatchObject({ ok: false, reason: 'none-pending' })
    expect(bridge.resolve('allow', 'permission:write-1', 1)).toMatchObject({
      ok: false,
      reason: 'unknown',
    })
  })

  it('refuses a confirmation from the same turn that raised the request', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    let turn = 4
    bridge.attach(recorder(() => turn).speaker)
    const answer = askWrite(bridge, 'permission:write-1')

    expect(bridge.resolve('allow', 'permission:write-1', turn)).toMatchObject({
      ok: false,
      reason: 'same-turn',
    })
    expect(bridge.hasPending()).toBe(true)

    // Said again on the next turn, once the user has actually heard it, it lands.
    turn = 5
    expect(bridge.resolve('allow', 'permission:write-1', turn)).toMatchObject({ ok: true })
    await expect(answer).resolves.toBe('allow-once')
  })

  it('denies everything outstanding on close so no harness turn parks forever', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    bridge.attach(recorder().speaker)
    const answer = askWrite(bridge, 'permission:write-1')
    bridge.close()
    await expect(answer).resolves.toBe('deny')
    await expect(askWrite(bridge, 'permission:write-2')).resolves.toBe('deny')
  })

  it('buffers semantic-plane text raised before the session attaches a speaker', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    const answer = askWrite(bridge, 'permission:write-1')
    const { speaker, presented } = recorder()
    bridge.attach(speaker)
    expect(presented).toHaveLength(1)
    expect(presented[0]!.text).toContain('Permission needed')
    bridge.close()
    await expect(answer).resolves.toBe('deny')
  })
})

describe('VoiceAttentionBridge permission notices', () => {
  it('tells the listening session a decision is outstanding, and what its identity is', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    const { speaker, notices } = recorder(() => 1)
    bridge.attach(speaker)

    const answer = askWrite(bridge, 'permission:write-1')
    expect(notices).toEqual([
      { kind: 'pending', id: 'permission:write-1', summary: 'Write notes.txt' },
    ])

    // Resolving retires it, so the model's view cannot stay stuck on "still waiting".
    bridge.resolve('allow', 'permission:write-1', 2)
    expect(notices[1]).toEqual({
      kind: 'resolved', id: 'permission:write-1', action: 'allow',
    })
    await expect(answer).resolves.toBe('allow-once')
  })

  it('reports a refusal and a shutdown denial as their own states', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    const { speaker, notices } = recorder(() => 4)
    bridge.attach(speaker)
    const answer = askWrite(bridge, 'permission:write-1')

    bridge.resolve('allow', 'permission:write-1', 4)
    expect(notices[1]).toEqual({ kind: 'refused', reason: 'same-turn' })
    // The refusal changed nothing, so the request is still waiting and still answerable.
    expect(bridge.hasPending()).toBe(true)

    bridge.close()
    expect(notices[2]).toEqual({ kind: 'shutdown', id: 'permission:write-1' })
    await expect(answer).resolves.toBe('deny')
  })

  it('re-derives what is waiting when a speaker attaches, rather than replaying a queue', async () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    const first = askWrite(bridge, 'permission:write-1', 'one.txt')
    const second = askWrite(bridge, 'permission:write-2', 'two.txt')
    // Decided before anything was listening: a queued notice would announce it as pending.
    bridge.resolve('deny', 'permission:write-1', 1)
    await expect(first).resolves.toBe('deny')

    const { speaker, notices } = recorder()
    bridge.attach(speaker)
    expect(notices).toEqual([
      { kind: 'pending', id: 'permission:write-2', summary: 'Write two.txt' },
    ])
    bridge.close()
    await expect(second).resolves.toBe('deny')
  })

  it('keeps a permission spoken and answerable when the notice sink is missing or throws', async () => {
    const silent = new VoiceAttentionBridge({ cwd: CWD })
    const presented: Presented[] = []
    // A speaker with no model behind it simply has no notify; that must not be an error.
    silent.attach({ currentTurn: () => 1, present: (item) => { presented.push(item) } })
    const first = askWrite(silent, 'permission:write-1')
    expect(presented[0]!.text).toContain('Permission needed')
    expect(silent.resolve('allow', 'permission:write-1', 2)).toMatchObject({ ok: true })
    await expect(first).resolves.toBe('allow-once')

    const broken = new VoiceAttentionBridge({ cwd: CWD })
    broken.attach({
      currentTurn: () => 1,
      present: () => {},
      notify: () => {
        throw new Error('the voice session is gone')
      },
    })
    // The canonical request was already spoken; a model that missed the hint must never be
    // able to take the decision down with it.
    const second = askWrite(broken, 'permission:write-2')
    expect(broken.pendingIds()).toEqual(['permission:write-2'])
    expect(broken.resolve('allow', 'permission:write-2', 2)).toMatchObject({ ok: true })
    await expect(second).resolves.toBe('allow-once')
  })
})

describe('VoiceAttentionBridge announcement routing', () => {
  it('keeps polite chatter as stable text and speaks assertive and blocking states', () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    const { speaker, presented } = recorder()
    bridge.attach(speaker)

    bridge.announce(announcement({ priority: 'polite', category: 'phase', text: 'Completed: Work completed.' }))
    bridge.announce(announcement())
    bridge.announce(announcement({ priority: 'blocking', category: 'phase', text: 'Attention: Work is blocked and needs you.' }))

    expect(presented.map((item) => item.spoken)).toEqual([false, true, true])
    expect(presented).toHaveLength(3)
  })

  it('never says the permission twice: the plane line yields to the canonical record', () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD })
    const { speaker, presented } = recorder()
    bridge.attach(speaker)
    bridge.announce(announcement({
      priority: 'blocking',
      category: 'permission',
      text: 'Permission: Write requires permission.',
    }))
    expect(presented).toHaveLength(0)
  })

  it('yields routine speech to an active screen reader but never a blocking state', () => {
    const bridge = new VoiceAttentionBridge({ cwd: CWD, screenReaderActive: true })
    const { speaker, presented } = recorder()
    bridge.attach(speaker)
    bridge.announce(announcement())
    bridge.announce(announcement({ priority: 'blocking', category: 'phase', text: 'Attention: Work is blocked and needs you.' }))
    expect(presented.map((item) => item.spoken)).toEqual([false, true])
  })

  it('hands even a permission to the screen reader under exclusive ownership', async () => {
    const bridge = new VoiceAttentionBridge({
      cwd: CWD,
      ownership: 'exclusive',
      screenReaderActive: true,
    })
    const { speaker, presented } = recorder()
    bridge.attach(speaker)
    const answer = askWrite(bridge, 'permission:write-1')
    // Stable text still carries it; only the spoken duplicate is suppressed.
    expect(presented).toHaveLength(1)
    expect(presented[0]!.spoken).toBe(false)
    expect(presented[0]!.text).toContain('Permission needed')
    bridge.close()
    await expect(answer).resolves.toBe('deny')
  })
})

describe('parseVoicePermissionCommand', () => {
  it('recognizes bare answers only while something is actually waiting', () => {
    expect(parseVoicePermissionCommand('allow', ['permission:a'])).toEqual({ action: 'allow' })
    expect(parseVoicePermissionCommand('deny', ['permission:a'])).toEqual({ action: 'deny' })
    expect(parseVoicePermissionCommand('allow', [])).toBeNull()
  })

  it('takes a qualified answer only for an identity that is really pending', () => {
    expect(parseVoicePermissionCommand('allow permission:a', ['permission:a']))
      .toEqual({ action: 'allow', permissionId: 'permission:a' })
    expect(parseVoicePermissionCommand('allow permission:b', ['permission:a'])).toBeNull()
  })

  it('leaves an ordinary request that happens to start with allow alone', () => {
    expect(parseVoicePermissionCommand('allow list the failing tests', ['permission:a'])).toBeNull()
    expect(parseVoicePermissionCommand('summarize the objective', ['permission:a'])).toBeNull()
  })
})
