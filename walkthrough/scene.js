// The storybook house. Pure scene building: no page chrome, no camera logic.
import * as THREE from 'three'

export const RW = 5 // room width
export const RH = 3.4 // room height
export const RD = 4.4 // room depth
export const UP = RH + 0.25 // floor height of the upper storey

const PAL = {
  cream: '#f4e6c8',
  paper: '#efdcb4',
  terracotta: '#c8674a',
  olive: '#7a8b4a',
  oliveDark: '#55663a',
  teal: '#2f6f73',
  tealSoft: '#5f9ea0',
  ink: '#3b2a20',
  gold: '#e0a83c',
  wood: '#b07a4a',
  woodDark: '#7a4f2e',
  rose: '#d98b86',
  sky: '#9fc7d6',
  plum: '#6b4a73',
  stone: '#b9ab94',
}

// ---------- materials: hand-painted paper ----------
const texCache = new Map()
function paperTexture(hex) {
  if (texCache.has(hex)) return texCache.get(hex)
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  g.fillStyle = hex
  g.fillRect(0, 0, 256, 256)
  let seed = 1
  for (let i = 0; i < hex.length; i++) seed = (seed * 31 + hex.charCodeAt(i)) >>> 0
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < 520; i++) {
    const light = rnd() > 0.5
    g.strokeStyle = light ? `rgba(255,248,230,${0.03 + rnd() * 0.06})` : `rgba(60,36,20,${0.02 + rnd() * 0.05})`
    g.lineWidth = 1 + rnd() * 5
    const x = rnd() * 256
    const y = rnd() * 256
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + (rnd() - 0.5) * 60, y + (rnd() - 0.5) * 14)
    g.stroke()
  }
  for (let i = 0; i < 700; i++) {
    g.fillStyle = `rgba(70,45,25,${rnd() * 0.07})`
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  texCache.set(hex, t)
  return t
}
const matCache = new Map()
function mat(hex) {
  if (matCache.has(hex)) return matCache.get(hex)
  const m = new THREE.MeshLambertMaterial({ color: '#ffffff', map: paperTexture(hex) })
  matCache.set(hex, m)
  return m
}
const glowCache = new Map()
function glow(hex) {
  if (glowCache.has(hex)) return glowCache.get(hex)
  const m = new THREE.MeshBasicMaterial({ color: hex })
  glowCache.set(hex, m)
  return m
}
const inkMat = new THREE.MeshBasicMaterial({ color: PAL.ink, side: THREE.BackSide })

// ---------- tiny geometry helpers ----------
function shadow(m) {
  m.castShadow = true
  m.receiveShadow = true
  return m
}
function B(parent, w, h, d, color, x = 0, y = 0, z = 0) {
  const m = shadow(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof color === 'string' ? mat(color) : color))
  m.position.set(x, y + h / 2, z)
  parent.add(m)
  return m
}
function C(parent, rt, rb, h, color, x = 0, y = 0, z = 0, seg = 24) {
  const m = shadow(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), typeof color === 'string' ? mat(color) : color))
  m.position.set(x, y + h / 2, z)
  parent.add(m)
  return m
}
function S(parent, r, color, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, outline = false) {
  const m = shadow(new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), typeof color === 'string' ? mat(color) : color))
  m.position.set(x, y, z)
  m.scale.set(sx, sy, sz)
  parent.add(m)
  if (outline) {
    const o = new THREE.Mesh(m.geometry, inkMat)
    o.scale.setScalar(1.045)
    o.userData.noPick = true
    m.add(o)
  }
  return m
}
function T(parent, R, tube, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, arc = Math.PI * 2) {
  const m = shadow(new THREE.Mesh(new THREE.TorusGeometry(R, tube, 12, 36, arc), typeof color === 'string' ? mat(color) : color))
  m.position.set(x, y, z)
  m.rotation.set(rx, ry, 0)
  parent.add(m)
  return m
}
function G(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  parent.add(g)
  return g
}
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}
function signPlane(parent, w, h, text, bg, fg, x, y, z, font = 'bold 64px Georgia, serif') {
  const tex = canvasTex(512, Math.round((512 * h) / w), (g, cw, ch) => {
    g.fillStyle = bg
    g.fillRect(0, 0, cw, ch)
    g.strokeStyle = 'rgba(60,36,20,0.55)'
    g.lineWidth = 8
    g.strokeRect(10, 10, cw - 20, ch - 20)
    g.fillStyle = fg
    g.font = font
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, cw / 2, ch / 2 + 4)
  })
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), [mat(PAL.woodDark), mat(PAL.woodDark), mat(PAL.woodDark), mat(PAL.woodDark), new THREE.MeshLambertMaterial({ map: tex }), mat(PAL.woodDark)])
  m.castShadow = true
  m.position.set(x, y, z)
  parent.add(m)
  return m
}
function glowSpriteTexture() {
  return canvasTex(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 4, 64, 64, 64)
    r.addColorStop(0, 'rgba(255,230,150,0.95)')
    r.addColorStop(0.45, 'rgba(255,200,90,0.35)')
    r.addColorStop(1, 'rgba(255,200,90,0)')
    g.fillStyle = r
    g.fillRect(0, 0, 128, 128)
  })
}

// ---------- characters ----------
function buildOwl(parent, scale = 1) {
  const o = G(parent)
  o.scale.setScalar(scale)
  const body = S(o, 0.55, '#8a5a3c', 0, 0.62, 0, 1, 1.15, 0.92, true)
  S(o, 0.4, '#e9cfa2', 0, 0.55, 0.28, 0.95, 1.05, 0.6)
  for (const s of [-1, 1]) {
    const eye = S(o, 0.19, '#fff8e6', s * 0.2, 0.98, 0.43, 1, 1, 0.5, true)
    S(eye, 0.09, '#2a1d15', 0, 0, 0.14, 1, 1, 0.6)
    S(eye, 0.035, '#ffffff', 0.03, 0.04, 0.21, 1, 1, 0.6)
    eye.userData.eye = true
    const ear = shadow(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.3, 12), mat('#7a4d32')))
    ear.position.set(s * 0.33, 1.42, 0.02)
    ear.rotation.z = -s * 0.35
    o.add(ear)
    const wing = S(o, 0.3, '#6e4630', s * 0.56, 0.62, -0.02, 0.4, 1.05, 0.7)
    wing.rotation.z = s * 0.12
    const foot = B(o, 0.18, 0.08, 0.2, PAL.gold, s * 0.18, 0, 0.22)
    foot.castShadow = false
  }
  const beak = shadow(new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.17, 12), mat(PAL.gold)))
  beak.position.set(0, 0.86, 0.58)
  beak.rotation.x = Math.PI / 2
  o.add(beak)
  // olive-leaf crown: the one nod to the name
  const wreath = T(o, 0.3, 0.035, PAL.olive, 0, 1.28, 0.02, Math.PI / 2 - 0.25, 0)
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2
    const leaf = S(o, 0.055, PAL.oliveDark, Math.cos(a) * 0.31, 1.3 + Math.sin(a) * 0.04, Math.sin(a) * 0.31, 1.6, 0.4, 0.8)
    leaf.rotation.y = -a
  }
  void body
  void wreath
  return o
}

function buildKeeper(parent) {
  const k = G(parent)
  S(k, 0.52, '#4d6b46', 0, 0.62, 0, 1, 1.15, 0.9, true)
  S(k, 0.14, PAL.gold, 0, 0.7, 0.44, 1, 1, 0.4) // button
  S(k, 0.14, PAL.gold, 0, 0.45, 0.46, 1, 1, 0.4)
  const head = S(k, 0.3, '#f0c9a0', 0, 1.42, 0, 1, 1, 1, true)
  for (const s of [-1, 1]) S(head, 0.04, PAL.ink, s * 0.1, 0.04, 0.27)
  S(head, 0.06, '#e5a98a', 0, -0.03, 0.3) // nose
  const stache = S(head, 0.1, '#d9d3c4', 0, -0.12, 0.26, 2.0, 0.7, 0.6)
  stache.userData.keep = true
  C(k, 0.4, 0.4, 0.05, '#3f5a3a', 0, 1.62)
  C(k, 0.26, 0.28, 0.3, '#3f5a3a', 0, 1.66)
  C(k, 0.27, 0.27, 0.06, PAL.gold, 0, 1.7)
  const arm = G(k, 0.5, 0.85, 0.15)
  S(arm, 0.16, '#4d6b46', 0, 0, 0, 1, 1.4, 1)
  arm.userData.arm = true
  k.userData.arm = arm
  return k
}

// ---------- rooms ----------
function buildRoom(world, id, name, cx, cy, wallColor, floorColor, opts = {}) {
  const r = G(world.root, cx, cy, 0)
  r.userData.roomId = id
  const { leftWall = true, rightWall = false, backWall = true, openTop = false } = opts
  B(r, RW, 0.25, RD, floorColor, 0, -0.25, 0) // floor slab
  if (backWall) {
    B(r, RW + 0.2, RH, 0.2, wallColor, 0, 0, -RD / 2 - 0.1)
    B(r, RW, 1.0, 0.05, shade(wallColor, -0.12), 0, 0, -RD / 2 + 0.02) // wainscot
    B(r, RW, 0.08, 0.08, PAL.cream, 0, 1.0, -RD / 2 + 0.05)
    B(r, RW, 0.16, 0.06, PAL.woodDark, 0, 0, -RD / 2 + 0.04) // baseboard
  }
  if (leftWall) B(r, 0.2, RH, RD, wallColor, -RW / 2 - 0.1, 0, 0)
  if (rightWall) B(r, 0.2, RH, RD, wallColor, RW / 2 + 0.1, 0, 0)
  if (!openTop) B(r, RW + 0.2, 0.1, RD, PAL.cream, 0, RH - 0.02, 0).castShadow = false
  const light = new THREE.PointLight('#ffd9a0', 9, 11, 1.6)
  light.position.set(0, RH - 0.5, 1.2)
  r.add(light)
  world.rooms[id] = { id, name, group: r, cx, cy, light }
  return r
}
function shade(hex, amt) {
  const c = new THREE.Color(hex)
  const hsl = {}
  c.getHSL(hsl)
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amt)))
  return '#' + c.getHexString()
}

function windowOn(parent, x, y, z, w = 1.2, h = 1.4, glowHex = '#bfe0ea') {
  const f = G(parent, x, y, z)
  B(f, w + 0.2, h + 0.2, 0.08, PAL.woodDark, 0, 0, 0)
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glow(glowHex))
  pane.position.set(0, h / 2 + 0.1, 0.05)
  pane.userData.noPick = true
  f.add(pane)
  B(f, 0.06, h, 0.1, PAL.woodDark, 0, 0.1, 0.02)
  B(f, w, 0.06, 0.1, PAL.woodDark, 0, h / 2 + 0.07, 0.02)
  B(f, w + 0.4, 0.08, 0.25, PAL.cream, 0, -0.02, 0.1)
  return f
}

function reg(world, roomId, propId, obj) {
  obj.userData.pickId = propId
  obj.userData.pickRoom = roomId
  world.props[`${roomId}:${propId}`] = obj
}

// ---------- the world ----------
export function buildWorld() {
  const world = { scene: new THREE.Scene(), root: new THREE.Group(), rooms: {}, props: {}, tickers: [], blink: [], glowTex: null }
  const scene = world.scene
  scene.add(world.root)

  // sky
  scene.background = canvasTex(8, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h)
    gr.addColorStop(0, '#5f78ad')
    gr.addColorStop(0.38, '#b99bb4')
    gr.addColorStop(0.72, '#f6c9a0')
    gr.addColorStop(1, '#ffe3b8')
    g.fillStyle = gr
    g.fillRect(0, 0, w, h)
  })
  scene.fog = new THREE.Fog('#f2cfa6', 55, 120)

  // light
  scene.add(new THREE.HemisphereLight('#fff1d6', '#8a6a4a', 1.5))
  const sun = new THREE.DirectionalLight('#ffe2b0', 2.1)
  sun.position.set(-10, 24, 24)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const sc = sun.shadow.camera
  sc.left = -24
  sc.right = 20
  sc.top = 16
  sc.bottom = -14
  sc.near = 5
  sc.far = 80
  sun.shadow.bias = -0.0004
  sun.shadow.radius = 4
  scene.add(sun)
  scene.add(sun.target)
  sun.target.position.set(-4, 3, 0)

  buildGround(world)
  buildHouse(world)
  buildStudy(world)
  buildTools(world)
  buildLodge(world)
  buildNotes(world)
  buildAnnex(world)
  buildBalcony(world)
  buildDoor(world)
  buildDecor(world)

  world.glowTex = glowSpriteTexture()
  return world
}

function buildGround(world) {
  const g = shadow(new THREE.Mesh(new THREE.CylinderGeometry(70, 70, 0.4, 64), mat('#8c9a55')))
  g.position.set(-4, -1.1, 0)
  g.castShadow = false
  world.root.add(g)
  // painted path from the door to the house
  for (let i = 0; i < 6; i++) {
    const s = C(world.root, 0.5 + (i % 2) * 0.08, 0.5, 0.08, PAL.cream, -13 + i * 0.6 + (i > 3 ? 0.3 : 0), -0.9, 3.2 - i * 0.35, 18)
    s.scale.z = 0.8
    s.castShadow = false
  }
  // far hills
  const hills = [
    [-40, -2, -48, 22, '#7d8d58'],
    [-8, -4, -58, 26, '#6f8a62'],
    [30, -3, -50, 22, '#8a9a5e'],
    [-70, -3, -30, 20, '#6f8a62'],
    [58, -3, -30, 18, '#7d8d58'],
  ]
  for (const [x, y, z, r, c] of hills) {
    const h = S(world.root, r, c, x, y, z, 1.5, 0.55, 1)
    h.castShadow = false
  }
}

function buildHouse(world) {
  const r = world.root
  // stone plinth
  B(r, 15.6, 0.9, RD + 0.5, PAL.stone, -2.5, -1.1, 0).receiveShadow = true
  // steps
  for (let i = 0; i < 3; i++) B(r, 3.2, 0.2, 0.5, PAL.stone, -7.5, -0.9 + i * 0.15, RD / 2 + 0.55 - i * 0.2)
  // roof: a painted pitched roof behind the top floor, like the back of a dollhouse lid
  const roofShape = new THREE.Shape()
  roofShape.moveTo(-10.5, 0)
  roofShape.lineTo(5.5, 0)
  roofShape.lineTo(5.5, 0.3)
  roofShape.lineTo(-2.5, 3.6)
  roofShape.lineTo(-10.5, 0.3)
  roofShape.closePath()
  const roof = shadow(new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 0.35, bevelEnabled: false }), mat(PAL.terracotta)))
  roof.position.set(0, UP + RH, -RD / 2 - 0.4)
  r.add(roof)
  B(r, 16.8, 0.18, 1.0, PAL.woodDark, -2.5, UP + RH - 0.05, -RD / 2 - 0.2) // eave beam
  // chimney + smoke
  B(r, 0.9, 2.2, 0.9, '#a5573f', 2.8, UP + RH + 0.6, -RD / 2 - 0.2)
  B(r, 1.1, 0.14, 1.1, PAL.stone, 2.8, UP + RH + 2.75, -RD / 2 - 0.2)
  const smoke = []
  for (let i = 0; i < 5; i++) {
    const p = S(r, 0.3, '#fff5e4', 2.8, UP + RH + 3.2, -RD / 2 - 0.2)
    p.material = new THREE.MeshBasicMaterial({ color: '#fff5e4', transparent: true, opacity: 0.6 })
    p.castShadow = false
    p.userData.noPick = true
    smoke.push(p)
  }
  world.tickers.push((t) => {
    smoke.forEach((p, i) => {
      const k = (t * 0.12 + i / smoke.length) % 1
      p.position.y = UP + RH + 3.2 + k * 3
      p.position.x = 2.8 + k * 1.2 + Math.sin(k * 6 + i) * 0.2
      p.scale.setScalar(0.5 + k * 1.1)
      p.material.opacity = 0.6 * (1 - k)
    })
  })
}

// ---- 2. the study ----
function buildStudy(world) {
  const room = buildRoom(world, 'study', 'The study', -7.5, 0, '#d9a98a', '#a8744a', { leftWall: true })
  windowOn(room, 1.35, 1.0, -RD / 2 + 0.08, 1.2, 1.5, '#cfe6ee')
  // desk
  const desk = G(room, -1.5, 0, -1.3)
  B(desk, 1.9, 0.12, 0.95, PAL.wood, 0, 0.78, 0)
  for (const [x, z] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]]) B(desk, 0.1, 0.78, 0.1, PAL.woodDark, x, 0, z)
  B(desk, 0.5, 0.12, 0.35, '#8a4b3b', -0.3, 0.9, 0.05)
  B(desk, 0.46, 0.1, 0.32, '#3f6b6f', -0.28, 1.02, 0.05)
  // desk lamp
  C(desk, 0.14, 0.18, 0.06, PAL.gold, 0.5, 0.9, 0)
  C(desk, 0.03, 0.03, 0.5, PAL.gold, 0.5, 0.95, 0)
  const shadeM = shadow(new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.26, 20, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd37a', side: THREE.DoubleSide })))
  shadeM.position.set(0.5, 1.58, 0)
  desk.add(shadeM)
  const lampLight = new THREE.PointLight('#ffcc80', 5, 6, 1.6)
  lampLight.position.set(0.5, 1.4, 0.2)
  desk.add(lampLight)
  // rug
  const rug = C(room, 1.5, 1.5, 0.03, '#a85a52', 0.3, 0, 0.5, 40)
  rug.scale.z = 0.7
  rug.castShadow = false
  // perch stack of books for the owl
  const perch = G(room, 0.3, 0, 0.1)
  B(perch, 1.3, 0.22, 0.9, '#5d7d5a', 0, 0, 0)
  B(perch, 1.2, 0.2, 0.85, '#a8544a', 0.03, 0.22, 0)
  B(perch, 1.1, 0.2, 0.8, '#d8b25a', -0.03, 0.42, 0)
  const owl = buildOwl(perch, 1.15)
  owl.position.y = 0.62
  world.blink.push(owl)
  reg(world, 'study', 'owl', owl)
  world.tickers.push((t) => {
    owl.position.y = 0.62 + Math.sin(t * 1.6) * 0.012
    owl.rotation.y = Math.sin(t * 0.5) * 0.12
  })
  // glass bell jar: only the brass rim and knob are clickable
  const jar = G(room, 0.3, 0, 0.1)
  const glassMat = new THREE.MeshPhongMaterial({ color: '#cfeaf2', transparent: true, opacity: 0.16, shininess: 120, depthWrite: false, side: THREE.DoubleSide })
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.9, 32, 1, true), glassMat)
  tube.position.y = 1.35
  tube.userData.noPick = true
  jar.add(tube)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.0, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), glassMat)
  dome.position.y = 2.3
  dome.userData.noPick = true
  jar.add(dome)
  const rim = T(jar, 1.0, 0.06, PAL.gold, 0, 0.42, 0, Math.PI / 2)
  const rim2 = T(jar, 1.0, 0.05, PAL.gold, 0, 2.3, 0, Math.PI / 2)
  const knob = S(jar, 0.12, PAL.gold, 0, 3.35, 0)
  C(jar, 0.03, 0.03, 0.1, PAL.gold, 0, 3.2, 0)
  reg(world, 'study', 'glass', jar)
  void rim
  void rim2
  void knob
  // thought cloud
  const cloud = G(room, 2.0, 2.5, 0.9)
  for (const [x, y, s] of [[0, 0, 0.32], [0.35, 0.05, 0.27], [-0.33, 0.02, 0.25], [0.12, 0.22, 0.25]]) {
    const b = S(cloud, s, '#fffaf0', x, y, 0)
    b.castShadow = false
  }
  const orbMat = glow('#ffd36e')
  const orb = S(cloud, 0.14, orbMat, 0, 0.05, 0.32)
  orb.castShadow = false
  for (let i = 0; i < 3; i++) {
    const b = S(room, 0.1 - i * 0.025, '#fffaf0', 1.3 - i * 0.28, 1.9 - i * 0.28, 0.9)
    b.castShadow = false
  }
  reg(world, 'study', 'orb', cloud)
  world.tickers.push((t) => {
    cloud.position.y = 2.5 + Math.sin(t * 1.2) * 0.06
    orb.scale.setScalar(1 + Math.sin(t * 3) * 0.12)
  })
  // book piles on the floor
  const books = G(room, -1.9, 0, 0.9)
  ;['#8a3f3f', '#3f6b6f', '#d8b25a', '#6b4a73', '#5d7d5a'].forEach((c, i) => {
    const b = B(books, 0.9 - i * 0.05, 0.16, 0.6, c, 0, i * 0.16, 0)
    b.rotation.y = (i % 2 ? 1 : -1) * 0.18
  })
  reg(world, 'study', 'books', books)
}

// ---- 3. the tool wall ----
function buildTools(world) {
  const room = buildRoom(world, 'tools', 'The tool wall', -2.5, 0, '#6f9a96', '#9c6a40', { leftWall: true })
  // pegboard
  const board = B(room, RW - 0.5, 2.5, 0.08, '#d6b27a', 0, 0.6, -RD / 2 + 0.07)
  board.receiveShadow = true
  for (let ix = 0; ix < 12; ix++) for (let iy = 0; iy < 6; iy++) {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 8), glow('#6a4a2a'))
    dot.position.set(-2.0 + ix * 0.36, 0.85 + iy * 0.4, -RD / 2 + 0.12)
    dot.userData.noPick = true
    room.add(dot)
  }
  const wz = -RD / 2 + 0.2
  // magnifier
  const mag = G(room, -1.5, 2.1, wz)
  T(mag, 0.42, 0.07, PAL.gold, 0, 0, 0)
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.4, 28), new THREE.MeshBasicMaterial({ color: '#bfe5f0', transparent: true, opacity: 0.55 }))
  lens.position.z = 0.01
  mag.add(lens)
  const h1 = C(mag, 0.06, 0.07, 0.7, PAL.woodDark, 0.46, -0.9, 0)
  h1.rotation.z = Math.PI / 4
  h1.position.set(0.58, -0.58, 0)
  reg(world, 'tools', 'magnifier', mag)
  // hammer
  const ham = G(room, -0.1, 1.9, wz)
  ham.rotation.z = 0.45
  C(ham, 0.06, 0.07, 1.2, PAL.wood, 0, -0.6, 0)
  B(ham, 0.62, 0.3, 0.26, '#7e8590', 0, 0.55, 0)
  B(ham, 0.18, 0.3, 0.26, '#a5acb5', 0.38, 0.55, 0)
  reg(world, 'tools', 'hammer', ham)
  // cog
  const cog = G(room, 1.45, 2.0, wz)
  const cogBody = C(cog, 0.4, 0.4, 0.16, PAL.terracotta, 0, -0.08, 0, 24)
  cogBody.rotation.x = Math.PI / 2
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const tooth = B(cog, 0.18, 0.18, 0.16, PAL.terracotta, Math.cos(a) * 0.5, Math.sin(a) * 0.5 - 0.09, 0)
    tooth.rotation.z = a
  }
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.16, 20), glow('#d6b27a'))
  hole.position.z = 0.1
  hole.userData.noPick = true
  cog.add(hole)
  reg(world, 'tools', 'cog', cog)
  world.tickers.push((t, motion) => {
    if (motion) cog.rotation.z = t * 0.35
  })
  // slash signs on little chains
  const signs = G(room, 0, 0, 0)
  const names = ['/help', '/clear', '/plan']
  names.forEach((n, i) => {
    const sg = signPlane(signs, 1.15, 0.5, n, '#f4e6c8', '#3b2a20', -1.55 + i * 1.5, 1.05 - (i % 2) * 0.12, wz + 0.15, 'bold 96px "Courier New", monospace')
    for (const s of [-1, 1]) {
      const ch = C(signs, 0.012, 0.012, 0.55, '#5a4a3a', sg.position.x + s * 0.45, sg.position.y + 0.25, wz + 0.15, 6)
      ch.castShadow = false
    }
  })
  reg(world, 'tools', 'slash', signs)
  // tidy bench with a few small hand tools
  B(room, 4.2, 0.1, 0.8, PAL.wood, 0, 0.55, -1.2)
  for (const x of [-1.9, 1.9]) B(room, 0.12, 0.55, 0.7, PAL.woodDark, x, 0, -1.2)
  for (let i = 0; i < 5; i++) {
    const p = C(room, 0.05, 0.05, 0.5, ['#c8674a', '#5f9ea0', '#e0a83c', '#6b4a73', '#7a8b4a'][i], -1.6 + i * 0.28, 0.65, -1.0, 8)
    p.rotation.z = Math.PI / 2
  }
  // little robot-like friendly helper: an open toolbox
  const tb = G(room, 1.3, 0.65, -1.05)
  B(tb, 0.9, 0.35, 0.5, '#b8523f', 0, 0, 0)
  B(tb, 0.9, 0.08, 0.5, '#8a3f30', 0, 0.35, 0)
  T(tb, 0.25, 0.03, '#cfcfcf', 0, 0.55, 0, 0, 0, Math.PI)
}

// ---- 4. the gatekeeper's lodge ----
function buildLodge(world) {
  const room = buildRoom(world, 'lodge', 'The gatekeeper\'s lodge', 2.5, 0, '#c9b07a', '#8a6a45', { leftWall: true, rightWall: true })
  windowOn(room, -0.4, 1.1, -RD / 2 + 0.08, 1.0, 1.1, '#e8dcb0')
  // counter + keeper
  const counter = G(room, -0.8, 0, -0.4)
  B(counter, 2.0, 0.95, 0.8, PAL.woodDark, 0, 0, 0)
  B(counter, 2.2, 0.1, 0.95, PAL.wood, 0, 0.95, 0)
  const keeper = buildKeeper(room)
  keeper.position.set(-0.8, 0, -1.25)
  keeper.scale.setScalar(1.05)
  reg(world, 'lodge', 'keeper', keeper)
  // stamp
  const stamp = G(room, -0.3, 1.05, -0.35)
  B(stamp, 0.55, 0.06, 0.4, '#2f6f4a', 0, 0, 0)
  const sBase = C(stamp, 0.17, 0.17, 0.08, '#6a4a2a', 0, 0.06, 0)
  C(stamp, 0.05, 0.07, 0.24, PAL.wood, 0, 0.14, 0)
  S(stamp, 0.09, PAL.wood, 0, 0.42, 0)
  void sBase
  reg(world, 'lodge', 'stamp', stamp)
  world.tickers.push((t, motion) => {
    if (!motion) return
    const press = Math.sin(t * 1.3) > 0.9 ? 0.12 : 0
    stamp.children[2].position.y = 0.26 - press
    stamp.children[3].position.y = 0.42 - press
  })
  // barrier arm: down by default
  const bar = G(room, -1.9, 0, 1.35)
  B(bar, 0.22, 1.0, 0.22, '#d8d0bf', 0, 0, 0)
  const arm = G(bar, 0.1, 0.78, 0)
  for (let i = 0; i < 6; i++) B(arm, 0.3, 0.14, 0.12, i % 2 ? '#f4ede0' : '#b8403a', 0.15 + i * 0.3, 0, 0)
  reg(world, 'lodge', 'gate', bar)
  const post2 = B(room, 0.22, 0.9, 0.22, '#d8d0bf', -0.1, 0, 1.35)
  void post2
  // red rope + padlocked door
  const rd = G(room, 1.6, 0, 0)
  const door = B(rd, 1.1, 2.0, 0.12, '#4a3a4a', 0, 0, -RD / 2 + 0.08)
  door.receiveShadow = true
  B(rd, 1.3, 0.14, 0.2, PAL.woodDark, 0, 2.0, -RD / 2 + 0.09)
  signPlane(rd, 0.8, 0.4, 'NO ENTRY', '#f0c0b5', '#8a2a24', 0, 1.35, -RD / 2 + 0.2, 'bold 78px Georgia, serif')
  const lock = G(rd, 0, 0.9, -RD / 2 + 0.2)
  B(lock, 0.3, 0.26, 0.12, PAL.gold, 0, 0, 0)
  T(lock, 0.1, 0.03, PAL.gold, 0, 0.3, 0, 0, 0, Math.PI)
  for (const s of [-1, 1]) {
    C(rd, 0.07, 0.09, 0.85, PAL.woodDark, s * 0.85, 0, 0.9)
    S(rd, 0.1, PAL.gold, s * 0.85, 0.9, 0.9)
  }
  const ropeCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.85, 0.85, 0.9), new THREE.Vector3(-0.4, 0.55, 0.9), new THREE.Vector3(0.4, 0.55, 0.9), new THREE.Vector3(0.85, 0.85, 0.9)])
  const rope = shadow(new THREE.Mesh(new THREE.TubeGeometry(ropeCurve, 24, 0.045, 8), mat('#b8403a')))
  rd.add(rope)
  reg(world, 'lodge', 'ropes', rd)
  // lantern
  const lan = G(room, 0.6, 2.5, -0.4)
  C(lan, 0.01, 0.01, 0.9, '#5a4a3a', 0, 0.35, 0, 6)
  B(lan, 0.3, 0.4, 0.3, glow('#ffd37a'), 0, -0.2, 0)
  B(lan, 0.36, 0.06, 0.36, '#3b2a20', 0, 0.2, 0)
  // key board with hooks
  const kb = B(room, 1.2, 0.6, 0.06, PAL.woodDark, -1.9, 1.5, -RD / 2 + 0.07)
  void kb
  for (let i = 0; i < 4; i++) {
    const key = T(room, 0.06, 0.02, PAL.gold, -2.3 + i * 0.28, 1.8, -RD / 2 + 0.12)
    void key
    C(room, 0.015, 0.015, 0.2, PAL.gold, -2.3 + i * 0.28, 1.5, -RD / 2 + 0.12, 6)
  }
}

// ---- 5. the notebook room ----
function buildNotes(world) {
  const room = buildRoom(world, 'notes', 'The notebook room', 2.5, UP, '#d9c3d6', '#9a6f4a', { leftWall: true, rightWall: true })
  windowOn(room, 0.0, 1.2, -RD / 2 + 0.08, 1.0, 1.2, '#d3e4ef')
  // bookshelf on the back-left
  const shelf = G(room, -1.5, 0, -RD / 2 + 0.3)
  B(shelf, 1.7, 2.6, 0.42, PAL.woodDark, 0, 0, 0)
  const cols = ['#c8674a', '#2f6f73', '#e0a83c', '#6b4a73', '#7a8b4a', '#d98b86']
  for (let row = 0; row < 4; row++) {
    B(shelf, 1.6, 0.05, 0.46, PAL.wood, 0, 0.1 + row * 0.62, 0.02)
    for (let i = 0; i < 8; i++) {
      const bh = 0.38 + ((i * 7 + row * 3) % 5) * 0.03
      B(shelf, 0.16, bh, 0.34, cols[(i + row) % cols.length], -0.7 + i * 0.2, 0.15 + row * 0.62, 0.06)
    }
  }
  // lectern with the big notebook
  const book = G(room, 0.5, 0, -0.5)
  B(book, 0.9, 1.0, 0.7, PAL.woodDark, 0, 0, 0)
  const slope = G(book, 0, 1.0, 0)
  slope.rotation.x = -0.45
  B(slope, 1.4, 0.07, 1.0, PAL.wood, 0, 0, 0)
  for (const s of [-1, 1]) {
    const pg = B(slope, 0.68, 0.06, 0.92, '#fff4d6', s * 0.35, 0.07, 0)
    pg.rotation.z = -s * 0.06
    for (let l = 0; l < 6; l++) {
      const ln = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.025), glow('#8a7a5a'))
      ln.rotation.x = -Math.PI / 2
      ln.position.set(s * 0.35, 0.145 + (s > 0 ? 0 : 0), -0.32 + l * 0.13)
      ln.userData.noPick = true
      slope.add(ln)
    }
  }
  const pageGlow = new THREE.PointLight('#ffe2a0', 4, 4, 1.6)
  pageGlow.position.set(0, 1.9, 0.4)
  book.add(pageGlow)
  reg(world, 'notes', 'book', book)
  // journal on a small table with quill and inkwell
  const jr = G(room, 1.75, 0, 0.7)
  B(jr, 0.95, 0.07, 0.8, PAL.wood, 0, 0.7, 0)
  for (const [x, z] of [[-0.4, -0.3], [0.4, -0.3], [-0.4, 0.3], [0.4, 0.3]]) B(jr, 0.07, 0.7, 0.07, PAL.woodDark, x, 0, z)
  const jb = B(jr, 0.5, 0.1, 0.38, '#2f6f73', -0.12, 0.77, 0.02)
  jb.rotation.y = 0.2
  B(jr, 0.46, 0.05, 0.34, '#fff4d6', -0.12, 0.87, 0.02).rotation.y = 0.2
  B(jr, 0.04, 0.02, 0.38, PAL.terracotta, 0.1, 0.9, 0.02)
  C(jr, 0.07, 0.09, 0.12, '#222a3a', 0.28, 0.77, -0.2)
  const quill = shadow(new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.6, 8), mat('#f4e6c8')))
  quill.position.set(0.32, 1.1, -0.2)
  quill.rotation.z = -0.5
  jr.add(quill)
  reg(world, 'notes', 'journal', jr)
  // locked drawer cabinet
  const dr = G(room, -2.0, 0, 0.9)
  B(dr, 1.0, 1.1, 0.6, PAL.woodDark, 0, 0, 0)
  for (let i = 0; i < 3; i++) {
    B(dr, 0.9, 0.3, 0.05, PAL.wood, 0, 0.08 + i * 0.34, 0.31)
    S(dr, 0.04, PAL.gold, 0, 0.23 + i * 0.34, 0.37)
  }
  const pl = G(dr, 0, 0.58, 0.36)
  B(pl, 0.22, 0.2, 0.08, PAL.gold, 0, 0, 0)
  T(pl, 0.07, 0.025, PAL.gold, 0, 0.2, 0, 0, 0, Math.PI)
  reg(world, 'notes', 'drawer', dr)
  // calendar
  const cal = canvasTex(256, 320, (g, w, h) => {
    g.fillStyle = '#fff6e0'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#c8674a'
    g.fillRect(0, 0, w, 64)
    g.fillStyle = '#fff6e0'
    g.font = 'bold 40px Georgia, serif'
    g.textAlign = 'center'
    g.fillText('WEEK', w / 2, 46)
    g.fillStyle = '#5a4a3a'
    g.font = '26px Georgia, serif'
    for (let i = 0; i < 28; i++) {
      const x = 32 + (i % 7) * 32
      const y = 108 + Math.floor(i / 7) * 48
      g.fillText(String((i % 31) + 1), x, y)
    }
    g.strokeStyle = '#2f6f73'
    g.lineWidth = 5
    g.beginPath()
    g.arc(32 + 2 * 32, 100 + 48, 20, 0, 7)
    g.stroke()
  })
  const calM = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.1), new THREE.MeshLambertMaterial({ map: cal }))
  calM.position.set(1.95, 1.9, -RD / 2 + 0.09)
  const calG = G(room)
  calG.add(calM)
  B(calG, 1.0, 0.06, 0.06, PAL.woodDark, 1.95, 2.48, -RD / 2 + 0.1)
  reg(world, 'notes', 'calendar', calG)
  // floating motes of memory
  const motes = []
  for (let i = 0; i < 6; i++) {
    const m = S(room, 0.05, glow('#ffd36e'), 0.5 + (i - 3) * 0.2, 2.0, -0.3, 1, 1, 1)
    m.castShadow = false
    m.userData.noPick = true
    motes.push(m)
  }
  world.tickers.push((t, motion) => {
    motes.forEach((m, i) => {
      const k = motion ? t * 0.4 + i * 1.1 : i * 1.1
      m.position.y = 2.1 + Math.sin(k) * 0.35 + (i % 3) * 0.12
      m.position.x = 0.5 + Math.cos(k * 0.7) * 0.7
    })
  })
}

// ---- 6. the workshop annex ----
function buildAnnex(world) {
  const room = buildRoom(world, 'annex', 'The workshop', -2.5, UP, '#8fb7a0', '#a07c52', { leftWall: true })
  windowOn(room, -1.4, 1.2, -RD / 2 + 0.08, 0.9, 1.1, '#d9ecd8')
  // socket panel on the back wall
  const sp = G(room, 1.35, 1.0, -RD / 2 + 0.1)
  B(sp, 1.3, 1.3, 0.1, '#2f4a4d', 0, 0, 0)
  const slot = B(sp, 0.7, 0.7, 0.06, glow('#7fe0b0'), 0, 0.3, 0.06)
  B(sp, 0.54, 0.54, 0.07, '#1d2d30', 0, 0.38, 0.07)
  slot.userData.slot = true
  // the plugin block hovering above with a cable
  const plug = G(sp, 0, 1.45, 0.4)
  B(plug, 0.5, 0.5, 0.3, PAL.gold, 0, 0, 0)
  const plus = canvasTex(64, 64, (g) => {
    g.fillStyle = '#e0a83c'
    g.fillRect(0, 0, 64, 64)
    g.fillStyle = '#3b2a20'
    g.fillRect(26, 12, 12, 40)
    g.fillRect(12, 26, 40, 12)
  })
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.46), new THREE.MeshBasicMaterial({ map: plus }))
  face.position.z = 0.16
  face.userData.noPick = true
  plug.add(face)
  const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 1.45, 0.4), new THREE.Vector3(-0.5, 1.9, 0.5), new THREE.Vector3(-0.9, 1.0, 0.45), new THREE.Vector3(-0.5, 0.2, 0.3)]), 24, 0.03, 6), mat(PAL.ink))
  sp.add(cable)
  reg(world, 'annex', 'socket', sp)
  world.tickers.push((t, motion) => {
    plug.position.y = 1.45 + (motion ? Math.sin(t * 1.4) * 0.08 : 0)
    plug.rotation.y = motion ? Math.sin(t * 0.8) * 0.2 : 0
  })
  // workbench
  const bench = G(room, -0.3, 0, -1.2)
  B(bench, 2.4, 0.14, 0.95, PAL.wood, 0, 0.82, 0)
  for (const [x, z] of [[-1.1, -0.35], [1.1, -0.35], [-1.1, 0.35], [1.1, 0.35]]) B(bench, 0.1, 0.82, 0.1, PAL.woodDark, x, 0, z)
  B(bench, 2.2, 0.06, 0.8, PAL.woodDark, 0, 0.3, 0)
  const vise = B(bench, 0.35, 0.22, 0.3, '#7e8590', -0.8, 0.96, 0.2)
  void vise
  for (let i = 0; i < 3; i++) C(bench, 0.1, 0.1, 0.2, ['#5f9ea0', '#e0a83c', '#d98b86'][i], 0.2 + i * 0.28, 0.96, 0.1, 14)
  const g1 = C(bench, 0.25, 0.25, 0.08, '#c8674a', -0.2, 0.96, -0.1, 16)
  g1.rotation.x = Math.PI / 2
  g1.position.y = 1.15
  reg(world, 'annex', 'bench', bench)
  // building blocks on the floor
  const blocks = G(room, -1.6, 0, 1.0)
  B(blocks, 0.5, 0.5, 0.5, PAL.terracotta, 0, 0, 0).rotation.y = 0.3
  B(blocks, 0.5, 0.5, 0.5, PAL.teal, 0.55, 0, 0.1).rotation.y = -0.2
  const cyl = C(blocks, 0.25, 0.25, 0.5, PAL.gold, 0.25, 0.5, 0.0, 20)
  cyl.rotation.y = 0.2
  const cone = shadow(new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 20), mat(PAL.rose)))
  cone.position.set(1.15, 0.25, 0.3)
  blocks.add(cone)
  S(blocks, 0.25, PAL.olive, 0.8, 0.25, 0.7)
  reg(world, 'annex', 'blocks', blocks)
}

// ---- 7. the balcony ----
function buildBalcony(world) {
  const room = buildRoom(world, 'balcony', 'The balcony', -7.5, UP, '#2f4a6b', '#9a7a55', { leftWall: false, openTop: true })
  // terrace extends forward
  B(room, RW, 0.25, 1.4, '#9a7a55', 0, -0.25, RD / 2 + 0.7)
  // french doors
  const doors = G(room, -1.2, 0, -RD / 2 + 0.1)
  B(doors, 1.6, 2.4, 0.08, PAL.woodDark, 0, 0, 0)
  for (const s of [-1, 1]) B(doors, 0.7, 2.2, 0.1, glow('#f6d98a'), s * 0.38, 0.1, 0.03)
  B(doors, 0.06, 2.2, 0.12, PAL.woodDark, 0, 0.1, 0.04)
  // railing along the front of the terrace
  const rz = RD / 2 + 1.35
  B(room, RW, 0.1, 0.1, PAL.cream, 0, 0.9, rz)
  for (let i = 0; i < 9; i++) B(room, 0.07, 0.9, 0.07, PAL.cream, -2.3 + i * 0.575, 0, rz)
  B(room, 0.1, 0.9, 1.4, PAL.cream, -RW / 2, 0, RD / 2 + 0.7).visible = true
  B(room, 0.1, 0.1, 1.4, PAL.cream, -RW / 2, 0.9, RD / 2 + 0.7)
  // fairy lights
  for (let i = 0; i < 9; i++) {
    const b = S(room, 0.07, glow(i % 2 ? '#ffd36e' : '#ff9d7a'), -2.3 + i * 0.575, 0.78 + Math.sin(i * 1.3) * 0.0, rz + 0.04)
    b.userData.noPick = true
    b.castShadow = false
  }
  // microphone on a stand
  const mic = G(room, 0.5, 0, 0.9)
  C(mic, 0.3, 0.34, 0.07, '#3b2a20', 0, 0, 0)
  C(mic, 0.035, 0.035, 1.35, '#8a8f98', 0, 0.07, 0, 10)
  const head = S(mic, 0.17, '#555b66', 0, 1.62, 0, 1, 1.25, 1)
  T(mic, 0.18, 0.025, PAL.gold, 0, 1.62, 0, Math.PI / 2, 0)
  head.userData.mic = true
  reg(world, 'balcony', 'mic', mic)
  // a small listening owl with headphones
  const owl = buildOwl(room, 0.85)
  owl.position.set(-1.0, 0, 1.2)
  owl.rotation.y = 0.5
  T(owl, 0.46, 0.05, '#3b2a20', 0, 1.0, 0, 0, Math.PI / 2, Math.PI)
  S(owl, 0.16, PAL.terracotta, -0.52, 1.0, 0, 0.6, 1, 1)
  S(owl, 0.16, PAL.terracotta, 0.52, 1.0, 0, 0.6, 1, 1)
  world.blink.push(owl)
  reg(world, 'balcony', 'waves', owl)
  // sound-wave rings: one ring set coming in, they expand outward from the mic
  const rings = []
  for (let i = 0; i < 3; i++) {
    const rm = new THREE.MeshBasicMaterial({ color: '#ffd36e', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 40), rm)
    ring.position.set(0.5, 1.62, 1.0)
    ring.userData.noPick = true
    room.add(ring)
    rings.push(ring)
  }
  world.tickers.push((t, motion) => {
    rings.forEach((rg, i) => {
      const k = motion ? (t * 0.35 + i / 3) % 1 : 0.2 + i * 0.28
      rg.scale.setScalar(0.25 + k * 1.2)
      rg.material.opacity = 0.8 * (1 - k)
    })
  })
  // the moon and stars (sky above the balcony)
  const moonG = new THREE.Group()
  moonG.position.set(-7.5, UP + 5.4, -9)
  const cres = new THREE.Shape()
  cres.absarc(0, 0, 1.2, 0, Math.PI * 2, false)
  const hole = new THREE.Path()
  hole.absarc(0.55, 0.15, 1.0, 0, Math.PI * 2, true)
  cres.holes.push(hole)
  const moon = new THREE.Mesh(new THREE.ExtrudeGeometry(cres, { depth: 0.15, bevelEnabled: false }), glow('#fff2c9'))
  moon.rotation.z = 0.4
  moonG.add(moon)
  world.root.add(moonG)
  const stars = G(world.root)
  for (let i = 0; i < 26; i++) {
    const s = S(stars, 0.06 + (i % 3) * 0.03, glow('#fff6d8'), -14 + (i * 37) % 16 + (i % 5) * 0.2, UP + 3.5 + ((i * 53) % 90) / 22, -9 + (i % 4) * -0.5)
    s.castShadow = false
  }
  stars.add(moonG)
  reg(world, 'balcony', 'moon', stars)
  world.tickers.push((t, motion) => {
    stars.children.forEach((s, i) => {
      if (s === moonG) return
      s.scale.setScalar(motion ? 0.8 + Math.sin(t * 2 + i) * 0.3 : 1)
    })
  })
}

// ---- 1. the front door ----
function buildDoor(world) {
  const d = G(world.root, -13.6, -0.9, 1.4)
  d.userData.roomId = 'door'
  world.rooms.door = { id: 'door', name: 'The front door', group: d, cx: -13.6, cy: -0.9 }
  B(d, 3.6, 0.5, 2.2, PAL.stone, 0, 0, 0)
  const base = G(d, 0, 0.5, 0)
  for (const s of [-1, 1]) {
    B(base, 0.45, 3.0, 0.5, '#cdbfa6', s * 1.4, 0, 0)
    B(base, 0.6, 0.2, 0.62, PAL.stone, s * 1.4, 3.0, 0)
  }
  T(base, 1.4, 0.24, '#cdbfa6', 0, 3.0, 0, 0, 0, Math.PI)
  const wood = B(base, 2.4, 2.9, 0.18, PAL.terracotta, 0, 0, -0.05)
  void wood
  for (const s of [-1, 1]) B(base, 0.08, 2.8, 0.2, '#8a3f30', s * 0.6, 0, -0.04)
  for (const y of [0.6, 1.3, 2.0]) B(base, 2.3, 0.07, 0.2, '#8a3f30', 0, y, -0.04)
  S(base, 0.09, PAL.gold, 0.9, 1.4, 0.08)
  // glowing message slot
  const slot = G(base, 0, 1.55, 0.08)
  B(slot, 0.9, 0.3, 0.1, PAL.gold, 0, 0, 0)
  B(slot, 0.76, 0.12, 0.12, glow('#fff2c0'), 0, 0.09, 0.02)
  reg(world, 'door', 'slot', slot)
  // the "type here" board with a blinking cursor
  const cursorOn = canvasTex(512, 128, (g, w, h) => drawType(g, w, h, true))
  const cursorOff = canvasTex(512, 128, (g, w, h) => drawType(g, w, h, false))
  const sm = new THREE.MeshBasicMaterial({ map: cursorOn })
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.5), sm)
  board.position.set(0, 3.95, 0.3)
  base.add(board)
  B(base, 2.0, 0.6, 0.1, PAL.woodDark, 0, 3.65, 0.22)
  world.tickers.push((t, motion) => {
    sm.map = !motion || Math.floor(t * 1.6) % 2 === 0 ? cursorOn : cursorOff
  })
  // porch lamp
  const lamp = G(base, 1.65, 2.3, 0.3)
  C(lamp, 0.02, 0.02, 0.4, '#3b2a20', 0, 0.2, 0, 6)
  B(lamp, 0.3, 0.42, 0.3, glow('#ffd37a'), 0, -0.2, 0)
  B(lamp, 0.38, 0.06, 0.38, '#3b2a20', 0, 0.22, 0)
  B(lamp, 0.38, 0.05, 0.38, '#3b2a20', 0, -0.25, 0)
  const lampLight = new THREE.PointLight('#ffcc80', 8, 8, 1.6)
  lampLight.position.set(0, 0, 0.5)
  lamp.add(lampLight)
  reg(world, 'door', 'lamp', lamp)
  // the rolled note hovering by the slot
  const note = G(d, 0.2, 2.1, 1.45)
  const roll = C(note, 0.12, 0.12, 0.7, '#fff4d6', 0, -0.35, 0, 16)
  roll.rotation.z = Math.PI / 2
  C(note, 0.125, 0.125, 0.08, PAL.terracotta, 0, -0.35, 0, 16).rotation.z = Math.PI / 2
  reg(world, 'door', 'scroll', note)
  world.tickers.push((t, motion) => {
    note.position.y = 2.1 + (motion ? Math.sin(t * 1.5) * 0.1 : 0)
    note.rotation.y = motion ? Math.sin(t * 0.9) * 0.3 : 0
  })
  // hedges on both sides
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) S(d, 0.55, '#6f8a4a', s * (2.3 + i * 0.7), 0.35, 0.6 - i * 0.2, 1.1, 0.8, 0.9)
  }
}
function drawType(g, w, h, on) {
  g.fillStyle = '#3b2a20'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#ffe9b0'
  g.font = 'bold 66px "Courier New", monospace'
  g.textBaseline = 'middle'
  g.fillText('> type here', 24, h / 2 + 4)
  if (on) g.fillRect(24 + 66 * 0.6 * 11 + 8, h / 2 - 34, 24, 66)
}

// ---- trees, flowers, clouds, and a few fireflies ----
function buildDecor(world) {
  const r = world.root
  const tree = (x, z, s, c) => {
    const t = G(r, x, -0.9, z)
    C(t, 0.18 * s, 0.26 * s, 1.5 * s, '#7a4f2e', 0, 0, 0, 10)
    S(t, 1.0 * s, c, 0, 2.0 * s, 0, 1, 1.1, 1)
    S(t, 0.7 * s, shade(c, 0.05), 0.4 * s, 2.7 * s, 0.1, 1, 1, 1)
  }
  tree(-17.5, -1, 1.3, '#6f8a4a')
  tree(7.5, 3, 1.0, '#7d9a52')
  tree(9.5, -2, 1.4, '#6a8548')
  tree(-9, 6.5, 0.8, '#8aa05a')
  tree(-22, 4, 1.2, '#6a8548')
  tree(14, 4, 1.1, '#7d9a52')
  tree(-3, -9, 1.6, '#6a8548')
  tree(-14, -8, 1.4, '#7d9a52')
  // flowers
  const fm = [PAL.rose, PAL.gold, '#ffffff', '#c58fc9']
  for (let i = 0; i < 70; i++) {
    const a = i * 2.399
    const rad = 3.5 + (i % 11) * 1.1
    const x = -3 + Math.cos(a) * rad * 1.6
    const z = 5.5 + Math.abs(Math.sin(a)) * rad * 0.5
    if (x > -11 && x < 6 && z < 4) continue
    const f = S(r, 0.09, glow(fm[i % fm.length]), x, -0.72, z)
    f.castShadow = false
    f.userData.noPick = true
    const st = C(r, 0.01, 0.01, 0.2, '#55663a', x, -0.9, z, 4)
    st.castShadow = false
  }
  // clouds
  const clouds = []
  for (let i = 0; i < 5; i++) {
    const c = G(r, -30 + i * 14, 14 + (i % 2) * 4, -26 - (i % 3) * 6)
    for (const [x, y, s] of [[0, 0, 2.0], [1.8, -0.2, 1.5], [-1.8, -0.3, 1.4], [0.6, 0.8, 1.4]]) {
      const b = S(c, s, glow('#fff3e0'), x, y, 0, 1, 0.7, 0.6)
      b.castShadow = false
      b.userData.noPick = true
      b.material = new THREE.MeshBasicMaterial({ color: '#fff3e0', transparent: true, opacity: 0.85, fog: false })
    }
    clouds.push(c)
  }
  world.tickers.push((t, motion) => {
    clouds.forEach((c, i) => {
      if (motion) c.position.x = -30 + i * 14 + ((t * 0.25 + i * 3) % 60) - 8
    })
  })
  // fireflies: warm dots that drift
  const ff = []
  for (let i = 0; i < 14; i++) {
    const m = S(r, 0.05, glow('#ffe58a'), 0, 0, 0)
    m.castShadow = false
    m.userData.noPick = true
    ff.push(m)
  }
  world.tickers.push((t, motion) => {
    ff.forEach((m, i) => {
      const k = motion ? t * 0.3 : 0
      m.position.set(-16 + i * 1.7 + Math.sin(k + i) * 0.6, 0.4 + (i % 4) * 0.8 + Math.sin(k * 1.4 + i * 2) * 0.3, 5 + Math.cos(k + i * 1.7) * 1.2)
    })
  })
}

// ---------- per-frame ----------
export function updateWorld(world, t, motion) {
  for (const fn of world.tickers) fn(t, motion)
  // gentle blink
  for (const owl of world.blink) {
    const blinking = motion && Math.floor(t * 2) % 9 === 0 && (t * 2) % 1 < 0.35
    owl.traverse((o) => {
      if (o.userData.eye) o.scale.y = blinking ? 0.12 : 1
    })
  }
}
