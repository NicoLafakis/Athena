import type { EngineEvent } from '../engine/types.js'
import {
  createInitialBrainActivity,
  decayBrainActivity,
  pulseBrainNodes,
  routeEngineEventToBrain,
  type BrainActivityState,
} from './brain-map.js'

export type VoiceHudPhase =
  | 'connecting'
  | 'standby'
  | 'hearing'
  | 'working'
  | 'speaking'
  | 'permission'
  | 'stopped'

export interface VoiceHudFeedEntry {
  id: number
  timestamp: string
  role: 'user' | 'athena' | 'system'
  text: string
}

export interface VoiceHudHandoff {
  id: string
  label: string
  target: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  finishedAt: number | null
  detail?: string
}

export interface VoiceHudAgentEntry {
  name: string
  description: string
  status: 'running' | 'idle'
  task: string
  startedAt: number | null
  finishedAt: number | null
  lastStatus?: 'completed' | 'failed'
  activeCallId?: string
}

export interface VoiceHudState {
  model: string
  projectName: string
  phase: VoiceHudPhase
  micLevel: number
  micHistory: number[]
  athenaLevel: number
  athenaHistory: number[]
  liveHypothesis: string
  lastStatus: string
  handoffs: VoiceHudHandoff[]
  agents: VoiceHudAgentEntry[]
  feed: VoiceHudFeedEntry[]
  brain: BrainActivityState
}

export type VoiceHudEvent =
  | { type: 'phase'; phase: VoiceHudPhase }
  | { type: 'project'; projectName: string }
  | { type: 'mic-level'; level: number }
  | { type: 'athena-level'; level: number }
  | { type: 'hypothesis'; text: string }
  | { type: 'status'; text: string }
  | { type: 'feed'; role: 'user' | 'athena' | 'system'; text: string }
  | { type: 'handoff-start'; id: string; label: string; target?: string; startedAt?: number }
  | { type: 'handoff-end'; id: string; status: 'completed' | 'failed'; detail?: string; finishedAt?: number }
  | { type: 'agents-sync'; agents: Array<{ name: string; description: string }> }
  | { type: 'engine-event'; event: EngineEvent; now?: number }
  | { type: 'brain-decay'; now?: number }

const BAR_RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const DEFAULT_HISTORY_WIDTH = 28
const MAX_FEED_ENTRIES = 200
const MAX_HANDOFF_ENTRIES = 4

/** Format elapsed hand-off time as MM:SS.t (e.g. 00:04.2). */
export function formatHandoffElapsed(startedAt: number, now: number): string {
  const ms = Math.max(0, now - startedAt)
  const totalTenths = Math.floor(ms / 100)
  const tenths = totalTenths % 10
  const totalSeconds = Math.floor(totalTenths / 10)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.max(0, Math.min(100, Math.round(level)))
}

/** Compute 0..100 RMS amplitude frames from 24 kHz mono PCM16LE audio. */
export function computePcmEnvelope(
  pcm16le: Buffer,
  sampleRate = 24_000,
  frameMs = 60,
): number[] {
  const totalSamples = Math.floor(pcm16le.length / 2)
  if (totalSamples === 0) return []
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1_000))
  const frames: number[] = []
  for (let offset = 0; offset < totalSamples; offset += samplesPerFrame) {
    const end = Math.min(totalSamples, offset + samplesPerFrame)
    let sumSq = 0
    for (let i = offset; i < end; i++) {
      const normalized = pcm16le.readInt16LE(i * 2) / 32_768
      sumSq += normalized * normalized
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - offset))
    // Boost perceptual curve so normal speech spans 25..95 cleanly.
    const scaled = Math.min(100, Math.round(Math.pow(rms, 0.65) * 140))
    frames.push(scaled)
  }
  return frames
}

export function pushSample(
  history: readonly number[],
  level: number,
  maxLen = DEFAULT_HISTORY_WIDTH,
): number[] {
  const next = [...history, clampLevel(level)]
  return next.length > maxLen ? next.slice(next.length - maxLen) : next
}

/** Render a fixed-width Unicode bar spectrum (`▁`..`█`) from 0..100 amplitude samples. */
export function renderWaveformBars(
  samples: readonly number[],
  width = DEFAULT_HISTORY_WIDTH,
): string {
  const targetWidth = Math.max(1, width)
  const padded =
    samples.length >= targetWidth
      ? samples.slice(samples.length - targetWidth)
      : [...new Array<number>(targetWidth - samples.length).fill(0), ...samples]
  return padded
    .map((sample) => {
      const clamped = clampLevel(sample)
      const idx = Math.min(BAR_RAMP.length - 1, Math.floor((clamped / 100) * BAR_RAMP.length))
      return BAR_RAMP[idx]!
    })
    .join('')
}

/** Render a compact inline progress-style mic meter for CLI probe output. */
export function renderLevelBar(level: number, width = 16): string {
  const clamped = clampLevel(level)
  const filled = Math.round((clamped / 100) * width)
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}] ${String(clamped).padStart(3, ' ')}%`
}

const HARNESS_AGENT_NAME = 'Athena Harness'

function makeDefaultHarnessAgent(): VoiceHudAgentEntry {
  return {
    name: HARNESS_AGENT_NAME,
    description: 'Primary delegated workspace & tool executor',
    status: 'idle',
    task: '',
    startedAt: null,
    finishedAt: null,
  }
}

export function createInitialVoiceHudState(options: {
  model: string
  projectName: string
}): VoiceHudState {
  return {
    model: options.model,
    projectName: options.projectName,
    phase: 'connecting',
    micLevel: 0,
    micHistory: new Array<number>(DEFAULT_HISTORY_WIDTH).fill(0),
    athenaLevel: 0,
    athenaHistory: new Array<number>(DEFAULT_HISTORY_WIDTH).fill(0),
    liveHypothesis: '',
    lastStatus: 'Connecting to OpenAI Realtime and opening microphone…',
    handoffs: [],
    agents: [makeDefaultHarnessAgent()],
    feed: [],
    brain: createInitialBrainActivity(),
  }
}

let nextFeedId = 1

export function reduceVoiceHudState(
  state: VoiceHudState,
  event: VoiceHudEvent,
): VoiceHudState {
  switch (event.type) {
    case 'phase':
      return {
        ...state,
        phase: event.phase,
        ...(event.phase === 'standby' ? { liveHypothesis: '', athenaLevel: 0 } : {}),
      }
    case 'project':
      return { ...state, projectName: event.projectName }
    case 'mic-level': {
      const level = clampLevel(event.level)
      const brain =
        level >= 16
          ? pulseBrainNodes(state.brain, ['voice'], Math.min(1, 0.35 + level / 120), 'Mic input')
          : state.brain
      return {
        ...state,
        micLevel: level,
        micHistory: pushSample(state.micHistory, level, DEFAULT_HISTORY_WIDTH),
        brain,
      }
    }
    case 'athena-level': {
      const level = clampLevel(event.level)
      const brain =
        level >= 8
          ? pulseBrainNodes(state.brain, ['voice', 'core'], Math.min(1, 0.4 + level / 120), 'Speaking')
          : state.brain
      return {
        ...state,
        athenaLevel: level,
        athenaHistory: pushSample(state.athenaHistory, level, DEFAULT_HISTORY_WIDTH),
        brain,
      }
    }
    case 'hypothesis':
      return {
        ...state,
        phase: state.phase === 'standby' || state.phase === 'connecting' ? 'hearing' : state.phase,
        liveHypothesis: event.text.slice(0, 140),
      }
    case 'status':
      return { ...state, lastStatus: event.text.slice(0, 200) }
    case 'feed': {
      const entry: VoiceHudFeedEntry = {
        id: nextFeedId++,
        timestamp: new Date().toISOString().slice(11, 19),
        role: event.role,
        text: event.text.slice(0, 2_000),
      }
      const feed = [...state.feed, entry].slice(-MAX_FEED_ENTRIES)
      return { ...state, feed }
    }
    case 'handoff-start': {
      const startedAt = event.startedAt ?? Date.now()
      const entry: VoiceHudHandoff = {
        id: event.id,
        label: event.label.trim().slice(0, 140) || 'Delegated task',
        target: event.target ?? HARNESS_AGENT_NAME,
        status: 'running',
        startedAt,
        finishedAt: null,
      }
      const withoutDup = state.handoffs.filter((h) => h.id !== event.id)
      const targetName = entry.target
      const hasTarget = state.agents.some((a) => a.name === targetName)
      const agents: VoiceHudAgentEntry[] = (
        hasTarget
          ? state.agents
          : [
              ...state.agents,
              {
                name: targetName,
                description: 'Delegated executor',
                status: 'idle' as const,
                task: '',
                startedAt: null,
                finishedAt: null,
              },
            ]
      ).map((a) =>
        a.name === targetName
          ? { ...a, status: 'running' as const, task: entry.label, startedAt, finishedAt: null }
          : a,
      )
      return {
        ...state,
        phase: 'working',
        handoffs: [...withoutDup, entry].slice(-MAX_HANDOFF_ENTRIES),
        agents,
        brain: pulseBrainNodes(state.brain, ['voice', 'core', 'engine', 'harness'], 1.0, entry.label),
      }
    }
    case 'handoff-end': {
      const finishedAt = event.finishedAt ?? Date.now()
      const matched = state.handoffs.find((h) => h.id === event.id)
      const targetName = matched?.target ?? HARNESS_AGENT_NAME
      const handoffs = state.handoffs.map((h) =>
        h.id === event.id
          ? {
              ...h,
              status: event.status,
              finishedAt,
              ...(event.detail ? { detail: event.detail.slice(0, 120) } : {}),
            }
          : h,
      )
      const stillRunningForTarget = handoffs.some(
        (h) => h.target === targetName && h.status === 'running',
      )
      const agents: VoiceHudAgentEntry[] = state.agents.map((a) =>
        a.name === targetName && !stillRunningForTarget
          ? {
              ...a,
              status: 'idle' as const,
              finishedAt,
              lastStatus: event.status,
            }
          : a,
      )
      return {
        ...state,
        handoffs,
        agents,
        brain: pulseBrainNodes(
          state.brain,
          event.status === 'completed' ? ['core', 'voice', 'journal'] : ['guards', 'core'],
          0.85,
          event.status === 'completed' ? 'Handoff returned' : 'Handoff failed',
        ),
      }
    }
    case 'agents-sync': {
      const existingByName = new Map(state.agents.map((a) => [a.name, a]))
      const harness = existingByName.get(HARNESS_AGENT_NAME) ?? makeDefaultHarnessAgent()
      const nextAgents: VoiceHudAgentEntry[] = [harness]
      const seen = new Set<string>([HARNESS_AGENT_NAME])
      for (const def of event.agents) {
        const name = def.name.trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        const prev = existingByName.get(name)
        nextAgents.push(
          prev
            ? { ...prev, description: def.description.slice(0, 120) }
            : {
                name,
                description: def.description.slice(0, 120),
                status: 'idle',
                task: '',
                startedAt: null,
                finishedAt: null,
              },
        )
      }
      return { ...state, agents: nextAgents }
    }
    case 'engine-event': {
      const now = event.now ?? Date.now()
      const routed = routeEngineEventToBrain(event.event)
      let agents = state.agents
      if (event.event.type === 'tool-request' && event.event.name === 'Agent') {
        const callId = event.event.id
        const rawInput = (event.event.input ?? {}) as Record<string, unknown>
        const agentName =
          typeof rawInput['agent'] === 'string' && rawInput['agent'].trim()
            ? rawInput['agent'].trim()
            : typeof rawInput['run_id'] === 'string' && rawInput['run_id'].trim()
              ? rawInput['run_id'].trim()
              : 'Subagent'
        const taskText =
          typeof rawInput['prompt'] === 'string' && rawInput['prompt'].trim()
            ? rawInput['prompt'].trim().slice(0, 140)
            : typeof rawInput['action'] === 'string'
              ? `Agent ${rawInput['action']}`
              : 'Running subagent'
        const exists = agents.some((a) => a.name === agentName)
        const baseList = exists
          ? agents
          : [
              ...agents,
              {
                name: agentName,
                description: 'Subagent',
                status: 'idle' as const,
                task: '',
                startedAt: null,
                finishedAt: null,
              },
            ]
        agents = baseList.map((a) =>
          a.name === agentName
            ? {
                ...a,
                status: 'running' as const,
                task: taskText,
                startedAt: now,
                finishedAt: null,
                activeCallId: callId,
              }
            : a,
        )
      } else if (event.event.type === 'tool-result' && event.event.name === 'Agent') {
        const callId = event.event.id
        const lastStatus: 'completed' | 'failed' = event.event.isError ? 'failed' : 'completed'
        agents = agents.map((a) =>
          a.activeCallId === callId
            ? {
                ...a,
                status: 'idle' as const,
                finishedAt: now,
                lastStatus,
                activeCallId: undefined,
              }
            : a,
        )
      } else if (event.event.type === 'agent-status-update') {
        const detail = (event.event.objective ?? event.event.nextExpected ?? '').trim().slice(0, 140)
        if (detail) {
          // Update the most-recently started running agent (prefer subagent over parent harness)
          let targetIdx = -1
          let latestStart = -1
          agents.forEach((a, idx) => {
            if (a.status === 'running' && (a.startedAt ?? 0) >= latestStart) {
              latestStart = a.startedAt ?? 0
              targetIdx = idx
            }
          })
          if (targetIdx !== -1) {
            agents = agents.map((a, idx) => (idx === targetIdx ? { ...a, task: detail } : a))
          }
        }
      }
      return {
        ...state,
        agents,
        brain: pulseBrainNodes(state.brain, routed.nodes, routed.intensity, routed.reason, event.now),
      }
    }
    case 'brain-decay': {
      const nextBrain = decayBrainActivity(state.brain, event.now)
      if (nextBrain === state.brain) return state
      return { ...state, brain: nextBrain }
    }
  }
}

export class VoiceHudStore {
  private state: VoiceHudState
  private readonly listeners = new Set<(state: VoiceHudState) => void>()

  constructor(initial: VoiceHudState) {
    this.state = initial
  }

  getState(): VoiceHudState {
    return this.state
  }

  dispatch(event: VoiceHudEvent): void {
    this.state = reduceVoiceHudState(this.state, event)
    for (const listener of this.listeners) listener(this.state)
  }

  subscribe(listener: (state: VoiceHudState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Drive Athena's speaking waveform in sync with Marin's PCM16LE playback duration. */
  animateAthenaPcm(pcm: Buffer, sampleRate = 24_000, frameMs = 60): () => void {
    const frames = computePcmEnvelope(pcm, sampleRate, frameMs)
    if (frames.length === 0) return () => {}
    let index = 0
    this.dispatch({ type: 'phase', phase: 'speaking' })
    const timer = setInterval(() => {
      const level = frames[index++]
      if (level === undefined) {
        clearInterval(timer)
        this.dispatch({ type: 'athena-level', level: 0 })
        return
      }
      this.dispatch({ type: 'athena-level', level })
    }, frameMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      this.dispatch({ type: 'athena-level', level: 0 })
    }
  }
}
