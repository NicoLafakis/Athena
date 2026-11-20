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
  feed: VoiceHudFeedEntry[]
}

export type VoiceHudEvent =
  | { type: 'phase'; phase: VoiceHudPhase }
  | { type: 'project'; projectName: string }
  | { type: 'mic-level'; level: number }
  | { type: 'athena-level'; level: number }
  | { type: 'hypothesis'; text: string }
  | { type: 'status'; text: string }
  | { type: 'feed'; role: 'user' | 'athena' | 'system'; text: string }

const BAR_RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const DEFAULT_HISTORY_WIDTH = 28
const MAX_FEED_ENTRIES = 10

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
    feed: [],
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
      return {
        ...state,
        micLevel: level,
        micHistory: pushSample(state.micHistory, level, DEFAULT_HISTORY_WIDTH),
      }
    }
    case 'athena-level': {
      const level = clampLevel(event.level)
      return {
        ...state,
        athenaLevel: level,
        athenaHistory: pushSample(state.athenaHistory, level, DEFAULT_HISTORY_WIDTH),
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
        text: event.text.slice(0, 240),
      }
      const feed = [...state.feed, entry].slice(-MAX_FEED_ENTRIES)
      return { ...state, feed }
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
