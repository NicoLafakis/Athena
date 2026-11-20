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

  it('uses plain-English labels (no cryptic 3-letter acronyms) and rotates a TrueColor 3D Jarvis sphere', () => {
    const cryptic = new Set(['VOC', 'ENG', 'BRN', 'TRU', 'HRN', 'GRD', 'LIB', 'JRN', 'LRN'])
    for (const node of BRAIN_NODES) {
      expect(cryptic.has(node.shortLabel)).toBe(false)
      expect(node.shortLabel.length).toBeGreaterThanOrEqual(4)
    }

    let state = createInitialBrainActivity()
    state = pulseBrainNodes(state, ['voice', 'brain', 'core'], 0.9, 'Recalling memory', 1_000)

    const frameA = renderBrainOrbitalLines(state, 52, 18, {
      phaseRad: 0,
      micEnergy: 0.7,
      athenaEnergy: 0.2,
    })
    const frameB = renderBrainOrbitalLines(state, 52, 18, {
      phaseRad: 1.25,
      micEnergy: 0.2,
      athenaEnergy: 0.85,
    })

    expect(frameA).toHaveLength(18)
    expect(frameB).toHaveLength(18)
    const textA = frameA.map((r) => r.segments.map((s) => s.text).join('')).join('\n')
    const textB = frameB.map((r) => r.segments.map((s) => s.text).join('')).join('\n')
    for (const row of frameA) expect(row.segments.map((s) => s.text).join('').length).toBe(52)
    for (const row of frameB) expect(row.segments.map((s) => s.text).join('').length).toBe(52)
    // Distinct 3D rotated frames
    expect(textA).not.toBe(textB)
    // Uses 24-bit TrueColor hex shading for 3D depth
    const hexColors = frameA
      .flatMap((r) => r.segments)
      .map((s) => s.color)
      .filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
    expect(hexColors.length).toBeGreaterThan(10)
    // Top firing node exposes plain-English label
    const top = topFiringNodes(state, 3)
    expect(top.map((n) => n.label)).toEqual(expect.arrayContaining(['Voice', 'Memory', 'Core']))
  })
})
