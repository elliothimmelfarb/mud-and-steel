/**
 * Ground cover & field defences — the "instancing geometries" family: each
 * helper returns ONE merged THREE.BufferGeometry with a baked per-vertex
 * 'color' attribute (lower/inner faces darkened for a grounded look). The
 * caller instances these with a single shared
 * MeshStandardMaterial({ vertexColors: true }).
 *
 * Sim/world convention: x west→east, z north→south, y up. Built groups face -Z,
 * ground plane is y=0. Builders return FRESH geometry every call (never cached).
 */

import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { PALETTE, localRand, xf, bakeAndMerge, type ColoredPart } from './shared'

// ---------------------------------------------------------------------------
// Local helpers (pure — no module-level geometry is cached)
// ---------------------------------------------------------------------------

const _c = new THREE.Color()
/** RGB (0..1) triple for a palette hex. */
function rgbOf(hex: number): [number, number, number] {
  _c.setHex(hex)
  return [_c.r, _c.g, _c.b]
}
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** Cheap deterministic position hash in [0,1). */
function hashNoise(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
  return s - Math.floor(s)
}

/** Remap each vertex's already-baked color in place (spatial grime/scorch/rust passes). */
function recolor(
  geo: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number, r: number, g: number, b: number) => [number, number, number],
): void {
  const pos = geo.getAttribute('position')
  const col = geo.getAttribute('color') as THREE.BufferAttribute | undefined
  if (!col) return
  for (let i = 0; i < pos.count; i++) {
    const o = fn(pos.getX(i), pos.getY(i), pos.getZ(i), col.getX(i), col.getY(i), col.getZ(i))
    col.setXYZ(i, o[0], o[1], o[2])
  }
  col.needsUpdate = true
}

/** Tapered round limb between two world points (radius r0 at p0, r1 at p1). Indexed. */
function limb(p0: THREE.Vector3, p1: THREE.Vector3, r0: number, r1: number, radial = 6): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(p1, p0)
  const len = Math.max(1e-3, dir.length())
  const geo = new THREE.CylinderGeometry(r1, r0, len, radial, 1)
  geo.translate(0, len / 2, 0)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  geo.applyQuaternion(q)
  geo.translate(p0.x, p0.y, p0.z)
  return geo
}

// ---------------------------------------------------------------------------
// Dead tree
// ---------------------------------------------------------------------------

/** 4-7m shell-shattered trunk: bark ridges, root flare, jagged splinter top, drooping branches. */
export function deadTreeGeometry(rand: () => number): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const totalH = 4 + rand() * 3
  const segCount = 3
  let curR = 0.2 + rand() * 0.08
  let curX = 0, curH = 0, curZ = 0
  let tiltX = 0, tiltZ = 0
  const hue = PALETTE.woodDark
  const spine: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)]

  for (let i = 0; i < segCount; i++) {
    const segH = (totalH / segCount) * (0.8 + rand() * 0.4)
    const nextR = curR * (0.62 + rand() * 0.14)
    tiltX += (rand() - 0.5) * 0.28
    tiltZ += (rand() - 0.5) * 0.28
    const geo = new THREE.CylinderGeometry(nextR, curR, segH, 9, 4)
    geo.translate(0, segH / 2, 0)
    // Bark ridges: displace side verts radially with vertical, angle-driven noise.
    const pos = geo.getAttribute('position')
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v)
      const rr = Math.hypot(x, z)
      if (rr < 1e-4) continue
      const ang = Math.atan2(z, x)
      const ridge = 0.55 * Math.sin(ang * 7) + 0.3 * Math.sin(ang * 13 + (curH + y) * 1.4) + 0.15 * Math.sin(ang * 23)
      const f = 1 + 0.06 * ridge
      pos.setX(v, x * f)
      pos.setZ(v, z * f)
    }
    pos.needsUpdate = true
    geo.computeVertexNormals()
    xf(geo, curX, curH, curZ, tiltX, 0, tiltZ)
    parts.push({ geo, hex: hue })
    curX += -Math.sin(tiltZ) * segH
    curZ += Math.sin(tiltX) * segH
    curH += Math.cos(tiltX) * Math.cos(tiltZ) * segH
    curR = nextR
    spine.push(new THREE.Vector3(curX, curH, curZ))
  }
  const tip = new THREE.Vector3(curX, curH, curZ)

  // Root flare — short flaring buttresses splaying to the ground.
  const flareN = 5
  for (let k = 0; k < flareN; k++) {
    const ang = (k / flareN) * Math.PI * 2 + rand() * 0.3
    const rad = 0.16 + rand() * 0.06
    const top = new THREE.Vector3(0, 0.35 + rand() * 0.12, 0)
    const bot = new THREE.Vector3(Math.cos(ang) * rad, 0, Math.sin(ang) * rad)
    parts.push({ geo: limb(bot, top, 0.09 + rand() * 0.03, 0.035, 5), hex: hue })
  }

  // Broken top — several jagged splinter shards fanning up, not one neat cone.
  const shardN = 3 + Math.floor(rand() * 3)
  for (let k = 0; k < shardN; k++) {
    const ang = rand() * Math.PI * 2
    const out = 0.05 + rand() * 0.14
    const up = 0.28 + rand() * 0.5
    const from = tip.clone().add(new THREE.Vector3(0, -0.05, 0))
    const to = new THREE.Vector3(tip.x + Math.cos(ang) * out, tip.y + up, tip.z + Math.sin(ang) * out)
    parts.push({ geo: limb(from, to, curR * (0.5 + rand() * 0.5), 0.004, 4), hex: hue })
  }

  // Branches — bent, tapering, drooping limbs off the upper trunk.
  const branchN = 2 + Math.floor(rand() * 2)
  for (let k = 0; k < branchN; k++) {
    const si = 1 + Math.floor(rand() * (spine.length - 1))
    const base = spine[Math.min(si, spine.length - 1)].clone()
    const ang = rand() * Math.PI * 2
    const l1 = 0.5 + rand() * 0.7
    const outDir = new THREE.Vector3(Math.cos(ang), 0.5 + rand() * 0.5, Math.sin(ang)).normalize()
    const mid = base.clone().addScaledVector(outDir, l1)
    const droop = new THREE.Vector3(outDir.x, outDir.y - 0.7 - rand() * 0.5, outDir.z).normalize()
    const l2 = 0.35 + rand() * 0.5
    const end = mid.clone().addScaledVector(droop, l2)
    const br = curR * (0.35 + rand() * 0.25) + 0.02
    parts.push({ geo: limb(base, mid, br, br * 0.6, 5), hex: hue })
    parts.push({ geo: limb(mid, end, br * 0.6, 0.012, 5), hex: hue })
  }

  const merged = bakeAndMerge(parts, 0.34)
  // Scorch-darken toward the shattered top + tonal bark breakup.
  const [cr, cg, cb] = rgbOf(0x1c140e)
  recolor(merged, (x, y, z, r, g, b) => {
    const scorch = smoothstep(totalH * 0.5, totalH * 1.02, y) * 0.8
    const m = 0.82 + 0.32 * hashNoise(x * 6, y * 3, z * 6)
    return [lerp(r, cr, scorch) * m, lerp(g, cg, scorch) * m, lerp(b, cb, scorch) * m]
  })
  return merged
}

// ---------------------------------------------------------------------------
// Wire picket (screw picket)
// ---------------------------------------------------------------------------

/** 1.2m screw picket: corkscrew auger base, pig-tail eyelets up the shaft, rust streaks. */
export function wirePostGeometry(): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const h = 1.2
  const bend = 0.05

  // Slightly bent shaft as a tube along a gently curved spine.
  const spinePts: THREE.Vector3[] = []
  const segs = 6
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    spinePts.push(new THREE.Vector3(bend * Math.sin(t * Math.PI * 0.8), t * h, 0))
  }
  const post = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(spinePts), 10, 0.026, 6, false)
  parts.push({ geo: post, hex: PALETTE.steelDark })

  // Corkscrew auger — tip at the ground, spiralling up into the base of the shaft.
  const augPts: THREE.Vector3[] = []
  const aSteps = 22
  const turns = 2.4
  for (let i = 0; i <= aSteps; i++) {
    const t = i / aSteps
    const rr = 0.065 * smoothstep(0, 0.18, t)
    const ang = t * turns * Math.PI * 2
    augPts.push(new THREE.Vector3(Math.cos(ang) * rr, t * 0.24, Math.sin(ang) * rr))
  }
  parts.push({ geo: new THREE.TubeGeometry(new THREE.CatmullRomCurve3(augPts), 22, 0.012, 4, false), hex: PALETTE.rust })

  // Pig-tail eyelets distributed UP the shaft (open loops kicked out to one side).
  const eyeHeights = [0.42, 0.66, 0.9, 1.12]
  const eyelets: THREE.Vector2[] = []
  for (const ey of eyeHeights) {
    const ex = bend * Math.sin((ey / h) * Math.PI * 0.8)
    const ring = new THREE.TorusGeometry(0.04, 0.008, 4, 8)
    ring.rotateY(Math.PI / 2)
    ring.rotateZ(0.5)
    ring.translate(ex + 0.045, ey, 0)
    parts.push({ geo: ring, hex: PALETTE.rust })
    eyelets.push(new THREE.Vector2(ex + 0.045, ey))
  }

  const merged = bakeAndMerge(parts, 0.25)
  // Rust streaks weeping DOWN the front face from each eyelet.
  const [sr, sg, sb] = rgbOf(0x6e3417)
  recolor(merged, (x, y, z, r, g, b) => {
    let strength = 0
    for (const e of eyelets) {
      if (y < e.y && y > e.y - 0.32 && x > -0.005) {
        strength = Math.max(strength, (1 - (e.y - y) / 0.32) * 0.7)
      }
    }
    const m = 0.9 + 0.2 * hashNoise(x * 20, y * 8, z * 20)
    return [lerp(r, sr, strength) * m, lerp(g, sg, strength) * m, lerp(b, sb, strength) * m]
  })
  return merged
}

// ---------------------------------------------------------------------------
// Barbed-wire concertina
// ---------------------------------------------------------------------------

/** 6m concertina: 6 sagging helical strands studded with cheap barb spikes. */
export function wireCoilGeometry(): THREE.BufferGeometry {
  const rand = localRand(0x9e3779b1)
  const parts: ColoredPart[] = []
  const x0 = -3, x1 = 3
  const R = 0.32
  const zc = 0
  const baseCenterY = R + 0.05
  const strands = 6
  const loops = 5
  // Sag between implied support pickets at x = -3, 0, 3.
  const sag = (x: number): number => {
    const u = (x - x0) / 3
    const frac = u - Math.floor(u)
    return -0.12 * Math.sin(frac * Math.PI)
  }

  const barbs: { p: THREE.Vector3; n: THREE.Vector3 }[] = []
  for (let s = 0; s < strands; s++) {
    const phase = (s / strands) * Math.PI * 2
    const rS = R * (0.9 + rand() * 0.22)
    const zOff = (rand() - 0.5) * 0.12
    const tubSeg = 46
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= tubSeg; i++) {
      const t = i / tubSeg
      const x = x0 + t * (x1 - x0)
      const ang = t * loops * Math.PI * 2 + phase
      const cy = baseCenterY + sag(x)
      const y = Math.max(0.03, cy + rS * Math.sin(ang))
      const z = zc + zOff + rS * Math.cos(ang)
      pts.push(new THREE.Vector3(x, y, z))
    }
    const curve = new THREE.CatmullRomCurve3(pts)
    parts.push({ geo: new THREE.TubeGeometry(curve, tubSeg, 0.012, 3, false), hex: s % 2 === 0 ? PALETTE.rust : PALETTE.steelDark })
    // Barbs at ~0.6m intervals, pointing radially outward from the coil.
    const nBarb = 10
    for (let b = 0; b < nBarb; b++) {
      const p = curve.getPointAt((b + 0.5) / nBarb)
      const cyAt = baseCenterY + sag(p.x)
      const n = new THREE.Vector3(0, p.y - cyAt, p.z - (zc + zOff))
      if (n.lengthSq() < 1e-6) n.set(0, 1, 0)
      barbs.push({ p, n: n.normalize() })
    }
  }
  // 6-tri cone spikes (indexed, so they merge cleanly with the tube strands).
  for (const bp of barbs) {
    const spike = new THREE.ConeGeometry(0.018, 0.06, 3)
    spike.translate(0, 0.03, 0)
    spike.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), bp.n))
    spike.translate(bp.p.x, bp.p.y, bp.p.z)
    parts.push({ geo: spike, hex: PALETTE.steelDark })
  }
  return bakeAndMerge(parts, 0.22)
}

// ---------------------------------------------------------------------------
// Sandbag
// ---------------------------------------------------------------------------

/** A single plump sandbag ~0.5m across: cloth folds, tied neck, seam, dirt mottle. */
export function sandbagGeometry(): THREE.BufferGeometry {
  const bag = new THREE.SphereGeometry(0.28, 14, 11)
  bag.scale(1.15, 0.62, 0.85)
  const pos = bag.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    // Low + high frequency cloth folds (radial displacement).
    const fold = 0.06 * Math.sin(x * 5 + z * 3) + 0.03 * Math.sin(x * 11 + y * 9 + z * 7)
    x *= 1 + fold; y *= 1 + fold * 0.6; z *= 1 + fold
    // Pinched tied neck toward the +x tip.
    const t = clamp01((x - 0.14) / 0.2)
    const pinch = 1 - 0.72 * t
    y *= pinch; z *= pinch; x += 0.03 * t
    // Faint seam ridge along the top centre-line.
    if (y > 0 && Math.abs(z) < 0.06) y += 0.012 * (1 - Math.abs(z) / 0.06)
    pos.setXYZ(i, x, y, z)
  }
  pos.needsUpdate = true
  bag.computeVertexNormals()

  const knot = new THREE.SphereGeometry(0.055, 6, 5)
  knot.scale(1.1, 0.85, 0.85)
  knot.translate(0.34, 0, 0)

  bag.translate(0, 0.17, 0)
  knot.translate(0, 0.17, 0)
  const merged = bakeAndMerge([{ geo: bag, hex: PALETTE.sandbag }, { geo: knot, hex: PALETTE.sandbag }], 0.3)
  // Per-vertex dirt mottle + mud toward the underside, so a wall never reads cloned.
  const [mr, mg, mb] = rgbOf(PALETTE.mud)
  recolor(merged, (x, y, z, r, g, b) => {
    const mott = 0.82 + 0.3 * hashNoise(x * 7, y * 7, z * 7)
    const mud = smoothstep(0.16, 0.02, y) * 0.5
    return [lerp(r * mott, mr, mud), lerp(g * mott, mg, mud), lerp(b * mott, mb, mud)]
  })
  return merged
}

// ---------------------------------------------------------------------------
// Knife-rest tank trap
// ---------------------------------------------------------------------------

/** Knife-rest obstacle: rough-hewn timber X-frames, diagonal brace, lashed joints. */
export function tankTrapGeometry(): THREE.BufferGeometry {
  const rand = localRand(0x7a1c3b5d)
  const parts: ColoredPart[] = []
  const legLen = 1.5
  const legR = 0.05
  const spanX = 1.8
  const frames = [-spanX / 2, spanX / 2]
  const splinterFrame = 1, splinterSign = 1
  // Height at which the two legs of each frame genuinely cross (leg midpoints
  // meet here, bottoms splay to y=0). The wire lashings wrap this crossing.
  const crossY = Math.cos(0.55) * (legLen * 0.5)

  for (let fi = 0; fi < frames.length; fi++) {
    const x = frames[fi]
    for (const sign of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(legR * 0.9, legR * 1.15, legLen, 8)
      // Leg stays centred on its own midpoint so rotateX pivots at the middle:
      // the two legs then cross at (x, crossY, 0) and their bottoms land at y=0.
      // Faint hewn facet — octagonal timber shouldn't read as a smooth dowel.
      const lp = leg.getAttribute('position')
      for (let v = 0; v < lp.count; v++) {
        const px = lp.getX(v), pz = lp.getZ(v)
        const rr = Math.hypot(px, pz)
        if (rr < 1e-4) continue
        const f = 1 + 0.05 * Math.sin(Math.atan2(pz, px) * 4)
        lp.setX(v, px * f); lp.setZ(v, pz * f)
      }
      lp.needsUpdate = true
      leg.computeVertexNormals()
      leg.rotateX(sign * 0.55)
      leg.translate(x, crossY, 0)
      parts.push({ geo: leg, hex: PALETTE.wood })

      // Splayed top end of this leg (measured from the crossing at the middle).
      const tipY = Math.cos(sign * 0.55) * legLen
      const tipZ = Math.sin(sign * 0.55) * (legLen * 0.5)
      if (fi === splinterFrame && sign === splinterSign) {
        // One splintered leg end.
        for (let sh = 0; sh < 3; sh++) {
          const from = new THREE.Vector3(x, tipY - 0.05, tipZ)
          const to = new THREE.Vector3(x + (rand() - 0.5) * 0.1, tipY + 0.12 + rand() * 0.12, tipZ + (rand() - 0.5) * 0.3)
          parts.push({ geo: limb(from, to, legR * 0.5, 0.004, 4), hex: PALETTE.wood })
        }
      } else {
        // Darker sawn end-grain cap.
        const cap = new THREE.CylinderGeometry(legR * 1.02, legR * 1.02, 0.03, 8)
        cap.rotateX(sign * 0.55)
        cap.translate(x, tipY, tipZ)
        parts.push({ geo: cap, hex: PALETTE.woodDark })
      }
    }
    // Wire-wrap lashing at the X crossing (~mid height).
    for (let w = 0; w < 3; w++) {
      const tor = new THREE.TorusGeometry(legR * 1.5, 0.01, 3, 6)
      tor.rotateY(Math.PI / 2)
      tor.translate(x, crossY - 0.03 + w * 0.03, 0)
      parts.push({ geo: tor, hex: PALETTE.steelDark })
    }
  }

  // Horizontal rails.
  for (const y of [0.85, 0.42]) {
    const rail = new THREE.CylinderGeometry(0.042, 0.042, spanX + 0.3, 6)
    rail.rotateZ(Math.PI / 2)
    rail.translate(0, y, 0)
    parts.push({ geo: rail, hex: PALETTE.woodDark })
  }

  // Diagonal cross-brace tying the two frames together — endpoints seated on
  // the lower and upper rails (both at z=0) so both ends meet real timber.
  parts.push({ geo: limb(new THREE.Vector3(-spanX / 2, 0.42, 0), new THREE.Vector3(spanX / 2, 0.85, 0), 0.03, 0.03, 6), hex: PALETTE.wood })

  return bakeAndMerge(parts, 0.28)
}

// ---------------------------------------------------------------------------
// Duckboard
// ---------------------------------------------------------------------------

/** 2m plank walkway: warped planks, one snapped, nail heads, mud staining from the ends. */
export function duckboardGeometry(): THREE.BufferGeometry {
  const rand = localRand(0x2b9d4f11)
  const parts: ColoredPart[] = []
  const length = 2, width = 0.7, plankCount = 7
  const plankW = width / plankCount
  const plankH = 0.04
  const runnerH = 0.05
  const runnerX = [-length / 2 + 0.18, length / 2 - 0.18]
  const snapIdx = 2 + Math.floor(rand() * 3)

  for (let i = 0; i < plankCount; i++) {
    const z = -width / 2 + plankW * (i + 0.5)
    const hex = i % 2 === 0 ? PALETTE.wood : PALETTE.woodDark
    const tilt = (rand() - 0.5) * 0.06
    const yaw = (rand() - 0.5) * 0.05
    const yOff = (rand() - 0.5) * 0.006

    if (i === snapIdx) {
      // Snapped plank — only the left run remains, with a jagged broken end.
      const keep = 0.9 + rand() * 0.3
      const plank = new THREE.BoxGeometry(keep, plankH, plankW * 0.86, 4, 1, 1)
      plank.rotateY(yaw); plank.rotateZ(tilt)
      plank.translate(-length / 2 + keep / 2, runnerH + plankH / 2 + yOff, z)
      parts.push({ geo: plank, hex })
      const bx = -length / 2 + keep
      for (let sh = 0; sh < 3; sh++) {
        const from = new THREE.Vector3(bx, runnerH + plankH / 2, z + (rand() - 0.5) * plankW * 0.6)
        const to = new THREE.Vector3(bx + 0.04 + rand() * 0.08, runnerH + plankH / 2 + (rand() - 0.5) * 0.02, z + (rand() - 0.5) * plankW * 0.5)
        parts.push({ geo: limb(from, to, 0.012, 0.003, 3), hex })
      }
      continue
    }

    const plank = new THREE.BoxGeometry(length, plankH, plankW * 0.86, 4, 1, 1)
    plank.rotateY(yaw); plank.rotateZ(tilt)
    plank.translate(0, runnerH + plankH / 2 + yOff, z)
    parts.push({ geo: plank, hex })
    // Nail heads where the plank crosses each runner.
    for (const rx of runnerX) {
      const nail = new THREE.CylinderGeometry(0.014, 0.016, 0.01, 5)
      nail.translate(rx, runnerH + plankH + 0.006 + yOff, z)
      parts.push({ geo: nail, hex: PALETTE.steelDark })
    }
  }

  for (const rx of runnerX) {
    const runner = new THREE.BoxGeometry(0.08, runnerH, width, 1, 1, 4)
    runner.translate(rx, runnerH / 2, 0)
    parts.push({ geo: runner, hex: PALETTE.woodDark })
  }

  const merged = bakeAndMerge(parts, 0.3)
  // Mud staining creeping in from the boot-trodden ends.
  const [mr, mg, mb] = rgbOf(PALETTE.mud)
  recolor(merged, (x, y, z, r, g, b) => {
    const mud = smoothstep(0.55, 1.0, Math.abs(x) / (length / 2)) * 0.55
    const n = 0.86 + 0.24 * hashNoise(x * 9, y * 5, z * 9)
    return [lerp(r, mr, mud) * n, lerp(g, mg, mud) * n, lerp(b, mb, mud) * n]
  })
  return merged
}

// ---------------------------------------------------------------------------
// Grave cross
// ---------------------------------------------------------------------------

/** Weathered leaning grave cross with chamfered arms, earth mound, identity-disc hint. */
export function crossGraveGeometry(): THREE.BufferGeometry {
  const rand = localRand(0x41d9a7)
  const parts: ColoredPart[] = []
  const lean = (rand() - 0.5) * 0.12

  // Chamfered beam via a bevel-extruded rectangle (re-indexed so it merges cleanly).
  const beam = (w: number, hh: number, yc: number, depth: number): THREE.BufferGeometry => {
    const shape = new THREE.Shape()
    const x0 = -w / 2, x1 = w / 2, y0 = yc - hh / 2, y1 = yc + hh / 2
    shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(x0, y1); shape.lineTo(x0, y0)
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, steps: 1,
    })
    geo.translate(0, 0, -depth / 2)
    return mergeVertices(geo)
  }

  const post = beam(0.08, 0.86, 0.44, 0.06)
  post.rotateZ(lean)
  parts.push({ geo: post, hex: PALETTE.bone })
  const bar = beam(0.5, 0.07, 0.66, 0.055)
  bar.rotateZ(lean)
  parts.push({ geo: bar, hex: PALETTE.bone })

  // Identity-disc cord hint hanging from the crossbar (helmet deliberately OFF — deterministic).
  const cord = limb(new THREE.Vector3(0.1, 0.66, 0.04), new THREE.Vector3(0.12, 0.5, 0.04), 0.004, 0.004, 3)
  cord.rotateZ(lean)
  parts.push({ geo: cord, hex: PALETTE.steelDark })
  const disc = new THREE.CylinderGeometry(0.028, 0.028, 0.008, 8)
  disc.rotateX(Math.PI / 2)
  disc.translate(0.12, 0.48, 0.04)
  disc.rotateZ(lean)
  parts.push({ geo: disc, hex: PALETTE.brass })

  // Mounded earth at the base (flattened, displaced, mud-toned).
  const mound = new THREE.SphereGeometry(0.34, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)
  mound.scale(1.15, 0.32, 1.0)
  const mp = mound.getAttribute('position')
  for (let i = 0; i < mp.count; i++) {
    const x = mp.getX(i), y = mp.getY(i), z = mp.getZ(i)
    if (y < 1e-4) continue
    mp.setY(i, y * (0.7 + 0.6 * hashNoise(x * 8, 0, z * 8)))
  }
  mp.needsUpdate = true
  mound.computeVertexNormals()
  parts.push({ geo: mound, hex: PALETTE.mud })

  const merged = bakeAndMerge(parts, 0.26)
  // Weathered tonal breakup on the timber.
  recolor(merged, (x, y, z, r, g, b) => {
    const n = 0.8 + 0.34 * hashNoise(x * 10, y * 6, z * 10)
    return [r * n, g * n, b * n]
  })
  return merged
}

// ---------------------------------------------------------------------------
// Rubble
// ---------------------------------------------------------------------------

/** Bombed-house debris: brick clusters, tile shards, charred beam, plaster-dust base mound. */
export function rubbleGeometry(rand: () => number): THREE.BufferGeometry {
  const parts: ColoredPart[] = []
  const moundR = 0.62
  const moundH = 0.16
  const surfaceY = (x: number, z: number): number => {
    const d = Math.hypot(x, z) / moundR
    return d >= 1 ? 0 : moundH * Math.sqrt(1 - d * d)
  }

  // Plaster-dust base mound so the pile sits IN the ground, not floating.
  const mound = new THREE.SphereGeometry(moundR, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2)
  mound.scale(1.1, moundH / moundR, 1.0)
  const mp = mound.getAttribute('position')
  for (let i = 0; i < mp.count; i++) {
    const x = mp.getX(i), y = mp.getY(i), z = mp.getZ(i)
    if (y < 1e-4) continue
    mp.setY(i, y * (0.7 + 0.6 * hashNoise(x * 7, 0, z * 7)))
  }
  mp.needsUpdate = true
  mound.computeVertexNormals()
  parts.push({ geo: mound, hex: 0xb8ab90 })

  // Brick clusters — rows of 2-3 bricks with mortar gaps on a dark mortar bed.
  const clusters = 4
  for (let c = 0; c < clusters; c++) {
    const ang = rand() * Math.PI * 2
    const rad = rand() * moundR * 0.6
    const cx = Math.cos(ang) * rad, cz = Math.sin(ang) * rad
    const yaw = rand() * Math.PI
    const n = 2 + Math.floor(rand() * 2)
    const bw = 0.11, bh = 0.055, bd = 0.052
    const rowY = surfaceY(cx, cz) + bh / 2 + rand() * 0.05
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * (bw + 0.008)
      const brick = new THREE.BoxGeometry(bw, bh, bd)
      brick.rotateY(yaw)
      brick.translate(cx + Math.cos(yaw) * off, rowY + (rand() - 0.5) * 0.01, cz - Math.sin(yaw) * off)
      parts.push({ geo: brick, hex: rand() < 0.7 ? PALETTE.rust : 0x9a5138 })
    }
    const slab = new THREE.BoxGeometry(bw * n + 0.03, 0.02, bd + 0.02)
    slab.rotateY(yaw)
    slab.translate(cx, rowY - bh / 2 - 0.005, cz)
    parts.push({ geo: slab, hex: PALETTE.woodDark })
  }

  // Roof-tile shards.
  const tiles = 5
  for (let t = 0; t < tiles; t++) {
    const ang = rand() * Math.PI * 2
    const rad = rand() * moundR * 0.7
    const tx = Math.cos(ang) * rad, tz = Math.sin(ang) * rad
    const tile = new THREE.BoxGeometry(0.16 + rand() * 0.06, 0.012, 0.1 + rand() * 0.04)
    tile.rotateY(rand() * Math.PI)
    tile.rotateZ((rand() - 0.5) * 0.5)
    tile.rotateX((rand() - 0.5) * 0.3)
    tile.translate(tx, surfaceY(tx, tz) + 0.05 + rand() * 0.06, tz)
    parts.push({ geo: tile, hex: rand() < 0.5 ? PALETTE.bone : PALETTE.rust })
  }

  // Charred roof beam laid across the pile.
  const bx0 = -0.5 - rand() * 0.2, bx1 = 0.5 + rand() * 0.2
  const beam = new THREE.BoxGeometry(bx1 - bx0, 0.09, 0.09, 6, 1, 1)
  beam.rotateY((rand() - 0.5) * 0.6)
  beam.translate((bx0 + bx1) / 2, moundH + 0.05, (rand() - 0.5) * 0.3)
  const charEnd = bx1
  parts.push({ geo: beam, hex: PALETTE.woodDark })

  const merged = bakeAndMerge(parts, 0.3)
  const [kr, kg, kb] = rgbOf(0x140f0b)
  recolor(merged, (x, y, z, r, g, b) => {
    // Char the +x end of the pile (upper pieces near that end blacken).
    const char = smoothstep(charEnd - 0.35, charEnd, x) * smoothstep(moundH, moundH + 0.03, y) * 0.85
    const n = 0.84 + 0.28 * hashNoise(x * 8, y * 8, z * 8)
    return [lerp(r, kr, char) * n, lerp(g, kg, char) * n, lerp(b, kb, char) * n]
  })
  return merged
}

// ---------------------------------------------------------------------------
// Mine stake
// ---------------------------------------------------------------------------

/** Driven wooden stake: bowed shaft, mallet-bruised mushroom head, split top. */
export function stakeGeometry(): THREE.BufferGeometry {
  const rand = localRand(0x3f6a19c7)
  const parts: ColoredPart[] = []
  const h = 0.62
  const bow = 0.04

  const shaft = new THREE.CylinderGeometry(0.02, 0.035, h, 7, 6)
  shaft.translate(0, h / 2, 0)
  const sp = shaft.getAttribute('position')
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i)
    const bx = bow * Math.sin((y / h) * Math.PI) // gentle bow, zero at both ends
    let nx = x, nz = z
    const rr = Math.hypot(x, z)
    if (rr > 1e-4) {
      const f = 1 + 0.04 * Math.sin(Math.atan2(z, x) * 5) // faint facet
      nx = x * f; nz = z * f
    }
    sp.setXYZ(i, nx + bx, y, nz)
  }
  sp.needsUpdate = true
  shaft.computeVertexNormals()
  parts.push({ geo: shaft, hex: PALETTE.wood })

  // Faceted mallet-bruised head, mushroomed out from being driven.
  const head = new THREE.CylinderGeometry(0.05, 0.036, 0.06, 6, 1)
  const hp = head.getAttribute('position')
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i), z = hp.getZ(i)
    const rr = Math.hypot(x, z)
    if (rr < 1e-4) continue
    const f = 1 + 0.18 * hashNoise(x * 20, 0, z * 20)
    hp.setX(i, x * f); hp.setZ(i, z * f)
  }
  hp.needsUpdate = true
  head.computeVertexNormals()
  head.translate(0, h - 0.02, 0)
  parts.push({ geo: head, hex: PALETTE.wood })

  // Split top — two shards driven apart into a V.
  for (const s of [-1, 1]) {
    const from = new THREE.Vector3(0, h - 0.03, 0)
    const to = new THREE.Vector3(s * (0.02 + rand() * 0.02), h + 0.06 + rand() * 0.05, (rand() - 0.5) * 0.02)
    parts.push({ geo: limb(from, to, 0.02, 0.003, 4), hex: PALETTE.wood })
  }

  const merged = bakeAndMerge(parts, 0.25)
  recolor(merged, (x, y, z, r, g, b) => {
    const n = 0.82 + 0.32 * hashNoise(x * 14, y * 8, z * 14)
    const bruise = smoothstep(h - 0.06, h, y) * 0.3 // darkened bruised head
    return [lerp(r, r * 0.5, bruise) * n, lerp(g, g * 0.5, bruise) * n, lerp(b, b * 0.5, bruise) * n]
  })
  return merged
}
