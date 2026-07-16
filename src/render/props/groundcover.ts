/**
 * Ground cover & field defences — the "instancing geometries" family: each
 * helper returns ONE merged THREE.BufferGeometry with a baked per-vertex
 * 'color' attribute (lower/inner faces darkened for a grounded look). The
 * caller instances these with a single shared
 * MeshStandardMaterial({ vertexColors: true }).
 */

import * as THREE from 'three'
import { PALETTE, localRand, xf, bakeAndMerge, type ColoredPart } from './shared'

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
