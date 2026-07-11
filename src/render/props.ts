/**
 * MUD & STEEL — procedural props.
 *
 * Everything here is generated geometry, no external assets. Two families:
 *
 *  - "Instancing geometries" (deadTreeGeometry, wirePostGeometry, ...) return a single
 *    merged THREE.BufferGeometry with a baked per-vertex 'color' attribute (lower/inner
 *    faces darkened for a grounded look). The caller instances these with ONE shared
 *    MeshStandardMaterial({ vertexColors: true }).
 *
 *  - "Complex builds" (buildRuin, buildFieldGun, ...) return a THREE.Group of meshes
 *    using a small set of module-cached materials (≤8 total). Some parts reuse the
 *    same baked-vertex-color trick (via the shared `vc` material) so multi-tone detail
 *    doesn't require extra material instances.
 *
 * Sim/world convention: x west→east, z north→south, y up. Forward for built groups is -Z.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const PALETTE: Record<string, number> = {
  mud: 0x4a3c2a,
  wood: 0x8a6a45,
  woodDark: 0x5b4530,
  steel: 0x6b7278,
  steelDark: 0x3c4247,
  rust: 0x8a4a2c,
  canvas: 0xab9a74,
  khaki: 0x8d8058,
  feldgrau: 0x4d5a44,
  bone: 0xe6dcc2,
  brass: 0xad8a3e,
  sandbag: 0x9c8a5e,
}

// ---------------------------------------------------------------------------
// Small local deterministic PRNG for functions that receive no `rand` param.
// (props.ts may only import 'three' + BufferGeometryUtils, so core/rng.ts is
// not available here — this is a self-contained duplicate of the same
// mulberry32 algorithm used elsewhere in the project.)
// ---------------------------------------------------------------------------

function localRand(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Vertex-color baking helpers
// ---------------------------------------------------------------------------

const _col = new THREE.Color()

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Bake a flat color onto every vertex of `geo`, darkened toward yMin (grounded look). */
function paintPart(
  geo: THREE.BufferGeometry,
  hex: number,
  yMin: number,
  yMax: number,
  darken = 0.28,
): THREE.BufferGeometry {
  const pos = geo.getAttribute('position')
  const count = pos.count
  const span = Math.max(1e-4, yMax - yMin)
  _col.setHex(hex)
  const r = _col.r, g = _col.g, b = _col.b
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i)
    const t = 1 - clamp01((y - yMin) / span)
    const shade = 1 - darken * t
    arr[i * 3 + 0] = r * shade
    arr[i * 3 + 1] = g * shade
    arr[i * 3 + 2] = b * shade
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

/** Apply scale → rotateX → rotateY → rotateZ → translate to `geo`, in place. */
function xf(
  geo: THREE.BufferGeometry,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.BufferGeometry {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz)
  if (rx !== 0) geo.rotateX(rx)
  if (ry !== 0) geo.rotateY(ry)
  if (rz !== 0) geo.rotateZ(rz)
  if (x !== 0 || y !== 0 || z !== 0) geo.translate(x, y, z)
  return geo
}

interface ColoredPart { geo: THREE.BufferGeometry; hex: number }

/** Bake per-part colors (using the assembly's global Y range) and merge into one geometry. */
function bakeAndMerge(parts: ColoredPart[], darken = 0.28): THREE.BufferGeometry {
  let yMin = Infinity
  let yMax = -Infinity
  for (const p of parts) {
    p.geo.computeBoundingBox()
    const bb = p.geo.boundingBox
    if (bb) {
      if (bb.min.y < yMin) yMin = bb.min.y
      if (bb.max.y > yMax) yMax = bb.max.y
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 1 }
  for (const p of parts) paintPart(p.geo, p.hex, yMin, yMax, darken)
  const merged = mergeGeometries(parts.map(p => p.geo), false)
  const result = merged ?? new THREE.BufferGeometry()
  result.computeBoundingSphere()
  return result
}

// ---------------------------------------------------------------------------
// Shared materials for complex builds (≤8 total, module-cached)
// ---------------------------------------------------------------------------

const mat = {
  wood: new THREE.MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.9, metalness: 0 }),
  woodDark: new THREE.MeshStandardMaterial({ color: PALETTE.woodDark, roughness: 0.95, metalness: 0 }),
  steel: new THREE.MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.55, metalness: 0.4 }),
  steelDark: new THREE.MeshStandardMaterial({ color: PALETTE.steelDark, roughness: 0.6, metalness: 0.4 }),
  cloth: new THREE.MeshStandardMaterial({ color: PALETTE.canvas, roughness: 0.95, metalness: 0 }),
  brass: new THREE.MeshStandardMaterial({ color: PALETTE.brass, roughness: 0.4, metalness: 0.6 }),
  mud: new THREE.MeshStandardMaterial({ color: PALETTE.mud, roughness: 1, metalness: 0 }),
  /** Generic baked-vertex-color material — lets a build use any palette hue without
   *  spending a new material slot; see `pm`/`wrapVC`. */
  vc: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.2 }),
}

/** Flat cached-material mesh, shadows on. */
function fm(geo: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): THREE.Mesh {
  const m = new THREE.Mesh(geo, material)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** Wrap an already vertex-colored geometry (e.g. from an instancing-geometry helper). */
function wrapVC(geo: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat.vc)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** Paint a fresh geometry uniformly (own bounding box, ground-darkened) and wrap with `vc`. */
function pm(geo: THREE.BufferGeometry, hex: number, darken = 0.25): THREE.Mesh {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const yMin = bb ? bb.min.y : 0
  const yMax = bb ? bb.max.y : 1
  paintPart(geo, hex, yMin, yMax, darken)
  return wrapVC(geo)
}

// ---------------------------------------------------------------------------
// Instancing geometries
// ---------------------------------------------------------------------------

/** 4-7m shattered trunk with a jagged broken top and a few stub branches. */
export function deadTreeGeometry(rand: () => number): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const totalH = 4 + rand() * 3
  const segCount = 3
  let curR = 0.2 + rand() * 0.08
  let curX = 0, curH = 0, curZ = 0
  let tiltX = 0, tiltZ = 0
  const hue = PALETTE.woodDark

  for (let i = 0; i < segCount; i++) {
    const segH = (totalH / segCount) * (0.8 + rand() * 0.4)
    const nextR = curR * (0.55 + rand() * 0.15)
    tiltX += (rand() - 0.5) * 0.3
    tiltZ += (rand() - 0.5) * 0.3
    const geo = new THREE.CylinderGeometry(nextR, curR, segH, 6, 1)
    geo.translate(0, segH / 2, 0)
    xf(geo, curX, curH, curZ, tiltX, 0, tiltZ)
    parts.push({ geo, hex: hue })
    curX += -Math.sin(tiltZ) * segH
    curZ += Math.sin(tiltX) * segH
    curH += Math.cos(tiltX) * Math.cos(tiltZ) * segH
    curR = nextR
  }

  const shardH = 0.5 + rand() * 0.4
  const shardGeo = new THREE.ConeGeometry(curR * 1.3, shardH, 5)
  shardGeo.translate(0, shardH / 2, 0)
  xf(shardGeo, curX, curH, curZ, tiltX + (rand() - 0.5) * 0.6, 0, tiltZ + (rand() - 0.5) * 0.6)
  parts.push({ geo: shardGeo, hex: hue })

  const branchCount = 2 + Math.floor(rand() * 3)
  for (let i = 0; i < branchCount; i++) {
    const bh = totalH * (0.3 + rand() * 0.55)
    const blen = 0.5 + rand() * 1.3
    const br = curR * (0.3 + rand() * 0.3) + 0.02
    const bgeo = new THREE.CylinderGeometry(br * 0.4, br, blen, 5, 1, true)
    bgeo.translate(0, blen / 2, 0)
    bgeo.rotateX(0.3 + rand() * 0.9)
    bgeo.rotateY(rand() * Math.PI * 2)
    bgeo.translate(0, bh, 0)
    parts.push({ geo: bgeo, hex: hue })
  }

  return bakeAndMerge(parts, 0.32)
}

/** 1.2m screw picket with auger threads near the base and a wire eyelet at the top. */
export function wirePostGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const h = 1.2
  const post = new THREE.CylinderGeometry(0.028, 0.032, h, 5, 1)
  post.translate(0, h / 2, 0)
  parts.push({ geo: post, hex: PALETTE.steelDark })

  for (let i = 0; i < 3; i++) {
    const ring = new THREE.TorusGeometry(0.09 - i * 0.012, 0.012, 3, 6)
    ring.rotateX(Math.PI / 2)
    ring.translate(0, 0.06 + i * 0.09, 0)
    parts.push({ geo: ring, hex: PALETTE.rust })
  }

  const eyelet = new THREE.TorusGeometry(0.05, 0.012, 3, 6)
  eyelet.rotateY(Math.PI / 2)
  eyelet.translate(0, h - 0.05, 0)
  parts.push({ geo: eyelet, hex: PALETTE.rust })

  return bakeAndMerge(parts, 0.25)
}

/** 6m-long, 0.8m-tall tangle: a few jittered helical tube strands, low poly. */
export function wireCoilGeometry(): THREE.BufferGeometry {
  const rand = localRand(0x9e3779b1)
  const parts: ColoredPart[] = []
  const strands = 4
  for (let s = 0; s < strands; s++) {
    const baseZ = (rand() - 0.5) * 0.5
    const baseY = 0.15 + rand() * 0.45
    const turns = 5 + Math.floor(rand() * 2)
    const segs = 10
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= segs; i++) {
      const t = i / segs
      const x = -3 + t * 6
      const ang = t * turns * Math.PI * 2
      const jitter = (rand() - 0.5) * 0.08
      const y = Math.max(0.04, baseY + Math.sin(ang) * 0.28 + jitter)
      const z = baseZ + Math.cos(ang) * 0.28 + jitter
      pts.push(new THREE.Vector3(x, y, z))
    }
    const curve = new THREE.CatmullRomCurve3(pts)
    const tubeGeo = new THREE.TubeGeometry(curve, 10, 0.02, 3, false)
    const hex = s % 2 === 0 ? PALETTE.rust : PALETTE.steelDark
    parts.push({ geo: tubeGeo, hex })
  }
  return bakeAndMerge(parts, 0.2)
}

/** A single plump sandbag ~0.5m across. */
export function sandbagGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.28, 8, 6)
  geo.scale(1.15, 0.62, 0.85)
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const bulge = 1 + 0.06 * Math.sin(x * 5 + z * 3)
    pos.setXYZ(i, x * bulge, y, z * bulge)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  geo.translate(0, 0.17, 0)
  return bakeAndMerge([{ geo, hex: PALETTE.sandbag }], 0.3)
}

/** Knife-rest obstacle: two timber X-frames joined by rails, ~1.8m span. */
export function tankTrapGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const legLen = 1.5
  const legR = 0.05
  const spanX = 1.8
  for (const x of [-spanX / 2, spanX / 2]) {
    for (const sign of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(legR, legR * 1.15, legLen, 5)
      leg.translate(0, legLen / 2, 0)
      leg.rotateX(sign * 0.55)
      leg.translate(x, 0, 0)
      parts.push({ geo: leg, hex: PALETTE.wood })
    }
  }
  for (const y of [0.85, 0.42]) {
    const rail = new THREE.CylinderGeometry(0.045, 0.045, spanX + 0.3, 5)
    rail.rotateZ(Math.PI / 2)
    rail.translate(0, y, 0)
    parts.push({ geo: rail, hex: PALETTE.woodDark })
  }
  return bakeAndMerge(parts, 0.28)
}

/** 2m plank walkway section over two runner beams. */
export function duckboardGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const length = 2, width = 0.7, plankCount = 7
  const plankW = width / plankCount
  const plankH = 0.04
  const runnerH = 0.05
  for (let i = 0; i < plankCount; i++) {
    const plank = new THREE.BoxGeometry(length, plankH, plankW * 0.86)
    const z = -width / 2 + plankW * (i + 0.5)
    plank.translate(0, runnerH + plankH / 2, z)
    parts.push({ geo: plank, hex: i % 2 === 0 ? PALETTE.wood : PALETTE.woodDark })
  }
  for (const x of [-length / 2 + 0.18, length / 2 - 0.18]) {
    const runner = new THREE.BoxGeometry(0.08, runnerH, width)
    runner.translate(x, runnerH / 2, 0)
    parts.push({ geo: runner, hex: PALETTE.woodDark })
  }
  return bakeAndMerge(parts, 0.3)
}

/** Simple wooden grave cross, ~0.9m. */
export function crossGraveGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const post = new THREE.BoxGeometry(0.08, 0.9, 0.06)
  post.translate(0, 0.45, 0)
  parts.push({ geo: post, hex: PALETTE.bone })
  const bar = new THREE.BoxGeometry(0.5, 0.07, 0.055)
  bar.translate(0, 0.68, 0)
  parts.push({ geo: bar, hex: PALETTE.bone })
  return bakeAndMerge(parts, 0.2)
}

/** Brick/beam debris pile, ~1.5m across. */
export function rubbleGeometry(rand: () => number): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const pieceCount = 9 + Math.floor(rand() * 5)
  for (let i = 0; i < pieceCount; i++) {
    const isBeam = rand() < 0.3
    let w: number, h: number, d: number, hex: number
    if (isBeam) {
      w = 0.5 + rand() * 0.9
      h = 0.09 + rand() * 0.04
      d = 0.09 + rand() * 0.04
      hex = PALETTE.woodDark
    } else {
      const s = 0.14 + rand() * 0.16
      w = s
      h = s * (0.6 + rand() * 0.4)
      d = s * (0.8 + rand() * 0.4)
      hex = rand() < 0.6 ? PALETTE.bone : PALETTE.rust
    }
    const geo = new THREE.BoxGeometry(w, h, d)
    const r = rand() * 0.6
    const ang = rand() * Math.PI * 2
    const x = Math.cos(ang) * r
    const z = Math.sin(ang) * r
    const y = (h / 2) * (0.4 + rand() * 0.6)
    geo.rotateY(rand() * Math.PI)
    geo.rotateX((rand() - 0.5) * 0.4)
    geo.rotateZ((rand() - 0.5) * 0.4)
    geo.translate(x, y, z)
    parts.push({ geo, hex })
  }
  return bakeAndMerge(parts, 0.32)
}

/** Simple leaning wooden stake/marker. */
export function stakeGeometry(): THREE.BufferGeometry {
  const h = 0.62
  const geo = new THREE.CylinderGeometry(0.018, 0.035, h, 5)
  geo.translate(0, h / 2, 0)
  geo.rotateZ(0.09)
  geo.rotateX(-0.05)
  return bakeAndMerge([{ geo, hex: PALETTE.wood }], 0.25)
}

// ---------------------------------------------------------------------------
// Complex builds
// ---------------------------------------------------------------------------

function buildSpokedWheel(radius: number): THREE.Group {
  const g = new THREE.Group()
  const rim = fm(new THREE.TorusGeometry(radius, radius * 0.12, 5, 12), mat.woodDark)
  g.add(rim)
  const hub = fm(new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, radius * 0.24, 6), mat.steelDark)
  hub.rotation.x = Math.PI / 2
  g.add(hub)
  const spokePairs = 3
  for (let i = 0; i < spokePairs; i++) {
    const a = (i / spokePairs) * Math.PI
    const spoke = fm(new THREE.BoxGeometry(radius * 1.85, radius * 0.07, radius * 0.05), mat.woodDark)
    spoke.rotation.z = a
    g.add(spoke)
  }
  return g
}

/** Broken farmhouse walls ~6x8m with window/door gaps. */
export function buildRuin(rand: () => number): THREE.Group {
  const g = new THREE.Group()
  const w = 6, d = 8
  const wallH = 2.6
  const wallT = 0.25
  const brick = PALETTE.bone
  const brickDark = PALETTE.mud

  const floor = fm(new THREE.BoxGeometry(w, 0.06, d), mat.mud)
  floor.position.set(0, 0.03, 0)
  g.add(floor)

  interface WallSpec { x: number; z: number; len: number; rotY: number }
  const walls: WallSpec[] = [
    { x: 0, z: -d / 2, len: w, rotY: 0 },
    { x: 0, z: d / 2, len: w, rotY: 0 },
    { x: -w / 2, z: 0, len: d, rotY: Math.PI / 2 },
    { x: w / 2, z: 0, len: d, rotY: Math.PI / 2 },
  ]
  for (const wall of walls) {
    const segCount = 3
    const segLen = wall.len / segCount
    for (let i = 0; i < segCount; i++) {
      if (rand() < 0.22) continue
      const h = wallH * (0.5 + rand() * 0.5)
      const segGeo = new THREE.BoxGeometry(segLen * 0.94, h, wallT)
      const localX = -wall.len / 2 + segLen * (i + 0.5)
      segGeo.translate(localX, h / 2, 0)
      segGeo.rotateY(wall.rotY)
      const mesh = pm(segGeo, rand() < 0.7 ? brick : brickDark, 0.25)
      mesh.position.set(wall.x, 0, wall.z)
      g.add(mesh)
    }
  }

  for (let i = 0; i < 3; i++) {
    const rub = wrapVC(rubbleGeometry(rand))
    rub.position.set((rand() - 0.5) * w * 0.8, 0, (rand() - 0.5) * d * 0.8)
    rub.rotation.y = rand() * Math.PI * 2
    g.add(rub)
  }

  return g
}

/** Landmark broken church tower ~12m plus a collapsed nave wall stub. */
export function buildChurchRuin(rand: () => number): THREE.Group {
  const g = new THREE.Group()
  const brick = PALETTE.bone
  const brickDark = PALETTE.mud
  const baseW = 3.4
  const towerH = 9 + rand() * 3

  const segCount = 4
  const segH = towerH / segCount
  for (let i = 0; i < segCount; i++) {
    const t = i / segCount
    const sw = baseW * (1 - t * 0.18)
    const isBellGap = i === segCount - 2
    const wallHex = rand() < 0.75 ? brick : brickDark
    if (isBellGap) {
      const pierS = sw * 0.22
      for (const cx of [-1, 1]) {
        for (const cz of [-1, 1]) {
          const pier = pm(new THREE.BoxGeometry(pierS, segH, pierS), wallHex, 0.2)
          pier.position.set(cx * (sw / 2 - pierS / 2), segH * (i + 0.5), cz * (sw / 2 - pierS / 2))
          g.add(pier)
        }
      }
    } else {
      const shaft = pm(new THREE.BoxGeometry(sw, segH * 0.98, sw), wallHex, 0.22)
      shaft.position.set(0, segH * (i + 0.5), 0)
      g.add(shaft)
    }
  }

  const topY = towerH
  const shardCount = 4 + Math.floor(rand() * 3)
  for (let i = 0; i < shardCount; i++) {
    const sw = 0.5 + rand() * 0.7
    const sh = 0.4 + rand() * 1.4
    const shard = pm(new THREE.BoxGeometry(sw, sh, sw), rand() < 0.7 ? brick : brickDark, 0.2)
    const ang = rand() * Math.PI * 2
    const r = rand() * baseW * 0.32
    shard.position.set(Math.cos(ang) * r, topY + sh / 2 - 0.2, Math.sin(ang) * r)
    shard.rotation.y = rand() * Math.PI
    g.add(shard)
  }

  const naveLen = 7 + rand() * 2
  const naveH = 2.2
  const segCount2 = 4
  for (const side of [-1, 1]) {
    for (let i = 0; i < segCount2; i++) {
      if (rand() < 0.3) continue
      const h = naveH * (0.4 + rand() * 0.6)
      const segLen = naveLen / segCount2
      const seg = pm(new THREE.BoxGeometry(segLen * 0.92, h, 0.3), rand() < 0.75 ? brick : brickDark, 0.25)
      seg.position.set(side * (baseW / 2 + 0.15), h / 2, baseW / 2 + segLen * (i + 0.5))
      g.add(seg)
    }
  }

  for (let i = 0; i < 4; i++) {
    const rub = wrapVC(rubbleGeometry(rand))
    const ang = rand() * Math.PI * 2
    const r = 1.5 + rand() * 3
    rub.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r + 1)
    rub.rotation.y = rand() * Math.PI * 2
    g.add(rub)
  }

  return g
}

/** 18-pdr field gun: shield, barrel, trail, two spoked wheels. */
export function buildFieldGun(): THREE.Group {
  const g = new THREE.Group()

  const shield = fm(new THREE.BoxGeometry(1.5, 1.0, 0.06), mat.steelDark)
  shield.position.set(0, 0.75, -0.5)
  shield.rotation.x = -0.08
  g.add(shield)

  const barrelGeo = new THREE.CylinderGeometry(0.055, 0.07, 2.6, 8)
  barrelGeo.rotateX(Math.PI / 2)
  const barrel = fm(barrelGeo, mat.steel)
  barrel.position.set(0, 0.85, -1.2)
  barrel.name = 'barrel'
  g.add(barrel)

  const breech = fm(new THREE.BoxGeometry(0.28, 0.3, 0.4), mat.steelDark)
  breech.position.set(0, 0.85, -0.15)
  g.add(breech)

  const axle = fm(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6), mat.steelDark)
  axle.rotation.z = Math.PI / 2
  axle.position.set(0, 0.55, 0.1)
  g.add(axle)

  for (const side of [-1, 1]) {
    const trail = fm(new THREE.BoxGeometry(0.12, 0.12, 2.2), mat.wood)
    trail.position.set(side * 0.18, 0.32, 1.4)
    trail.rotation.y = side * 0.05
    g.add(trail)
  }

  for (const side of [-1, 1]) {
    const wheel = buildSpokedWheel(0.55)
    wheel.position.set(side * 0.8, 0.55, 0.1)
    wheel.rotation.y = Math.PI / 2
    g.add(wheel)
  }

  return g
}

/** Vickers MG: tripod, water-jacket barrel, condenser can. */
export function buildVickers(): THREE.Group {
  const g = new THREE.Group()

  const legDefs: Array<[number, number]> = [[-0.28, 0.35], [0.28, 0.35], [0, -0.4]]
  for (const [x, z] of legDefs) {
    const leg = fm(new THREE.CylinderGeometry(0.025, 0.03, 0.78, 5), mat.steelDark)
    leg.position.set(x * 0.5, 0.38, z * 0.5)
    leg.rotation.x = z > 0 ? 0.35 : -0.15
    leg.rotation.z = -x * 0.5
    g.add(leg)
  }

  const cradle = fm(new THREE.BoxGeometry(0.22, 0.14, 0.3), mat.steelDark)
  cradle.position.set(0, 0.76, 0)
  g.add(cradle)

  const barrelGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.7, 8)
  barrelGeo.rotateX(Math.PI / 2)
  const barrel = fm(barrelGeo, mat.steel)
  barrel.position.set(0, 0.8, -0.55)
  barrel.name = 'barrel'
  g.add(barrel)

  const can = fm(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 6), mat.steelDark)
  can.position.set(0.28, 0.35, -0.15)
  g.add(can)

  const hoseGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.5, 4)
  hoseGeo.rotateZ(Math.PI / 2.3)
  const hose = fm(hoseGeo, mat.steelDark)
  hose.position.set(0.16, 0.55, -0.3)
  g.add(hose)

  const grip = fm(new THREE.BoxGeometry(0.06, 0.16, 0.03), mat.wood)
  grip.position.set(0, 0.7, 0.18)
  g.add(grip)

  return g
}

/** Stokes mortar: angled tube, bipod, base plate. */
export function buildStokesMortar(): THREE.Group {
  const g = new THREE.Group()

  const baseplate = fm(new THREE.CylinderGeometry(0.35, 0.38, 0.06, 8), mat.steelDark)
  baseplate.position.set(0, 0.03, 0.15)
  g.add(baseplate)

  const tubeGeo = new THREE.CylinderGeometry(0.055, 0.06, 1.3, 8)
  const tube = fm(tubeGeo, mat.steel)
  tube.position.set(0, 0.75, -0.1)
  tube.rotation.x = -0.25
  tube.name = 'barrel'
  g.add(tube)

  for (const side of [-1, 1]) {
    const leg = fm(new THREE.CylinderGeometry(0.03, 0.035, 0.85, 5), mat.steelDark)
    leg.position.set(side * 0.32, 0.42, 0.05)
    leg.rotation.z = side * 0.3
    leg.rotation.x = -0.15
    g.add(leg)
  }

  return g
}

/** Livens-style gas projector: rack of 6 angled tubes half-buried. */
export function buildGasProjector(): THREE.Group {
  const g = new THREE.Group()

  const earth = fm(new THREE.BoxGeometry(2.2, 0.2, 1.4), mat.mud)
  earth.position.set(0, 0.1, 0)
  g.add(earth)

  const rows = 2, cols = 3
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tube = fm(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 6), mat.steelDark)
      tube.position.set(-0.7 + c * 0.7, 0.55, -0.3 + r * 0.55)
      tube.rotation.x = -0.55
      g.add(tube)
    }
  }

  return g
}

/** Searchlight: drum lamp on a yoke mount, generator box alongside. */
export function buildSearchlight(): THREE.Group {
  const g = new THREE.Group()

  const genBox = fm(new THREE.BoxGeometry(0.9, 0.6, 0.6), mat.steelDark)
  genBox.position.set(-1.0, 0.3, 0)
  g.add(genBox)

  const mountPost = fm(new THREE.CylinderGeometry(0.05, 0.06, 1.1, 6), mat.steelDark)
  mountPost.position.set(0, 0.55, 0)
  g.add(mountPost)

  const yoke = fm(new THREE.BoxGeometry(0.5, 0.06, 0.06), mat.steel)
  yoke.position.set(0, 1.05, 0)
  g.add(yoke)

  const lampGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.4, 10)
  lampGeo.rotateZ(Math.PI / 2)
  const lamp = fm(lampGeo, mat.steel)
  lamp.position.set(0, 1.15, 0)
  lamp.name = 'lamp'
  g.add(lamp)

  const lens = fm(new THREE.CircleGeometry(0.28, 10), mat.brass)
  lens.rotation.y = Math.PI / 2
  lens.position.set(0.21, 1.15, 0)
  g.add(lens)

  return g
}

/** Flare post: small rocket rack on a stake, ringed by sandbags. */
export function buildFlarePost(): THREE.Group {
  const g = new THREE.Group()

  const postGeo = new THREE.BoxGeometry(0.12, 1.0, 0.12)
  postGeo.translate(0, 0.5, 0)
  g.add(fm(postGeo, mat.wood))

  const rackGeo = new THREE.BoxGeometry(0.4, 0.08, 0.3)
  rackGeo.translate(0, 0.95, 0)
  g.add(fm(rackGeo, mat.woodDark))

  for (let i = 0; i < 3; i++) {
    const tube = fm(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 5), mat.brass)
    tube.position.set(-0.12 + i * 0.12, 1.15, 0)
    tube.rotation.x = -0.5
    g.add(tube)
  }

  const ringCount = 8
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2
    const bag = wrapVC(sandbagGeometry())
    bag.position.set(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55)
    bag.rotation.y = a
    g.add(bag)
  }

  return g
}

/** A7V: 7.3m armoured box, riveted-seam plates, front 57mm gun, track skirts. */
export function buildTankA7V(): THREE.Group {
  const g = new THREE.Group()
  const hullHex = PALETTE.feldgrau

  const hull = pm(new THREE.BoxGeometry(3.0, 2.0, 7.3), hullHex, 0.3)
  hull.position.set(0, 1.3, 0)
  g.add(hull)

  for (const y of [0.7, 1.5]) {
    const seam = pm(new THREE.BoxGeometry(3.05, 0.05, 7.35), hullHex, 0.1)
    seam.position.set(0, 0.3 + y, 0)
    g.add(seam)
  }

  for (const side of [-1, 1]) {
    const skirt = fm(new THREE.BoxGeometry(0.4, 1.0, 7.3), mat.steelDark)
    skirt.position.set(side * 1.55, 0.5, 0)
    g.add(skirt)
  }

  const barrelGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.6, 8)
  barrelGeo.rotateX(Math.PI / 2)
  const barrel = fm(barrelGeo, mat.steel)
  barrel.position.set(0, 1.1, -4.1)
  barrel.name = 'barrel'
  g.add(barrel)

  const mantlet = fm(new THREE.BoxGeometry(0.7, 0.7, 0.3), mat.steelDark)
  mantlet.position.set(0, 1.1, -3.5)
  g.add(mantlet)

  const cupola = fm(new THREE.CylinderGeometry(0.35, 0.4, 0.4, 8), mat.steelDark)
  cupola.position.set(0, 2.5, 1.5)
  g.add(cupola)

  return g
}

/** Mk IV: 8m rhomboid hull with side sponsons and a track ridge line. */
export function buildTankMkIV(): THREE.Group {
  const g = new THREE.Group()
  const hullHex = PALETTE.khaki
  const bodyLen = 8, bodyH = 2.6, bodyW = 2.6

  const mid = pm(new THREE.BoxGeometry(bodyLen, bodyH * 0.5, bodyW), hullHex, 0.25)
  mid.position.set(0, 1.3, 0)
  g.add(mid)

  const topTaper = pm(new THREE.BoxGeometry(bodyLen * 0.7, bodyH * 0.35, bodyW * 0.8), hullHex, 0.2)
  topTaper.position.set(0, 1.3 + bodyH * 0.42, 0)
  g.add(topTaper)

  const trackFront = pm(new THREE.BoxGeometry(bodyH * 0.8, bodyH * 0.8, bodyW * 1.05), PALETTE.steelDark, 0.2)
  trackFront.position.set(bodyLen / 2 - 0.3, 1.0, 0)
  trackFront.rotation.z = Math.PI / 4
  g.add(trackFront)

  const trackRear = trackFront.clone()
  trackRear.position.set(-bodyLen / 2 + 0.3, 1.0, 0)
  g.add(trackRear)

  const ridge = fm(new THREE.BoxGeometry(bodyLen * 0.85, 0.15, 0.15), mat.steelDark)
  ridge.position.set(0, 2.15, bodyW / 2)
  g.add(ridge)
  const ridge2 = ridge.clone()
  ridge2.position.z = -bodyW / 2
  g.add(ridge2)

  for (const side of [-1, 1]) {
    const sponson = fm(new THREE.BoxGeometry(1.0, 1.0, 1.4), mat.steelDark)
    sponson.position.set(side * (bodyW / 2 + 0.4), 1.3, 0.3)
    g.add(sponson)

    const barrelGeo = new THREE.CylinderGeometry(0.06, 0.07, 1.2, 8)
    barrelGeo.rotateZ(Math.PI / 2)
    const barrel = fm(barrelGeo, mat.steel)
    barrel.position.set(side * (bodyW / 2 + 1.0), 1.3, 0.3)
    barrel.name = 'barrel'
    g.add(barrel)
  }

  return g
}

/** Turreted armoured car with four named wheels. */
export function buildArmoredCar(): THREE.Group {
  const g = new THREE.Group()
  const hullHex = PALETTE.khaki

  const body = pm(new THREE.BoxGeometry(1.7, 1.1, 3.6), hullHex, 0.25)
  body.position.set(0, 0.85, 0)
  g.add(body)

  const hood = pm(new THREE.BoxGeometry(1.4, 0.6, 1.1), hullHex, 0.2)
  hood.position.set(0, 0.55, -1.9)
  g.add(hood)

  const turret = fm(new THREE.CylinderGeometry(0.55, 0.6, 0.55, 8), mat.steelDark)
  turret.position.set(0, 1.7, 0.2)
  turret.name = 'turret'
  g.add(turret)

  const mgGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.6, 6)
  mgGeo.rotateX(Math.PI / 2)
  const mg = fm(mgGeo, mat.steel)
  mg.position.set(0, 0, -0.5)
  turret.add(mg)

  const wheelDefs: Array<[string, number, number]> = [
    ['wheel0', -0.85, -1.3], ['wheel1', 0.85, -1.3],
    ['wheel2', -0.85, 1.3], ['wheel3', 0.85, 1.3],
  ]
  for (const [name, x, z] of wheelDefs) {
    const wheel = buildSpokedWheel(0.42)
    wheel.position.set(x, 0.42, z)
    wheel.rotation.y = Math.PI / 2
    wheel.name = name
    g.add(wheel)
  }

  return g
}

/** ~7m wingspan two-decker with roundels (British) or crosses (German). */
export function buildBiplane(german: boolean): THREE.Group {
  const g = new THREE.Group()
  const bodyHex = german ? PALETTE.feldgrau : PALETTE.khaki

  const fuselage = pm(new THREE.BoxGeometry(0.55, 0.55, 4.2), bodyHex, 0.25)
  fuselage.position.set(0, 1.1, 0)
  g.add(fuselage)

  const wingSpan = 7
  const wingGeo = new THREE.BoxGeometry(wingSpan, 0.08, 0.9)
  for (const y of [1.35, 0.85]) {
    const wing = pm(wingGeo.clone(), bodyHex, 0.15)
    wing.position.set(0, y, -0.2)
    g.add(wing)
  }

  for (const side of [-1, 1]) {
    for (const zoff of [-0.35, 0.15]) {
      const strut = fm(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 4), mat.woodDark)
      strut.position.set(side * 2.6, 1.1, -0.2 + zoff)
      g.add(strut)
    }
  }

  const tail = pm(new THREE.BoxGeometry(1.8, 0.05, 0.6), bodyHex, 0.1)
  tail.position.set(0, 1.15, 1.95)
  g.add(tail)

  const fin = pm(new THREE.BoxGeometry(0.05, 0.5, 0.55), bodyHex, 0.1)
  fin.position.set(0, 1.4, 2.0)
  g.add(fin)

  const prop = fm(new THREE.BoxGeometry(0.09, 1.1, 0.03), mat.woodDark)
  prop.position.set(0, 1.1, -2.15)
  prop.name = 'prop'
  g.add(prop)

  const hub = fm(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 6), mat.brass)
  hub.rotation.x = Math.PI / 2
  hub.position.set(0, 1.1, -2.15)
  g.add(hub)

  for (const side of [-1, 1]) {
    if (german) {
      const cross1 = fm(new THREE.BoxGeometry(0.5, 0.02, 0.14), mat.steelDark)
      cross1.position.set(side * 2.2, 1.39, -0.2)
      g.add(cross1)
      const cross2 = fm(new THREE.BoxGeometry(0.14, 0.02, 0.5), mat.steelDark)
      cross2.position.set(side * 2.2, 1.39, -0.2)
      g.add(cross2)
    } else {
      const ring1 = fm(new THREE.CircleGeometry(0.32, 10), mat.steelDark)
      ring1.rotation.x = -Math.PI / 2
      ring1.position.set(side * 2.2, 1.39, -0.2)
      g.add(ring1)
      const ring2 = fm(new THREE.CircleGeometry(0.18, 10), mat.brass)
      ring2.rotation.x = -Math.PI / 2
      ring2.position.set(side * 2.2, 1.40, -0.2)
      g.add(ring2)
    }
  }

  return g
}

/** Low-poly cavalry horse, ~1.6m at the shoulder. */
export function buildHorse(): THREE.Group {
  const g = new THREE.Group()
  const coat = 0x5a4230
  const coatDark = 0x3a2b1e
  const hoofHex = 0x1c1712

  const body = pm(new THREE.SphereGeometry(0.4, 8, 6), coat, 0.25)
  body.scale.set(1.55, 0.85, 0.85)
  body.position.set(0, 1.05, 0)
  g.add(body)

  const neck = pm(new THREE.CylinderGeometry(0.16, 0.22, 0.75, 6), coat, 0.15)
  neck.position.set(0, 1.35, -0.55)
  neck.rotation.x = 0.9
  g.add(neck)

  const head = pm(new THREE.BoxGeometry(0.22, 0.28, 0.55), coatDark, 0.1)
  head.position.set(0, 1.62, -0.95)
  head.rotation.x = 0.35
  head.name = 'head'
  g.add(head)

  const earGeo = new THREE.ConeGeometry(0.045, 0.14, 4)
  for (const side of [-1, 1]) {
    const ear = pm(earGeo.clone(), coatDark, 0.1)
    ear.position.set(side * 0.08, 1.78, -0.85)
    g.add(ear)
  }

  const tail = pm(new THREE.ConeGeometry(0.08, 0.55, 5), coatDark, 0.2)
  tail.position.set(0, 0.95, 0.68)
  tail.rotation.x = Math.PI + 0.3
  g.add(tail)

  const legLen = 1.0
  const legDefs: Array<[string, number, number]> = [
    ['legFL', -0.18, -0.5], ['legFR', 0.18, -0.5],
    ['legBL', -0.18, 0.5], ['legBR', 0.18, 0.5],
  ]
  for (const [name, x, z] of legDefs) {
    const leg = new THREE.Group()
    leg.position.set(x, 1.05, z)
    leg.name = name

    const upperGeo = new THREE.CylinderGeometry(0.06, 0.05, legLen * 0.55, 5)
    upperGeo.translate(0, -legLen * 0.275, 0)
    leg.add(pm(upperGeo, coat, 0.3))

    const lowerGeo = new THREE.CylinderGeometry(0.045, 0.035, legLen * 0.45, 5)
    lowerGeo.translate(0, -legLen * 0.55 - legLen * 0.225, 0)
    leg.add(pm(lowerGeo, coatDark, 0.35))

    const hoofGeo = new THREE.BoxGeometry(0.09, 0.06, 0.11)
    hoofGeo.translate(0, -legLen * 0.55 - legLen * 0.45 + 0.03, 0.02)
    leg.add(pm(hoofGeo, hoofHex, 0.1))

    g.add(leg)
  }

  return g
}

/** Timber-framed dugout entrance ~2m with a stepped-down illusion. */
export function buildDugout(): THREE.Group {
  const g = new THREE.Group()
  const frameW = 1.6, frameH = 1.9, depth = 1.4

  const mound = fm(new THREE.BoxGeometry(3.2, 0.5, 2.2), mat.mud)
  mound.position.set(0, 0.25, 0.4)
  g.add(mound)

  for (const side of [-1, 1]) {
    const post = fm(new THREE.BoxGeometry(0.14, frameH, 0.14), mat.woodDark)
    post.position.set(side * frameW / 2, frameH / 2, -depth * 0.3)
    g.add(post)
  }

  const lintel = fm(new THREE.BoxGeometry(frameW + 0.2, 0.16, 0.16), mat.woodDark)
  lintel.position.set(0, frameH, -depth * 0.3)
  g.add(lintel)

  const roof = fm(new THREE.BoxGeometry(frameW + 0.3, 0.08, 1.0), mat.wood)
  roof.position.set(0, frameH + 0.15, -depth * 0.3 - 0.35)
  roof.rotation.x = -0.35
  g.add(roof)

  const stepCount = 4
  for (let i = 0; i < stepCount; i++) {
    const t = i / stepCount
    const stepW = frameW * (1 - t * 0.15)
    const step = fm(new THREE.BoxGeometry(stepW, 0.05, 0.35), mat.steelDark)
    step.position.set(0, frameH * 0.5 - t * 1.3, -depth * 0.3 + 0.2 + t * 0.9)
    g.add(step)
  }

  for (const side of [-1, 1]) {
    const bag = wrapVC(sandbagGeometry())
    bag.position.set(side * (frameW / 2 + 0.35), 0, -depth * 0.1)
    g.add(bag)
  }

  return g
}

/** Loose pile of ammunition crates. */
export function buildAmmoBoxes(rand: () => number): THREE.Group {
  const g = new THREE.Group()
  const count = 4 + Math.floor(rand() * 4)
  const placed: Array<{ x: number; z: number; h: number }> = []

  for (let i = 0; i < count; i++) {
    const w = 0.4 + rand() * 0.15
    const h = 0.22 + rand() * 0.06
    const d = 0.28 + rand() * 0.08

    let baseY = 0
    let px = (rand() - 0.5) * 0.6
    let pz = (rand() - 0.5) * 0.5
    if (i > 2 && rand() < 0.5 && placed.length > 0) {
      const under = placed[Math.floor(rand() * placed.length)]
      px = under.x + (rand() - 0.5) * 0.1
      pz = under.z + (rand() - 0.5) * 0.1
      baseY = under.h
    }

    const hex = rand() < 0.6 ? PALETTE.woodDark : PALETTE.steelDark
    const box = pm(new THREE.BoxGeometry(w, h, d), hex, 0.2)
    const rotY = rand() * Math.PI * 2
    box.position.set(px, baseY + h / 2, pz)
    box.rotation.y = rotY
    g.add(box)
    placed.push({ x: px, z: pz, h: baseY + h })

    if (rand() < 0.5) {
      const strap = fm(new THREE.BoxGeometry(w * 1.02, 0.03, d * 0.15), mat.brass)
      strap.position.set(px, baseY + h * 0.7, pz)
      strap.rotation.y = rotY
      g.add(strap)
    }
  }

  return g
}

/** Two poles with a canvas panel between them. */
export function buildStretcher(): THREE.Group {
  const g = new THREE.Group()
  const poleLen = 2.1

  for (const side of [-1, 1]) {
    const pole = fm(new THREE.CylinderGeometry(0.025, 0.025, poleLen, 6), mat.wood)
    pole.rotation.z = Math.PI / 2
    pole.position.set(0, 0.12, side * 0.28)
    g.add(pole)
  }

  const canvas = fm(new THREE.BoxGeometry(poleLen * 0.82, 0.02, 0.5), mat.cloth)
  canvas.position.set(0, 0.13, 0)
  g.add(canvas)

  for (const x of [-poleLen / 2, poleLen / 2]) {
    for (const side of [-1, 1]) {
      const cap = fm(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 5), mat.woodDark)
      cap.rotation.z = Math.PI / 2
      cap.position.set(x, 0.12, side * 0.28)
      g.add(cap)
    }
  }

  return g
}

/** Simple trench periscope: shaft, angled mirror head, grip. */
export function buildPeriscope(): THREE.Group {
  const g = new THREE.Group()

  const shaft = fm(new THREE.BoxGeometry(0.06, 1.3, 0.06), mat.steelDark)
  shaft.position.set(0, 0.65, 0)
  g.add(shaft)

  const topBox = fm(new THREE.BoxGeometry(0.12, 0.16, 0.09), mat.steel)
  topBox.position.set(0, 1.35, 0.015)
  topBox.rotation.x = 0.5
  g.add(topBox)

  const grip = fm(new THREE.BoxGeometry(0.14, 0.05, 0.05), mat.woodDark)
  grip.position.set(0, 0.45, 0)
  g.add(grip)

  return g
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/** Radial falloff white disc — for flares, muzzle flashes, soft blob sprites. */
export function makeSoftCircleTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.6, 'rgba(255,255,255,0.55)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

/** Tileable value-noise grayscale texture, for terrain detail blending. */
export function makeNoiseTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')

  const rand = localRand(0xc0ffee)
  const grid = 8
  const lattice: number[][] = []
  for (let i = 0; i <= grid; i++) {
    const row: number[] = []
    for (let j = 0; j <= grid; j++) row.push(rand())
    lattice.push(row)
  }
  for (let i = 0; i <= grid; i++) lattice[i][grid] = lattice[i][0]
  for (let j = 0; j <= grid; j++) lattice[grid][j] = lattice[0][j]

  const smooth = (t: number): number => t * t * (3 - 2 * t)
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * grid
    const iy = Math.floor(gy)
    const fy = smooth(gy - iy)
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * grid
      const ix = Math.floor(gx)
      const fx = smooth(gx - ix)
      const a = lattice[ix][iy]
      const b = lattice[ix + 1][iy]
      const c = lattice[ix][iy + 1]
      const d = lattice[ix + 1][iy + 1]
      const v = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
      const gray = Math.max(0, Math.min(255, Math.floor(v * 255)))
      const idx = (y * size + x) * 4
      img.data[idx] = gray
      img.data[idx + 1] = gray
      img.data[idx + 2] = gray
      img.data[idx + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  return tex
}
