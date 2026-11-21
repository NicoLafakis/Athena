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
  /** Plain-English label rendered on the 3D hologram and Active Pathways readout. */
  shortLabel: string
  fullLabel: string
  /** Normalized orbital radius 0..1.18 from center. */
  ring: number
  /** Azimuth angle in degrees (0..360). */
  angleDeg: number
  /** Elevation latitude in degrees (-60..60) for true 3D orbital placement. */
  elevDeg: number
  /** 24-bit TrueColor hex when actively firing. */
  hotColor: string
  /** 24-bit TrueColor hex during warm afterglow. */
  warmColor: string
}

export const BRAIN_NODES: readonly BrainNodeDef[] = [
  { id: 'core', shortLabel: 'Core', fullLabel: 'Athena Core', ring: 0.0, angleDeg: 0, elevDeg: 0, hotColor: '#fef08a', warmColor: '#f59e0b' },
  { id: 'voice', shortLabel: 'Voice', fullLabel: 'Voice Stream', ring: 1.04, angleDeg: 315, elevDeg: 28, hotColor: '#4ade80', warmColor: '#22d3ee' },
  { id: 'engine', shortLabel: 'Thinking', fullLabel: 'Reasoning Engine', ring: 0.88, angleDeg: 55, elevDeg: 38, hotColor: '#fde047', warmColor: '#f59e0b' },
  { id: 'brain', shortLabel: 'Memory', fullLabel: 'Brain & Memory', ring: 0.96, angleDeg: 140, elevDeg: 18, hotColor: '#e879f9', warmColor: '#c084fc' },
  { id: 'harness', shortLabel: 'Tools', fullLabel: 'Tools & Actions', ring: 1.02, angleDeg: 20, elevDeg: -22, hotColor: '#38bdf8', warmColor: '#0ea5e9' },
  { id: 'guards', shortLabel: 'Safety', fullLabel: 'Safety & Permissions', ring: 0.95, angleDeg: 100, elevDeg: -34, hotColor: '#f87171', warmColor: '#ef4444' },
  { id: 'truth', shortLabel: 'Verify', fullLabel: 'Truth & Checks', ring: 0.96, angleDeg: 235, elevDeg: 24, hotColor: '#22d3ee', warmColor: '#06b6d4' },
  { id: 'librarian', shortLabel: 'Library', fullLabel: 'Code Library', ring: 1.06, angleDeg: 195, elevDeg: -16, hotColor: '#60a5fa', warmColor: '#3b82f6' },
  { id: 'journal', shortLabel: 'Journal', fullLabel: 'Daily Journal', ring: 1.04, angleDeg: 265, elevDeg: -32, hotColor: '#818cf8', warmColor: '#6366f1' },
  { id: 'learning', shortLabel: 'Learning', fullLabel: 'Skill Learning', ring: 1.04, angleDeg: 350, elevDeg: 46, hotColor: '#c084fc', warmColor: '#818cf8' },
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

export interface BrainRenderOptions {
  /** Continuous rotation angle in radians for the 3D Jarvis sphere. */
  phaseRad?: number
  /** Normalized 0..1 user microphone energy (drives 3D surface ripple & emerald shift). */
  micEnergy?: number
  /** Normalized 0..1 Athena voice energy (drives golden core expansion & bloom). */
  athenaEnergy?: number
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

interface CellStyle {
  color: string
  bold: boolean
  dimColor: boolean
  z: number
  priority: number
}

interface Vec3 {
  x: number
  y: number
  z: number
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function rgbToHex(r: number, g: number, b: number): string {
  const cr = Math.max(0, Math.min(255, Math.round(r)))
  const cg = Math.max(0, Math.min(255, Math.round(g)))
  const cb = Math.max(0, Math.min(255, Math.round(b)))
  return `#${cr.toString(16).padStart(2, '0')}${cg.toString(16).padStart(2, '0')}${cb.toString(16).padStart(2, '0')}`
}

function lerpHex(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): string {
  const k = clamp01(t)
  return rgbToHex(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k)
}

function rotate3D(p: Vec3, yaw: number, tiltX: number): Vec3 {
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  const x1 = p.x * cosY + p.z * sinY
  const z1 = -p.x * sinY + p.z * cosY
  const cosX = Math.cos(tiltX)
  const sinX = Math.sin(tiltX)
  const y2 = p.y * cosX - z1 * sinX
  const z2 = p.y * sinX + z1 * cosX
  return { x: x1, y: y2, z: z2 }
}

function rotateAroundX(p: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c }
}

function rotateAroundZ(p: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z }
}

// Jarvis hologram TrueColor stops
const RGB_BACK: readonly [number, number, number] = [24, 48, 84]
const RGB_MID: readonly [number, number, number] = [14, 132, 196]
const RGB_FRONT: readonly [number, number, number] = [56, 189, 248]
const RGB_SPECULAR: readonly [number, number, number] = [186, 230, 253]
const RGB_MIC_GLOW: readonly [number, number, number] = [52, 211, 153]
const RGB_GOLD_HOT: readonly [number, number, number] = [254, 240, 138]
const RGB_GOLD_MID: readonly [number, number, number] = [245, 158, 11]
const RGB_GOLD_DIM: readonly [number, number, number] = [120, 74, 24]

/**
 * Renders a 3D rotating Jarvis holographic neural sphere in Unicode Braille with
 * 24-bit TrueColor depth shading, Z-buffered occlusion, inclined gyroscopic rings,
 * voice-reactive radial ripples, traveling 3D synaptic pulses, and plain-English labels.
 * Always returns exactly `heightRows` rows whose visible character width equals `widthCols`.
 */
export function renderBrainOrbitalLines(
  state: BrainActivityState,
  widthCols: number,
  heightRows: number,
  options?: BrainRenderOptions,
): RenderedOrbitalRow[] {
  const cols = Math.max(16, Math.floor(widthCols))
  const rows = Math.max(8, Math.floor(heightRows))
  const pxW = cols * 2
  const pxH = rows * 4
  const cx = (pxW - 1) / 2
  const cy = (pxH - 1) / 2

  const phaseRad = options?.phaseRad ?? 0
  const micEnergy = clamp01(options?.micEnergy ?? 0)
  const athenaEnergy = clamp01(options?.athenaEnergy ?? 0)
  const tiltX = 0.30
  const cameraZ = 3.3
  // Leave generous breathing room around the 3D sphere for anchored plain-English labels
  const radiusPx = Math.max(8, Math.min(cx - 14, cy - 4) * 0.88)

  const mask = new Uint8Array(cols * rows)
  const styles: Array<CellStyle | null> = new Array<CellStyle | null>(cols * rows).fill(null)

  const project = (p: Vec3): { px: number; py: number; depth: number; scale: number } => {
    const persp = cameraZ / Math.max(1.05, cameraZ - p.z)
    return {
      px: cx + p.x * radiusPx * persp,
      py: cy + p.y * radiusPx * persp,
      depth: clamp01((p.z + 1.25) / 2.5),
      scale: persp,
    }
  }

  const plotPixel = (px: number, py: number, style: CellStyle): void => {
    const ix = Math.round(px)
    const iy = Math.round(py)
    if (ix < 0 || ix >= pxW || iy < 0 || iy >= pxH) return
    const cellX = Math.floor(ix / 2)
    const cellY = Math.floor(iy / 4)
    const idx = cellY * cols + cellX
    mask[idx]! |= BRAILLE_BITS[iy % 4]![ix % 2]!
    const cur = styles[idx]
    if (!cur || style.priority > cur.priority || (style.priority === cur.priority && style.z >= cur.z)) {
      styles[idx] = style
    }
  }

  const sphereColor = (depth: number): { color: string; bold: boolean; dimColor: boolean } => {
    let base: string
    if (depth < 0.42) {
      base = lerpHex(RGB_BACK, RGB_MID, depth / 0.42)
    } else if (depth < 0.78) {
      base = lerpHex(RGB_MID, RGB_FRONT, (depth - 0.42) / 0.36)
    } else {
      base = lerpHex(RGB_FRONT, RGB_SPECULAR, (depth - 0.78) / 0.22)
    }
    if (micEnergy > 0.08 && depth > 0.45) {
      // Blend toward emerald-cyan as user speaks
      base = lerpHex(RGB_FRONT, RGB_MIC_GLOW, clamp01(micEnergy * 0.85))
    }
    return {
      color: base,
      bold: depth > 0.78,
      dimColor: depth < 0.32,
    }
  }

  // 1. Clean, airy 3D Geodesic Wireframe Sphere (4 meridians + 3 parallels)
  const sphereR = 0.78 + athenaEnergy * 0.04 + micEnergy * 0.025
  const meridians = 4
  for (let m = 0; m < meridians; m++) {
    const lon = (m / meridians) * Math.PI
    const steps = 44
    for (let s = 0; s < steps; s++) {
      const lat = (s / steps) * Math.PI * 2
      const ripple = micEnergy > 0.08 ? Math.sin(lat * 3 - phaseRad * 4) * 0.03 * micEnergy : 0
      const r = sphereR + ripple
      const raw: Vec3 = {
        x: Math.cos(lat) * Math.cos(lon) * r,
        y: Math.sin(lat) * r,
        z: Math.cos(lat) * Math.sin(lon) * r,
      }
      const rot = rotate3D(raw, phaseRad, tiltX)
      const proj = project(rot)
      const col = sphereColor(proj.depth)
      plotPixel(proj.px, proj.py, { ...col, z: rot.z, priority: 1 })
    }
  }

  const parallels = [-0.48, 0, 0.48]
  for (const sinLat of parallels) {
    const cosLat = Math.sqrt(Math.max(0, 1 - sinLat * sinLat))
    const steps = 50
    for (let s = 0; s < steps; s++) {
      const lon = (s / steps) * Math.PI * 2
      const ripple = athenaEnergy > 0.08 ? Math.sin(lon * 3 + phaseRad * 4) * 0.028 * athenaEnergy : 0
      const r = sphereR + ripple
      const raw: Vec3 = {
        x: Math.cos(lon) * cosLat * r,
        y: sinLat * r,
        z: Math.sin(lon) * cosLat * r,
      }
      const rot = rotate3D(raw, phaseRad, tiltX)
      const proj = project(rot)
      const col = sphereColor(proj.depth)
      plotPixel(proj.px, proj.py, { ...col, z: rot.z, priority: 1 })
    }
  }

  // 2. Single calm equatorial halo ring (minimalist anchor around the 3D globe)
  {
    const haloR = 0.98
    const steps = 68
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2
      const p: Vec3 = rotateAroundZ(
        rotateAroundX({ x: Math.cos(a) * haloR, y: 0, z: Math.sin(a) * haloR }, 0.35),
        0.12,
      )
      const rot = rotate3D(p, -phaseRad * 0.25, tiltX)
      const proj = project(rot)
      const color = lerpHex(RGB_GOLD_DIM, athenaEnergy > 0.12 ? RGB_GOLD_HOT : RGB_GOLD_MID, proj.depth)
      plotPixel(proj.px, proj.py, {
        color,
        bold: proj.depth > 0.78 && athenaEnergy > 0.12,
        dimColor: proj.depth < 0.45,
        z: rot.z,
        priority: 2,
      })
    }
  }

  // Compute calm, ANCHORED positions for every subsystem node so labels never fly around
  const node3D = new Map<BrainNodeId, Vec3>()
  for (const def of BRAIN_NODES) {
    if (def.id === 'core') {
      node3D.set('core', { x: 0, y: 0, z: 0 })
      continue
    }
    const rad = (def.angleDeg * Math.PI) / 180
    node3D.set(def.id, {
      x: Math.cos(rad) * 1.08,
      y: Math.sin(rad) * 1.02,
      z: 0.35,
    })
  }

  // 3. Traveling 3D Plasma Synaptic Arcs from Core to firing subsystems
  const sparkPhase = (phaseRad * 1.8) % 1
  for (const arc of state.arcs) {
    const p1 = node3D.get(arc.from)
    const p2 = node3D.get(arc.to)
    const toDef = BRAIN_NODES.find((n) => n.id === arc.to)
    if (!p1 || !p2 || !toDef) continue
    // Elevated 3D midpoint creates a clean curved plasma filament
    const mid: Vec3 = {
      x: (p1.x + p2.x) * 0.5,
      y: (p1.y + p2.y) * 0.5 - 0.22,
      z: (p1.z + p2.z) * 0.5 + 0.18,
    }
    const steps = 26
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const inv = 1 - t
      const pt: Vec3 = {
        x: inv * inv * p1.x + 2 * inv * t * mid.x + t * t * p2.x,
        y: inv * inv * p1.y + 2 * inv * t * mid.y + t * t * p2.y,
        z: inv * inv * p1.z + 2 * inv * t * mid.z + t * t * p2.z,
      }
      const proj = project(pt)
      const distToSpark = Math.abs(t - sparkPhase)
      const isSpark = distToSpark < 0.09
      plotPixel(proj.px, proj.py, {
        color: isSpark ? '#ffffff' : arc.heat >= 0.5 ? toDef.hotColor : toDef.warmColor,
        bold: isSpark || arc.heat >= 0.55,
        dimColor: !isSpark && arc.heat < 0.22,
        z: pt.z + 0.25,
        priority: isSpark ? 7 : 4,
      })
    }
  }

  // 4. Multi-layer Glowing 3D Jarvis Core at (0, 0, 0)
  const coreHeat = state.nodes.core.heat
  const corePulse = Math.sin(phaseRad * 3.2) * 0.35
  const coreRadius = 2.6 + coreHeat * 1.4 + athenaEnergy * 1.6 + corePulse
  const coreMax = Math.ceil(coreRadius + 1)
  for (let dy = -coreMax; dy <= coreMax; dy++) {
    for (let dx = -coreMax; dx <= coreMax; dx++) {
      const dist = Math.hypot(dx, dy)
      if (dist > coreRadius) continue
      const ratio = dist / Math.max(1, coreRadius)
      const color =
        ratio < 0.42
          ? '#fef9c3'
          : ratio < 0.72
            ? lerpHex(RGB_GOLD_HOT, RGB_GOLD_MID, (ratio - 0.42) / 0.3)
            : '#ea580c'
      plotPixel(cx + dx, cy + dy, {
        color,
        bold: ratio < 0.75,
        dimColor: false,
        z: 0.4 - ratio * 0.2,
        priority: 6,
      })
    }
  }

  // 5. 3D Subsystem Node Orbs
  const projectedNodes: Array<{
    def: BrainNodeDef
    px: number
    py: number
    z: number
    depth: number
    heat: number
  }> = []

  for (const def of BRAIN_NODES) {
    const pt = node3D.get(def.id)!
    const proj = project(pt)
    const heat = state.nodes[def.id].heat
    projectedNodes.push({ def, px: proj.px, py: proj.py, z: pt.z, depth: proj.depth, heat })
    if (def.id === 'core') continue

    const orbR = heat >= 0.45 ? 2.3 : proj.depth > 0.5 ? 1.5 : 1.0
    const color =
      heat >= 0.5
        ? def.hotColor
        : heat > 0.05
          ? def.warmColor
          : proj.depth > 0.52
            ? '#7dd3fc'
            : '#334155'
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy <= orbR * orbR) {
          plotPixel(proj.px + dx, proj.py + dy, {
            color,
            bold: heat >= 0.35 || proj.depth > 0.72,
            dimColor: heat <= 0.05 && proj.depth < 0.45,
            z: pt.z + 0.1,
            priority: heat > 0.05 ? 8 : 3,
          })
        }
      }
    }
  }

  // 6. Convert Braille bitmap to character cells and overlay collision-free plain-English labels
  const chars: string[] = new Array<string>(cols * rows)
  for (let i = 0; i < cols * rows; i++) {
    chars[i] = mask[i] === 0 ? ' ' : String.fromCharCode(0x2800 + mask[i]!)
  }

  const occupied = new Uint8Array(cols * rows)
  const tryPlaceLabel = (cellX: number, cellY: number, text: string, style: CellStyle): boolean => {
    if (cellY < 0 || cellY >= rows) return false
    const startX = Math.max(0, Math.min(cols - text.length, cellX))
    // Check collision with 1-cell horizontal padding so plain-English names stay legible
    const padStart = Math.max(0, startX - 1)
    const padEnd = Math.min(cols - 1, startX + text.length)
    for (let x = padStart; x <= padEnd; x++) {
      if (occupied[cellY * cols + x]) return false
    }
    for (let i = 0; i < text.length; i++) {
      const idx = cellY * cols + startX + i
      chars[idx] = text[i]!
      styles[idx] = style
      occupied[idx] = 1
    }
    return true
  }

  // Sort labels by priority: firing nodes first, then front-most 3D depth so foreground labels always win
  const sortedLabels = [...projectedNodes].sort((a, b) => {
    const aHot = a.heat > 0.05 ? 1 : 0
    const bHot = b.heat > 0.05 ? 1 : 0
    if (aHot !== bHot) return bHot - aHot
    if (a.def.id === 'core') return -1
    if (b.def.id === 'core') return 1
    return b.z - a.z
  })

  for (const item of sortedLabels) {
    const { def, px, py, z, heat } = item

    const cellX = Math.floor(px / 2)
    const cellY = Math.floor(py / 4)
    const label = def.shortLabel
    const baseX = def.id === 'core' ? cellX - Math.floor(label.length / 2) : cellX >= cols / 2 ? cellX + 1 : cellX - label.length
    const baseY = def.id === 'core' ? Math.min(rows - 1, cellY + 1) : cellY

    const labelStyle: CellStyle = {
      color:
        heat >= 0.5
          ? def.hotColor
          : heat > 0.05
            ? def.warmColor
            : def.id === 'core'
              ? '#fde047'
              : '#64748b',
      bold: heat >= 0.35 || def.id === 'core',
      dimColor: heat <= 0.05 && def.id !== 'core',
      z: z + 2,
      priority: 10,
    }

    // Try primary row, then nudge ±1 row if another orbiting label occupies that cell
    if (!tryPlaceLabel(baseX, baseY, label, labelStyle)) {
      if (!tryPlaceLabel(baseX, baseY - 1, label, labelStyle)) {
        tryPlaceLabel(baseX, baseY + 1, label, labelStyle)
      }
    }
  }

  // 7. Run-length encode adjacent cells with identical styles into Ink ColoredSegments
  const result: RenderedOrbitalRow[] = []
  for (let r = 0; r < rows; r++) {
    const segments: ColoredSegment[] = []
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      const ch = chars[idx]!
      const st = styles[idx]
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
