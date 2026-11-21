import { describe, expect, it } from 'vitest'
import {
  computePcmEnvelope,
  createInitialVoiceHudState,
  formatHandoffElapsed,
  pushSample,
  reduceVoiceHudState,
  renderWaveformBars,
} from '../../src/voice/visualizer.js'
import { parseWakeListenerLine } from '../../src/voice/windows-speech.js'

describe('voice visualizer math', () => {
  it('computes 0..100 RMS amplitude frames from 24kHz PCM16LE audio', () => {
    // 120ms of silence at 24kHz = 2880 samples = 5760 bytes -> 2 frames at 60ms each.
    const silence = Buffer.alloc(24_000 * 2 * 0.12)
    expect(computePcmEnvelope(silence, 24_000, 60)).toEqual([0, 0])

    // 120ms of loud 440Hz sine wave at ~80% amplitude.
    const samples = Math.floor(24_000 * 0.12)
    const loud = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 26_000)
      loud.writeInt16LE(v, i * 2)
    }
    const env = computePcmEnvelope(loud, 24_000, 60)
    expect(env).toHaveLength(2)
    expect(env[0]!).toBeGreaterThan(50)
    expect(env[0]!).toBeLessThanOrEqual(100)
  })

  it('renders bounded Unicode bar waveforms with exact width and rolling history', () => {
    const history = pushSample(pushSample([], 0, 8), 100, 8)
    expect(history).toEqual([0, 100])
    const rendered = renderWaveformBars([0, 15, 35, 60, 85, 100], 6)
    expect([...rendered]).toHaveLength(6)
    expect(rendered[0]).toBe('▁')
    expect(rendered.at(-1)).toBe('█')
  })

  it('reduces VoiceHudState cleanly across standby, hearing, working, and speaking phases', () => {
    let state = createInitialVoiceHudState({ model: 'gpt-realtime-2.1-mini', projectName: 'Athena' })
    state = reduceVoiceHudState(state, { type: 'phase', phase: 'standby' })
    state = reduceVoiceHudState(state, { type: 'mic-level', level: 48 })
    state = reduceVoiceHudState(state, { type: 'hypothesis', text: 'Athena check status' })
    expect(state.phase).toBe('hearing')
    expect(state.micLevel).toBe(48)
    expect(state.liveHypothesis).toBe('Athena check status')

    state = reduceVoiceHudState(state, { type: 'phase', phase: 'speaking' })
    state = reduceVoiceHudState(state, { type: 'athena-level', level: 72 })
    expect(state.athenaLevel).toBe(72)
    expect(state.athenaHistory.at(-1)).toBe(72)

    state = reduceVoiceHudState(state, { type: 'feed', role: 'athena', text: 'All tests are green.' })
    expect(state.feed.at(-1)?.text).toBe('All tests are green.')
  })
})

describe('parseWakeListenerLine live telemetry events', () => {
  it('parses level, speech-detected, hypothesis, and rejected JSONL lines', () => {
    expect(parseWakeListenerLine('{"level":42}')).toEqual({ kind: 'level', level: 42 })
    expect(parseWakeListenerLine('{"speech":"detected"}')).toEqual({ kind: 'speech-detected' })
    expect(parseWakeListenerLine('{"hypothesis":"Athena check"}')).toEqual({
      kind: 'hypothesis',
      text: 'Athena check',
    })
    expect(parseWakeListenerLine('{"rejected":true,"text":"mumble","confidence":0.2}')).toEqual({
      kind: 'rejected',
      text: 'mumble',
      confidence: 0.2,
    })
  })

  it('keeps long feed entries unwrapped up to 2000 chars for full conversational visibility', () => {
    const longReply = 'This is a long Athena response. '.repeat(20)
    const state = reduceVoiceHudState(
      createInitialVoiceHudState({ model: 'gpt-realtime-2.1-mini', projectName: 'Athena' }),
      { type: 'feed', role: 'athena', text: longReply },
    )
    expect(state.feed[0]!.text).toBe(longReply)
  })

  it('tracks active hand-offs and formats elapsed timer cleanly', () => {
    expect(formatHandoffElapsed(1_000, 5_250)).toBe('00:04.2')
    expect(formatHandoffElapsed(0, 72_500)).toBe('01:12.5')

    let state = createInitialVoiceHudState({ model: 'gpt-live-1.1', projectName: 'Athena' })
    state = reduceVoiceHudState(state, {
      type: 'handoff-start',
      id: 'item_1',
      label: 'Check git status',
      startedAt: 10_000,
    })
    expect(state.phase).toBe('working')
    expect(state.handoffs).toHaveLength(1)
    expect(state.handoffs[0]).toMatchObject({
      id: 'item_1',
      status: 'running',
      target: 'Athena Harness',
      startedAt: 10_000,
      finishedAt: null,
    })

    state = reduceVoiceHudState(state, {
      type: 'handoff-end',
      id: 'item_1',
      status: 'completed',
      finishedAt: 14_300,
    })
    expect(state.handoffs[0]).toMatchObject({
      id: 'item_1',
      status: 'completed',
      finishedAt: 14_300,
    })
  })

  it('tracks active and idle agents in the running agent ledger across Agent tool & handoff events', () => {
    let state = createInitialVoiceHudState({ model: 'gpt-live-1.1', projectName: 'Athena' })
    state = reduceVoiceHudState(state, {
      type: 'agents-sync',
      agents: [
        { name: 'explorer', description: 'Fast read-only codebase search' },
        { name: 'reviewer', description: 'Diff and safety audit' },
      ],
    })
    expect(state.agents.map((a) => a.name)).toEqual(['Athena Harness', 'explorer', 'reviewer'])
    expect(state.agents.every((a) => a.status === 'idle')).toBe(true)

    // Subagent invoked via Agent tool -> flips to running
    state = reduceVoiceHudState(state, {
      type: 'engine-event',
      now: 20_000,
      event: {
        type: 'tool-request',
        id: 'tc_agent_1',
        name: 'Agent',
        input: { agent: 'explorer', prompt: 'Inspect VoiceHud layout' },
      },
    })
    const explorerRunning = state.agents.find((a) => a.name === 'explorer')
    expect(explorerRunning).toMatchObject({
      status: 'running',
      task: 'Inspect VoiceHud layout',
      startedAt: 20_000,
      activeCallId: 'tc_agent_1',
    })

    // Live agent-status-update refines the active objective
    state = reduceVoiceHudState(state, {
      type: 'engine-event',
      now: 21_500,
      event: {
        type: 'agent-status-update',
        objective: 'Checking row budgets in src/tui/VoiceHud.tsx',
        sourceRef: 'turn:1',
      },
    })
    expect(state.agents.find((a) => a.name === 'explorer')?.task).toBe(
      'Checking row budgets in src/tui/VoiceHud.tsx',
    )

    // Tool result flips explorer back to idle with completed status
    state = reduceVoiceHudState(state, {
      type: 'engine-event',
      now: 24_200,
      event: {
        type: 'tool-result',
        id: 'tc_agent_1',
        name: 'Agent',
        output: 'Found layout',
        isError: false,
      },
    })
    expect(state.agents.find((a) => a.name === 'explorer')).toMatchObject({
      status: 'idle',
      lastStatus: 'completed',
      finishedAt: 24_200,
    })

    // Handoff flips Athena Harness running -> idle
    state = reduceVoiceHudState(state, {
      type: 'handoff-start',
      id: 'h_1',
      label: 'Run vitest suite',
      startedAt: 30_000,
    })
    expect(state.agents.find((a) => a.name === 'Athena Harness')).toMatchObject({
      status: 'running',
      task: 'Run vitest suite',
    })
    state = reduceVoiceHudState(state, {
      type: 'handoff-end',
      id: 'h_1',
      status: 'completed',
      finishedAt: 35_000,
    })
    expect(state.agents.find((a) => a.name === 'Athena Harness')).toMatchObject({
      status: 'idle',
      lastStatus: 'completed',
      finishedAt: 35_000,
    })
  })
})
