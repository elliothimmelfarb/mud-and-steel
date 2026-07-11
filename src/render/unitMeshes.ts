/**
 * Instanced soldier rendering: every man on the field — both armies, the
 * living and the dead — drawn as 9 instanced part meshes with a procedural
 * pose rig (walk cycles, aiming, crouching under fire, going prone, dying).
 * ~500 soldiers cost 9 draw calls.
 */
import * as THREE from 'three'
import type { Stance, Team } from '../core/types'
import { buildHorse } from './props'

export interface SoldierPose {
  x: number; y: number; z: number
  facing: number          // 0 = north (-z), clockwise from above
  stance: Stance
  moveAmount: number      // 0 still → 1 full stride
  animPhase: number
  aiming: boolean
  recoil: number          // 0..1, kicks on shot
  deadT: number           // seconds since death (sinks into the mud)
  deadSeed: number        // stable random for fall direction
  masked: boolean
  team: Team
  tint: number            // 0..1 per-man uniform variation
  mounted: boolean
}

const CAP = 560

// Muted uniforms. Slight per-man tint keeps ranks from looking cloned.
const COL_BRIT = new THREE.Color(0x6b6446)
const COL_GERMAN = new THREE.Color(0x4e5346)
const COL_SKIN = new THREE.Color(0xb08a68)
const COL_MASK = new THREE.Color(0x67705a)
const COL_RIFLE = new THREE.Color(0x4a3826)
const COL_PACK = new THREE.Color(0x54503a)

const enum Part { LegL, LegR, Torso, Head, HelmetB, HelmetG, ArmL, ArmR, Rifle, Pack }
const PART_COUNT = 10

function legGeo(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(0.14, 0.52, 0.16)
  g.translate(0, -0.26, 0) // pivot at hip
  return g
}
function armGeo(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(0.09, 0.44, 0.11)
  g.translate(0, -0.22, 0) // pivot at shoulder
  return g
}
function torsoGeo(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(0.38, 0.52, 0.24)
  g.translate(0, 0.26, 0) // pivot at hip
  return g
}
function helmetBritGeo(): THREE.BufferGeometry {
  // Brodie: shallow bowl + wide brim.
  const bowl = new THREE.SphereGeometry(0.105, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.45)
  bowl.scale(1, 0.75, 1)
  const brim = new THREE.CylinderGeometry(0.165, 0.175, 0.02, 12)
  brim.translate(0, -0.005, 0)
  const merged = mergeGeos([bowl, brim])
  return merged
}
function helmetGermanGeo(): THREE.BufferGeometry {
  // Stahlhelm: deeper dome with a flared skirt.
  const dome = new THREE.SphereGeometry(0.115, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.52)
  dome.scale(1, 0.92, 1.08)
  const skirt = new THREE.CylinderGeometry(0.125, 0.148, 0.055, 12)
  skirt.translate(0, -0.02, 0)
  return mergeGeos([dome, skirt])
}
/** Minimal merge (positions/normals only) so we don't depend on addons here. */
function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0
  const nonIndexed = geos.map((g) => g.toNonIndexed())
  for (const g of nonIndexed) total += g.getAttribute('position').count
  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  let o = 0
  for (const g of nonIndexed) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3)
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3)
    o += g.getAttribute('position').count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  return out
}

const _m = new THREE.Matrix4()
const _root = new THREE.Matrix4()
const _part = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const _c = new THREE.Color()
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0)

export class SoldierRenderer {
  private meshes: THREE.InstancedMesh[] = []
  private counts = new Array<number>(PART_COUNT).fill(0)
  private horses: HorsePool

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 })
    const geos: THREE.BufferGeometry[] = []
    geos[Part.LegL] = legGeo(); geos[Part.LegR] = legGeo()
    geos[Part.Torso] = torsoGeo()
    geos[Part.Head] = new THREE.SphereGeometry(0.095, 8, 6)
    geos[Part.HelmetB] = helmetBritGeo(); geos[Part.HelmetG] = helmetGermanGeo()
    geos[Part.ArmL] = armGeo(); geos[Part.ArmR] = armGeo()
    geos[Part.Rifle] = new THREE.BoxGeometry(0.05, 0.06, 1.08)
    geos[Part.Pack] = new THREE.BoxGeometry(0.3, 0.32, 0.15)
    for (let i = 0; i < PART_COUNT; i++) {
      const im = new THREE.InstancedMesh(geos[i], mat, CAP)
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.castShadow = true
      im.receiveShadow = false
      im.frustumCulled = false
      // instanceColor is lazily created on first setColorAt.
      scene.add(im)
      this.meshes.push(im)
    }
    this.horses = new HorsePool(scene)
  }

  begin(): void {
    this.counts.fill(0)
    this.horses.begin()
  }

  push(p: SoldierPose): void {
    // All-or-nothing per soldier: past capacity, drop the whole man rather
    // than desync his parts (torso count binds every per-soldier part).
    if (this.counts[Part.Torso] >= CAP) return
    const dead = p.stance === 'dead'
    const deadSink = dead ? Math.min(0.12, p.deadT * 0.002) : 0
    // Only ride as high as a horse we can actually draw.
    const hasHorse = p.mounted && !dead &&
      this.horses.push(p.x, p.y, p.z, p.facing, p.animPhase)
    const mountY = hasHorse ? 1.05 : 0

    // ---- whole-body frame -------------------------------------------------
    let bodyPitch = 0, bodyRoll = 0, lift = 0
    let hipY = 0.98, torsoPitch = 0.04
    let legSwingAmp = 0.55, prone = false
    switch (p.stance) {
      case 'stand': break
      case 'crouch': hipY = 0.6; torsoPitch = 0.42; legSwingAmp = 0.35; break
      case 'prone': prone = true; bodyPitch = -1.42; lift = 0.28; hipY = 0.9; break
      case 'dead': {
        const back = (p.deadSeed * 7.3) % 1 > 0.45
        bodyPitch = back ? 1.5 : -1.52
        bodyRoll = ((p.deadSeed * 13.7) % 1 - 0.5) * 0.9
        lift = 0.2 - deadSink
        hipY = 0.9
        break
      }
    }
    if (hasHorse) { hipY = 0.55; legSwingAmp = 0 }

    _e.set(bodyPitch, -p.facing, bodyRoll, 'YXZ')
    _q.setFromEuler(_e)
    _v.set(p.x, p.y + lift + mountY, p.z)
    _root.compose(_v, _q, _s)

    const walk = Math.sin(p.animPhase) * legSwingAmp * p.moveAmount
    const bob = Math.abs(Math.sin(p.animPhase)) * 0.05 * p.moveAmount

    // ---- parts in body space ----------------------------------------------
    // legs
    this.setPart(Part.LegL, p, -0.095, hipY + bob, 0, hasHorse ? 0.5 : (prone || dead ? 0.08 : walk), 0, hasHorse ? 0.5 : 0)
    this.setPart(Part.LegR, p, 0.095, hipY + bob, 0, hasHorse ? 0.5 : (prone || dead ? -0.05 : -walk), 0, hasHorse ? -0.5 : 0)
    // torso
    this.setPart(Part.Torso, p, 0, hipY + bob, 0, -torsoPitch, 0, 0)
    const shoulderY = hipY + bob + 0.46
    const chestZ = -Math.sin(torsoPitch) * 0.4
    // head + helmet
    this.setPart(Part.Head, p, 0, shoulderY + 0.16, chestZ - 0.02, prone ? -1.1 : -torsoPitch * 0.5, 0, 0)
    const helmetPart = p.team === 'brit' ? Part.HelmetB : Part.HelmetG
    this.setPart(helmetPart, p, 0, shoulderY + 0.235, chestZ - 0.02, prone ? -1.1 : -torsoPitch * 0.5, 0, 0)
    // arms + rifle
    const hasRifle = true
    if (p.aiming || prone) {
      this.setPart(Part.ArmR, p, 0.2, shoulderY, chestZ, -1.32, -0.25, 0)
      this.setPart(Part.ArmL, p, -0.16, shoulderY, chestZ, -1.18, 0.35, 0)
      if (hasRifle) {
        const kick = p.recoil * 0.09
        this.setPart(Part.Rifle, p, 0.04, shoulderY + 0.06, chestZ - 0.38 + kick, 0.03, 0, 0)
      }
    } else if (dead) {
      this.setPart(Part.ArmR, p, 0.24, shoulderY, 0, 0.3, 0, -0.5)
      this.setPart(Part.ArmL, p, -0.24, shoulderY, 0, 0.2, 0, 0.6)
      if (hasRifle) this.setPart(Part.Rifle, p, 0.42, 0.12, 0.1, 0, 1.2, 0) // dropped beside
    } else {
      // slung / at ready, arms swing opposite legs
      this.setPart(Part.ArmR, p, 0.235, shoulderY, 0, -0.35 - walk * 0.5, 0, -0.06)
      this.setPart(Part.ArmL, p, -0.235, shoulderY, 0, -0.35 + walk * 0.5, 0, 0.06)
      if (hasRifle) this.setPart(Part.Rifle, p, 0.26, shoulderY - 0.05, 0.08, -0.5, 0, 0)
    }
    // pack
    this.setPart(Part.Pack, p, 0, hipY + bob + 0.3, 0.2, -torsoPitch, 0, 0)
  }

  private setPart(
    part: Part, p: SoldierPose,
    lx: number, ly: number, lz: number,
    rx: number, ry: number, rz: number,
  ): void {
    const idx = this.counts[part]
    if (idx >= CAP) return
    _e.set(rx, ry, rz, 'YXZ')
    _q.setFromEuler(_e)
    _v.set(lx, ly, lz)
    _part.compose(_v, _q, _s)
    _m.multiplyMatrices(_root, _part)
    const mesh = this.meshes[part]
    mesh.setMatrixAt(idx, _m)
    // color
    switch (part) {
      case Part.Head:
        _c.copy(p.masked ? COL_MASK : COL_SKIN); break
      case Part.Rifle: _c.copy(COL_RIFLE); break
      case Part.Pack: _c.copy(COL_PACK); break
      case Part.HelmetB: case Part.HelmetG:
        _c.copy(p.team === 'brit' ? COL_BRIT : COL_GERMAN).multiplyScalar(0.82); break
      default:
        _c.copy(p.team === 'brit' ? COL_BRIT : COL_GERMAN).multiplyScalar(0.88 + p.tint * 0.24)
    }
    mesh.setColorAt(idx, _c)
    this.counts[part] = idx + 1
  }

  finish(): void {
    for (let i = 0; i < PART_COUNT; i++) {
      const mesh = this.meshes[i]
      const n = this.counts[i]
      // Zero out one stale slot past the end (cheap trailing cleanup), then set count.
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    this.horses.finish()
  }
}

/** Small pool of cloned low-poly horses for cavalry waves. */
class HorsePool {
  private pool: THREE.Group[] = []
  private used = 0
  constructor(private scene: THREE.Scene) {}

  begin(): void { this.used = 0 }

  push(x: number, y: number, z: number, facing: number, phase: number): boolean {
    if (this.used >= 24) return false
    if (this.used >= this.pool.length) {
      const h = buildHorse()
      this.scene.add(h)
      this.pool.push(h)
    }
    const h = this.pool[this.used++]
    h.visible = true
    h.position.set(x, y, z)
    h.rotation.y = -facing
    // Gallop: diagonal pairs.
    const g = Math.sin(phase * 2) * 0.7
    const legs = ['legFL', 'legBR', 'legFR', 'legBL']
    for (let i = 0; i < legs.length; i++) {
      const leg = h.getObjectByName(legs[i])
      if (leg) leg.rotation.x = i < 2 ? g : -g
    }
    return true
  }

  finish(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false
  }
}
