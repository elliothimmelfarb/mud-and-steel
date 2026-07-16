/**
 * Model Gallery — a dev-only viewer for every procedural model and the
 * terrain, so model work has a place to be SEEN before it's judged in-game.
 *
 * Enabled with `?gallery` on the URL (main.ts boots this INSTEAD of the game).
 * Views:
 *   ?gallery              → contact sheet: every exhibit on a labelled grid
 *   ?gallery&m=<id>       → single exhibit on the turntable, auto-framed
 *   ?gallery&m=terrain-*  → terrain diorama camera presets
 *
 * Everything also hangs off `window.__gallery` so a screenshot pass can drive
 * it without clicking:
 *
 *   __gallery.list(); __gallery.show('a7v'); __gallery.spin(true)
 *   __gallery.sheet(); __gallery.wet(0.9); __gallery.stats()
 *
 * None of this ships in a normal boot — main.ts only imports it behind the
 * flag, so the game bundle is unaffected.
 */
import * as THREE from 'three'
import { forkRand } from '../core/rng'
import { WORLD } from '../core/config'
import {
  buildAmmoBoxes, buildArmoredCar, buildBiplane, buildChurchRuin, buildDugout,
  buildFieldGun, buildGasProjector, buildHorse, buildPeriscope, buildRuin,
  buildSearchlight, buildFlarePost, buildStokesMortar, buildStretcher,
  buildTankA7V, buildTankMkIV, buildVickers,
  crossGraveGeometry, deadTreeGeometry, duckboardGeometry, rubbleGeometry,
  sandbagGeometry, stakeGeometry, tankTrapGeometry, wireCoilGeometry,
  wirePostGeometry,
} from '../render/props'
import { SoldierRenderer, type SoldierPose } from '../render/unitMeshes'
import { WEAPON_PROFILES, setViewmodelEmissive } from './weapons'
import { Terrain } from '../world/terrain'
import { TerrainMesh } from '../world/terrainMesh'
import { Scenery } from '../render/scenery'
import type { UnitKindId } from '../core/types'

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

type Family = 'cover' | 'structure' | 'emplacement' | 'vehicle' | 'viewmodel'

interface ObjectExhibit {
  id: string
  label: string
  family: Family
  build: () => THREE.Object3D
}

/** Wrap a vertex-colored instancing geometry the way Scenery does. */
function geoMesh(geo: THREE.BufferGeometry): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 })
  const m = new THREE.Mesh(geo, mat)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function vmGroup(kind: UnitKindId): THREE.Object3D {
  const vm = WEAPON_PROFILES[kind].build()
  // Viewmodels ship with castShadow off (they live in camera space in-game);
  // in the studio we want their form readable, shadows help.
  vm.group.traverse((o) => { o.castShadow = true })
  return vm.group
}

function catalog(): ObjectExhibit[] {
  // Deterministic per-exhibit rand so reloads show the identical model.
  const r = (id: string) => forkRand(1213, id)
  return [
    // -- ground cover / defences (instancing geometries) ---------------------
    { id: 'deadtree', label: 'Dead Tree', family: 'cover', build: () => geoMesh(deadTreeGeometry(r('deadtree'))) },
    { id: 'wirepost', label: 'Wire Picket', family: 'cover', build: () => geoMesh(wirePostGeometry()) },
    { id: 'wirecoil', label: 'Wire Coil', family: 'cover', build: () => geoMesh(wireCoilGeometry()) },
    { id: 'sandbag', label: 'Sandbag', family: 'cover', build: () => geoMesh(sandbagGeometry()) },
    { id: 'tanktrap', label: 'Knife Rest', family: 'cover', build: () => geoMesh(tankTrapGeometry()) },
    { id: 'duckboard', label: 'Duckboard', family: 'cover', build: () => geoMesh(duckboardGeometry()) },
    { id: 'grave', label: 'Grave Cross', family: 'cover', build: () => geoMesh(crossGraveGeometry()) },
    { id: 'rubble', label: 'Rubble', family: 'cover', build: () => geoMesh(rubbleGeometry(r('rubble'))) },
    { id: 'stake', label: 'Mine Stake', family: 'cover', build: () => geoMesh(stakeGeometry()) },
    // -- structures -----------------------------------------------------------
    { id: 'ruin', label: 'Farm Ruin', family: 'structure', build: () => buildRuin(r('ruin')) },
    { id: 'church', label: 'Church Ruin', family: 'structure', build: () => buildChurchRuin(r('church')) },
    { id: 'dugout', label: 'Dugout', family: 'structure', build: () => buildDugout() },
    { id: 'ammoboxes', label: 'Ammo Boxes', family: 'structure', build: () => buildAmmoBoxes(r('ammoboxes')) },
    // -- emplacements / kit ----------------------------------------------------
    { id: 'fieldgun', label: '18-Pounder', family: 'emplacement', build: buildFieldGun },
    { id: 'vickers', label: 'Vickers MG', family: 'emplacement', build: buildVickers },
    { id: 'mortar', label: 'Stokes Mortar', family: 'emplacement', build: buildStokesMortar },
    { id: 'gasproj', label: 'Livens Projector', family: 'emplacement', build: buildGasProjector },
    { id: 'searchlight', label: 'Searchlight', family: 'emplacement', build: buildSearchlight },
    { id: 'flarepost', label: 'Flare Post', family: 'emplacement', build: buildFlarePost },
    { id: 'periscope', label: 'Periscope', family: 'emplacement', build: buildPeriscope },
    { id: 'stretcher', label: 'Stretcher', family: 'emplacement', build: buildStretcher },
    // -- vehicles / creatures --------------------------------------------------
    { id: 'a7v', label: 'A7V (German)', family: 'vehicle', build: buildTankA7V },
    { id: 'mkiv', label: 'Mk IV (British)', family: 'vehicle', build: buildTankMkIV },
    { id: 'armoredcar', label: 'Armoured Car', family: 'vehicle', build: buildArmoredCar },
    { id: 'biplane-brit', label: 'Biplane (RFC)', family: 'vehicle', build: () => buildBiplane(false) },
    { id: 'biplane-ger', label: 'Biplane (German)', family: 'vehicle', build: () => buildBiplane(true) },
    { id: 'horse', label: 'Horse', family: 'vehicle', build: buildHorse },
    // -- first-person viewmodels ----------------------------------------------
    { id: 'vm-rifleman', label: 'VM: SMLE', family: 'viewmodel', build: () => vmGroup('rifleman') },
    { id: 'vm-sniper', label: 'VM: Scoped SMLE', family: 'viewmodel', build: () => vmGroup('sniper') },
    { id: 'vm-officer', label: 'VM: Webley', family: 'viewmodel', build: () => vmGroup('officer') },
    { id: 'vm-lewis', label: 'VM: Lewis', family: 'viewmodel', build: () => vmGroup('lewis') },
    { id: 'vm-vickers', label: 'VM: Vickers', family: 'viewmodel', build: () => vmGroup('vickers') },
    { id: 'vm-grenadier', label: 'VM: Mills Bomb', family: 'viewmodel', build: () => vmGroup('grenadier') },
    { id: 'vm-flamer', label: 'VM: Flame Projector', family: 'viewmodel', build: () => vmGroup('flamer') },
    { id: 'vm-mortar', label: 'VM: Stokes', family: 'viewmodel', build: () => vmGroup('mortar') },
    { id: 'vm-fieldgun', label: 'VM: 18-Pounder', family: 'viewmodel', build: () => vmGroup('fieldgun') },
    { id: 'vm-gasproj', label: 'VM: Livens', family: 'viewmodel', build: () => vmGroup('gasproj') },
    { id: 'vm-medic', label: 'VM: Medic Kit', family: 'viewmodel', build: () => vmGroup('medic') },
    { id: 'vm-engineer', label: 'VM: Sapper Kit', family: 'viewmodel', build: () => vmGroup('engineer') },
  ]
}

// Soldier pose row: id/label pairs used by both the sheet and single view.
interface PoseSpec { label: string; make: (t: number) => Partial<SoldierPose> }
const POSES: PoseSpec[] = [
  { label: 'stand', make: () => ({}) },
  { label: 'walk', make: (t) => ({ moveAmount: 0.45, animPhase: t * 5.2 }) },
  { label: 'charge', make: (t) => ({ moveAmount: 1, animPhase: t * 8.5 }) },
  { label: 'aim', make: () => ({ aiming: true }) },
  { label: 'crouch', make: (t) => ({ stance: 'crouch', moveAmount: 0.5, animPhase: t * 4.6 }) },
  { label: 'kneel-aim', make: () => ({ stance: 'crouch', aiming: true }) },
  { label: 'prone', make: () => ({ stance: 'prone', aiming: true }) },
  { label: 'german', make: () => ({ team: 'german' }) },
  { label: 'masked', make: () => ({ team: 'german', masked: true }) },
  { label: 'dead-1', make: () => ({ stance: 'dead', deadSeed: 3.1, deadT: 5 }) },
  { label: 'dead-2', make: () => ({ stance: 'dead', deadSeed: 7.7, deadT: 5 }) },
  { label: 'dead-3', make: () => ({ stance: 'dead', deadSeed: 12.9, deadT: 5 }) },
  { label: 'mounted', make: (t) => ({ mounted: true, moveAmount: 1, animPhase: t * 7 }) },
]

// Terrain camera presets (world coords — the diorama is the real generated map).
interface TerrainView { id: string; label: string; pos: [number, number, number]; target: [number, number, number]; wet: number }
const TERRAIN_VIEWS: TerrainView[] = [
  { id: 'terrain-over', label: 'Terrain: Overview', pos: [0, 150, WORLD.frontTrenchZ + 190], target: [0, 0, -40], wet: 0 },
  { id: 'terrain-front', label: 'Terrain: Front Trench', pos: [24, 6, WORLD.frontTrenchZ + 18], target: [-30, 0, WORLD.frontTrenchZ - 14], wet: 0 },
  { id: 'terrain-nml', label: 'Terrain: No-Man’s Land', pos: [-18, 9, 30], target: [10, -1, -30], wet: 0 },
  { id: 'terrain-wet', label: 'Terrain: Flooded', pos: [-18, 9, 30], target: [10, -1, -30], wet: 0.9 },
]

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

export interface GalleryApi {
  list(): string[]
  show(id: string): boolean
  sheet(): void
  next(): void
  prev(): void
  spin(on?: boolean): boolean
  rotate(dYaw: number, dPitch?: number): void
  zoom(factor: number): void
  fit(): void
  wet(v: number): void
  current(): string
  /** Triangles/draw-calls of the last rendered frame. */
  stats(): { triangles: number; calls: number }
}

const SHEET_CELL = 18
const SHEET_COLS = 6

export function startModelGallery(app: HTMLElement): void {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  app.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x2b2e33)
  scene.fog = null

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 2000)

  // -- studio lighting --------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xcfd8e8, 0x4a4238, 0.85)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.0)
  sun.position.set(60, 90, 40)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.camera.left = -130; sun.shadow.camera.right = 130
  sun.shadow.camera.top = 130; sun.shadow.camera.bottom = -130
  sun.shadow.camera.far = 400
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.02
  scene.add(sun)
  const rim = new THREE.DirectionalLight(0xbfd0ff, 0.5)
  rim.position.set(-50, 40, -60)
  scene.add(rim)

  // Studio floor (hidden while the terrain diorama is up).
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(400, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.96, metalness: 0 }),
  )
  floor.receiveShadow = true
  scene.add(floor)

  // -- exhibits ---------------------------------------------------------------
  const items = catalog()
  const built = new Map<string, THREE.Object3D>()
  const getBuilt = (ex: ObjectExhibit): THREE.Object3D => {
    let o = built.get(ex.id)
    if (!o) {
      o = ex.build()
      o.visible = false
      scene.add(o)
      built.set(ex.id, o)
    }
    return o
  }

  // Viewmodel materials carry a daylight emissive floor; normalise it.
  setViewmodelEmissive(0)

  // Soldiers: one renderer, poses re-pushed every frame while visible.
  const soldiers = new SoldierRenderer(scene)
  let soldiersVisible = false
  let soldiersOrigin: [number, number, number] = [0, 0, 0]

  // Terrain diorama, built lazily on first request.
  let terrain: Terrain | null = null
  let terrainMesh: TerrainMesh | null = null
  let terrainDressing: THREE.Group | null = null
  let terrainWet = 0
  const ensureTerrain = (): void => {
    if (terrain) return
    terrain = new Terrain(115599)
    terrainMesh = new TerrainMesh(terrain)
    terrainMesh.mesh.visible = false
    scene.add(terrainMesh.mesh)
    // Dress the diorama: trees, ruins, defences and the instanced ground clutter.
    // Scenery adds all of that (plus the frustumCulled=false clutter meshes, which
    // always render) straight onto the scene, so collect everything it adds into
    // one group we can hide alongside terrainMesh — otherwise the battlefield
    // dressing would stay visible over every other exhibit and the contact sheet.
    // Scenery's live-sync pools start at count=0 and are never synced here, so the
    // static dressing is all that shows.
    const before = new Set(scene.children)
    new Scenery(scene, terrain, 115599)
    terrainDressing = new THREE.Group()
    for (const child of scene.children.slice()) {
      if (!before.has(child)) terrainDressing.add(child) // reparents off the scene root
    }
    terrainDressing.visible = false
    scene.add(terrainDressing)
  }

  // -- orbit camera -----------------------------------------------------------
  const orbit = { target: new THREE.Vector3(), dist: 10, yaw: 0.6, pitch: -0.45, spin: false }
  const applyOrbit = (): void => {
    const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch)
    camera.position.set(
      orbit.target.x + Math.sin(orbit.yaw) * cp * orbit.dist,
      orbit.target.y - sp * orbit.dist,
      orbit.target.z + Math.cos(orbit.yaw) * cp * orbit.dist,
    )
    camera.lookAt(orbit.target)
  }

  const _box = new THREE.Box3()
  const _sph = new THREE.Sphere()
  const fitObject = (o: THREE.Object3D): void => {
    _box.setFromObject(o)
    if (_box.isEmpty()) { orbit.dist = 8; return }
    _box.getBoundingSphere(_sph)
    orbit.target.copy(_sph.center)
    orbit.dist = Math.max(0.4, (_sph.radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.25)
    orbit.yaw = 0.6
    orbit.pitch = -0.35
    applyOrbit()
  }

  // -- labels (contact sheet) ---------------------------------------------------
  const labelTex = (text: string): THREE.CanvasTexture => {
    const c = document.createElement('canvas')
    c.width = 512; c.height = 128
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.font = 'bold 56px ui-monospace, Menlo, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 10
      ctx.strokeStyle = 'rgba(0,0,0,0.9)'
      ctx.strokeText(text, 256, 64)
      ctx.fillStyle = '#f0e8d0'
      ctx.fillText(text, 256, 64)
    }
    const tex = new THREE.CanvasTexture(c)
    tex.anisotropy = 4
    return tex
  }
  const labels: THREE.Sprite[] = []
  let labelsBuilt = false
  const buildLabels = (): void => {
    if (labelsBuilt) return
    labelsBuilt = true
    const mk = (text: string, x: number, z: number): void => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex(text), depthTest: false, transparent: true }))
      s.scale.set(7, 1.75, 1)
      s.position.set(x, 0.9, z + SHEET_CELL * 0.42)
      s.visible = false
      scene.add(s)
      labels.push(s)
    }
    items.forEach((ex, i) => {
      const [x, z] = cellPos(i)
      mk(ex.label, x, z)
    })
    const [sx, sz] = cellPos(items.length)
    mk('Soldiers', sx, sz)
  }

  const cellPos = (i: number): [number, number] => {
    const col = i % SHEET_COLS
    const row = Math.floor(i / SHEET_COLS)
    const cols = Math.min(SHEET_COLS, items.length + 1)
    const rows = Math.ceil((items.length + 1) / SHEET_COLS)
    return [
      (col - (cols - 1) / 2) * SHEET_CELL,
      (row - (rows - 1) / 2) * SHEET_CELL,
    ]
  }

  // -- view state ---------------------------------------------------------------
  let mode: 'single' | 'sheet' = 'sheet'
  let currentId = ''

  const hideAll = (): void => {
    for (const o of built.values()) o.visible = false
    for (const s of labels) s.visible = false
    soldiersVisible = false
    if (terrainMesh) terrainMesh.mesh.visible = false
    if (terrainDressing) terrainDressing.visible = false
    floor.visible = true
  }

  const showSingle = (id: string): boolean => {
    const tv = TERRAIN_VIEWS.find((v) => v.id === id)
    if (tv) {
      hideAll()
      ensureTerrain()
      if (terrainMesh) terrainMesh.mesh.visible = true
      if (terrainDressing) terrainDressing.visible = true
      floor.visible = false
      terrainWet = tv.wet
      camera.position.set(...tv.pos)
      orbit.target.set(...tv.target)
      orbit.dist = camera.position.distanceTo(orbit.target)
      const d = new THREE.Vector3(...tv.target).sub(camera.position).normalize()
      orbit.yaw = Math.atan2(-d.x, -d.z)
      orbit.pitch = Math.asin(d.y)
      applyOrbit()
      mode = 'single'
      currentId = id
      syncPanel()
      return true
    }
    if (id === 'soldiers') {
      hideAll()
      soldiersVisible = true
      soldiersOrigin = [0, 0, 0]
      orbit.target.set(0, 0.9, 0)
      orbit.dist = 14
      orbit.yaw = 0
      orbit.pitch = -0.12
      applyOrbit()
      mode = 'single'
      currentId = id
      syncPanel()
      return true
    }
    const ex = items.find((e) => e.id === id)
    if (!ex) return false
    hideAll()
    const o = getBuilt(ex)
    o.position.set(0, 0, 0)
    o.visible = true
    fitObject(o)
    mode = 'single'
    currentId = id
    syncPanel()
    return true
  }

  const showSheet = (): void => {
    hideAll()
    buildLabels()
    items.forEach((ex, i) => {
      const o = getBuilt(ex)
      const [x, z] = cellPos(i)
      o.position.set(x, 0, z)
      o.visible = true
    })
    const [sx, sz] = cellPos(items.length)
    soldiersVisible = true
    soldiersOrigin = [sx - 7, 0, sz]
    for (const s of labels) s.visible = true
    const rows = Math.ceil((items.length + 1) / SHEET_COLS)
    orbit.target.set(0, 0, 0)
    orbit.dist = Math.max(SHEET_COLS, rows) * SHEET_CELL * 0.92
    orbit.yaw = 0
    orbit.pitch = -0.72
    applyOrbit()
    mode = 'sheet'
    currentId = 'sheet'
    syncPanel()
  }

  const allIds = (): string[] => [
    ...items.map((e) => e.id), 'soldiers', ...TERRAIN_VIEWS.map((v) => v.id),
  ]

  const step = (dir: 1 | -1): void => {
    const ids = allIds()
    const i = ids.indexOf(currentId)
    const nxt = ids[(i + dir + ids.length) % ids.length] ?? ids[0]
    showSingle(nxt)
  }

  // -- soldier pose push --------------------------------------------------------
  const pushSoldiers = (t: number): void => {
    soldiers.begin()
    if (soldiersVisible) {
      const [ox, oy, oz] = soldiersOrigin
      POSES.forEach((spec, i) => {
        const base: SoldierPose = {
          x: ox + (i - (POSES.length - 1) / 2) * 1.35, y: oy, z: oz,
          facing: Math.PI, stance: 'stand', moveAmount: 0, animPhase: 0,
          aiming: false, recoil: 0, deadT: 0, deadSeed: 1, masked: false,
          team: 'brit', tint: (i * 0.37) % 1, mounted: false,
        }
        soldiers.push({ ...base, ...spec.make(t) })
      })
    }
    soldiers.finish()
  }

  // -- input ----------------------------------------------------------------------
  const el = renderer.domElement
  const drag = { on: false, x: 0, y: 0 }
  el.addEventListener('pointerdown', (e) => { drag.on = true; drag.x = e.clientX; drag.y = e.clientY; el.setPointerCapture(e.pointerId) })
  el.addEventListener('pointermove', (e) => {
    if (!drag.on) return
    orbit.yaw -= (e.clientX - drag.x) * 0.006
    orbit.pitch = Math.max(-1.45, Math.min(0.4, orbit.pitch - (e.clientY - drag.y) * 0.005))
    drag.x = e.clientX; drag.y = e.clientY
    applyOrbit()
  })
  el.addEventListener('pointerup', (e) => { drag.on = false; try { el.releasePointerCapture(e.pointerId) } catch { /* ignore */ } })
  el.addEventListener('wheel', (e) => {
    e.preventDefault()
    orbit.dist = Math.max(0.3, Math.min(700, orbit.dist * (e.deltaY > 0 ? 1.12 : 0.89)))
    applyOrbit()
  }, { passive: false })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // -- panel ------------------------------------------------------------------------
  const panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;top:10px;left:10px;z-index:9999;width:230px;padding:9px;' +
    'background:rgba(18,16,12,0.88);border:1px solid #5a5038;border-radius:6px;' +
    'font:11px/1.4 ui-monospace,Menlo,monospace;color:#e8e0c8;user-select:none'
  panel.innerHTML = '<div style="font-weight:bold;letter-spacing:0.18em;color:#e0a94a;margin-bottom:6px">MODEL GALLERY</div>'

  const select = document.createElement('select')
  select.style.cssText = 'width:100%;background:#2a2519;color:#e8e0c8;border:1px solid #4a4130;border-radius:4px;padding:3px;font:inherit'
  const addOpt = (group: HTMLOptGroupElement, id: string, label: string): void => {
    const o = document.createElement('option')
    o.value = id; o.textContent = label
    group.appendChild(o)
  }
  const families: Array<[Family | 'special', string]> = [
    ['cover', 'Ground cover'], ['structure', 'Structures'], ['emplacement', 'Emplacements'],
    ['vehicle', 'Vehicles'], ['viewmodel', 'Viewmodels'], ['special', 'Soldiers & Terrain'],
  ]
  for (const [fam, famLabel] of families) {
    const og = document.createElement('optgroup')
    og.label = famLabel
    if (fam === 'special') {
      addOpt(og, 'soldiers', 'Soldier poses')
      for (const v of TERRAIN_VIEWS) addOpt(og, v.id, v.label)
    } else {
      for (const ex of items) if (ex.family === fam) addOpt(og, ex.id, ex.label)
    }
    select.appendChild(og)
  }
  select.onchange = () => showSingle(select.value)
  panel.appendChild(select)

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:3px;margin-top:6px;flex-wrap:wrap'
  const mkBtn = (label: string, cb: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = 'padding:3px 7px;background:#2a2519;color:#e8e0c8;border:1px solid #4a4130;border-radius:4px;cursor:pointer;font:inherit'
    b.onclick = cb
    return b
  }
  const spinBtn = mkBtn('Spin', () => api.spin())
  row.append(
    mkBtn('◀', () => step(-1)),
    mkBtn('▶', () => step(1)),
    mkBtn('Sheet', () => showSheet()),
    spinBtn,
    mkBtn('Fit', () => api.fit()),
  )
  panel.appendChild(row)

  const info = document.createElement('div')
  info.style.cssText = 'margin-top:6px;opacity:0.85;font-size:10px;white-space:pre-line'
  panel.appendChild(info)
  document.body.appendChild(panel)

  const syncPanel = (): void => {
    if (currentId && currentId !== 'sheet') select.value = currentId
    const ex = items.find((e) => e.id === currentId)
    let dims = ''
    if (ex) {
      const o = getBuilt(ex)
      _box.setFromObject(o)
      if (!_box.isEmpty()) {
        const s = _box.getSize(new THREE.Vector3())
        dims = `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} m`
      }
    }
    info.textContent = `${currentId}${dims ? '\n' + dims : ''}\ndrag rotate · wheel zoom · __gallery`
  }

  // -- api ---------------------------------------------------------------------------
  const api: GalleryApi = {
    list: () => allIds(),
    show: (id) => showSingle(id),
    sheet: () => showSheet(),
    next: () => step(1),
    prev: () => step(-1),
    spin: (on) => {
      orbit.spin = on === undefined ? !orbit.spin : on
      spinBtn.style.background = orbit.spin ? '#5a4a1e' : '#2a2519'
      return orbit.spin
    },
    rotate: (dYaw, dPitch = 0) => {
      orbit.yaw += dYaw
      orbit.pitch = Math.max(-1.45, Math.min(0.4, orbit.pitch + dPitch))
      applyOrbit()
    },
    zoom: (f) => { orbit.dist = Math.max(0.3, Math.min(700, orbit.dist * f)); applyOrbit() },
    fit: () => {
      const ex = items.find((e) => e.id === currentId)
      if (ex) fitObject(getBuilt(ex))
    },
    wet: (v) => { terrainWet = Math.max(0, Math.min(1, v)) },
    current: () => currentId,
    stats: () => ({ triangles: renderer.info.render.triangles, calls: renderer.info.render.calls }),
  }
  ;(window as unknown as { __gallery: GalleryApi }).__gallery = api

  // -- boot state from URL --------------------------------------------------------
  const q = new URLSearchParams(location.search)
  const m = q.get('m')
  if (m && !showSingle(m)) showSheet()
  else if (!m) showSheet()
  if (q.has('spin')) api.spin(true)

  // -- loop --------------------------------------------------------------------------
  let last = performance.now()
  let t = 0
  const loop = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    t += dt
    if (orbit.spin) { orbit.yaw += dt * 0.5; applyOrbit() }
    pushSoldiers(t)
    if (terrainMesh && terrainMesh.mesh.visible) terrainMesh.update(dt, terrainWet)
    renderer.render(scene, camera)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  // eslint-disable-next-line no-console
  console.log('[Gallery] ready — window.__gallery. Exhibits:', allIds().join(', '))
}
