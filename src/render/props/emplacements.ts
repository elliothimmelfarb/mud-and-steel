/**
 * Emplaced weapons & trench kit — the crewed guns the player builds, plus the
 * small kit props (periscope, stretcher). Complex builds returning
 * THREE.Group over the shared material set. Meshes named 'barrel'/'lamp' are
 * looked up by the renderer for recoil/aiming/light effects — keep the names.
 *
 * Style: everything is built from many small indexed primitives collected into
 * a ColoredPart[] and flattened with bakeAndMerge → ONE vertex-colored mesh per
 * static assembly (free per-vertex grime, one draw call). The recoiling/aiming
 * parts (`barrel`, `lamp`) are baked into their OWN mesh so the engine can find
 * and move them. No ExtrudeGeometry: it is non-indexed and cannot merge with
 * the indexed primitives, which would silently drop the whole model.
 *
 * Sim/world convention: x west→east, z north→south, y up. Forward is -Z.
 */

import * as THREE from 'three'
import { PALETTE, bakeAndMerge, wrapVC, xf, type ColoredPart } from './shared'
import { sandbagGeometry } from './groundcover'

// ---------------------------------------------------------------------------
// Muted 1916 hues (any hex is legal — bakeAndMerge darkens toward the ground).
// ---------------------------------------------------------------------------
const OLIVE = 0x555a46 // British field-gun drab
const OLIVE_D = 0x3d4234
const STEEL = PALETTE.steel
const STEEL_D = PALETTE.steelDark
const IRON = 0x2c3033
const RUST = PALETTE.rust
const WOOD = PALETTE.wood
const WOOD_D = PALETTE.woodDark
const BRASS = PALETTE.brass
const CANVAS = PALETTE.canvas
const MUD = PALETTE.mud
const WICKER = 0x9a7c4c
const LEATHER = 0x4a3320
const GLASS = 0x93a8a6 // pale reflector tint
const SANDBAG = PALETTE.sandbag

// ---------------------------------------------------------------------------
// Primitive-push helpers — each appends one baked-color part. All primitives
// are indexed and carry position/normal/uv, so they merge cleanly.
// ---------------------------------------------------------------------------
type Parts = ColoredPart[]
const _up = /*@__PURE__*/ new THREE.Vector3(0, 1, 0)

function pBox(P: Parts, hex: number, w: number, h: number, d: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
  const g = new THREE.BoxGeometry(w, h, d)
  xf(g, x, y, z, rx, ry, rz)
  P.push({ geo: g, hex })
}

function pCyl(P: Parts, hex: number, rt: number, rb: number, h: number, seg: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, open = false): void {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open)
  xf(g, x, y, z, rx, ry, rz)
  P.push({ geo: g, hex })
}

function pCone(P: Parts, hex: number, r: number, h: number, seg: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
  const g = new THREE.ConeGeometry(r, h, seg)
  xf(g, x, y, z, rx, ry, rz)
  P.push({ geo: g, hex })
}

function pTorus(P: Parts, hex: number, r: number, t: number, radial: number, tub: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, arc = Math.PI * 2): void {
  const g = new THREE.TorusGeometry(r, t, radial, tub, arc)
  xf(g, x, y, z, rx, ry, rz)
  P.push({ geo: g, hex })
}

function pSphere(P: Parts, hex: number, r: number, wseg: number, hseg: number,
  x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0): void {
  const g = new THREE.SphereGeometry(r, wseg, hseg)
  xf(g, x, y, z, rx, ry, rz, sx, sy, sz)
  P.push({ geo: g, hex })
}

/** Round strut between two points (legs, poles, trails). */
function pStrut(P: Parts, hex: number, ax: number, ay: number, az: number,
  bx: number, by: number, bz: number, r: number, seg = 6): void {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az)
  const len = dir.length()
  if (len < 1e-5) return
  dir.multiplyScalar(1 / len)
  const g = new THREE.CylinderGeometry(r, r, len, seg)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, dir))
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
  P.push({ geo: g, hex })
}

/** Rectangular-section strut between two points (girder trail, frame rails). */
function pBoxStrut(P: Parts, hex: number, ax: number, ay: number, az: number,
  bx: number, by: number, bz: number, w: number, h: number): void {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az)
  const len = dir.length()
  if (len < 1e-5) return
  dir.multiplyScalar(1 / len)
  const g = new THREE.BoxGeometry(w, len, h)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, dir))
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
  P.push({ geo: g, hex })
}

/** A row of small rivet/bolt heads between two points. */
function pRivets(P: Parts, hex: number, ax: number, ay: number, az: number,
  bx: number, by: number, bz: number, n: number, r = 0.011): void {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1)
    pSphere(P, hex, r, 4, 3, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t)
  }
}

/** Small spoked handwheel/traverse wheel whose disc-normal points along `axis`. */
function pHandwheel(P: Parts, cx: number, cy: number, cz: number, R: number,
  axis: 'x' | 'y' | 'z', hex = IRON): void {
  const tmp: Parts = []
  pTorus(tmp, hex, R, Math.max(0.008, R * 0.16), 4, 12)
  pCyl(tmp, hex, R * 0.22, R * 0.22, R * 0.5, 6, 0, 0, 0, Math.PI / 2, 0, 0)
  for (let k = 0; k < 4; k++) {
    const s = new THREE.BoxGeometry(R * 1.7, R * 0.11, R * 0.05)
    s.rotateZ((k / 4) * Math.PI)
    tmp.push({ geo: s, hex })
  }
  pCyl(tmp, hex, R * 0.09, R * 0.09, R * 0.4, 5, R * 0.92, 0, 0, Math.PI / 2, 0, 0)
  const ry = axis === 'x' ? Math.PI / 2 : 0
  const rx = axis === 'y' ? Math.PI / 2 : 0
  for (const p of tmp) {
    if (rx) p.geo.rotateX(rx)
    if (ry) p.geo.rotateY(ry)
    p.geo.translate(cx, cy, cz)
    P.push(p)
  }
}

/** A short length of threaded rod (elevating screw): rod + a few thread rings. */
function pScrew(P: Parts, hex: number, ax: number, ay: number, az: number,
  bx: number, by: number, bz: number, r: number): void {
  pStrut(P, hex, ax, ay, az, bx, by, bz, r, 6)
  const n = 6
  for (let i = 1; i < n; i++) {
    const t = i / n
    pTorus(P, hex, r * 1.35, r * 0.35, 3, 8,
      ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, Math.PI / 2, 0, 0)
  }
}

/** Big artillery wheel (12–14 spokes, steel tyre, wood felloe, hub cap), spins about X. */
function pArtilleryWheel(P: Parts, cx: number, cy: number, cz: number, R: number,
  faceSign: number, spokes = 13): void {
  const tmp: Parts = []
  pTorus(tmp, STEEL_D, R, R * 0.055, 5, 22) // steel tyre
  pTorus(tmp, WOOD_D, R * 0.9, R * 0.07, 5, 20) // wooden felloe
  pCyl(tmp, STEEL_D, R * 0.2, R * 0.2, R * 0.34, 8, 0, 0, 0, Math.PI / 2, 0, 0) // hub barrel
  pCyl(tmp, IRON, R * 0.13, R * 0.15, R * 0.14, 8, 0, 0, faceSign * R * 0.2, Math.PI / 2, 0, 0) // hub cap
  pSphere(tmp, STEEL, R * 0.07, 5, 4, 0, 0, faceSign * R * 0.28) // hub nut
  for (let k = 0; k < spokes; k++) {
    const s = new THREE.BoxGeometry(R * 0.05, R * 0.72, R * 0.05)
    s.translate(0, R * 0.55, 0)
    s.rotateZ((k / spokes) * Math.PI * 2)
    tmp.push({ geo: s, hex: WOOD_D })
  }
  for (const p of tmp) {
    p.geo.rotateY(Math.PI / 2)
    p.geo.translate(cx, cy, cz)
    P.push(p)
  }
}

/** Finish a static assembly: bake parts into one grounded vertex-colored mesh. */
function bakedMesh(parts: Parts, darken = 0.3): THREE.Mesh {
  return wrapVC(bakeAndMerge(parts, darken))
}

// ---------------------------------------------------------------------------
// Ordnance QF 18-pounder field gun
// ---------------------------------------------------------------------------
export function buildFieldGun(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []

  const wheelR = 0.62
  const axleY = 0.62
  const axleZ = 0.12
  const boreY = 0.82

  // ---- gun shield: lower plate + two upper wings framing an open barrel slot,
  //      plus a folded-back top flap with a sighting port bracket.
  const shieldZ = -0.5
  const st = 0.05 // plate thickness
  pBox(P, OLIVE, 1.54, 0.42, st, 0, 0.44, shieldZ) // lower plate
  pBox(P, OLIVE, 0.62, 0.52, st, -0.46, 0.9, shieldZ) // left wing
  pBox(P, OLIVE, 0.62, 0.52, st, 0.46, 0.9, shieldZ) // right wing
  pBox(P, OLIVE_D, 0.16, 0.52, st * 0.7, 0, 0.9, shieldZ - 0.01) // slot backing strip
  // folded-back top flap, hinged on the upper edge and leaning over the crew
  const flap = new THREE.BoxGeometry(1.5, 0.38, 0.035)
  flap.translate(0, 0.19, 0)
  flap.rotateX(0.72)
  flap.translate(0, 1.15, shieldZ + 0.01)
  P.push({ geo: flap, hex: OLIVE_D })
  // sighting port + folding sight bracket on the left wing
  pBox(P, IRON, 0.11, 0.08, st * 1.6, -0.3, 1.06, shieldZ - 0.02)
  pBox(P, STEEL_D, 0.03, 0.16, 0.03, -0.3, 1.18, shieldZ - 0.04)
  pSphere(P, STEEL, 0.03, 5, 4, -0.3, 1.26, shieldZ - 0.04)
  // shield greebles: edge rivets + a couple of rust streaks (rust-hued bolts)
  pRivets(P, IRON, -0.74, 0.26, shieldZ + 0.01, -0.74, 1.14, shieldZ + 0.01, 7)
  pRivets(P, IRON, 0.74, 0.26, shieldZ + 0.01, 0.74, 1.14, shieldZ + 0.01, 7)
  pRivets(P, RUST, -0.7, 0.28, shieldZ + 0.02, 0.7, 0.28, shieldZ + 0.02, 9)

  // ---- cradle / recuperator housing running above the recoiling tube
  pBox(P, STEEL_D, 0.2, 0.16, 1.0, 0, boreY - 0.03, -0.55) // cradle saddle
  pCyl(P, STEEL, 0.09, 0.09, 1.3, 10, 0, boreY + 0.14, -0.6, Math.PI / 2, 0, 0) // recuperator
  pTorus(P, IRON, 0.09, 0.02, 4, 10, 0, boreY + 0.14, -1.22, Math.PI / 2, 0, 0) // front band
  pCyl(P, STEEL_D, 0.05, 0.05, 0.18, 6, 0, boreY + 0.14, 0.02, Math.PI / 2, 0, 0) // buffer cap
  pRivets(P, IRON, -0.05, boreY + 0.22, -1.0, -0.05, boreY + 0.22, -0.2, 5)

  // ---- breech block behind the shield, with a breech ring and lever handle
  pBox(P, IRON, 0.27, 0.34, 0.4, 0, boreY, 0.16)
  pTorus(P, STEEL_D, 0.13, 0.035, 5, 10, 0, boreY, -0.04, Math.PI / 2, 0, 0)
  pStrut(P, STEEL_D, 0.13, boreY + 0.02, 0.2, 0.34, boreY - 0.16, 0.34, 0.02) // lever
  pSphere(P, IRON, 0.045, 5, 4, 0.36, boreY - 0.18, 0.36)

  // ---- axle-tree with hub housings
  pCyl(P, IRON, 0.06, 0.06, 1.44, 8, 0, axleY, axleZ, 0, 0, Math.PI / 2)
  for (const s of [-1, 1]) pBox(P, STEEL_D, 0.16, 0.16, 0.16, s * 0.6, axleY, axleZ)

  // ---- axle-tree seats for the two layers, behind the shield
  for (const s of [-1, 1]) {
    pSphere(P, STEEL_D, 0.14, 6, 4, s * 0.5, 0.72, 0.4, 1, 0.4, 1) // dished pan
    pBox(P, STEEL_D, 0.16, 0.2, 0.03, s * 0.5, 0.82, 0.52) // back rest
    pStrut(P, IRON, s * 0.5, axleY, axleZ, s * 0.5, 0.72, 0.4, 0.022) // bracket
  }

  // ---- elevation handwheel on the left of the cradle
  pHandwheel(P, -0.42, 0.62, 0.05, 0.16, 'x')
  pStrut(P, IRON, -0.32, 0.62, 0.05, -0.14, boreY - 0.02, -0.2, 0.02)

  // ---- SINGLE pole (box-girder) trail to a spade + towing eye
  pBoxStrut(P, OLIVE_D, 0, 0.5, 0.32, 0, 0.06, 2.7, 0.17, 0.19)
  pBoxStrut(P, WOOD_D, 0, 0.52, 0.34, 0, 0.09, 2.55, 0.1, 0.06) // top rib
  pRivets(P, IRON, 0, 0.4, 0.5, 0, 0.12, 2.5, 7)
  pBox(P, IRON, 0.34, 0.3, 0.06, 0, 0.15, 2.78, 0.5) // spade blade (bites the earth)
  pTorus(P, STEEL_D, 0.07, 0.022, 4, 10, 0, 0.3, 2.86) // towing eye (vertical ring)
  for (const s of [-1, 1]) pStrut(P, WOOD_D, s * 0.09, 0.34, 2.35, s * 0.16, 0.42, 2.2, 0.02) // handspikes

  // ---- wicker shell basket + brass shell noses beside the trail
  pCyl(P, WICKER, 0.2, 0.22, 0.42, 10, 0.62, 0.21, 1.7, 0, 0, 0, true)
  pTorus(P, WOOD_D, 0.2, 0.02, 4, 12, 0.62, 0.42, 1.7, Math.PI / 2, 0, 0)
  pTorus(P, WOOD_D, 0.21, 0.02, 4, 12, 0.62, 0.06, 1.7, Math.PI / 2, 0, 0)
  const noses: Array<[number, number]> = [[0.55, 1.62], [0.68, 1.66], [0.6, 1.78], [0.72, 1.74]]
  for (const [nx, nz] of noses) {
    pCyl(P, BRASS, 0.045, 0.048, 0.34, 8, nx, 0.38, nz)
    pCone(P, BRASS, 0.045, 0.09, 8, nx, 0.59, nz)
  }

  g.add(bakedMesh(P, 0.32))

  // ---- wheels (baked separately so the tyre/felloe tones stay crisp)
  const wp: Parts = []
  pArtilleryWheel(wp, -0.72, wheelR, axleZ, wheelR, -1)
  pArtilleryWheel(wp, 0.72, wheelR, axleZ, wheelR, 1)
  g.add(bakedMesh(wp, 0.34))

  // ---- recoiling gun tube (named 'barrel'): built centered on its bore axis
  g.add(buildGunTube())

  return g
}

/** The 18-pdr recoiling tube, centred on origin, muzzle toward -Z. */
function buildGunTube(): THREE.Mesh {
  const P: Parts = []
  pCyl(P, STEEL, 0.058, 0.07, 2.5, 12, 0, 0, 0, Math.PI / 2, 0, 0) // tube (taper to muzzle)
  pCyl(P, STEEL_D, 0.078, 0.078, 0.14, 12, 0, 0, -1.2, Math.PI / 2, 0, 0) // muzzle swell
  pTorus(P, IRON, 0.06, 0.012, 4, 10, 0, 0, -1.25, Math.PI / 2, 0, 0) // muzzle face
  pCyl(P, IRON, 0.092, 0.092, 0.18, 12, 0, 0, 1.14, Math.PI / 2, 0, 0) // breech collar
  pTorus(P, STEEL_D, 0.078, 0.012, 4, 10, 0, 0, 0.5, Math.PI / 2, 0, 0) // reinforce band
  const barrel = wrapVC(bakeAndMerge(P, 0.12))
  barrel.name = 'barrel'
  barrel.position.set(0, 0.82, -0.7)
  return barrel
}

// ---------------------------------------------------------------------------
// Vickers .303 medium machine gun
// ---------------------------------------------------------------------------
export function buildVickers(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []
  const boreY = 0.8

  // ---- tripod: two front legs + one rear leg, clamps, traversing arc
  const head = new THREE.Vector3(0, 0.56, 0.08)
  const feet: Array<[number, number, number]> = [
    [-0.34, 0, -0.34], [0.34, 0, -0.34], [0, 0, 0.62],
  ]
  for (const [fx, fy, fz] of feet) {
    pStrut(P, STEEL_D, head.x, head.y, head.z, fx, fy, fz, 0.026, 6)
    pSphere(P, IRON, 0.05, 5, 4, fx, 0.02, fz, 1, 0.5, 1) // foot pad
    // leg clamp collar partway up
    pTorus(P, IRON, 0.045, 0.016, 4, 8,
      head.x + (fx - head.x) * 0.45, head.y + (fy - head.y) * 0.45, head.z + (fz - head.z) * 0.45,
      Math.PI / 2, 0, 0)
  }
  pCyl(P, IRON, 0.06, 0.07, 0.14, 8, head.x, head.y, head.z) // pintle head
  // traversing arc under the front of the gun (horizontal half-torus)
  pTorus(P, STEEL_D, 0.3, 0.02, 4, 14, 0, 0.5, -0.05, Math.PI / 2, 0, 0, Math.PI)
  pScrew(P, STEEL, 0, 0.5, 0.18, 0, 0.72, 0.14, 0.018) // elevating screw to body

  // ---- receiver / body on the pintle
  pBox(P, IRON, 0.16, 0.2, 0.42, 0, boreY - 0.04, 0.06)
  pBox(P, STEEL_D, 0.13, 0.13, 0.2, 0, boreY, -0.16) // trunnion block under jacket

  // ---- rear lock frame with twin spade grips + thumb trigger
  pBox(P, IRON, 0.2, 0.22, 0.06, 0, boreY, 0.26) // rear plate
  for (const s of [-1, 1]) {
    pStrut(P, IRON, s * 0.09, boreY - 0.06, 0.28, s * 0.11, boreY + 0.16, 0.34, 0.02) // grip
    pSphere(P, WOOD_D, 0.03, 5, 4, s * 0.11, boreY + 0.17, 0.35) // grip knob
  }
  pBox(P, STEEL, 0.1, 0.03, 0.03, 0, boreY + 0.05, 0.32) // thumb trigger bar

  // ---- condenser can at the right, hose actually connecting jacket → can
  pCyl(P, STEEL_D, 0.11, 0.11, 0.3, 10, 0.44, 0.16, 0.14)
  pCyl(P, IRON, 0.11, 0.09, 0.05, 10, 0.44, 0.33, 0.14) // lid
  pTorus(P, IRON, 0.05, 0.014, 4, 8, 0.44, 0.36, 0.14, Math.PI / 2, 0, 0) // filler ring
  pTube(P, STEEL_D, [
    new THREE.Vector3(0.06, boreY - 0.05, -0.5),
    new THREE.Vector3(0.28, 0.55, -0.2),
    new THREE.Vector3(0.42, 0.4, 0.02),
    new THREE.Vector3(0.44, 0.35, 0.12),
  ], 0.016, 14, 5)

  // ---- ammo box at the right with a canvas belt feeding into the receiver
  pBox(P, STEEL_D, 0.34, 0.2, 0.24, 0.5, 0.1, -0.1)
  pBox(P, IRON, 0.34, 0.03, 0.24, 0.5, 0.21, -0.1) // lid
  pStrut(P, LEATHER, 0.5, 0.24, -0.1, 0.5, 0.32, -0.1, 0.015) // carry handle post
  pTorus(P, LEATHER, 0.04, 0.012, 3, 8, 0.5, 0.33, -0.1)
  // belt: a sagging canvas strip climbing from the box to the feed block
  pTube(P, CANVAS, [
    new THREE.Vector3(0.4, 0.22, -0.12),
    new THREE.Vector3(0.28, 0.34, -0.06),
    new THREE.Vector3(0.14, boreY - 0.02, 0.0),
    new THREE.Vector3(0.06, boreY, -0.04),
  ], 0.02, 14, 4)

  g.add(bakedMesh(P, 0.3))

  // ---- fluted water-jacket barrel (named 'barrel'), centred on its bore
  g.add(buildWaterJacket())

  return g
}

/** Vickers water jacket: fat fluted cylinder + rib rings + muzzle cup, centred, muzzle -Z. */
function buildWaterJacket(): THREE.Mesh {
  const P: Parts = []
  pCyl(P, STEEL, 0.078, 0.078, 0.7, 12, 0, 0, 0, Math.PI / 2, 0, 0) // jacket body
  // corrugated cooling ribs along the jacket
  for (let i = 0; i < 7; i++) {
    pTorus(P, STEEL_D, 0.082, 0.014, 4, 12, 0, 0, -0.28 + i * 0.09, Math.PI / 2, 0, 0)
  }
  pCyl(P, STEEL_D, 0.06, 0.06, 0.12, 10, 0, 0, -0.4, Math.PI / 2, 0, 0) // muzzle cup neck
  pTorus(P, IRON, 0.055, 0.02, 4, 10, 0, 0, -0.46, Math.PI / 2, 0, 0) // muzzle cup mouth
  pCyl(P, IRON, 0.05, 0.05, 0.16, 8, 0, 0, 0.42, Math.PI / 2, 0, 0) // rear breech spigot
  pCyl(P, STEEL_D, 0.02, 0.02, 0.1, 5, 0.02, 0.09, -0.05, Math.PI / 2, 0, 0) // steam vent nub
  const barrel = wrapVC(bakeAndMerge(P, 0.16))
  barrel.name = 'barrel'
  barrel.position.set(0, 0.8, -0.34)
  return barrel
}

// ---------------------------------------------------------------------------
// 3-inch Stokes trench mortar
// ---------------------------------------------------------------------------
export function buildStokesMortar(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []

  // tube geometry (built vertical, base at y=0), placed with a forward lean
  const tilt = -0.22
  const socket = new THREE.Vector3(0, 0.09, 0.12)
  const dir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt)) // apply rotateX(tilt) to +Y
  const clampAt = new THREE.Vector3().copy(socket).addScaledVector(dir, 0.52)

  // ---- wedge base plate with socket lug
  pBox(P, IRON, 0.62, 0.05, 0.5, 0, 0.05, 0.14)
  pBox(P, STEEL_D, 0.5, 0.09, 0.4, 0, 0.06, 0.14, 0.12, 0, 0) // wedge ramp
  pCyl(P, IRON, 0.09, 0.1, 0.1, 10, socket.x, 0.1, socket.z, tilt, 0, 0) // socket lug cup
  pRivets(P, STEEL, -0.24, 0.08, 0.02, 0.24, 0.08, 0.02, 5)

  // ---- bipod: clamp collar on the tube, two legs, elevating screw + traverse wheel
  pTorus(P, IRON, 0.075, 0.02, 4, 10, clampAt.x, clampAt.y, clampAt.z, tilt + Math.PI / 2, 0, 0)
  const cross = new THREE.Vector3(0, clampAt.y - 0.06, clampAt.z - 0.28)
  const legFeet: Array<[number, number, number]> = [[-0.32, 0, -0.12], [0.32, 0, -0.12]]
  for (const [fx, fy, fz] of legFeet) {
    pStrut(P, STEEL_D, cross.x, cross.y, cross.z, fx, fy, fz, 0.026, 6)
    pSphere(P, IRON, 0.045, 5, 4, fx, 0.02, fz, 1, 0.5, 1)
  }
  pBox(P, IRON, 0.5, 0.05, 0.05, cross.x, cross.y, cross.z) // crosshead
  pScrew(P, STEEL, clampAt.x, clampAt.y - 0.02, clampAt.z - 0.02, cross.x, cross.y + 0.02, cross.z + 0.02, 0.018) // elevating screw
  pHandwheel(P, 0.28, cross.y, cross.z, 0.09, 'z') // traverse handwheel

  // ---- two bomb crates + a couple of cylindrical bombs beside
  pBox(P, WOOD, 0.42, 0.24, 0.3, 0.6, 0.12, 0.4)
  pBox(P, WOOD_D, 0.42, 0.22, 0.3, 0.56, 0.34, 0.42, 0, 0.2, 0) // stacked
  for (const cy of [0.12, 0.34]) {
    pBox(P, IRON, 0.44, 0.03, 0.06, 0.6, cy, 0.4) // crate strap
  }
  const bombs: Array<[number, number, number]> = [[-0.5, 0.07, 0.42], [-0.46, 0.07, 0.58]]
  for (const [bx, by, bz] of bombs) {
    pCyl(P, OLIVE_D, 0.06, 0.06, 0.24, 8, bx, by, bz, Math.PI / 2, 0, 0.15)
    pSphere(P, OLIVE_D, 0.06, 6, 5, bx + 0.02, by, bz - 0.13) // nose cap
    for (let k = 0; k < 4; k++) { // tail fins
      pBox(P, STEEL_D, 0.02, 0.06, 0.05, bx - 0.02, by, bz + 0.13, 0, 0, (k / 4) * Math.PI)
    }
  }

  g.add(bakedMesh(P, 0.3))

  // ---- firing tube (named 'barrel'), muzzle-forward with reinforcing band
  g.add(buildMortarTube(socket, dir, tilt))

  return g
}

function buildMortarTube(socket: THREE.Vector3, dir: THREE.Vector3, tilt: number): THREE.Mesh {
  const P: Parts = []
  const len = 1.3
  pCyl(P, STEEL, 0.056, 0.062, len, 10, 0, 0, 0) // tube (vertical, centred)
  pTorus(P, STEEL_D, 0.062, 0.016, 4, 10, 0, len * 0.42, 0) // muzzle reinforcing band
  pTorus(P, IRON, 0.06, 0.01, 4, 10, 0, len * 0.5, 0) // muzzle lip
  pSphere(P, IRON, 0.062, 8, 5, 0, -len * 0.5 + 0.02, 0) // base ball (sits in socket)
  const barrel = wrapVC(bakeAndMerge(P, 0.14))
  barrel.name = 'barrel'
  barrel.rotation.x = tilt
  const mid = new THREE.Vector3().copy(socket).addScaledVector(dir, len * 0.5)
  barrel.position.copy(mid)
  return barrel
}

// ---------------------------------------------------------------------------
// Livens gas projector battery
// ---------------------------------------------------------------------------
export function buildGasProjector(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []

  // ---- low noise-displaced earth berm the tubes are buried into
  const berm = new THREE.BoxGeometry(2.3, 0.34, 1.35, 12, 3, 6)
  const bp = berm.getAttribute('position')
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i)
    if (y > 0) { // only lift the top surface into a rounded, lumpy mound
      const dome = Math.cos((x / 1.15) * 1.4) * Math.cos((z / 0.68) * 1.4)
      const lump = 0.05 * Math.sin(x * 5.3 + z * 3.1) + 0.04 * Math.sin(x * 2.1 - z * 6.2)
      bp.setY(i, y + Math.max(0, dome) * 0.14 + lump)
    }
  }
  bp.needsUpdate = true
  berm.computeVertexNormals()
  berm.translate(0, 0.17, 0)
  P.push({ geo: berm, hex: MUD })

  // ---- timber frame rails the tubes rest on
  for (const z of [-0.34, 0.34]) {
    pBoxStrut(P, WOOD_D, -1.0, 0.28, z, 1.0, 0.28, z + 0.02, 0.08, 0.08)
  }
  for (const x of [-0.95, 0, 0.95]) pBox(P, WOOD_D, 0.08, 0.24, 0.86, x, 0.14, 0) // cross ties

  // ---- 6 tubes half-buried at varied angles/heights
  const tubeDefs: Array<[number, number, number, number]> = [
    // x,   z,    lean(x-rot from vertical), extra-height
    [-0.78, -0.18, 0.30, 0.02],
    [-0.36, 0.16, 0.20, -0.03],
    [0.04, -0.2, 0.42, 0.04],
    [0.06, 0.2, 0.26, 0.0],
    [0.7, -0.16, 0.34, 0.05],
    [0.8, 0.18, 0.16, -0.02],
  ]
  for (const [tx, tz, lean, dh] of tubeDefs) {
    const h = 0.95 + dh
    const t = new THREE.CylinderGeometry(0.088, 0.092, h, 10)
    t.translate(0, h / 2 - 0.28, 0) // bury the lower 0.28
    t.rotateX(-lean)
    t.rotateY(lean * 0.4)
    t.translate(tx, 0.25, tz)
    P.push({ geo: t, hex: IRON })
    // muzzle rim
    const rim = new THREE.TorusGeometry(0.088, 0.015, 4, 10)
    rim.rotateX(Math.PI / 2)
    rim.translate(0, h - 0.28, 0)
    rim.rotateX(-lean)
    rim.translate(tx, 0.25, tz)
    P.push({ geo: rim, hex: RUST })
  }

  // ---- gas drums + a crate alongside
  const drums: Array<[number, number]> = [[-1.4, -0.3], [-1.32, 0.2], [1.42, 0.0]]
  for (const [dx, dz] of drums) {
    pCyl(P, OLIVE_D, 0.16, 0.16, 0.44, 10, dx, 0.22, dz)
    pTorus(P, IRON, 0.16, 0.02, 4, 12, dx, 0.4, dz, Math.PI / 2, 0, 0)
    pTorus(P, IRON, 0.16, 0.02, 4, 12, dx, 0.06, dz, Math.PI / 2, 0, 0)
    pCyl(P, RUST, 0.04, 0.04, 0.03, 6, dx + 0.06, 0.44, dz) // bung
  }
  pBox(P, WOOD, 0.4, 0.26, 0.34, 1.4, 0.13, -0.4)
  pBox(P, IRON, 0.4, 0.03, 0.06, 1.4, 0.24, -0.4)

  g.add(bakedMesh(P, 0.34))
  return g
}

// ---------------------------------------------------------------------------
// Coastal / trench searchlight
// ---------------------------------------------------------------------------
export function buildSearchlight(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []
  const lampY = 1.2

  // ---- pedestal + base with a small handwheel each side
  pCyl(P, IRON, 0.28, 0.34, 0.1, 12, 0, 0.05, 0) // base foot
  pCyl(P, STEEL_D, 0.07, 0.08, 0.82, 8, 0, 0.5, 0) // post
  pHandwheel(P, -0.16, 0.5, 0, 0.11, 'x')
  pHandwheel(P, 0.16, 0.5, 0, 0.11, 'x')

  // ---- fork yoke with tilt pivot bosses
  pBox(P, STEEL_D, 0.16, 0.12, 0.16, 0, 0.9, 0) // yoke base
  for (const s of [-1, 1]) {
    pStrut(P, STEEL, 0, 0.94, s * 0.06, 0, lampY, s * 0.4, 0.03) // yoke arm
    pCyl(P, IRON, 0.06, 0.06, 0.08, 8, 0, lampY, s * 0.4, Math.PI / 2, 0, 0) // pivot boss
    pSphere(P, STEEL, 0.03, 5, 4, 0, lampY, s * 0.46)
  }

  // ---- cable (sagging tube) from the pedestal base to the generator
  pTube(P, IRON, [
    new THREE.Vector3(-0.2, 0.12, 0.08),
    new THREE.Vector3(-0.55, 0.05, 0.14),
    new THREE.Vector3(-0.85, 0.16, 0.1),
    new THREE.Vector3(-0.95, 0.34, 0.05),
  ], 0.02, 14, 5)

  // ---- generator box: louvres + filler cap + carry handles
  const gx = -1.12
  pBox(P, STEEL_D, 0.95, 0.62, 0.62, gx, 0.31, 0)
  pBox(P, IRON, 0.97, 0.05, 0.64, gx, 0.61, 0) // lid
  for (let i = 0; i < 4; i++) pBox(P, IRON, 0.03, 0.04, 0.5, gx + 0.48, 0.17 + i * 0.1, 0) // louvres
  pCyl(P, BRASS, 0.05, 0.05, 0.06, 8, gx - 0.2, 0.65, -0.16) // filler cap
  for (const s of [-1, 1]) { // carry handles on the ends
    pTorus(P, IRON, 0.07, 0.014, 3, 8, gx + s * 0.49, 0.47, 0, 0, Math.PI / 2, 0, Math.PI)
  }
  pRivets(P, IRON, gx - 0.46, 0.08, 0.32, gx + 0.46, 0.08, 0.32, 6)

  g.add(bakedMesh(P, 0.32))

  // ---- lamp drum (named 'lamp'), aims along +X; centred so it pivots cleanly
  g.add(buildLampDrum(lampY))

  return g
}

/** Searchlight drum: ribbed housing, rear door, top vent cowl, domed tinted glass. */
function buildLampDrum(lampY: number): THREE.Mesh {
  const P: Parts = []
  pCyl(P, STEEL, 0.38, 0.38, 0.5, 16, 0, 0, 0, 0, 0, Math.PI / 2) // drum body (axis X)
  for (const x of [-0.18, 0, 0.18]) pTorus(P, STEEL_D, 0.38, 0.02, 4, 16, x, 0, 0, 0, Math.PI / 2, 0) // rim ribs
  pTorus(P, IRON, 0.4, 0.03, 4, 16, -0.24, 0, 0, 0, Math.PI / 2, 0) // rear rim
  pBox(P, STEEL_D, 0.06, 0.22, 0.22, -0.27, 0, 0) // rear access door
  pTorus(P, IRON, 0.02, 0.01, 3, 6, -0.3, 0, 0.08, 0, Math.PI / 2, 0) // door hinge
  // top vent cowl (half cylinder over the crown)
  pCyl(P, STEEL_D, 0.1, 0.1, 0.34, 8, 0.0, 0.36, 0, 0, 0, Math.PI / 2, false)
  pCone(P, IRON, 0.12, 0.08, 8, 0.0, 0.46, 0) // vent cap
  // domed tinted glass face + pale inner reflector
  pSphere(P, GLASS, 0.36, 12, 6, 0.26, 0, 0, 0.4, 1, 1) // glass dome (+X)
  pCone(P, GLASS, 0.34, 0.3, 14, 0.1, 0, 0, 0, 0, -Math.PI / 2) // reflector cone inside
  pTorus(P, STEEL_D, 0.37, 0.03, 4, 16, 0.24, 0, 0, 0, Math.PI / 2, 0) // front bezel
  const lamp = wrapVC(bakeAndMerge(P, 0.14))
  lamp.name = 'lamp'
  lamp.position.set(0, lampY, 0)
  return lamp
}

// ---------------------------------------------------------------------------
// Flare / rocket post
// ---------------------------------------------------------------------------
export function buildFlarePost(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []

  // ---- stake + rocket magazine box with a sloped lid
  pBox(P, WOOD, 0.12, 1.0, 0.12, 0, 0.5, 0)
  pBox(P, WOOD_D, 0.44, 0.16, 0.34, 0, 0.98, 0) // magazine body
  pRivets(P, IRON, -0.2, 0.98, 0.17, 0.2, 0.98, 0.17, 4)
  // sloped lid, hinged at the back, propped open toward the rockets
  const lid = new THREE.BoxGeometry(0.44, 0.03, 0.34)
  lid.translate(0, 0, -0.17)
  lid.rotateX(-0.6)
  lid.translate(0, 1.08, 0.17)
  P.push({ geo: lid, hex: IRON })

  // ---- three rockets in tubes, angled, with a fin hint at each base
  for (let i = 0; i < 3; i++) {
    const rx = -0.13 + i * 0.13
    pCyl(P, STEEL_D, 0.032, 0.034, 0.16, 6, rx, 1.06, 0.02, -0.5, 0, 0) // launch tube
    pCyl(P, BRASS, 0.028, 0.028, 0.5, 6, rx + 0.06, 1.28, 0.14, -0.5, 0, 0) // rocket body
    pCone(P, BRASS, 0.028, 0.06, 6, rx + 0.11, 1.5, 0.24, -0.5, 0, 0) // rocket nose
    for (let k = 0; k < 3; k++) { // fin hint at the base
      pBox(P, STEEL_D, 0.015, 0.05, 0.03, rx + 0.02, 1.09, 0.06, -0.5, (k / 3) * Math.PI * 2, 0)
    }
  }

  g.add(bakedMesh(P, 0.28))

  // ---- ring of protecting sandbags (pre-baked geometry)
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

// ---------------------------------------------------------------------------
// Trench periscope
// ---------------------------------------------------------------------------
export function buildPeriscope(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []
  const shaftH = 1.28

  // ---- wooden shaft with metal ferrules
  pBox(P, WOOD_D, 0.055, shaftH, 0.055, 0, shaftH / 2, 0)
  pTorus(P, STEEL_D, 0.04, 0.012, 4, 8, 0, shaftH * 0.75, 0, Math.PI / 2, 0, 0)
  pTorus(P, STEEL_D, 0.04, 0.012, 4, 8, 0, shaftH * 0.28, 0, Math.PI / 2, 0, 0)

  // ---- top mirror box, angled to look forward (-Z) over the parapet
  pBox(P, STEEL, 0.11, 0.16, 0.11, 0, shaftH + 0.02, 0.0, 0.5, 0, 0)
  pBox(P, GLASS, 0.09, 0.1, 0.01, 0, shaftH + 0.06, -0.075, 0.5, 0, 0) // upper mirror glass
  // ---- bottom eyepiece box, angled the opposite way toward the viewer (+Z)
  pBox(P, STEEL, 0.1, 0.14, 0.1, 0, 0.12, 0.0, -0.5, 0, 0)
  pBox(P, GLASS, 0.08, 0.09, 0.01, 0, 0.15, 0.07, -0.5, 0, 0) // eyepiece glass
  pCyl(P, IRON, 0.03, 0.03, 0.05, 8, 0, 0.11, 0.11, Math.PI / 2, 0, 0) // eyecup

  // ---- leather strap grip across the shaft
  pTorus(P, LEATHER, 0.045, 0.016, 4, 10, 0, 0.5, 0, Math.PI / 2, 0, 0)
  pBox(P, LEATHER, 0.02, 0.14, 0.06, 0.05, 0.5, 0)

  g.add(bakedMesh(P, 0.26))
  return g
}

// ---------------------------------------------------------------------------
// Field stretcher
// ---------------------------------------------------------------------------
export function buildStretcher(): THREE.Group {
  const g = new THREE.Group()
  const P: Parts = []
  const poleLen = 2.1
  const poleY = 0.13
  const halfZ = 0.28

  // ---- two carrying poles with turned grips at each end
  for (const s of [-1, 1]) {
    pCyl(P, WOOD, 0.026, 0.026, poleLen, 8, 0, poleY, s * halfZ, 0, 0, Math.PI / 2)
    for (const x of [-poleLen / 2, poleLen / 2]) {
      pCyl(P, WOOD_D, 0.03, 0.024, 0.16, 8, x, poleY, s * halfZ, 0, 0, Math.PI / 2) // grip
      pSphere(P, WOOD_D, 0.03, 6, 4, x + Math.sign(x) * 0.09, poleY, s * halfZ) // end knob
    }
    // stubby feet that hold it off the mud
    for (const x of [-0.55, 0.55]) pBox(P, STEEL_D, 0.04, 0.09, 0.05, x, poleY - 0.09, s * halfZ)
  }

  // ---- canvas bed with a real sag between the poles (displaced plane)
  const cw = poleLen * 0.8
  const cvs = new THREE.PlaneGeometry(cw, halfZ * 1.9, 10, 4)
  cvs.rotateX(-Math.PI / 2) // lie flat in XZ
  const cp = cvs.getAttribute('position')
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i), z = cp.getZ(i)
    const sagX = Math.max(0, 1 - (x / (cw / 2)) ** 2)
    const sagZ = Math.max(0, 1 - (z / halfZ) ** 2)
    cp.setY(i, poleY + 0.02 - 0.055 * sagX * sagZ)
  }
  cp.needsUpdate = true
  cvs.computeVertexNormals()
  P.push({ geo: cvs, hex: CANVAS })

  // ---- fold hinges at the pole midpoints + leather straps across the canvas
  for (const s of [-1, 1]) {
    pBox(P, IRON, 0.05, 0.04, 0.07, 0, poleY, s * halfZ)
    pCyl(P, STEEL, 0.012, 0.012, 0.1, 6, 0, poleY + 0.02, s * halfZ, Math.PI / 2, 0, 0)
  }
  for (const sx of [-0.55, 0, 0.55]) {
    pBox(P, LEATHER, 0.05, 0.012, halfZ * 1.8, sx, poleY + 0.005, 0)
    pSphere(P, BRASS, 0.014, 4, 3, sx, poleY + 0.01, 0) // buckle
  }

  g.add(bakedMesh(P, 0.24))
  return g
}

/** Low-segment tube along a Catmull-Rom curve (hoses, cables, ammo belts). */
function pTube(P: Parts, hex: number, pts: THREE.Vector3[], r: number,
  tubular = 12, radial = 5): void {
  const curve = new THREE.CatmullRomCurve3(pts)
  const g = new THREE.TubeGeometry(curve, tubular, r, radial, false)
  P.push({ geo: g, hex })
}
