/**
 * Shared infrastructure for the procedural prop builders: the palette, the
 * vertex-color baking helpers, the module-cached materials, and the canvas
 * textures. See props.ts (the barrel) for the family overview.
 *
 * Sim/world convention: x west→east, z north→south, y up. Forward for built
 * groups is -Z.
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
// (props modules may only import 'three' + BufferGeometryUtils, so core/rng.ts
// is not available here — this is a self-contained duplicate of the same
// mulberry32 algorithm used elsewhere in the project.)
// ---------------------------------------------------------------------------

export function localRand(seed: number): () => number {
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

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Cheap deterministic per-position hash in [0,1) (sin-fract). Feeds the
 *  per-vertex weathering / tonal breakup passes across the prop builders.
 *  (vehicles.ts keeps its own variant on purpose — see the note there.) */
export function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
  return s - Math.floor(s)
}

/** Bake a flat color onto every vertex of `geo`, darkened toward yMin (grounded look). */
export function paintPart(
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
export function xf(
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

export interface ColoredPart { geo: THREE.BufferGeometry; hex: number }

/** Bake per-part colors (using the assembly's global Y range) and merge into one geometry. */
export function bakeAndMerge(parts: ColoredPart[], darken = 0.28): THREE.BufferGeometry {
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
// ColoredPart primitive vocabulary
//
// `part` is the atom: wrap ANY geometry as a ColoredPart with a
// scale→rotate→translate applied (used directly by vehicles.ts). The `p*`
// family are the common primitives expressed through `part` and PUSHED onto a
// parts array (the ergonomic style emplacements.ts builds guns with). One home
// for both so the xf-and-wrap logic lives once.
// ---------------------------------------------------------------------------

/** Build one coloured part: fresh geometry with scale→rotate→translate applied. */
export function part(
  geo: THREE.BufferGeometry,
  hex: number,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): ColoredPart {
  return { geo: xf(geo, x, y, z, rx, ry, rz, sx, sy, sz), hex }
}

export function pBox(P: ColoredPart[], hex: number, w: number, h: number, d: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
  P.push(part(new THREE.BoxGeometry(w, h, d), hex, x, y, z, rx, ry, rz))
}

export function pCyl(P: ColoredPart[], hex: number, rt: number, rb: number, h: number, seg: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, open = false): void {
  P.push(part(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), hex, x, y, z, rx, ry, rz))
}

export function pCone(P: ColoredPart[], hex: number, r: number, h: number, seg: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
  P.push(part(new THREE.ConeGeometry(r, h, seg), hex, x, y, z, rx, ry, rz))
}

export function pTorus(P: ColoredPart[], hex: number, r: number, t: number, radial: number, tub: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, arc = Math.PI * 2): void {
  P.push(part(new THREE.TorusGeometry(r, t, radial, tub, arc), hex, x, y, z, rx, ry, rz))
}

export function pSphere(P: ColoredPart[], hex: number, r: number, wseg: number, hseg: number,
  x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0): void {
  P.push(part(new THREE.SphereGeometry(r, wseg, hseg), hex, x, y, z, rx, ry, rz, sx, sy, sz))
}

/**
 * A row of `n` small merged rivet/bolt spheres from a→b (world coords).
 * `squishY` flattens each sphere on Y — vehicles' hull rivets use 0.55, the
 * guns leave them round (1). A lone rivet (n===1) sits at the midpoint.
 */
export function rivetRow(
  out: ColoredPart[],
  a: [number, number, number],
  b: [number, number, number],
  n: number,
  r: number,
  hex: number,
  squishY = 1,
): void {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1)
    out.push(part(
      new THREE.SphereGeometry(r, 4, 3),
      hex,
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      0, 0, 0, 1, squishY, 1,
    ))
  }
}

// ---------------------------------------------------------------------------
// Shared materials for complex builds (≤8 total, module-cached)
// ---------------------------------------------------------------------------

export const mat = {
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
export function fm(geo: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): THREE.Mesh {
  const m = new THREE.Mesh(geo, material)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** Wrap an already vertex-colored geometry (e.g. from an instancing-geometry helper). */
export function wrapVC(geo: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat.vc)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** Paint a fresh geometry uniformly (own bounding box, ground-darkened) and wrap with `vc`. */
export function pm(geo: THREE.BufferGeometry, hex: number, darken = 0.25): THREE.Mesh {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const yMin = bb ? bb.min.y : 0
  const yMax = bb ? bb.max.y : 1
  paintPart(geo, hex, yMin, yMax, darken)
  return wrapVC(geo)
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
