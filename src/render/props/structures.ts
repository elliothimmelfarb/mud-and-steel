/**
 * Structures — ruins, the church landmark, dugout entrances, stores. Complex
 * builds returning THREE.Group of meshes over the shared material set.
 *
 * Everything masonry is assembled from many small boxes and baked into ONE
 * vertex-colored geometry per build (see `mergeStone`): course-line banding,
 * ground grime, tonal noise and soot around openings are all free per-vertex
 * detail. Builders always return FRESH geometry (no module-level caching).
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PALETTE, fm, mat, pm, wrapVC, bakeAndMerge, localRand, clamp01, hash3, type ColoredPart } from './shared'
import { rubbleGeometry, sandbagGeometry, crossGraveGeometry } from './groundcover'

// ---------------------------------------------------------------------------
// Local masonry baking helpers
// ---------------------------------------------------------------------------

const _sc = new THREE.Color()

interface StoneOpts {
  /** Vertical spacing of the baked mortar-course lines (m). */
  courseH?: number
  /** Darkening depth at a course line. 0 disables banding (use for timber). */
  band?: number
  /** Ground-grime darkening toward yMin. */
  grime?: number
  yMin?: number
  yMax?: number
  /** Group-local soot centres (window/door/shell scorch). */
  char?: THREE.Vector3[]
  charR?: number
  charStr?: number
  /** Per-vertex tonal breakup so big plates don't read flat. */
  noise?: number
}

/**
 * Bake masonry vertex colors onto `geo`: ground grime, horizontal course
 * lines, tonal noise and optional soot around opening centres. Mutates and
 * returns the geometry.
 */
function paintStone(geo: THREE.BufferGeometry, hex: number, o: StoneOpts = {}): THREE.BufferGeometry {
  const courseH = o.courseH ?? 0.34
  const band = o.band ?? 0.32
  const grime = o.grime ?? 0.24
  const noiseAmt = o.noise ?? 0.1
  const charR = o.charR ?? 1.0
  const charStr = o.charStr ?? 0.7
  const char = o.char
  const pos = geo.getAttribute('position')
  const count = pos.count
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const yMin = o.yMin ?? (bb ? bb.min.y : 0)
  const yMax = o.yMax ?? (bb ? bb.max.y : 1)
  const span = Math.max(1e-4, yMax - yMin)
  _sc.setHex(hex)
  const cr = _sc.r, cg = _sc.g, cb = _sc.b
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    // ground grime
    const tg = 1 - clamp01((y - yMin) / span)
    let shade = 1 - grime * tg
    // mortar course line (thin dark band at the base of each course)
    if (band > 0) {
      let frac = y / courseH
      frac = frac - Math.floor(frac)
      if (frac < 0.16) shade *= 1 - band * (1 - frac / 0.16)
    }
    // tonal breakup
    const n = hash3(x * 1.7, y * 1.7, z * 1.7)
    shade *= 1 + noiseAmt * (n - 0.5)
    // soot around openings
    if (char) {
      let dmin = Infinity
      for (let c = 0; c < char.length; c++) {
        const p = char[c]
        const dx = x - p.x, dy = y - p.y, dz = z - p.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < dmin) dmin = d
      }
      if (dmin < charR) shade *= 1 - charStr * (1 - dmin / charR)
    }
    if (shade < 0) shade = 0
    arr[i * 3 + 0] = cr * shade
    arr[i * 3 + 1] = cg * shade
    arr[i * 3 + 2] = cb * shade
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

interface StonePart { geo: THREE.BufferGeometry; hex: number; o?: StoneOpts }

/** Bake each part (shared opts overridable per-part) and merge into one mesh. */
function mergeStone(parts: StonePart[], shared: StoneOpts = {}): THREE.Mesh {
  for (const p of parts) paintStone(p.geo, p.hex, { ...shared, ...(p.o ?? {}) })
  const merged = mergeGeometries(parts.map(p => p.geo), false) ?? new THREE.BufferGeometry()
  merged.computeBoundingSphere()
  return wrapVC(merged)
}

/** Paint a single geometry and wrap it (own bounding box unless overridden). */
function stoneMesh(geo: THREE.BufferGeometry, hex: number, o: StoneOpts = {}): THREE.Mesh {
  paintStone(geo, hex, o)
  geo.computeBoundingSphere()
  return wrapVC(geo)
}

/** Lift a (possibly tilted) geometry so its lowest vertex rests at `minY`. */
function settle(geo: THREE.BufferGeometry, minY = 0.02): THREE.BufferGeometry {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  if (bb && bb.min.y < minY) geo.translate(0, minY - bb.min.y, 0)
  return geo
}

/** Push a translated box part. */
function pushBox(
  parts: StonePart[], w: number, h: number, d: number,
  x: number, y: number, z: number, hex: number, o?: StoneOpts,
): void {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  parts.push({ geo: g, hex, o })
}

/**
 * Push one box of a tower/nave face. `axis` is the direction the wall RUNS
 * ('x' → faces ±Z at plane z=`fixed`; 'z' → faces ±X at plane x=`fixed`).
 * `uc` is the centre along the run axis, `uw` the box length along it.
 */
function faceBox(
  parts: StonePart[], axis: 'x' | 'z', fixed: number,
  uc: number, y0: number, y1: number, uw: number, thick: number, hex: number,
): void {
  const h = y1 - y0
  let geo: THREE.BufferGeometry
  if (axis === 'x') {
    geo = new THREE.BoxGeometry(uw, h, thick)
    geo.translate(uc, (y0 + y1) / 2, fixed)
  } else {
    geo = new THREE.BoxGeometry(thick, h, uw)
    geo.translate(fixed, (y0 + y1) / 2, uc)
  }
  parts.push({ geo, hex })
}

/**
 * Build a wall face with a pointed (gothic) arch opening, corbelled from
 * stacked narrowing courses. Clamps to `faceTop` so a broken/short wall just
 * loses its arch head and reads as a shattered window.
 */
function archFace(
  parts: StonePart[], axis: 'x' | 'z', fixed: number, u0: number,
  faceW: number, thick: number, y0: number, faceTop: number,
  openW: number, sillTop: number, springY: number, apexY: number,
  toneFn: () => number,
): void {
  const jw = (faceW - openW) / 2
  if (sillTop > y0 + 0.01) faceBox(parts, axis, fixed, u0, y0, sillTop, faceW, thick, toneFn())
  const jTop = Math.min(springY, faceTop)
  if (jTop > sillTop + 0.01 && jw > 0.02) {
    faceBox(parts, axis, fixed, u0 - (openW / 2 + jw / 2), sillTop, jTop, jw, thick, toneFn())
    faceBox(parts, axis, fixed, u0 + (openW / 2 + jw / 2), sillTop, jTop, jw, thick, toneFn())
  }
  if (faceTop > springY + 0.01 && apexY > springY) {
    const headTop = Math.min(apexY, faceTop)
    const steps = 5
    const dy = (apexY - springY) / steps
    for (let s = 0; s < steps; s++) {
      const yy0 = springY + dy * s
      if (yy0 >= headTop - 0.01) break
      const yy1 = Math.min(yy0 + dy, headTop)
      const t = (s + 0.5) / steps
      const half = (openW / 2) * (1 - t)
      const sideW = faceW / 2 - half
      if (sideW > 0.02) {
        faceBox(parts, axis, fixed, u0 - (half + sideW / 2), yy0, yy1, sideW, thick, toneFn())
        faceBox(parts, axis, fixed, u0 + (half + sideW / 2), yy0, yy1, sideW, thick, toneFn())
      }
    }
    if (faceTop > apexY + 0.01) faceBox(parts, axis, fixed, u0, apexY, faceTop, faceW, thick, toneFn())
  }
}

/** Protruding cornice / string-course ring around a square tower. */
function addRing(parts: StonePart[], y: number, hw: number, hex: number): void {
  const L = 2 * hw + 0.34
  const s = 0.18
  pushBox(parts, L, s, s, 0, y, +hw, hex)
  pushBox(parts, L, s, s, 0, y, -hw, hex)
  pushBox(parts, s, s, L, +hw, y, 0, hex)
  pushBox(parts, s, s, L, -hw, y, 0, hex)
}

/** Turned bronze bell (Lathe shell + crown loop), baked as one geometry. */
function bellGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const profile = [
    new THREE.Vector2(0.001, 0.0),
    new THREE.Vector2(0.32, 0.0),
    new THREE.Vector2(0.34, 0.06),
    new THREE.Vector2(0.30, 0.18),
    new THREE.Vector2(0.24, 0.32),
    new THREE.Vector2(0.18, 0.44),
    new THREE.Vector2(0.14, 0.52),
    new THREE.Vector2(0.13, 0.56),
    new THREE.Vector2(0.07, 0.57),
    new THREE.Vector2(0.05, 0.57),
  ]
  const bell = new THREE.LatheGeometry(profile, 16)
  parts.push({ geo: bell, hex: PALETTE.brass })
  const crown = new THREE.TorusGeometry(0.05, 0.02, 4, 8)
  crown.rotateX(Math.PI / 2)
  crown.translate(0, 0.6, 0)
  parts.push({ geo: crown, hex: PALETTE.brass })
  return bakeAndMerge(parts, 0.32)
}

// ---------------------------------------------------------------------------
// Farm ruin
// ---------------------------------------------------------------------------

/** Broken farmhouse walls ~6x8m: coursed masonry, punched openings, quoins. */
export function buildRuin(rand: () => number): THREE.Group {
  const g = new THREE.Group()
  const w = 6, d = 8
  const wallH = 2.6
  const wallT = 0.28
  const brick = PALETTE.bone
  const burnt = PALETTE.mud
  const timber = PALETTE.woodDark
  const plaster = PALETTE.canvas
  const tone = () => (rand() < 0.78 ? brick : burnt)

  const parts: StonePart[] = []
  const char: THREE.Vector3[] = []
  const rubbleBases: THREE.Vector3[] = []

  const buildWall = (axis: 'x' | 'z', fixed: number, length: number, interiorSign: number, door: boolean) => {
    const bays = axis === 'x' ? 6 : 8
    const bw = length / bays
    const doorBay = door ? 2 + Math.floor(rand() * (bays - 4)) : -1
    let winBay = 1 + Math.floor(rand() * (bays - 2))
    if (winBay === doorBay) winBay = (winBay + 1) % bays

    const put = (u: number, y0: number, y1: number, uw: number, t: number, hex: number, tOff = 0) => {
      const h = y1 - y0
      let geo: THREE.BufferGeometry
      if (axis === 'x') {
        geo = new THREE.BoxGeometry(uw, h, t)
        geo.translate(u, (y0 + y1) / 2, fixed + tOff)
      } else {
        geo = new THREE.BoxGeometry(t, h, uw)
        geo.translate(fixed + tOff, (y0 + y1) / 2, u)
      }
      parts.push({ geo, hex })
    }
    const worldOf = (u: number, y: number) =>
      axis === 'x' ? new THREE.Vector3(u, y, fixed) : new THREE.Vector3(fixed, y, u)

    for (let i = 0; i < bays; i++) {
      const u = -length / 2 + bw * (i + 0.5)

      if (i !== doorBay && i !== winBay && rand() < 0.16) {
        // collapsed bay — a low ragged stub and a rubble spill marker
        const stubH = 0.25 + rand() * 0.55
        put(u, 0, stubH, bw * 0.98, wallT, tone())
        rubbleBases.push(worldOf(u, 0))
        continue
      }

      if (i === doorBay) {
        put(u, 1.95, 2.13, bw * 1.06, wallT * 1.1, timber) // lintel beam
        const topH = wallH * (0.55 + rand() * 0.35)
        if (topH > 2.33) put(u, 2.13, topH, bw * 0.98, wallT, tone())
        char.push(worldOf(u, 1.0))
        continue
      }

      if (i === winBay) {
        const sillH = 0.85 + rand() * 0.15
        put(u, 0, sillH, bw * 0.98, wallT, tone())               // sill
        put(u, 1.6, 1.75, bw * 1.04, wallT * 1.05, timber)       // lintel
        const topH = wallH * (0.6 + rand() * 0.35)
        if (topH > 1.92) put(u, 1.75, topH, bw * 0.98, wallT, tone())
        char.push(worldOf(u, (sillH + 1.6) / 2))
        continue
      }

      // full bay + inner plaster skin + ragged stepped crest
      const bayH = wallH * (0.7 + rand() * 0.32)
      put(u, 0, bayH, bw * 0.98, wallT, tone())
      if (rand() < 0.6) {
        const pH = Math.min(bayH - 0.1, 1.1 + rand() * 0.5)
        put(u, 0.05, pH, bw * 0.86, 0.05, plaster, interiorSign * (wallT / 2))
      }
      const crestN = 2 + Math.floor(rand() * 2)
      const cw = bw / crestN
      for (let k = 0; k < crestN; k++) {
        if (rand() < 0.35) continue
        const ch = 0.12 + rand() * 0.28
        const cu = u - bw / 2 + cw * (k + 0.5)
        put(cu, bayH, bayH + ch, cw * 0.9, wallT * (0.8 + rand() * 0.3), tone())
      }
    }
  }

  buildWall('x', -d / 2, w, +1, false) // north
  buildWall('x', +d / 2, w, -1, true)  // south (door)
  buildWall('z', -w / 2, d, +1, false) // west
  buildWall('z', +w / 2, d, -1, false) // east

  // toothed corner quoins (alternating course sizes), lighter stone
  const corners: Array<[number, number]> = [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]
  for (const [qx, qz] of corners) {
    const qH = 1.6 + rand() * 0.8
    const courses = Math.max(3, Math.floor(qH / 0.34))
    for (let c = 0; c < courses; c++) {
      const s = c % 2 === 0 ? 0.42 : 0.34
      pushBox(parts, s, 0.32, s, qx * 0.98, 0.16 + c * 0.34, qz * 0.98, brick, { grime: 0.2 })
    }
  }

  // leaning broken roof-beam stubs off some wall tops
  for (let i = 0; i < 4; i++) {
    if (rand() < 0.4) continue
    const bx = (rand() - 0.5) * w * 0.7
    const bz = (rand() < 0.5 ? -1 : 1) * (d / 2 - 0.2)
    const len = 1.4 + rand() * 1.2
    const geo = new THREE.BoxGeometry(0.12, len, 0.12)
    geo.translate(0, len / 2, 0)
    geo.rotateX((bz < 0 ? 1 : -1) * (0.6 + rand() * 0.5))
    geo.rotateZ((rand() - 0.5) * 0.5)
    geo.translate(bx, 1.55 + rand() * 0.4, bz)
    parts.push({ geo, hex: timber, o: { band: 0, grime: 0.15 } })
  }

  g.add(mergeStone(parts, { yMin: 0, yMax: wallH, char, charR: 0.95, charStr: 0.7, courseH: 0.34 }))

  // low mud floor
  const floor = fm(new THREE.BoxGeometry(w - 0.1, 0.06, d - 0.1), mat.mud)
  floor.position.set(0, 0.03, 0)
  g.add(floor)

  // collapsed / tilted concrete floor slabs (one edge resting on the ground)
  for (let i = 0; i < 2; i++) {
    const sw = 1.4 + rand() * 1.0, sd = 1.2 + rand() * 1.0
    const sgeo = new THREE.BoxGeometry(sw, 0.12, sd)
    sgeo.rotateX((rand() - 0.5) * 0.4)
    sgeo.rotateY(rand() * Math.PI)
    sgeo.rotateZ((rand() - 0.5) * 0.4)
    settle(sgeo, 0.03)
    sgeo.translate((rand() - 0.5) * w * 0.4, 0, (rand() - 0.5) * d * 0.4)
    g.add(pm(sgeo, rand() < 0.5 ? PALETTE.steel : PALETTE.bone, 0.3))
  }

  // rubble spill at wall bases + interior
  const rubbleN = 3 + Math.floor(rand() * 2)
  for (let i = 0; i < rubbleN; i++) {
    const rub = wrapVC(rubbleGeometry(rand))
    if (i < rubbleBases.length && rand() < 0.7) {
      const b = rubbleBases[i]
      rub.position.set(b.x + (rand() - 0.5) * 0.4, 0, b.z + (rand() - 0.5) * 0.4)
    } else {
      rub.position.set((rand() - 0.5) * w * 0.7, 0, (rand() - 0.5) * d * 0.7)
    }
    rub.rotation.y = rand() * Math.PI * 2
    g.add(rub)
  }

  return g
}

// ---------------------------------------------------------------------------
// Church ruin (landmark)
// ---------------------------------------------------------------------------

/** Landmark broken church tower ~11m with belfry, buttresses, fallen bell & nave. */
export function buildChurchRuin(rand: () => number): THREE.Group {
  const g = new THREE.Group()
  const hw = 1.7        // tower half-width (3.4m square)
  const thick = 0.34
  const stone = PALETTE.bone
  const st = () => (rand() < 0.8 ? stone : PALETTE.mud)

  const parts: StonePart[] = []
  const char: THREE.Vector3[] = []

  const faces: Array<{ axis: 'x' | 'z'; fixed: number }> = [
    { axis: 'x', fixed: +hw }, { axis: 'x', fixed: -hw },
    { axis: 'z', fixed: +hw }, { axis: 'z', fixed: -hw },
  ]

  // Stage A — tall gothic lancet on every face
  for (const f of faces) archFace(parts, f.axis, f.fixed, 0, 2 * hw, thick, 0, 4.0, 1.2, 1.2, 2.7, 3.8, st)
  // Stage B — smaller pointed window
  for (const f of faces) archFace(parts, f.axis, f.fixed, 0, 2 * hw, thick, 4.0, 6.9, 0.9, 4.7, 5.7, 6.6, st)

  // Belfry — corner piers + big open louvre arches on all faces
  const belY0 = 6.9, belY1 = 9.5
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    pushBox(parts, 0.5, belY1 - belY0 + 0.3, 0.5, sx * (hw - 0.05), (belY0 + belY1) / 2, sz * (hw - 0.05), st())
  }
  for (const f of faces) archFace(parts, f.axis, f.fixed, 0, 2 * hw - 1.0, thick, belY0, belY1, 1.6, belY0 + 0.25, belY0 + 1.3, belY1, st)

  // cornice string-courses
  addRing(parts, 4.0, hw, stone)
  addRing(parts, 6.9, hw, stone)
  addRing(parts, belY1, hw, stone)

  // stepped corner buttresses (set in twice up the height)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    pushBox(parts, 0.7, 2.0, 0.7, sx * (hw + 0.12), 1.0, sz * (hw + 0.12), stone)
    pushBox(parts, 0.55, 1.5, 0.55, sx * (hw + 0.04), 2.75, sz * (hw + 0.04), stone)
    pushBox(parts, 0.4, 1.1, 0.4, sx * (hw - 0.02), 4.05, sz * (hw - 0.02), stone)
  }

  // jagged shattered top — angled shards, not neat cubes
  const shardN = 6 + Math.floor(rand() * 3)
  for (let i = 0; i < shardN; i++) {
    const sw = 0.35 + rand() * 0.55
    const sh = 0.5 + rand() * 1.3
    const geo = new THREE.BoxGeometry(sw, sh, sw * (0.7 + rand() * 0.5))
    geo.rotateX((rand() - 0.5) * 0.7)
    geo.rotateZ((rand() - 0.5) * 0.7)
    const ang = rand() * Math.PI * 2
    const r = rand() * hw * 0.7
    geo.translate(Math.cos(ang) * r, belY1 + sh / 2 - 0.1, Math.sin(ang) * r)
    parts.push({ geo, hex: rand() < 0.65 ? stone : PALETTE.mud })
  }

  // soot the lancets & belfry
  for (const f of faces) {
    char.push(f.axis === 'x' ? new THREE.Vector3(0, 2.3, f.fixed) : new THREE.Vector3(f.fixed, 2.3, 0))
  }

  // Nave — two side walls of arched window bays running off the tower (+Z)
  const naveLen = 7.5, bays = 4, bw = naveLen / bays
  for (const sx of [-1, 1]) {
    for (let i = 0; i < bays; i++) {
      const zc = hw + bw * (i + 0.5)
      if (rand() < 0.18) {
        const stubH = 0.3 + rand() * 0.5
        pushBox(parts, thick, stubH, bw * 0.9, sx * hw, stubH / 2, zc, st())
        continue
      }
      const topH = 1.9 + rand() * 0.9
      archFace(parts, 'z', sx * hw, zc, bw * 0.94, thick, 0, topH, bw * 0.42, 0.6, 1.3, 2.2, st)
    }
  }

  // Gable end — partially standing, with a rose-window hole hint
  const gz = hw + naveLen
  const gW = 2 * hw
  pushBox(parts, gW, 2.2, thick, -0.1, 1.1, gz, st()) // slightly off-centre = partial collapse
  const apex = 4.1
  const gsteps = 5
  const gStanding = 4 // top course knocked off
  for (let s = 0; s < gStanding; s++) {
    const yy0 = 2.2 + (apex - 2.2) * (s / gsteps)
    const yy1 = 2.2 + (apex - 2.2) * ((s + 1) / gsteps)
    const wq = gW * (1 - (s + 0.5) / gsteps)
    pushBox(parts, wq, yy1 - yy0, thick, -0.1 * (1 - s / gsteps), (yy0 + yy1) / 2, gz, st())
  }
  // rose window: recessed dark disc + ring frame + cross tracery
  const roseY = 2.65
  const disc = new THREE.CylinderGeometry(0.5, 0.5, 0.06, 14)
  disc.rotateX(Math.PI / 2)
  disc.translate(0, roseY, gz - 0.06)
  parts.push({ geo: disc, hex: PALETTE.mud, o: { band: 0, grime: 0.1 } })
  const ring = new THREE.TorusGeometry(0.55, 0.09, 5, 14)
  ring.translate(0, roseY, gz)
  parts.push({ geo: ring, hex: stone, o: { band: 0 } })
  pushBox(parts, 1.02, 0.07, 0.08, 0, roseY, gz, stone, { band: 0 })
  pushBox(parts, 0.07, 1.02, 0.08, 0, roseY, gz, stone, { band: 0 })

  // fallen roof-truss timbers leaning across the nave (low end on the ground)
  for (let i = 0; i < 3; i++) {
    const zc = hw + 1.0 + rand() * (naveLen - 2)
    const geo = new THREE.BoxGeometry(2 * hw * 1.15, 0.14, 0.14)
    geo.rotateZ((rand() < 0.5 ? 1 : -1) * (0.4 + rand() * 0.35))
    geo.rotateY((rand() - 0.5) * 0.4)
    geo.translate((rand() - 0.5) * 0.6, 0, zc)
    settle(geo, 0.12)
    parts.push({ geo, hex: PALETTE.woodDark, o: { band: 0, grime: 0.15 } })
  }

  g.add(mergeStone(parts, { yMin: 0, yMax: belY1, char, charR: 1.1, charStr: 0.55, courseH: 0.36 }))

  // fallen bell at the tower foot, tipped on its side and resting on the ground
  const bgeo = bellGeometry()
  bgeo.rotateX(Math.PI * 0.46)
  bgeo.rotateZ(0.18)
  bgeo.rotateY(0.4)
  settle(bgeo, 0.02)
  bgeo.translate(hw + 0.7, 0, 0.8)
  g.add(wrapVC(bgeo))

  // graveyard-adjacent rubble + a couple of grave crosses
  for (let i = 0; i < 4; i++) {
    const rub = wrapVC(rubbleGeometry(rand))
    const ang = rand() * Math.PI * 2
    const r = 1.4 + rand() * 3
    rub.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r + 1.5)
    rub.rotation.y = rand() * Math.PI * 2
    g.add(rub)
  }
  for (let i = 0; i < 3; i++) {
    const cross = wrapVC(crossGraveGeometry())
    cross.position.set(-hw - 0.8 - rand() * 1.6, 0, hw + 1 + rand() * (naveLen - 1))
    cross.rotation.set((rand() - 0.5) * 0.2, rand() * 0.6, (rand() - 0.5) * 0.25)
    g.add(cross)
  }

  return g
}

// ---------------------------------------------------------------------------
// Dugout entrance
// ---------------------------------------------------------------------------

/** Timber-revetted dugout entrance ~3m: mound, corrugated roof, sandbags, sign. */
export function buildDugout(): THREE.Group {
  const g = new THREE.Group()
  const rand = localRand(0x0d090a7)
  const frameW = 1.6, frameH = 1.95, depth = 1.4
  const front = -depth * 0.3 // z of the doorway plane; entrance opens toward -Z
  const timber: ColoredPart[] = []

  // --- rounded, displaced earth mound over the shelter ---
  const mound = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2)
  mound.scale(1.7, 1.05, 1.45)
  {
    const pos = mound.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const n = hash3(x * 2.1, y * 2.1, z * 2.1) - 0.5
      pos.setXYZ(i, x * (1 + 0.09 * n), y * (1 + 0.05 * n), z * (1 + 0.09 * n))
    }
    pos.needsUpdate = true
    mound.computeVertexNormals()
  }
  mound.translate(0, 0, 0.55)
  g.add(stoneMesh(mound, PALETTE.mud, { band: 0, noise: 0.14, grime: 0.42, yMin: 0, yMax: 1.2 }))

  // --- corrugated-iron lean-to roof over the entrance ---
  // A porch awning: the high rear edge rests on the doorframe header and the
  // sheet slopes down and forward onto two support posts. Corrugations run
  // down-slope; a gentle mid-span sag dips between the two supported edges.
  const roofDepth = 1.15
  const roof = new THREE.BoxGeometry(frameW + 0.9, 0.05, roofDepth, 30, 1, 3)
  {
    const pos = roof.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const corr = 0.03 * Math.sin(x * 11)
      const sag = -0.04 * (1 - clamp01((z / (roofDepth / 2)) ** 2))
      pos.setXYZ(i, x, y + corr + sag, z)
    }
    pos.needsUpdate = true
    roof.computeVertexNormals()
  }
  roof.rotateX(-0.30)
  roof.translate(0, 1.93, -0.97) // rear edge rides the header (~y2.1,z-0.42); slopes forward to ~y1.76,z-1.52
  g.add(stoneMesh(roof, PALETTE.steelDark, { band: 0, noise: 0.2, grime: 0.25, yMin: 1.6, yMax: 2.2 }))

  // front support posts + a purlin under the sheet's low forward edge
  for (const s of [-1, 1]) {
    const leg = new THREE.BoxGeometry(0.12, 1.78, 0.12)
    leg.translate(s * 0.9, 0.89, -1.5)
    timber.push({ geo: leg, hex: PALETTE.woodDark })
  }
  const purlin = new THREE.BoxGeometry(2.0, 0.12, 0.12)
  purlin.translate(0, 1.72, -1.5)
  timber.push({ geo: purlin, hex: PALETTE.wood })

  // --- doorway frame ---
  for (const s of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.16, frameH, 0.16)
    post.translate(s * frameW / 2, frameH / 2, front)
    timber.push({ geo: post, hex: PALETTE.woodDark })
  }
  const lintel = new THREE.BoxGeometry(frameW + 0.34, 0.2, 0.2)
  lintel.translate(0, frameH + 0.02, front)
  timber.push({ geo: lintel, hex: PALETTE.woodDark })
  const header = new THREE.BoxGeometry(frameW + 0.5, 0.12, 0.14)
  header.translate(0, frameH + 0.2, front - 0.02)
  timber.push({ geo: header, hex: PALETTE.wood })

  // --- plank revetment walls flanking the entrance (alternating tones) ---
  for (const s of [-1, 1]) {
    const planks = 6
    const pw = 0.14
    for (let i = 0; i < planks; i++) {
      const plank = new THREE.BoxGeometry(pw, frameH * 0.95, 0.06)
      plank.rotateZ((rand() - 0.5) * 0.05)
      plank.translate(s * (frameW / 2 + 0.12 + i * pw * 1.02), frameH * 0.48, front + 0.02)
      timber.push({ geo: plank, hex: i % 2 === 0 ? PALETTE.wood : PALETTE.woodDark })
    }
    const wale = new THREE.BoxGeometry(pw * 6.4, 0.1, 0.08)
    wale.translate(s * (frameW / 2 + 0.12 + pw * 3), frameH * 0.7, front - 0.02)
    timber.push({ geo: wale, hex: PALETTE.woodDark })
  }

  // --- hessian curtain hint hanging in the doorway ---
  const curtain = new THREE.BoxGeometry(frameW * 0.86, 1.15, 0.04, 5, 4, 1)
  {
    const pos = curtain.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      pos.setZ(i, z + 0.05 * Math.sin(x * 7) + 0.03 * Math.sin(y * 5))
    }
    pos.needsUpdate = true
    curtain.computeVertexNormals()
  }
  curtain.translate(0, frameH - 0.02 - 1.15 / 2, front + 0.09)
  timber.push({ geo: curtain, hex: PALETTE.woodDark })

  // --- painted sign board over the lintel ---
  const board = new THREE.BoxGeometry(1.0, 0.28, 0.04)
  board.rotateZ(0.04)
  board.translate(-0.1, frameH + 0.34, front - 0.05)
  timber.push({ geo: board, hex: PALETTE.wood })
  const paint = new THREE.BoxGeometry(0.86, 0.18, 0.02)
  paint.rotateZ(0.04)
  paint.translate(-0.1, frameH + 0.34, front - 0.08)
  timber.push({ geo: paint, hex: PALETTE.bone })
  for (let i = 0; i < 3; i++) {
    const ltr = new THREE.BoxGeometry(0.06, 0.1, 0.02)
    ltr.translate(-0.35 + i * 0.22, frameH + 0.34, front - 0.1)
    timber.push({ geo: ltr, hex: PALETTE.steelDark })
  }

  // --- steps receding into the shelter (solid risers, grounded, not floating) ---
  for (let i = 0; i < 4; i++) {
    const t = i / 4
    const sw = frameW * (1 - t * 0.12)
    const treadTop = Math.max(0.1, frameH * 0.42 - t * 1.0)
    const step = new THREE.BoxGeometry(sw, treadTop, 0.36)
    step.translate(0, treadTop / 2, front + 0.35 + t * 0.42)
    timber.push({ geo: step, hex: PALETTE.steelDark })
  }

  // --- a couple of ammo boxes stacked by the entrance ---
  for (let i = 0; i < 2; i++) {
    const box = new THREE.BoxGeometry(0.5, 0.28, 0.32)
    box.rotateY((rand() - 0.5) * 0.6)
    box.translate(-frameW / 2 - 0.55 + i * 0.06, 0.14 + i * 0.28, front - 0.7)
    timber.push({ geo: box, hex: i % 2 ? PALETTE.woodDark : PALETTE.wood })
  }

  g.add(wrapVC(bakeAndMerge(timber, 0.32)))

  // --- sandbag stacks flanking the entrance (staggered courses) ---
  const bagGeos: THREE.BufferGeometry[] = []
  for (const s of [-1, 1]) {
    const bx = s * (frameW / 2 + 0.55)
    // Bags are low, settled sacks (~0.16 crown) — courses nest, not hover.
    const courses = [{ y: 0, n: 3, off: 0 }, { y: 0.15, n: 2, off: 0.26 }, { y: 0.3, n: 1, off: 0 }]
    for (const c of courses) {
      for (let k = 0; k < c.n; k++) {
        const bag = sandbagGeometry()
        const zc = front - 0.35 + (k - (c.n - 1) / 2) * 0.52 + c.off
        bag.translate(bx, c.y, zc)
        bagGeos.push(bag)
      }
    }
  }
  const bags = mergeGeometries(bagGeos, false)
  if (bags) {
    bags.computeBoundingSphere()
    g.add(wrapVC(bags))
  }

  // --- rusted brazier drum by the entrance ---
  const braz: ColoredPart[] = []
  const drum = new THREE.CylinderGeometry(0.24, 0.26, 0.6, 12)
  drum.translate(0, 0.3, 0)
  braz.push({ geo: drum, hex: PALETTE.rust })
  const rim = new THREE.TorusGeometry(0.24, 0.03, 4, 12)
  rim.rotateX(Math.PI / 2)
  rim.translate(0, 0.6, 0)
  braz.push({ geo: rim, hex: PALETTE.steelDark })
  const coals = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 10)
  coals.translate(0, 0.58, 0)
  braz.push({ geo: coals, hex: PALETTE.mud })
  const brazMesh = wrapVC(bakeAndMerge(braz, 0.3))
  brazMesh.position.set(frameW / 2 + 0.7, 0, front - 0.8)
  g.add(brazMesh)

  return g
}

// ---------------------------------------------------------------------------
// Ammunition crates
// ---------------------------------------------------------------------------

/** Loose pile of ammunition crates: rope handles, stencils, an open lid, a tarp. */
export function buildAmmoBoxes(rand: () => number): THREE.Group {
  const g = new THREE.Group()
  const parts: ColoredPart[] = []
  const tones = [PALETTE.woodDark, PALETTE.feldgrau, PALETTE.wood]

  interface Crate { px: number; pz: number; baseY: number; w: number; h: number; dd: number; rotY: number; hex: number }
  const crates: Crate[] = []
  const n = 5 + Math.floor(rand() * 2)
  for (let i = 0; i < n; i++) {
    const w = 0.42 + rand() * 0.12, h = 0.24 + rand() * 0.05, dd = 0.3 + rand() * 0.07
    let px = (rand() - 0.5) * 0.85, pz = (rand() - 0.5) * 0.75, baseY = 0, rotY = (rand() - 0.5) * 1.0
    const hex = tones[Math.floor(rand() * tones.length)]
    if (i === 1 && crates.length) {
      const b = crates[0]
      px = b.px + (rand() - 0.5) * 0.06
      pz = b.pz + (rand() - 0.5) * 0.06
      baseY = b.baseY + b.h
      rotY = b.rotY + (rand() - 0.5) * 0.25
    } else if (i > 2 && rand() < 0.4 && crates.length) {
      const b = crates[Math.floor(rand() * crates.length)]
      px = b.px + (rand() - 0.5) * 0.1
      pz = b.pz + (rand() - 0.5) * 0.1
      baseY = b.baseY + b.h
    }
    crates.push({ px, pz, baseY, w, h, dd, rotY, hex })
  }

  const place = (geo: THREE.BufferGeometry, hex: number, c: Crate) => {
    geo.rotateY(c.rotY)
    geo.translate(c.px, c.baseY, c.pz)
    parts.push({ geo, hex })
  }

  crates.forEach((c, idx) => {
    const ajar = idx === 2
    const bodyH = ajar ? c.h - 0.04 : c.h
    const body = new THREE.BoxGeometry(c.w, bodyH, c.dd)
    body.translate(0, bodyH / 2, 0)
    place(body, c.hex, c)

    // steel corner reinforcements
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const strap = new THREE.BoxGeometry(0.03, c.h * 0.9, 0.03)
      strap.translate(sx * (c.w / 2 - 0.015), c.h * 0.45, sz * (c.dd / 2 - 0.015))
      place(strap, PALETTE.steelDark, c)
    }

    // rope handle loops at both ends
    for (const sx of [-1, 1]) {
      const handle = new THREE.TorusGeometry(0.07, 0.016, 4, 8, Math.PI)
      handle.rotateY(Math.PI / 2)
      handle.translate(sx * (c.w / 2 + 0.005), c.h * 0.62, 0)
      place(handle, PALETTE.canvas, c)
    }

    if (ajar) {
      // tilted-open lid, hinged at the back edge
      const lid = new THREE.BoxGeometry(c.w, 0.04, c.dd)
      lid.translate(0, 0.02, c.dd / 2)
      lid.rotateX(-0.85)
      lid.translate(0, c.h - 0.02, -c.dd / 2)
      place(lid, c.hex, c)
      // brass shell noses poking out
      for (let k = 0; k < 3; k++) {
        const sx = (k - 1) * 0.11
        const shell = new THREE.CylinderGeometry(0.03, 0.032, 0.16, 6)
        shell.translate(sx, c.h + 0.02, 0)
        place(shell, PALETTE.brass, c)
        const tip = new THREE.ConeGeometry(0.03, 0.06, 6)
        tip.translate(sx, c.h + 0.13, 0)
        place(tip, PALETTE.brass, c)
      }
    } else {
      // closed lid + pale stencil band
      const lid = new THREE.BoxGeometry(c.w * 1.02, 0.04, c.dd * 1.02)
      lid.translate(0, c.h + 0.02, 0)
      place(lid, PALETTE.woodDark, c)
      const stencil = new THREE.BoxGeometry(c.w * 0.5, 0.012, c.dd * 0.66)
      stencil.translate(0, c.h + 0.045, 0)
      place(stencil, PALETTE.bone, c)
    }
  })

  // tarpaulin thrown over the stacked pair
  if (crates.length > 1) {
    const b = crates[1]
    const tw = b.w * 1.25, td = b.dd * 1.25
    const tarp = new THREE.BoxGeometry(tw, 0.05, td, 6, 1, 6)
    const pos = tarp.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const edge = Math.max(Math.abs(x) / (tw / 2), Math.abs(z) / (td / 2))
      const drop = -0.18 * edge * edge
      const sag = 0.03 * Math.sin(x * 9) + 0.02 * Math.sin(z * 9)
      pos.setXYZ(i, x, y + drop + sag, z)
    }
    pos.needsUpdate = true
    tarp.computeVertexNormals()
    tarp.rotateY(b.rotY + 0.2)
    tarp.translate(b.px + 0.02, b.baseY + b.h + 0.03, b.pz + 0.02)
    parts.push({ geo: tarp, hex: PALETTE.canvas })
  }

  g.add(wrapVC(bakeAndMerge(parts, 0.3)))
  return g
}
