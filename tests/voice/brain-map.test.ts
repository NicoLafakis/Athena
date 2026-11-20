import { describe, expect, it } from 'vitest'
import {
  BRAIN_NODES,
  createInitialBrainActivity,
  decayBrainActivity,
  pulseBrainNodes,
  renderBrainOrbitalLines,
  routeEngineEventToBrain,
  topFiringNodes,
} from '../../src/voice/brain-map.js'

describe('Orbital Brain Scan (EEG) state & renderer', () => {
  it('pulses nodes and decays heat smoothly to zero over time', () => {
    let state = createInitialBrainActivity()
    state = pulseBrainNodes(state, ['voice', 'core'], 1.0, 'User speaking', 1_000)
    expect(state.nodes.voice.heat).toBe(1)
    expect(state.nodes.core.heat).toBe(1)
    expect(state.arcs.length).toBeGreaterThan(0)

    // After 1.4s (~1 half-life), heat is noticeably lower but still glowing
    const mid = decayBrainActivity(state, 2_400)
    expect(mid.nodes.voice.heat).toBeGreaterThan(0.2)
    expect(mid.nodes.voice.heat).toBeLessThan(0.6)

    // After 10s, heat snaps cleanly to 0 so idle renders stop
    const cold = decayBrainActivity(state, 11_000)
    expect(cold.nodes.voice.heat).toBe(0)
    expect(cold.arcs).toHaveLength(0)
  })

  it('routes real Athena EngineEvents to the right architectural subsystems', () => {
    expect(routeEngineEventToBrain({ type: 'turn-start', turn: 1 }).nodes).toContain('engine')
    expect(
      routeEngineEventToBrain({ type: 'tool-request', id: '1', name: 'Memory', input: {} }).nodes,
    ).toContain('brain')
    expect(
      routeEngineEventToBrain({ type: 'tool-request', id: '2', name: 'LibraryRead', input: {} }).nodes,
    ).toContain('librarian')
    expect(
      routeEngineEventToBrain({
        type: 'permission-requested',
        requestId: 'p1',
        toolCallId: 't1',
        toolName: 'Bash',
        summary: 'Run tests',
        reason: 'exec',
      }).nodes,
    ).toContain('guards')
    expect(
      routeEngineEventToBrain({
        type: 'turn-done',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      }).nodes,
    ).toContain('journal')
  })

  it('renders an exact width x height Braille orbital canvas with active nodes highlighted', () => {
    let state = createInitialBrainActivity()
    state = pulseBrainNodes(state, ['voice', 'engine', 'core'], 0.95, 'Delegated turn', 1_000)
    const rows = renderBrainOrbitalLines(state, 44, 16)
    expect(rows).toHaveLength(16)
    for (const row of rows) {
      expect(row.segments.map((s) => s.text).join('').length).toBe(44)
    }
    const top = topFiringNodes(state, 3)
    expect(top.map((n) => n.id)).toEqual(expect.arrayContaining(['voice', 'engine', 'core']))
    expect(BRAIN_NODES.length).toBeGreaterThanOrEqual(9)
  })
})
