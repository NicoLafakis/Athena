import type { EngineEvent } from '../engine/types.js'

export type BrainNodeId =
  | 'core'
  | 'engine'
  | 'brain'
  | 'truth'
  | 'harness'
  | 'guards'
  | 'librarian'
  | 'journal'
  | 'learning'
  | 'voice'

export interface BrainNodeDef {
  id: BrainNodeId
  shortLabel: string
  fullLabel: string
  /** Normalized orbital radius 0..1 from center. */
  ring: number
  /** Angle in degrees (0 = right, 90 = bottom, 180 = left, 270 = top). */
  angleDeg: number
  hotColor: string
  warmColor: string
}

export const BRAIN_NODES: readonly BrainNodeDef[] = [
  { id: 'core', shortLabel: 'CORE', fullLabel: 'Session Controller', ring: 0.0, angleDeg: 0, hotColor: 'yellowBright', warmColor: 'yellow' },
  { id: 'engine', shortLabel: 'ENG', fullLabel: 'Engine', ring: 0.30, angleDeg: 80, hotColor: 'yellowBright', warmColor: 'yellow' },
  { id: 'brain', shortLabel: 'BRN', fullLabel: 'Brain & Memory', ring: 0.48, angleDeg: 145, hotColor: 'magentaBright', warmColor: 'magenta' },
  { id: 'truth', shortLabel: 'TRU', fullLabel: 'Truth Plane', ring: 0.66, angleDeg: 235, hotColor: 'cyanBright', warmColor: 'cyan' },
  { id: 'harness', shortLabel: 'HRN', fullLabel: 'Harness Services', ring: 0.66, angleDeg: 38, hotColor: 'cyanBright', warmColor: 'blueBright' },
  { id: 'guards', shortLabel: 'GRD', fullLabel: 'Guards & Perms', ring: 0.66, angleDeg: 105, hotColor: 'redBright', warmColor: 'red' },
  { id: 'librarian', shortLabel: 'LIB', fullLabel: 'Librarian', ring: 0.84, angleDeg: 205, hotColor: 'blueBright', warmColor: 'blue' },
  { id: 'journal', shortLabel: 'JRN', fullLabel: 'Journal', ring: 0.84, angleDeg: 165, hotColor: 'blueBright', warmColor: 'blue' },
  { id: 'learning', shortLabel: 'LRN', fullLabel: 'Learning', ring: 0.84, angleDeg: 355, hotColor: 'magentaBright', warmColor: 'blue' },
  { id: 'voice', shortLabel: 'VOC', fullLabel: 'Voice Duplex', ring: 0.92, angleDeg: 300, hotColor: 'greenBright', warmColor: 'cyanBright' },
] as const

export interface BrainNodeState {
  heat: number
  lastFiredAt: number
  reason: string
}

export interface BrainArc {
  from: BrainNodeId
  to: BrainNodeId
  heat: number
  lastFiredAt: number
}

export interface BrainActivityState {
  nodes: Record<BrainNodeId, BrainNodeState>
  arcs: BrainArc[]
}

export interface ColoredSegment {
  text: string
  color?: string
  bold?: boolean
  dimColor?: boolean
}

export interface RenderedOrbitalRow {
  segments: ColoredSegment[]
}

export function createInitialBrainActivity(): BrainActivityState {
  const nodes = {} as Record<BrainNodeId, BrainNodeState>
  for (const def of BRAIN_NODES) {
    nodes[def.id] = { heat: 0, lastFiredAt: 0, reason: '' }
  }
  return { nodes, arcs: [] }
}

export function pulseBrainNodes(
  state: BrainActivityState,
  ids: readonly BrainNodeId[],
  intensity: number,
  reason: string,
  now = Date.now(),
): BrainActivityState {
  const clamped = Math.max(0.05, Math.min(1, intensity))
  const nextNodes: Record<BrainNodeId, BrainNodeState> = { ...state.nodes }
  for (const id of ids) {
    const prev = nextNodes[id]
    nextNodes[id] = {
      heat: Math.min(1, Math.max(prev.heat, clamped)),
      lastFiredAt: now,
      reason,
    }
  }
  const arcMap = new Map<string, BrainArc>()
  for (const arc of state.arcs) {
    arcMap.set(`${arc.from}->${arc.to}`, arc)
  }
  for (const id of ids) {
    if (id === 'core') continue
    const key = `core->${id}`
    const prev = arcMap.get(key)
    arcMap.set(key, {
      from: 'core',
      to: id,
      heat: Math.min(1, Math.max(prev?.heat ?? 0, clamped * 0.9)),
      lastFiredAt: now,
    })
  }
  return { nodes: nextNodes, arcs: [...arcMap.values()] }
}

export function decayBrainActivity(
  state: BrainActivityState,
  now = Date.now(),
  halfLifeMs = 1_400,
): BrainActivityState {
  const nextNodes = {} as Record<BrainNodeId, BrainNodeState>
  let anyChanged = false
  for (const def of BRAIN_NODES) {
    const cur = state.nodes[def.id]
    if (cur.heat <= 0) {
      nextNodes[def.id] = cur
      continue
    }
    const dt = Math.max(0, now - cur.lastFiredAt)
    const decayed = cur.heat * Math.exp(-dt / halfLifeMs)
    const nextHeat = decayed < 0.03 ? 0 : decayed
    if (nextHeat !== cur.heat) anyChanged = true
    nextNodes[def.id] = {
      ...cur,
      heat: nextHeat,
      ...(nextHeat === 0 ? { reason: '' } : {}),
    }
  }
  const nextArcs: BrainArc[] = []
  for (const arc of state.arcs) {
    const dt = Math.max(0, now - arc.lastFiredAt)
    const decayed = arc.heat * Math.exp(-dt / (halfLifeMs * 0.85))
    if (decayed >= 0.04) {
      nextArcs.push({ ...arc, heat: decayed })
    } else {
      anyChanged = true
    }
  }
  if (!anyChanged && nextArcs.length === state.arcs.length) return state
  return { nodes: nextNodes, arcs: nextArcs }
}

export function hasActiveBrainHeat(state: BrainActivityState): boolean {
  for (const def of BRAIN_NODES) {
    if (state.nodes[def.id].heat > 0) return true
  }
  return state.arcs.length > 0
}

export function topFiringNodes(
  state: BrainActivityState,
  limit = 3,
): Array<{ id: BrainNodeId; label: string; heat: number; color: string; reason: string }> {
  return BRAIN_NODES
    .map((def) => ({
      id: def.id,
      label: def.shortLabel,
      heat: state.nodes[def.id].heat,
      color: state.nodes[def.id].heat >= 0.55 ? def.hotColor : def.warmColor,
      reason: state.nodes[def.id].reason,
    }))
    .filter((item) => item.heat > 0.03)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, limit)
}

export function routeEngineEventToBrain(event: EngineEvent): {
  nodes: BrainNodeId[]
  intensity: number
  reason: string
} {
  switch (event.type) {
    case 'turn-start':
      return { nodes: ['core', 'engine'], intensity: 0.9, reason: `Turn ${event.turn}` }
    case 'assistant-thinking':
      return { nodes: ['engine', 'brain'], intensity: 0.65, reason: 'Reasoning' }
    case 'assistant-text':
      return { nodes: ['engine', 'core'], intensity: 0.6, reason: 'Responding' }
    case 'tool-request':
    case 'tool-progress':
    case 'tool-result': {
      const name = event.name.toLowerCase()
      if (name.includes('memory') || name.includes('continuity')) {
        return { nodes: ['brain', 'harness', 'core'], intensity: 0.95, reason: event.name }
      }
      if (name.includes('library')) {
        return { nodes: ['librarian', 'brain', 'core'], intensity: 0.95, reason: event.name }
      }
      if (name.includes('investigat')) {
        return { nodes: ['truth', 'engine', 'core'], intensity: 0.95, reason: event.name }
      }
      if (name.includes('learn')) {
        return { nodes: ['learning', 'brain', 'core'], intensity: 0.9, reason: event.name }
      }
      return { nodes: ['harness', 'truth', 'engine'], intensity: 0.9, reason: event.name }
    }
    case 'permission-requested':
    case 'permission-resolved':
      return { nodes: ['guards', 'core'], intensity: 1.0, reason: `Permission (${event.toolName})` }
    case 'background-status':
    case 'background-output':
      return { nodes: ['harness', 'core'], intensity: 0.75, reason: 'Background task' }
    case 'todo-update':
    case 'agent-status-update':
      return { nodes: ['truth', 'core'], intensity: 0.6, reason: 'Status update' }
    case 'turn-done':
      return { nodes: ['core', 'journal'], intensity: 0.75, reason: 'Turn persisted' }
    default:
      return { nodes: ['core'], intensity: 0.35, reason: event.type }
  }
}

// Unicode Braille bit mapping for a 2x4 sub-pixel cell:
// col 0: rows 0..3 -> bits 0, 1, 2, 6 (0x01, 0x02, 0x04, 0x40)
// col 1: rows 0..3 -> bits 3, 4, 5, 7 (0x08, 0x10, 0x20, 0x80)
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

interface CellColor {
  color: string
  bold: boolean
  dimColor: boolean
  priority: number
}

/**
 * Renders a crisp Unicode Braille orbital diagram of Athena's subsystems with live EEG
 * firing glow, synaptic arcs, and node labels. Always returns exactly `heightRows` rows
 * whose visible character width equals `widthCols`.
 */
export function renderBrainOrbitalLines(
  state: BrainActivityState,
  widthCols: number,
  heightRows: number,
): RenderedOrbitalRow[] {
  const cols = Math.max(16, Math.floor(widthCols))
  const rows = Math.max(8, Math.floor(heightRows))
  const pxW = cols * 2
  const pxH = rows * 4
  const cx = (pxW - 1) / 2
  const cy = (pxH - 1) / 2
  const rxMax = Math.max(6, cx - 5)
  const ryMax = Math.max(6, cy - 3)

  const mask = new Uint8Array(cols * rows)
  const colors: Array<CellColor | null> = new Array<CellColor | null>(cols * rows).fill(null)

  const setPixel = (px: number, py: number, style: CellColor): void => {
    const ix = Math.round(px)
    const iy = Math.round(py)
    if (ix < 0 || ix >= pxW || iy < 0 || iy >= pxH) return
    const cellX = Math.floor(ix / 2)
    const cellY = Math.floor(iy / 4)
    const idx = cellY * cols + cellX
    mask[idx]! |= BRAILLE_BITS[iy % 4]![ix % 2]!
    const cur = colors[idx]
    if (!cur || style.priority >= cur.priority) {
      colors[idx] = style
    }
  }

  // 1. Concentric orbital rings (4 rings matching Engine, Brain, Guards/Services, Capabilities/Knowledge)
  const ringRadii = [0.30, 0.48, 0.66, 0.88]
  for (const r of ringRadii) {
    const steps = Math.max(72, Math.round(2 * Math.PI * Math.max(rxMax, ryMax) * r * 1.4))
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2
      setPixel(cx + Math.cos(a) * rxMax * r, cy + Math.sin(a) * ryMax * r, {
        color: r <= 0.48 ? 'yellow' : 'cyan',
        bold: false,
        dimColor: true,
        priority: 1,
      })
    }
  }

  // Helper to get node pixel coordinates
  const nodePos = (def: BrainNodeDef): { x: number; y: number } => {
    const rad = (def.angleDeg * Math.PI) / 180
    return {
      x: cx + Math.cos(rad) * rxMax * def.ring,
      y: cy + Math.sin(rad) * ryMax * def.ring,
    }
  }

  // 2. Active synaptic arcs between firing nodes and core
  for (const arc of state.arcs) {
    const fromDef = BRAIN_NODES.find((n) => n.id === arc.from)
    const toDef = BRAIN_NODES.find((n) => n.id === arc.to)
    if (!fromDef || !toDef) continue
    const p1 = nodePos(fromDef)
    const p2 = nodePos(toDef)
    const steps = Math.max(12, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y)))
    const style: CellColor = {
      color: arc.heat >= 0.5 ? toDef.hotColor : toDef.warmColor,
      bold: arc.heat >= 0.6,
      dimColor: arc.heat < 0.25,
      priority: 3,
    }
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      setPixel(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t, style)
    }
  }

  // 3. Central glowing core orb
  const coreHeat = state.nodes.core.heat
  const coreRadius = coreHeat > 0.4 ? 3.2 : 2.2
  const coreStyle: CellColor = {
    color: coreHeat > 0.4 ? 'yellowBright' : 'yellow',
    bold: coreHeat > 0.2,
    dimColor: coreHeat < 0.1,
    priority: 5,
  }
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (dx * dx + dy * dy <= coreRadius * coreRadius) {
        setPixel(cx + dx, cy + dy, coreStyle)
      }
    }
  }

  // 4. Subsystem node markers on their orbital rings
  for (const def of BRAIN_NODES) {
    if (def.id === 'core') continue
    const { x, y } = nodePos(def)
    const heat = state.nodes[def.id].heat
    const radius = heat >= 0.5 ? 2.2 : 1.3
    const style: CellColor = {
      color: heat >= 0.5 ? def.hotColor : heat > 0.05 ? def.warmColor : 'gray',
      bold: heat >= 0.4,
      dimColor: heat <= 0.05,
      priority: heat > 0.05 ? 6 : 2,
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy <= radius * radius) {
          setPixel(x + dx, y + dy, style)
        }
      }
    }
  }

  // 5. Convert Braille grid to character cells and overlay crisp node labels
  const chars: string[] = new Array<string>(cols * rows)
  for (let i = 0; i < cols * rows; i++) {
    chars[i] = mask[i] === 0 ? ' ' : String.fromCharCode(0x2800 + mask[i]!)
  }

  const placeLabel = (cellX: number, cellY: number, text: string, style: CellColor): void => {
    if (cellY < 0 || cellY >= rows) return
    const startX = Math.max(0, Math.min(cols - text.length, cellX))
    for (let i = 0; i < text.length; i++) {
      const idx = cellY * cols + startX + i
      chars[idx] = text[i]!
      colors[idx] = style
    }
  }

  for (const def of BRAIN_NODES) {
    const { x, y } = nodePos(def)
    const heat = state.nodes[def.id].heat
    const cellX = Math.floor(x / 2)
    const cellY = Math.floor(y / 4)
    const label = def.id === 'core' ? 'CORE' : def.shortLabel
    const offsetX = def.id === 'core' ? cellX - 2 : cellX >= cols / 2 ? cellX + 1 : cellX - label.length
    const offsetY = def.id === 'core' ? Math.min(rows - 1, cellY + 1) : cellY
    placeLabel(offsetX, offsetY, label, {
      color: heat >= 0.5 ? def.hotColor : heat > 0.05 ? def.warmColor : 'gray',
      bold: heat >= 0.35 || def.id === 'core',
      dimColor: heat <= 0.05 && def.id !== 'core',
      priority: 10,
    })
  }

  // 6. Run-length encode adjacent cells with identical styles into Ink ColoredSegments
  const result: RenderedOrbitalRow[] = []
  for (let r = 0; r < rows; r++) {
    const segments: ColoredSegment[] = []
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      const ch = chars[idx]!
      const st = colors[idx]
      const prev = segments[segments.length - 1]
      const color = st?.color
      const bold = st?.bold ?? false
      const dimColor = st?.dimColor ?? false
      if (
        prev &&
        prev.color === color &&
        (prev.bold ?? false) === bold &&
        (prev.dimColor ?? false) === dimColor
      ) {
        prev.text += ch
      } else {
        segments.push({
          text: ch,
          ...(color ? { color } : {}),
          ...(bold ? { bold } : {}),
          ...(dimColor ? { dimColor } : {}),
        })
      }
    }
    result.push({ segments })
  }
  return result
}
