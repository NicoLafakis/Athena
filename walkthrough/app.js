// Page controller: camera, Tour and Explore modes, captions, mini-map. Scene building lives in scene.js.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/OrbitControls.js'
import { STOPS, SITE } from './content.js'
import { buildWorld, updateWorld, RW, RH } from './scene.js'

const $ = (id) => document.getElementById(id)
const BEAT_SECONDS = 12
const TOTAL_BEATS = STOPS.reduce((n, s) => n + s.beats.length, 0)
const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
let motion = !reducedQuery.matches
reducedQuery.addEventListener('change', () => {
  motion = !reducedQuery.matches
  if (state.mode === 'play') renderCard()
})

fillIntro()

let renderer
try {
  const probe = document.createElement('canvas')
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('no webgl')
  renderer = new THREE.WebGLRenderer({ canvas: $('stage'), antialias: true, powerPreference: 'high-performance' })
} catch {
  showFallback()
}
if (renderer) start()

function fillIntro() {
  $('intro-lede').textContent = SITE.tagline
  $('intro-note').textContent = 'Works on phones. Drag to look around, pinch to zoom.'
}

function showFallback() {
  $('intro').hidden = true
  $('stage').hidden = true
  const list = $('fallback-list')
  for (const s of STOPS) {
    const li = document.createElement('li')
    const h = document.createElement('h2')
    h.textContent = s.title
    li.appendChild(h)
    for (const b of s.beats) {
      const p = document.createElement('p')
      p.textContent = b.text
      li.appendChild(p)
    }
    list.appendChild(li)
  }
  $('fallback').hidden = false
}

function start() {
  const isPhone = () => window.innerWidth <= 760
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  const world = buildWorld()
  if (isPhone()) world.scene.traverse((o) => { if (o.isDirectionalLight) o.shadow.mapSize.set(1024, 1024) })
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 3
  controls.maxDistance = 48
  controls.minPolarAngle = 0.35
  controls.maxPolarAngle = Math.PI * 0.53
  controls.screenSpacePanning = true
  controls.enabled = false

  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: world.glowTex, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, opacity: 0.45 }))
  glowSprite.renderOrder = 20
  glowSprite.userData.noPick = true
  glowSprite.visible = false
  world.scene.add(glowSprite)

  // ---------- layout: which part of the screen is free of the caption ----------
  let free = { cx: 0.5, cy: 0.5, w: 1, h: 1 }
  function layout() {
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    const card = $('card')
    let shiftX = 0
    let shiftY = 0
    let fw = w
    let fh = h
    if (!card.hidden) {
      const r = card.getBoundingClientRect()
      if (isPhone()) {
        fh = Math.max(160, r.top - 56) // below the top bar, above the sheet
        shiftY = (h - r.top - 56) / 2
      } else {
        const left = r.right + 12
        fw = w - left
        shiftX = left / 2
      }
    } else if (isPhone()) fh = h - 56
    free = { w: fw, h: fh }
    camera.setViewOffset(w, h, -shiftX, shiftY, w, h)
    camera.updateProjectionMatrix()
  }
  function fitDistance(width, height) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const h = window.innerHeight
    const dW = (width * h) / (2 * tanV * free.w * 0.9)
    const dH = (height * h) / (2 * tanV * free.h * 0.88)
    return Math.max(dW, dH)
  }

  // ---------- poses ----------
  const tmp = new THREE.Vector3()
  function propCenter(roomId, propId) {
    const o = world.props[`${roomId}:${propId}`]
    if (!o) return null
    const b = new THREE.Box3().setFromObject(o)
    return { center: b.getCenter(new THREE.Vector3()), size: b.getSize(new THREE.Vector3()) }
  }
  function roomFrame(id) {
    if (id === 'house') return { c: new THREE.Vector3(-4.5, 3.4, 0), w: 25, h: 13, lift: 0.22 }
    if (id === 'door') return { c: new THREE.Vector3(-13.6, 1.7, 1.4), w: 9, h: 9, lift: 0.08 }
    const r = world.rooms[id]
    const extraH = id === 'balcony' ? 2.4 : 1.6
    return { c: new THREE.Vector3(r.cx, r.cy + RH / 2 + 0.1, id === 'balcony' ? 0.6 : 0), w: RW + 2.6, h: RH + extraH, lift: 0.1 }
  }
  function poseFor(stop, beat) {
    const f = roomFrame(stop.id)
    let target = f.c.clone()
    let dist = fitDistance(f.w, f.h)
    const focus = stop.beats[beat]?.focus
    if (beat > 0 && focus) {
      const pc = propCenter(stop.id, focus)
      if (pc) {
        target.lerp(pc.center, 0.5)
        dist *= 0.78
      }
    }
    const pos = target.clone().add(new THREE.Vector3(dist * (f.lift + 0.02), dist * f.lift + 0.5, dist * 0.98))
    return { pos, target }
  }

  // ---------- camera tween ----------
  let tween = null
  let goal = null
  function flyTo(pos, target, seconds) {
    goal = { pos: pos.clone(), target: target.clone() }
    if (!motion || seconds <= 0) {
      camera.position.copy(pos)
      controls.target.copy(target)
      camera.lookAt(target)
      tween = null
      controls.update()
      return
    }
    tween = { k: 0, dur: seconds, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone() }
  }
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)

  // ---------- state ----------
  const state = { mode: 'intro', stop: 0, beat: 0, playing: true, elapsed: 0, done: false, picked: null, room: 'door' }
  window.__walk = { state, world, camera, controls }

  function showGlow(roomId, propId) {
    const pc = propId ? propCenter(roomId, propId) : null
    if (!pc) {
      glowSprite.visible = false
      return
    }
    glowSprite.position.copy(pc.center)
    const s = Math.max(pc.size.x, pc.size.y, pc.size.z) * 1.2 + 0.5
    glowSprite.userData.base = s
    glowSprite.scale.set(s, s, 1)
    glowSprite.visible = true
  }

  // ---------- chrome ----------
  const card = $('card')
  const bar = $('bar')
  const plan = $('plan')
  const labelsEl = $('labels')
  let stepEls = []

  function setPressed() {
    $('m-play').setAttribute('aria-pressed', String(state.mode === 'play'))
    $('m-explore').setAttribute('aria-pressed', String(state.mode === 'explore'))
  }
  function swapIn(el) {
    if (!motion) return
    el.classList.remove('swap')
    void el.offsetWidth
    el.classList.add('swap')
  }
  function btn(label, cls, fn, aria) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn ' + (cls || '')
    b.textContent = label
    if (aria) b.setAttribute('aria-label', aria)
    b.addEventListener('click', fn)
    return b
  }

  function buildSteps() {
    const wrap = $('steps')
    wrap.textContent = ''
    stepEls = STOPS.map((s, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('aria-label', `Go to stop ${i + 1}, ${s.short}`)
      b.addEventListener('click', () => goStop(i))
      wrap.appendChild(b)
      return b
    })
  }
  function paintSteps() {
    stepEls.forEach((b, i) => {
      b.className = state.mode !== 'play' ? '' : i < state.stop ? 'done' : i === state.stop ? 'now' : ''
    })
    $('steps').style.display = state.mode === 'play' ? 'flex' : 'none'
  }
  function beatsBefore(stopIdx) {
    let n = 0
    for (let i = 0; i < stopIdx; i++) n += STOPS[i].beats.length
    return n
  }
  function paintProgress() {
    const done = beatsBefore(state.stop) + state.beat + (state.done ? 1 : Math.min(1, state.elapsed / BEAT_SECONDS))
    $('progress-fill').style.width = `${Math.min(100, (done / TOTAL_BEATS) * 100)}%`
  }

  function renderCard() {
    const controlsRow = $('c-controls')
    controlsRow.textContent = ''
    card.hidden = state.mode === 'intro'
    if (state.mode === 'play') {
      const stop = STOPS[state.stop]
      const beat = stop.beats[state.beat]
      $('c-kicker').textContent = stop.finale ? 'The finish' : `Stop ${state.stop + 1} of ${STOPS.length - 1}  ·  ${stop.kicker}`
      $('c-title').textContent = stop.title
      $('c-text').textContent = beat.text
      $('progress').hidden = false
      const last = state.stop === STOPS.length - 1 && state.beat === stop.beats.length - 1
      controlsRow.appendChild(btn('Back', 'icon', () => step(-1), 'Previous'))
      if (motion && !last) controlsRow.appendChild(btn(state.playing ? 'Pause' : 'Play', 'icon', togglePlay, state.playing ? 'Pause the tour' : 'Resume the tour'))
      controlsRow.appendChild(btn(last ? 'Explore the house' : 'Next', 'primary', () => (last ? setMode('explore') : step(1))))
      if (last) controlsRow.appendChild(btn('Replay', '', () => startTour()))
      $('c-note').textContent = motion ? 'Tip: tap the bars above to skip to any stop.' : 'Motion is reduced, so the tour moves when you press Next.'
      swapIn($('c-text'))
    } else if (state.mode === 'explore') {
      $('progress').hidden = true
      if (state.picked) {
        const stop = STOPS.find((s) => s.id === state.picked.room)
        const prop = stop.props.find((p) => p.id === state.picked.id)
        $('c-kicker').textContent = stop.title
        $('c-title').textContent = prop.name
        $('c-text').textContent = prop.text
      } else {
        $('c-kicker').textContent = 'Explore'
        $('c-title').textContent = 'Look around the house'
        $('c-text').textContent = 'Drag to turn the house, pinch or scroll to zoom. Tap anything that catches your eye, or use the plan to visit a room.'
      }
      controlsRow.appendChild(btn('Take the tour', 'primary', () => startTour()))
      $('c-note').textContent = 'Rooms are numbered in tour order.'
      swapIn($('c-text'))
    }
    paintSteps()
    paintProgress()
    layout()
  }

  function buildPlan() {
    plan.textContent = ''
    const t = document.createElement('p')
    t.className = 'plan-title'
    t.textContent = 'House plan'
    plan.appendChild(t)
    const order = [
      ['balcony', 'annex', 'notes', null],
      ['door', 'study', 'tools', 'lodge'],
    ]
    for (const row of order) {
      for (const id of row) {
        if (!id) {
          const e = document.createElement('span')
          e.className = 'empty'
          plan.appendChild(e)
          continue
        }
        const idx = STOPS.findIndex((s) => s.id === id)
        const b = document.createElement('button')
        b.type = 'button'
        b.dataset.room = id
        b.setAttribute('aria-label', `${STOPS[idx].title}, room ${idx + 1}`)
        b.innerHTML = `<b>${idx + 1}</b><span>${STOPS[idx].short}</span>`
        b.addEventListener('click', () => visitRoom(id))
        plan.appendChild(b)
      }
    }
  }
  function paintPlan() {
    plan.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.room === state.room)))
  }

  const labels = {}
  function buildLabels() {
    for (const s of STOPS) {
      if (s.id === 'house') continue
      const el = document.createElement('div')
      el.className = 'label'
      el.textContent = s.short
      el.addEventListener('click', () => visitRoom(s.id))
      labelsEl.appendChild(el)
      labels[s.id] = el
    }
  }
  const labelAnchor = (id) => {
    if (id === 'door') return new THREE.Vector3(-13.6, 5.7, 1.8)
    const r = world.rooms[id]
    return new THREE.Vector3(r.cx, r.cy + RH + 0.35, 2.0)
  }
  function updateLabels() {
    const show = state.mode === 'explore' || (state.mode === 'play' && STOPS[state.stop].finale)
    const w = window.innerWidth
    const h = window.innerHeight
    const cardRect = card.hidden ? null : card.getBoundingClientRect()
    for (const id in labels) {
      const el = labels[id]
      if (!show) {
        el.style.opacity = '0'
        el.style.pointerEvents = 'none'
        continue
      }
      tmp.copy(labelAnchor(id)).project(camera)
      const x = (tmp.x * 0.5 + 0.5) * w
      const y = (-tmp.y * 0.5 + 0.5) * h
      let hidden = tmp.z > 1 || x < 10 || x > w - 10 || y < 60 || y > h - 10
      if (cardRect && x > cardRect.left - 20 && x < cardRect.right + 20 && y > cardRect.top - 16 && y < cardRect.bottom + 16) hidden = true
      el.style.opacity = hidden ? '0' : '1'
      el.style.pointerEvents = hidden ? 'none' : 'auto'
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }

  // ---------- modes ----------
  function setMode(mode) {
    state.mode = mode
    setPressed()
    bar.hidden = false
    $('intro').hidden = true
    plan.hidden = mode !== 'explore'
    if (mode === 'explore') {
      state.picked = null
      controls.enabled = true
      glowSprite.visible = false
      renderCard()
      // pull back a little to show the whole house, then let the visitor roam
      const f = roomFrame('house')
      const dist = fitDistance(f.w, f.h)
      const pos = f.c.clone().add(new THREE.Vector3(dist * 0.28, dist * 0.2 + 0.5, dist * 0.95))
      state.room = 'house'
      paintPlan()
      flyTo(pos, f.c, 2.4)
    } else if (mode === 'play') {
      controls.enabled = false
      renderCard()
    }
  }
  function startTour() {
    state.stop = 0
    state.beat = 0
    state.elapsed = 0
    state.done = false
    state.playing = motion
    state.picked = null
    setMode('play')
    applyBeat(true)
  }
  function applyBeat(slow) {
    const stop = STOPS[state.stop]
    state.room = stop.id
    state.elapsed = 0
    state.done = false
    renderCard()
    const p = poseFor(stop, state.beat)
    const firstBeat = state.beat === 0
    flyTo(p.pos, p.target, firstBeat ? (slow ? 3.4 : 3.2) : 2.2)
    showGlow(stop.id, stop.beats[state.beat].focus)
    paintPlan()
  }
  function step(dir) {
    let s = state.stop
    let b = state.beat + dir
    if (b < 0) {
      if (s === 0) b = 0
      else {
        s -= 1
        b = STOPS[s].beats.length - 1
      }
    } else if (b >= STOPS[s].beats.length) {
      if (s === STOPS.length - 1) {
        state.done = true
        paintProgress()
        return
      }
      s += 1
      b = 0
    }
    state.stop = s
    state.beat = b
    applyBeat()
  }
  function goStop(i) {
    if (state.mode !== 'play') return
    state.stop = i
    state.beat = 0
    applyBeat()
  }
  function togglePlay() {
    state.playing = !state.playing
    renderCard()
  }
  function visitRoom(id) {
    if (state.mode !== 'explore') return
    state.picked = null
    state.room = id
    glowSprite.visible = false
    renderCard()
    const stop = STOPS.find((s) => s.id === id)
    const p = poseFor(stop, 0)
    paintPlan()
    flyTo(p.pos, p.target, 2.0)
  }
  function pick(propEntry) {
    state.picked = propEntry
    renderCard()
    const pc = propCenter(propEntry.room, propEntry.id)
    showGlow(propEntry.room, propEntry.id)
    if (!pc) return
    const dir = camera.position.clone().sub(controls.target).normalize()
    const d = Math.max(5.5, Math.max(pc.size.x, pc.size.y, pc.size.z) * 2.8)
    const pos = pc.center.clone().add(dir.multiplyScalar(d))
    state.room = propEntry.room
    paintPlan()
    flyTo(pos, pc.center, 1.4)
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  function pickAt(clientX, clientY) {
    ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1)
    // the view offset shifts the projection; the raycaster accounts for it through the camera matrices
    ray.setFromCamera(ndc, camera)
    const hits = ray.intersectObjects(world.scene.children, true)
    for (const h of hits) {
      let o = h.object
      if (o.userData.noPick || o.isSprite || o.isLight) continue
      if (o.material && o.material.visible === false) continue
      while (o) {
        if (o.userData.pickId) return { room: o.userData.pickRoom, id: o.userData.pickId }
        o = o.parent
      }
      // an ordinary wall or floor: let clicks pass through to nothing
      return null
    }
    return null
  }
  const canvas = renderer.domElement
  let down = null
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY } })
  canvas.addEventListener('pointerup', (e) => {
    if (!down || state.mode !== 'explore') return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    if (moved > 7) return
    const hit = pickAt(e.clientX, e.clientY)
    if (hit && STOPS.find((s) => s.id === hit.room)?.props.some((p) => p.id === hit.id)) pick(hit)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (state.mode !== 'explore' || e.buttons) return
    const hit = pickAt(e.clientX, e.clientY)
    canvas.style.cursor = hit ? 'pointer' : 'grab'
  })

  // ---------- events ----------
  $('go-play').addEventListener('click', startTour)
  $('go-explore').addEventListener('click', () => setMode('explore'))
  $('m-play').addEventListener('click', startTour)
  $('m-explore').addEventListener('click', () => setMode('explore'))
  window.addEventListener('keydown', (e) => {
    if (state.mode === 'play') {
      if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === ' ' && motion && e.target === document.body) { e.preventDefault(); togglePlay() }
    } else if (state.mode === 'explore' && e.key === 'Escape') {
      state.picked = null
      glowSprite.visible = false
      renderCard()
    }
  })
  window.addEventListener('resize', () => { layout() })
  new ResizeObserver(() => layout()).observe(card)

  // ---------- go ----------
  buildSteps()
  buildPlan()
  buildLabels()
  layout()
  // opening shot: the whole house behind the welcome card
  {
    const f = roomFrame('house')
    const dist = fitDistance(f.w, f.h)
    const pos = f.c.clone().add(new THREE.Vector3(dist * 0.28, dist * 0.2 + 0.5, dist * 0.95))
    camera.position.copy(pos)
    controls.target.copy(f.c)
    camera.lookAt(f.c)
    controls.update()
  }

  const clock = new THREE.Clock()
  let t = 0
  function frame() {
    requestAnimationFrame(frame)
    tick(null)
  }
  // `tick(seconds)` lets an automated check advance time when the browser throttles hidden tabs.
  function tick(forcedDt) {
    const dt = forcedDt ?? Math.min(0.5, clock.getDelta())
    window.__walk.frames = (window.__walk.frames || 0) + 1
    if (motion) t += dt
    updateWorld(world, motion ? t : 0, motion)

    if (tween) {
      tween.k += dt / tween.dur
      const e = ease(Math.min(1, tween.k))
      camera.position.lerpVectors(tween.p0, tween.p1, e)
      camera.position.y += Math.sin(Math.PI * e) * 0.9
      controls.target.lerpVectors(tween.t0, tween.t1, e)
      if (tween.k >= 1) tween = null
      camera.lookAt(controls.target)
    } else if (state.mode === 'play' && goal && motion) {
      camera.position.copy(goal.pos)
      camera.position.x += Math.sin(t * 0.25) * 0.28
      camera.position.y += Math.sin(t * 0.19) * 0.1
      camera.lookAt(goal.target)
    }
    if (state.mode === 'explore') {
      const tg = controls.target
      tg.x = THREE.MathUtils.clamp(tg.x, -24, 10)
      tg.y = THREE.MathUtils.clamp(tg.y, -1, 11)
      tg.z = THREE.MathUtils.clamp(tg.z, -8, 8)
      controls.update()
    }

    if (glowSprite.visible) {
      const b = glowSprite.userData.base || 1
      const k = motion ? 1 + Math.sin(t * 3) * 0.08 : 1
      glowSprite.scale.set(b * k, b * k, 1)
    }

    if (state.mode === 'play' && state.playing && motion && !state.done && !tween) {
      state.elapsed += dt
      if (state.elapsed >= BEAT_SECONDS) {
        const lastStop = state.stop === STOPS.length - 1
        const lastBeat = state.beat === STOPS[state.stop].beats.length - 1
        if (lastStop && lastBeat) {
          state.done = true
          state.playing = false
          renderCard()
        } else step(1)
      }
      paintProgress()
    }
    updateLabels()
    renderer.render(world.scene, camera)
  }
  window.__walk.tick = tick
  frame()
}
