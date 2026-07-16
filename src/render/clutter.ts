/**
 * Ground clutter — the instanced surface litter that turns the bare heightfield
 * into a lived-in, fought-over field. Four independent systems, each ONE
 * InstancedMesh sharing one vertex-colored MeshStandardMaterial:
 *
 *   1. grass tufts  — crossed blade-fan billboards, scattered in clumps where
 *      the ground is neither churned nor trenched. Per-instance tint lerps the
 *      terrain grass palette (dry-khaki ↔ green).
 *   2. stones       — small sunk pebble clusters, anywhere on firm ground.
 *   3. battle debris— splinters, board fragments and the odd rusted dome,
 *      biased INTO the shell-churn belt.
 *   4. brass        — spent casings glinting around the emplacement pads.
 *
 * Everything is procedural, one draw call per system (4 total, ≤5), and placed
 * deterministically from forkRand(seed, 'clutter'): the same seed dresses the
 * same field every boot. Geometry is built FRESH here (no module-level cache),
 * matching the rest of the props family; these meshes live for the Scenery's
 * lifetime, so nothing disposes them per-frame.
 *
 * Sim/world convention: x west→east, z north→south, y up.
 */

import * as THREE from 'three'
import { forkRand, type Rand } from '../core/rng'
import type { Terrain } from '../world/terrain'
import { bakeAndMerge, type ColoredPart } from './props/shared'

// -- shared scratch ----------------------------------------------------------

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _p = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _col = new THREE.Color()

// Terrain grass palette (kept in sync with world/terrainMesh.ts) so tufts read
// as part of the same field rather than pasted on top.
const GRASS_DRY = new THREE.Color(0x8a7f52)
const GRASS_GREEN = new THREE.Color(0x596b3c)

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

/**
 * Compose an instance matrix at (x,z): sit on the surface, sink by `yOff`, spin
 * to `yaw`, and tilt loosely toward the local slope (× `tiltK`) plus a little
 * random wobble. Consumes two rand() draws for the wobble — always called in a
 * fixed order so the field stays deterministic.
 */
function placeMatrix(
  t: Terrain, x: number, z: number, yaw: number, tiltK: number, rand: Rand,
  sx: number, sy: number, sz: number, yOff: number, out: THREE.Matrix4,
): void {
  const e = 0.8
  let gx = (t.heightAt(x + e, z) - t.heightAt(x - e, z)) / (2 * e)
  let gz = (t.heightAt(x, z + e) - t.heightAt(x, z - e)) / (2 * e)
  gx = Math.max(-0.6, Math.min(0.6, gx))
  gz = Math.max(-0.6, Math.min(0.6, gz))
  const wobX = (rand() - 0.5) * 0.18
  const wobZ = (rand() - 0.5) * 0.18
  _e.set(gz * tiltK + wobX, yaw, -gx * tiltK + wobZ, 'XYZ')
  _q.setFromEuler(_e)
  _p.set(x, t.heightAt(x, z) + yOff, z)
  _sc.set(sx, sy, sz)
  out.compose(_p, _q, _sc)
}

function makeInstanced(
  geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial, cap: number, castShadow: boolean,
): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, cap)
  im.castShadow = castShadow
  im.receiveShadow = true
  im.frustumCulled = false
  im.count = 0
  return im
}

// ---------------------------------------------------------------------------
// System 1 — grass tufts
// ---------------------------------------------------------------------------

/** One tapered grass blade: a near-pointed quad in local XY (normal up-and-out). */
function bladeGeo(baseHW: number, topHW: number, h: number, lean: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -baseHW, 0, 0,
    baseHW, 0, 0,
    topHW + lean, h, 0,
    -topHW + lean, h, 0,
  ]), 3))
  // Up-and-forward normal so blades catch sky/sun rather than reading edge-dark.
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0, 0.75, 0.66, 0, 0.75, 0.66, 0, 0.75, 0.66, 0, 0.75, 0.66,
  ]), 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/**
 * Crossed-quad grass star: 3 blade-fans at 60° around Y, three tapered blades
 * each (~18 tris). Colour is a near-white vertical ramp (dark base → bright
 * tip); the per-instance tint supplies the actual grass hue, so one geometry
 * covers dry-khaki through green.
 */
function grassTuftGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const planes = 3
  for (let pl = 0; pl < planes; pl++) {
    const ang = (pl / planes) * Math.PI
    for (let b = 0; b < 3; b++) {
      const dx = (b - 1) * 0.05
      const h = 0.17 + (b === 1 ? 0.05 : 0) + pl * 0.012
      const lean = (b - 1) * 0.035
      const g = bladeGeo(0.018, 0.004, h, lean)
      g.translate(dx, 0, 0)
      g.rotateY(ang)
      parts.push({ geo: g, hex: 0xffffff })
    }
  }
  return bakeAndMerge(parts, 0.32)
}

function scatterGrass(scene: THREE.Scene, terrain: Terrain, rand: Rand): THREE.InstancedMesh {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
  })
  const cap = 3600
  const im = makeInstanced(grassTuftGeometry(), mat, cap, false)

  const halfW = terrain.width / 2 - 3
  const zMin = -terrain.depth / 2 + 30
  const zMax = terrain.depth / 2 - 15
  const target = 3200
  let n = 0
  let attempts = 0
  while (n < target && attempts < target * 4) {
    attempts++
    const cx = (rand() - 0.5) * 2 * halfW
    const cz = zMin + rand() * (zMax - zMin)
    // Grass only where the soil hasn't been shredded, cut open, or drowned.
    if (terrain.churnAt(cx, cz) > 0.25) continue
    if (terrain.trenchAt(cx, cz) > 0.2) continue
    if (terrain.craterDepthAt(cx, cz) > 0.35) continue
    const clump = 2 + ((rand() * 4) | 0) // 2–5 tufts per patch
    for (let k = 0; k < clump && n < cap; k++) {
      const x = cx + (rand() - 0.5) * 1.1
      const z = cz + (rand() - 0.5) * 1.1
      if (terrain.trenchAt(x, z) > 0.25) continue
      const yaw = rand() * Math.PI * 2
      const s = 0.75 + rand() * 0.65
      const sy = s * (0.85 + rand() * 0.5)
      placeMatrix(terrain, x, z, yaw, 0.45, rand, s, sy, s, -0.015 - rand() * 0.02, _m)
      im.setMatrixAt(n, _m)
      // Lifted well above the terrain tones: thin double-sided blades catch far
      // less light than the ground plane, so an un-boosted tint reads black.
      _col.copy(GRASS_DRY).lerp(GRASS_GREEN, rand()).multiplyScalar(1.45 + rand() * 0.5)
      im.setColorAt(n, _col)
      n++
    }
  }
  im.count = n
  im.instanceMatrix.needsUpdate = true
  if (im.instanceColor) im.instanceColor.needsUpdate = true
  scene.add(im)
  return im
}

// ---------------------------------------------------------------------------
// System 2 — stones / pebble clusters
// ---------------------------------------------------------------------------

/** A merged clump of three irregular low-poly rocks (~60 tris), sitting on y=0. */
function stoneClusterGeometry(rand: Rand): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const rocks = 3
  for (let i = 0; i < rocks; i++) {
    const r = 0.06 + rand() * 0.08
    const g = new THREE.IcosahedronGeometry(r, 0)
    const pos = g.getAttribute('position')
    for (let v = 0; v < pos.count; v++) {
      pos.setXYZ(
        v,
        pos.getX(v) + (rand() - 0.5) * r * 0.5,
        pos.getY(v) + (rand() - 0.5) * r * 0.5,
        pos.getZ(v) + (rand() - 0.5) * r * 0.5,
      )
    }
    pos.needsUpdate = true
    g.scale(1, 0.7 + rand() * 0.25, 1)
    g.computeVertexNormals()
    g.translate((rand() - 0.5) * 0.14, r * 0.42, (rand() - 0.5) * 0.14)
    parts.push({ geo: g, hex: rand() < 0.5 ? 0x726a5e : 0x5d5346 })
  }
  return bakeAndMerge(parts, 0.3)
}

function scatterStones(scene: THREE.Scene, terrain: Terrain, rand: Rand): THREE.InstancedMesh {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 })
  const cap = 520
  const im = makeInstanced(stoneClusterGeometry(rand), mat, cap, true)

  const halfW = terrain.width / 2 - 3
  const zMin = -terrain.depth / 2 + 24
  const zMax = terrain.depth / 2 - 12
  const target = 500
  let n = 0
  let attempts = 0
  while (n < target && attempts < target * 6) {
    attempts++
    const x = (rand() - 0.5) * 2 * halfW
    const z = zMin + rand() * (zMax - zMin)
    if (terrain.craterDepthAt(x, z) > 0.35) continue // don't float in future puddles
    if (terrain.trenchAt(x, z) > 0.85) continue       // keep off the duckboarded floor
    const yaw = rand() * Math.PI * 2
    const s = 0.6 + rand() * 0.7
    placeMatrix(terrain, x, z, yaw, 0.7, rand, s, s * (0.75 + rand() * 0.4), s, -0.04 - rand() * 0.05, _m)
    im.setMatrixAt(n, _m)
    const br = 0.78 + rand() * 0.34
    _col.setRGB(br, br * 0.97, br * 0.92)
    im.setColorAt(n, _col)
    n++
  }
  im.count = n
  im.instanceMatrix.needsUpdate = true
  if (im.instanceColor) im.instanceColor.needsUpdate = true
  scene.add(im)
  return im
}

// ---------------------------------------------------------------------------
// System 3 — battle debris
// ---------------------------------------------------------------------------

/** Splinters + a board fragment + a rusted dome (~80 tris), rust & dark-wood tones. */
function debrisGeometry(rand: Rand): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  for (let i = 0; i < 3; i++) {
    const l = 0.18 + rand() * 0.26
    const th = 0.015 + rand() * 0.018
    const w = 0.02 + rand() * 0.02
    const g = new THREE.BoxGeometry(l, th, w)
    g.rotateY(rand() * Math.PI)
    g.rotateZ((rand() - 0.5) * 0.3)
    g.translate((rand() - 0.5) * 0.16, th / 2 + rand() * 0.02, (rand() - 0.5) * 0.16)
    parts.push({ geo: g, hex: rand() < 0.5 ? 0x6b4f30 : 0x4a3826 })
  }
  {
    const g = new THREE.BoxGeometry(0.28 + rand() * 0.14, 0.025, 0.1 + rand() * 0.06)
    g.rotateY(rand() * Math.PI)
    g.rotateX((rand() - 0.5) * 0.2)
    g.translate((rand() - 0.5) * 0.1, 0.02, (rand() - 0.5) * 0.1)
    parts.push({ geo: g, hex: 0x5b4530 })
  }
  {
    // Helmet-sized rusted dome — reads as scattered kit in the churn.
    const g = new THREE.SphereGeometry(0.1, 6, 3, 0, Math.PI * 2, 0, Math.PI * 0.5)
    g.scale(1, 0.6, 1.15)
    g.computeVertexNormals()
    g.translate((rand() - 0.5) * 0.12, 0.0, (rand() - 0.5) * 0.12)
    parts.push({ geo: g, hex: 0x6a4a30 })
  }
  return bakeAndMerge(parts, 0.32)
}

function scatterDebris(scene: THREE.Scene, terrain: Terrain, rand: Rand): THREE.InstancedMesh {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.03 })
  const cap = 420
  const im = makeInstanced(debrisGeometry(rand), mat, cap, true)

  const halfW = terrain.width / 2 - 3
  // The shell-churn belt lives across no-man's land, heaviest short of the wire.
  const zMin = -175
  const zMax = 86
  const target = 400
  let n = 0
  let attempts = 0
  while (n < target && attempts < target * 12) {
    attempts++
    const x = (rand() - 0.5) * 2 * halfW
    const z = zMin + rand() * (zMax - zMin)
    if (terrain.churnAt(x, z) <= 0.3) continue      // bias INTO the churn
    if (terrain.craterDepthAt(x, z) > 0.4) continue // rims yes, deep bowls no
    const yaw = rand() * Math.PI * 2
    const s = 0.6 + rand() * 0.6
    placeMatrix(terrain, x, z, yaw, 0.8, rand, s, s, s, -0.02 - rand() * 0.02, _m)
    im.setMatrixAt(n, _m)
    const br = 0.72 + rand() * 0.4
    _col.setRGB(br, br * (0.82 + rand() * 0.12), br * 0.7) // warm rust/wood breakup
    im.setColorAt(n, _col)
    n++
  }
  im.count = n
  im.instanceMatrix.needsUpdate = true
  if (im.instanceColor) im.instanceColor.needsUpdate = true
  scene.add(im)
  return im
}

// ---------------------------------------------------------------------------
// System 4 — spent brass near the emplacements
// ---------------------------------------------------------------------------

/** A single spent casing: tapered brass body + a brighter rim glint (~36 tris). */
function casingGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const len = 0.075
  const r = 0.011
  const body = new THREE.CylinderGeometry(r * 0.9, r, len, 6, 1, true)
  body.translate(0, len / 2, 0)
  parts.push({ geo: body, hex: 0xad8a3e })
  const rim = new THREE.CylinderGeometry(r * 1.18, r * 1.18, 0.01, 6, 1)
  rim.translate(0, 0.005, 0)
  parts.push({ geo: rim, hex: 0xc9a860 })
  return bakeAndMerge(parts, 0.15)
}

function scatterCasings(scene: THREE.Scene, terrain: Terrain, rand: Rand): THREE.InstancedMesh {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.55 })
  const cap = 170
  const im = makeInstanced(casingGeometry(), mat, cap, false)

  const pads = terrain.pads
  const target = 150
  const perPad = pads.length > 0 ? Math.ceil(target / pads.length) : target
  let n = 0
  for (const pad of pads) {
    for (let k = 0; k < perPad && n < target; k++) {
      const ang = rand() * Math.PI * 2
      const rad = rand() * 2.8
      const x = pad.x + Math.cos(ang) * rad
      const z = pad.z + Math.sin(ang) * rad
      if (terrain.craterDepthAt(x, z) > 0.35) continue
      if (terrain.trenchAt(x, z) > 0.6) continue
      // Casings lie on their side: tip the body horizontal, then random yaw/roll.
      _e.set(Math.PI / 2 + (rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.4, 'XYZ')
      _q.setFromEuler(_e)
      const s = 0.7 + rand() * 0.6
      _p.set(x, terrain.heightAt(x, z) + 0.008, z)
      _sc.set(s, s, s)
      _m.compose(_p, _q, _sc)
      im.setMatrixAt(n, _m)
      const br = 0.7 + rand() * 0.42
      _col.setRGB(br, br * (0.9 + rand() * 0.08), br * (0.72 + rand() * 0.12)) // some tarnished
      im.setColorAt(n, _col)
      n++
    }
  }
  im.count = n
  im.instanceMatrix.needsUpdate = true
  if (im.instanceColor) im.instanceColor.needsUpdate = true
  scene.add(im)
  return im
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build and add all four clutter systems to the scene, placed deterministically
 * from `seed`. Returns the meshes (four InstancedMeshes) in case the caller
 * wants to track them; they persist for the scene's lifetime.
 */
export function dressClutter(scene: THREE.Scene, terrain: Terrain, seed: number): THREE.InstancedMesh[] {
  const rand = forkRand(seed, 'clutter')
  return [
    scatterGrass(scene, terrain, rand),
    scatterStones(scene, terrain, rand),
    scatterDebris(scene, terrain, rand),
    scatterCasings(scene, terrain, rand),
  ]
}
