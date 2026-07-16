/**
 * Structures — ruins, the church landmark, dugout entrances, stores. Complex
 * builds returning THREE.Group of meshes over the shared material set.
 */

import * as THREE from 'three'
import { PALETTE, fm, mat, pm, wrapVC } from './shared'
import { rubbleGeometry, sandbagGeometry } from './groundcover'

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
