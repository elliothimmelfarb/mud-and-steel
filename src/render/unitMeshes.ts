/**
 * Instanced soldier rendering: every man on the field — both armies, the
 * living and the dead — drawn as 14 instanced part meshes with a procedural
 * pose rig (proper walk/run gait with knee bend, shouldered rifles, combat
 * kneel, articulated prone, varied collapse poses). ~500 soldiers cost 14
 * draw calls. Kit detail (webbing, puttees, boots, rifle furniture) is baked
 * into grayscale-ish vertex colors, which multiply with the per-instance
 * uniform tint.
 *
 * Facing convention (from the sim): 0 = north (-z), increases CLOCKWISE
 * viewed from above; direction vector = (sin f, -cos f). All geometry is
 * built facing local -z, so render yaw = -facing.
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
  /** Optional aim elevation in radians, positive = up. Defaults to 0. */
  pitch?: number
}

const CAP = 560

// Muted uniforms. Slight per-man tint keeps ranks from looking cloned.
const COL_BRIT = new THREE.Color(0x6b6446)
const COL_GERMAN = new THREE.Color(0x4e5346)
const COL_SKIN = new THREE.Color(0xb08a68)
const COL_MASK = new THREE.Color(0x67705a)
const COL_PACK = new THREE.Color(0x54503a)

const enum Part {
  ThighL, ThighR, CalfL, CalfR,
  Torso, Head, HelmetB, HelmetG,
  ArmUpL, ArmUpR, ArmLoL, ArmLoR,
  Rifle, Pack,
}
const PART_COUNT = 14

// Proportions (metres-ish). Legs sum exactly to hip height so boots meet the
// standing surface passed in as pose.y.
const HIP_H = 0.94
const THIGH_L = 0.46
const TORSO_H = 0.54
const SHOULDER_Y = 0.48
const SHOULDER_X = 0.235
const HEAD_Y = 0.60
const UPARM_L = 0.28

// ---------------------------------------------------------------------------
// Geometry. Accent shading is baked into vertex colors; the material has
// vertexColors on, so shader color = vertexColor × instanceColor. Uniform
// cloth bakes white and takes the per-instance team/tint color; kit bakes
// its own tone (the rifle instance color is near-white so its baked wood and
// metal tones read true).
// ---------------------------------------------------------------------------

function bake(g: THREE.BufferGeometry, r: number, gr: number, b: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = gr; col[i * 3 + 2] = b }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

/** Minimal merge (position/normal/color) so we don't depend on addons here. */
function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0
  const nonIndexed = geos.map((g) => g.toNonIndexed())
  for (const g of nonIndexed) total += g.getAttribute('position').count
  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  const col = new Float32Array(total * 3)
  let o = 0
  for (const g of nonIndexed) {
    const n = g.getAttribute('position').count
    pos.set(g.getAttribute('position').array as Float32Array, o * 3)
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3)
    const c = g.getAttribute('color')
    if (c) col.set(c.array as Float32Array, o * 3)
    else col.fill(1, o * 3, (o + n) * 3)
    o += n
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return out
}

function thighGeo(): THREE.BufferGeometry {
  return bake(new THREE.BoxGeometry(0.15, THIGH_L, 0.17).translate(0, -THIGH_L / 2, 0), 1, 1, 1)
}
/** Knee-to-sole: trouser, wrapped puttee, dark boot with a toe. Pivot at knee. */
function calfGeo(): THREE.BufferGeometry {
  const trouser = bake(new THREE.BoxGeometry(0.135, 0.18, 0.155).translate(0, -0.09, 0), 1, 1, 1)
  const puttee = bake(new THREE.BoxGeometry(0.115, 0.235, 0.135).translate(0, -0.295, 0), 0.85, 0.80, 0.66)
  const boot = bake(new THREE.BoxGeometry(0.105, 0.10, 0.26).translate(0, -0.435, -0.045), 0.33, 0.29, 0.26)
  return mergeGeos([trouser, puttee, boot])
}
/** Tunic with belt, cross-straps, ammo pouches, collar. Pivot at hip. */
function torsoGeo(): THREE.BufferGeometry {
  const chest = bake(new THREE.BoxGeometry(0.38, TORSO_H, 0.23).translate(0, TORSO_H / 2, 0), 1, 1, 1)
  const belt = bake(new THREE.BoxGeometry(0.40, 0.07, 0.25).translate(0, 0.16, 0), 0.52, 0.49, 0.42)
  const strapL = bake(new THREE.BoxGeometry(0.075, 0.34, 0.016).translate(-0.10, 0.37, -0.122), 0.62, 0.58, 0.48)
  const strapR = bake(new THREE.BoxGeometry(0.075, 0.34, 0.016).translate(0.10, 0.37, -0.122), 0.62, 0.58, 0.48)
  const pouchL = bake(new THREE.BoxGeometry(0.09, 0.10, 0.05).translate(-0.10, 0.245, -0.135), 0.80, 0.76, 0.62)
  const pouchR = bake(new THREE.BoxGeometry(0.09, 0.10, 0.05).translate(0.10, 0.245, -0.135), 0.80, 0.76, 0.62)
  const collar = bake(new THREE.BoxGeometry(0.20, 0.05, 0.16).translate(0, TORSO_H + 0.005, -0.01), 0.90, 0.87, 0.78)
  return mergeGeos([chest, belt, strapL, strapR, pouchL, pouchR, collar])
}
function headGeo(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.095, 8, 6)
  g.scale(0.92, 1.02, 0.98)
  return bake(g, 1, 1, 1)
}
/** Brodie: shallow flattened bowl over a wide flat brim. Shares the head matrix. */
function helmetBritGeo(): THREE.BufferGeometry {
  const bowl = new THREE.SphereGeometry(0.115, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42)
  bowl.scale(1, 0.60, 1)
  bowl.translate(0, 0.032, 0)
  const brim = new THREE.CylinderGeometry(0.178, 0.192, 0.016, 14)
  brim.translate(0, 0.044, 0)
  return mergeGeos([bake(bowl, 1, 1, 1), bake(brim, 0.92, 0.92, 0.92)])
}
/** Stahlhelm: deep dome, flared ear/neck skirt, small front visor lip. */
function helmetGermanGeo(): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(0.118, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.55)
  dome.scale(1, 0.88, 1.06)
  dome.translate(0, 0.042, 0.005)
  const skirt = new THREE.CylinderGeometry(0.128, 0.158, 0.055, 12)
  skirt.scale(1, 1, 1.12)
  skirt.translate(0, -0.004, 0.008)
  const visor = new THREE.BoxGeometry(0.13, 0.014, 0.05)
  visor.translate(0, 0.014, -0.148)
  return mergeGeos([bake(dome, 1, 1, 1), bake(skirt, 0.95, 0.95, 0.95), bake(visor, 0.90, 0.90, 0.90)])
}
function armUpGeo(): THREE.BufferGeometry {
  return bake(new THREE.BoxGeometry(0.105, UPARM_L, 0.115).translate(0, -UPARM_L / 2, 0), 1, 1, 1)
}
/** Sleeve with a bare hand at the wrist. Pivot at elbow. */
function armLoGeo(): THREE.BufferGeometry {
  const sleeve = bake(new THREE.BoxGeometry(0.09, 0.24, 0.10).translate(0, -0.12, 0), 1, 1, 1)
  // Hand tone bakes >1 so multiplying by the drab uniform instance color
  // still lands on a skin-ish tan.
  const hand = bake(new THREE.BoxGeometry(0.055, 0.075, 0.06).translate(0, -0.275, 0), 1.55, 1.30, 1.05)
  return mergeGeos([sleeve, hand])
}
/**
 * SMLE-ish rifle, muzzle toward -z, pivot at the receiver: full wood stock,
 * dropped butt, exposed barrel + front sight, receiver with a bolt handle
 * sticking right, box magazine. Real colors are baked (wood/dark metal);
 * the instance color stays near-white.
 */
function rifleGeo(): THREE.BufferGeometry {
  const WOOD: [number, number, number] = [0.36, 0.26, 0.16]
  const METAL: [number, number, number] = [0.30, 0.31, 0.34]
  const forestock = bake(new THREE.BoxGeometry(0.05, 0.06, 0.72).translate(0, -0.005, -0.30), ...WOOD)
  const buttG = new THREE.BoxGeometry(0.05, 0.095, 0.30)
  buttG.rotateX(0.12)
  buttG.translate(0, -0.022, 0.24)
  const butt = bake(buttG, ...WOOD)
  const barrelG = new THREE.CylinderGeometry(0.016, 0.016, 0.30, 6)
  barrelG.rotateX(Math.PI / 2)
  barrelG.translate(0, 0.012, -0.60)
  const barrel = bake(barrelG, ...METAL)
  const receiver = bake(new THREE.BoxGeometry(0.055, 0.075, 0.16).translate(0, 0.005, 0.02), ...METAL)
  const bolt = bake(new THREE.BoxGeometry(0.06, 0.022, 0.022).translate(0.05, 0.02, 0.045), ...METAL)
  const mag = bake(new THREE.BoxGeometry(0.035, 0.07, 0.10).translate(0, -0.065, -0.02), ...METAL)
  const sightF = bake(new THREE.BoxGeometry(0.012, 0.035, 0.02).translate(0, 0.035, -0.73), ...METAL)
  const sightR = bake(new THREE.BoxGeometry(0.04, 0.02, 0.02).translate(0, 0.048, -0.06), ...METAL)
  return mergeGeos([forestock, butt, barrel, receiver, bolt, mag, sightF, sightR])
}
/** Pack with a blanket roll on top and a mess tin strapped to the back. */
function packGeo(): THREE.BufferGeometry {
  const main = bake(new THREE.BoxGeometry(0.30, 0.30, 0.14), 1, 1, 1)
  const rollG = new THREE.CylinderGeometry(0.055, 0.055, 0.34, 7)
  rollG.rotateZ(Math.PI / 2)
  rollG.translate(0, 0.19, 0)
  const roll = bake(rollG, 0.82, 0.76, 0.62)
  const tin = bake(new THREE.BoxGeometry(0.13, 0.13, 0.035).translate(0, -0.01, 0.085), 0.60, 0.60, 0.55)
  return mergeGeos([main, roll, tin])
}

// ---------------------------------------------------------------------------
// Pose math. Module-level temps: zero per-frame allocation in push().
// A limb box extends along local -y from its pivot, so for limbs POSITIVE rx
// swings the tip toward -z (forward). For the torso (extends +y) NEGATIVE rx
// leans it forward. Knees only flex with negative local rx, elbows positive.
// ---------------------------------------------------------------------------

const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const _c = new THREE.Color()
const _mT = new THREE.Matrix4()
const _mRoot = new THREE.Matrix4()
const _mChest = new THREE.Matrix4()
const _mAim = new THREE.Matrix4()
const _mA = new THREE.Matrix4()
const _mB = new THREE.Matrix4()
const _mC = new THREE.Matrix4()

/** out = parent × T(x,y,z)·R(rx,ry,rz)  (YXZ, matching the sim's yaw-first frame). */
function local(
  out: THREE.Matrix4, parent: THREE.Matrix4,
  x: number, y: number, z: number,
  rx: number, ry: number, rz: number,
): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ')
  _q.setFromEuler(_e)
  _v.set(x, y, z)
  _mT.compose(_v, _q, _s)
  return out.multiplyMatrices(parent, _mT)
}

const fract = (v: number): number => v - Math.floor(v)

export class SoldierRenderer {
  private meshes: THREE.InstancedMesh[] = []
  private counts = new Array<number>(PART_COUNT).fill(0)
  private horses: HorsePool

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02, vertexColors: true })
    const geos: THREE.BufferGeometry[] = []
    geos[Part.ThighL] = thighGeo(); geos[Part.ThighR] = thighGeo()
    geos[Part.CalfL] = calfGeo(); geos[Part.CalfR] = calfGeo()
    geos[Part.Torso] = torsoGeo()
    geos[Part.Head] = headGeo()
    geos[Part.HelmetB] = helmetBritGeo(); geos[Part.HelmetG] = helmetGermanGeo()
    geos[Part.ArmUpL] = armUpGeo(); geos[Part.ArmUpR] = armUpGeo()
    geos[Part.ArmLoL] = armLoGeo(); geos[Part.ArmLoR] = armLoGeo()
    geos[Part.Rifle] = rifleGeo()
    geos[Part.Pack] = packGeo()
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
    if (p.stance === 'dead') { this.poseDead(p); return }

    // Only ride as high as a horse we can actually draw.
    const hasHorse = p.mounted && this.horses.push(p.x, p.y, p.z, p.facing, p.animPhase)

    // Root: position + yaw only. Facing 0 = -z, clockwise from above, and all
    // geometry faces local -z, so yaw = -facing. Body pitch/roll live on the
    // chest/limbs so posture can't flip the visual heading.
    _e.set(0, -p.facing, 0, 'YXZ')
    _q.setFromEuler(_e)
    _v.set(p.x, p.y, p.z)
    _mRoot.compose(_v, _q, _s)

    const raw = p.pitch ?? 0
    const aimPitch = raw > 0.9 ? 0.9 : raw < -0.7 ? -0.7 : raw

    if (hasHorse) this.poseMounted(p)
    else if (p.stance === 'prone') this.poseProne(p, aimPitch)
    else this.poseUpright(p, aimPitch)
  }

  // ---- stand / crouch (idle, walk, charge, shouldered aim, combat kneel) ---
  private poseUpright(p: SoldierPose, aimPitch: number): void {
    const move = p.moveAmount < 0 ? 0 : p.moveAmount > 1 ? 1 : p.moveAmount
    const ph = p.animPhase
    const sinP = Math.sin(ph)
    const cosP = Math.cos(ph)
    const crouched = p.stance === 'crouch'
    const kneeling = crouched && move < 0.35
    const running = move >= 0.65
    const shoulderMode = p.aiming && move < 0.5   // shouldered rifle, cheek weld
    const kick = shoulderMode ? p.recoil * p.recoil : 0

    // Body frame.
    const bob = Math.abs(sinP) * 0.055 * move
    let hipY: number, lean: number
    let twist = 0, roll = 0
    if (kneeling) { hipY = 0.52; lean = 0.16 }
    else if (crouched) { hipY = 0.70 + bob * 0.7; lean = 0.50 }   // hunched advance
    else { hipY = HIP_H - 0.05 * move + bob; lean = 0.05 + 0.34 * move * move }
    if (!kneeling && move > 0.01) {
      roll = 0.06 * sinP * move          // shoulders rock with the stride
      twist = -0.10 * sinP * move        // counter-rotate vs hips
    }
    if (shoulderMode) {
      twist = -0.26                       // bladed: right shoulder back
      lean = (kneeling ? 0.14 : 0.05) - aimPitch * 0.22
    }

    // Legs.
    if (kneeling) {
      // Left boot planted forward, right knee down with the shin flat behind.
      this.limb(Part.ThighL, Part.CalfL, p, -0.10, hipY, 0, 1.35, 0, -0.05, -1.35)
      this.limb(Part.ThighR, Part.CalfR, p, 0.10, hipY, 0, -0.50, 0, 0.10, -1.05)
    } else if (crouched) {
      // Deep-bent legs so boots stay near the ground at the low hip.
      const swing = sinP * 0.40 * move
      this.limb(Part.ThighL, Part.CalfL, p, -0.10, hipY, 0, 0.65 + swing, 0, -0.03,
        -1.15 - 0.40 * move * Math.max(0, cosP))
      this.limb(Part.ThighR, Part.CalfR, p, 0.10, hipY, 0, 0.65 - swing, 0, 0.03,
        -1.15 - 0.40 * move * Math.max(0, -cosP))
    } else {
      // Proper gait: thigh swing + knee that folds through the recovery and
      // arrives straight for heel-strike. Bladed stagger when aiming still.
      const swing = sinP * 0.62 * move
      const stagger = shoulderMode ? 0.10 : 0
      const kneeL = -(1.05 * Math.max(0, cosP) + 0.15) * move
      const kneeR = -(1.05 * Math.max(0, -cosP) + 0.15) * move
      this.limb(Part.ThighL, Part.CalfL, p, -0.10, hipY, 0, swing + stagger, 0, -0.03, kneeL)
      this.limb(Part.ThighR, Part.CalfR, p, 0.10, hipY, 0, -swing - stagger * 1.2, 0, 0.03, kneeR)
    }

    // Torso, pack.
    local(_mChest, _mRoot, 0, hipY, 0, -lean - kick * 0.05, twist, roll)
    this.emit(Part.Torso, p, _mChest)
    local(_mB, _mChest, 0, 0.30, 0.185, 0.06, 0, 0)
    this.emit(Part.Pack, p, _mB)

    // Head + helmet (keep the face level against the body lean).
    let headRx = lean * 0.8
    let headRy = -twist * 0.7
    let headRz = 0
    let headX = 0
    if (shoulderMode) {
      headRx += aimPitch * 0.7           // look along the sights
      headRy = -twist * 0.9 - 0.05
      headRz = 0.15                      // cheek dropped to the stock
      headX = 0.05
    }
    local(_mB, _mChest, headX, HEAD_Y, -0.02, headRx, headRy, headRz)
    this.emit(Part.Head, p, _mB)
    this.emit(p.team === 'brit' ? Part.HelmetB : Part.HelmetG, p, _mB)

    // Arms + rifle.
    if (shoulderMode) {
      // Rifle shouldered: butt in the right shoulder pocket, left arm
      // extended under the forestock, muzzle following aim pitch. Recoil
      // drives the whole piece back into the shoulder with muzzle rise.
      this.arm(p, 1, 0.50 + aimPitch * 0.5, -0.20, 0.50, 1.30 + kick * 0.25, -0.40)
      this.arm(p, -1, 1.00 + aimPitch * 0.75, 0.32, -0.22, 0.55, 0.18)
      // The aim frame cancels the chest blade/lean so the muzzle tracks the
      // sim's facing (bullets leave along `facing`) plus the aim pitch.
      local(_mAim, _mChest, 0.10, SHOULDER_Y - 0.01, 0.02, aimPitch + lean + kick * 0.12, -twist, 0)
      local(_mB, _mAim, 0, 0.03, -0.30 + kick * 0.08, 0, 0, 0)
      this.emit(Part.Rifle, p, _mB)
    } else if (running) {
      // Charge: rifle pumping at low port across the chest, both hands on,
      // hard forward lean doing the "urgent" work.
      this.arm(p, 1, 0.35, -0.10, 0.25, 1.15, -0.30)
      this.arm(p, -1, 0.75, 0.25, -0.30, 0.70, 0.25)
      local(_mB, _mChest, 0.03, 0.26, -0.22, 0.35 + 0.06 * sinP, 0.30, 0.15)
      this.emit(Part.Rifle, p, _mB)
    } else {
      // Walk / halt: rifle carried in the right hand (at the ready when
      // halted, levelling toward the trail on the move); the free left arm
      // counter-swings the legs.
      this.arm(p, -1, -sinP * 0.55 * move - 0.03, 0, -0.08,
        0.22 + Math.max(0, -sinP) * 0.35 * move, 0.10)
      local(_mA, _mChest, SHOULDER_X, SHOULDER_Y, 0, 0.10 + sinP * 0.28 * move, 0, 0.12)
      this.emit(Part.ArmUpR, p, _mA)
      local(_mB, _mA, 0, -UPARM_L, 0, 0.38, 0, -0.10)
      this.emit(Part.ArmLoR, p, _mB)
      local(_mC, _mB, 0, -0.30, 0.01, 1.18 - move * 1.30, 0, 0.06)
      this.emit(Part.Rifle, p, _mC)
    }
  }

  // ---- prone: flat along the ground, feet AWAY from facing, head/rifle at
  // the aim point, chest propped on planted elbows -------------------------
  private poseProne(p: SoldierPose, aimPitch: number): void {
    const kick = p.recoil * p.recoil
    // Torso lies from the hip (behind the anchor) toward -z, chest raised.
    local(_mChest, _mRoot, 0, 0.145, 0.52, -1.28, 0, 0)
    this.emit(Part.Torso, p, _mChest)
    local(_mB, _mChest, 0, 0.30, 0.16, 0, 0, 0)   // pack rides on top of the back
    this.emit(Part.Pack, p, _mB)
    // Head up behind the sights.
    local(_mB, _mChest, 0, HEAD_Y, -0.03, 1.30 + aimPitch * 0.5, 0, 0.02)
    this.emit(Part.Head, p, _mB)
    this.emit(p.team === 'brit' ? Part.HelmetB : Part.HelmetG, p, _mB)
    // Legs trail flat backward (+z), splayed, one heel kicked up.
    this.limb(Part.ThighL, Part.CalfL, p, -0.11, 0.16, 0.56, -1.52, 0, -0.10, -0.18)
    this.limb(Part.ThighR, Part.CalfR, p, 0.11, 0.16, 0.56, -1.50, 0, 0.12, -0.55)
    // Elbows planted, forearms up to the rifle.
    this.arm(p, 1, 1.70, -0.15, 0.35, 1.70 + kick * 0.15, -0.25)
    this.arm(p, -1, 1.78, 0.15, -0.35, 1.60, 0.25)
    // Rifle forward off the ground, following aim pitch, kicking on recoil.
    local(_mB, _mRoot, 0.05, 0.30, -0.26 + kick * 0.06, aimPitch + 0.03 + kick * 0.10, 0, 0)
    this.emit(Part.Rifle, p, _mB)
  }

  // ---- cavalry seat --------------------------------------------------------
  private poseMounted(p: SoldierPose): void {
    const bounce = Math.abs(Math.sin(p.animPhase * 2)) * 0.05
    const hipY = 1.38 + bounce
    // Straddle: thighs forward and out over the barrel, calves down the flanks.
    this.limb(Part.ThighL, Part.CalfL, p, -0.14, hipY, 0.02, 1.05, 0, -0.40, -1.20)
    this.limb(Part.ThighR, Part.CalfR, p, 0.14, hipY, 0.02, 1.05, 0, 0.40, -1.20)
    local(_mChest, _mRoot, 0, hipY, 0, -0.15 - bounce * 0.5, 0, 0)
    this.emit(Part.Torso, p, _mChest)
    local(_mB, _mChest, 0, 0.30, 0.185, 0.05, 0, 0)
    this.emit(Part.Pack, p, _mB)
    local(_mB, _mChest, 0, HEAD_Y, -0.02, 0.12, 0, 0)
    this.emit(Part.Head, p, _mB)
    this.emit(p.team === 'brit' ? Part.HelmetB : Part.HelmetG, p, _mB)
    // Arms forward-down to the reins.
    this.arm(p, 1, 0.55, -0.15, 0.10, 0.55, -0.05)
    this.arm(p, -1, 0.55, 0.15, -0.10, 0.55, 0.05)
    // Rifle slung diagonally across the back.
    local(_mB, _mChest, -0.02, 0.30, 0.26, 1.30, 0, 0.50)
    this.emit(Part.Rifle, p, _mB)
  }

  // ---- the fallen: three collapse families varied by seed, sinking into the
  // mud over deadT, some with a dropped rifle beside them --------------------
  private poseDead(p: SoldierPose): void {
    const sink = Math.min(0.12, p.deadT * 0.002)
    const r1 = fract(p.deadSeed * 0.731 + 0.13)
    const r2 = fract(p.deadSeed * 0.377 + 0.29)
    const r3 = fract(p.deadSeed * 0.193 + 0.71)
    const yawJit = (r2 - 0.5) * 1.2       // bodies rarely align with last facing

    let variant: 0 | 1 | 2
    let pitch: number, roll: number
    if (r1 < 0.40) { variant = 0; pitch = -1.55; roll = (r3 - 0.5) * 0.3 }   // face-down sprawl
    else if (r1 < 0.75) { variant = 1; pitch = 1.52; roll = (r3 - 0.5) * 0.3 } // flat on his back
    else { variant = 2; pitch = -1.35; roll = r3 > 0.5 ? 1.05 : -1.05 }       // crumpled on his side

    _e.set(pitch, -p.facing + yawJit, roll, 'YXZ')
    _q.setFromEuler(_e)
    _v.set(p.x, p.y + 0.16 - sink, p.z)
    _mRoot.compose(_v, _q, _s)

    const hip = 0.32
    local(_mChest, _mRoot, 0, hip, 0, variant === 1 ? 0.10 : -0.10, (r2 - 0.5) * 0.4, 0)
    this.emit(Part.Torso, p, _mChest)
    local(_mB, _mChest, 0, 0.30, 0.185, 0, 0, 0)
    this.emit(Part.Pack, p, _mB)
    // Head lolled to one side.
    local(_mB, _mChest, 0, HEAD_Y, -0.02, variant === 1 ? 0.30 : -0.15, (r3 - 0.5) * 1.6, 0.10)
    this.emit(Part.Head, p, _mB)
    this.emit(p.team === 'brit' ? Part.HelmetB : Part.HelmetG, p, _mB)

    if (variant === 2) {
      // Fetal crumple: both legs drawn up.
      this.limb(Part.ThighL, Part.CalfL, p, -0.10, hip, 0, 0.95, 0, -0.08, -1.25)
      this.limb(Part.ThighR, Part.CalfR, p, 0.10, hip, 0, 0.70, 0, 0.10, -1.00)
    } else {
      const spread = 0.12 + r2 * 0.30
      const kneeUp = variant === 1 && r3 > 0.6   // one knee left standing
      this.limb(Part.ThighL, Part.CalfL, p, -0.10, hip, 0, 0.05, 0, -spread, -0.15 - r2 * 0.4)
      this.limb(Part.ThighR, Part.CalfR, p, 0.10, hip, 0, kneeUp ? 0.55 : -0.02, 0, spread * 0.7,
        kneeUp ? -1.25 : -0.35 * r3)
    }

    if (variant === 1) {
      // On his back, arms flung wide.
      this.arm(p, 1, 0.25, 0, 1.35, 0.35, 0)
      this.arm(p, -1, 2.40, 0, -0.50, 0.30, 0)
    } else if (variant === 0) {
      // Face down, one arm thrown past the head, the other by his side.
      this.arm(p, 1, 2.60, 0, 0.35, 0.25, 0)
      this.arm(p, -1, -0.35, 0, -0.25, 0.45, 0)
    } else {
      // Crumpled, arms folded in.
      this.arm(p, 1, 0.90, 0, 0.30, 1.30, 0)
      this.arm(p, -1, 0.60, 0, -0.20, 1.00, 0)
    }

    // Dropped rifle in the mud beside just over half of the fallen.
    if (r3 > 0.45) {
      const side = r1 > 0.5 ? 1 : -1
      const dist = 0.40 + r2 * 0.35
      _e.set(0, -p.facing + (r2 * 2 - 1) * 2.4, 1.45, 'YXZ')  // flat, rolled on its side
      _q.setFromEuler(_e)
      _v.set(p.x + Math.cos(p.facing) * side * dist, p.y + 0.035 - sink * 0.5,
        p.z + Math.sin(p.facing) * side * dist)
      _mB.compose(_v, _q, _s)
      this.emit(Part.Rifle, p, _mB)
    }
  }

  // ---- helpers --------------------------------------------------------------

  /** Two-segment leg off the root: thigh at the hip, calf folding at the knee. */
  private limb(
    thigh: Part, calf: Part, p: SoldierPose,
    x: number, y: number, z: number,
    rx: number, ry: number, rz: number, knee: number,
  ): void {
    local(_mA, _mRoot, x, y, z, rx, ry, rz)
    this.emit(thigh, p, _mA)
    local(_mB, _mA, 0, -THIGH_L, 0, knee, 0, 0)
    this.emit(calf, p, _mB)
  }

  /** Two-segment arm off the chest. side: 1 = right, -1 = left. */
  private arm(
    p: SoldierPose, side: 1 | -1,
    rx: number, ry: number, rz: number,
    elbow: number, elbowRz: number,
  ): void {
    local(_mA, _mChest, SHOULDER_X * side, SHOULDER_Y, 0, rx, ry, rz)
    this.emit(side === 1 ? Part.ArmUpR : Part.ArmUpL, p, _mA)
    local(_mB, _mA, 0, -UPARM_L, 0, elbow, 0, elbowRz)
    this.emit(side === 1 ? Part.ArmLoR : Part.ArmLoL, p, _mB)
  }

  private emit(part: Part, p: SoldierPose, m: THREE.Matrix4): void {
    const idx = this.counts[part]
    if (idx >= CAP) return
    const mesh = this.meshes[part]
    mesh.setMatrixAt(idx, m)
    switch (part) {
      case Part.Head:
        _c.copy(p.masked ? COL_MASK : COL_SKIN); break
      case Part.Rifle:
        // Near-white: the rifle's true wood/metal tones are baked per-vertex.
        _c.setScalar(0.90 + p.tint * 0.20); break
      case Part.Pack:
        _c.copy(COL_PACK).multiplyScalar(0.90 + p.tint * 0.20); break
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
      mesh.count = this.counts[i]
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    this.horses.finish()
  }
}

/** Small pool of cloned low-poly horses for cavalry waves. buildHorse faces
 * -z (head at negative z), matching the soldiers, so yaw = -facing here too. */
interface HorseEntry {
  group: THREE.Group
  legs: (THREE.Object3D | undefined)[]   // FL, BR, FR, BL (diagonal pairs)
  head?: THREE.Object3D
}

class HorsePool {
  private pool: HorseEntry[] = []
  private used = 0
  constructor(private scene: THREE.Scene) {}

  begin(): void { this.used = 0 }

  push(x: number, y: number, z: number, facing: number, phase: number): boolean {
    if (this.used >= 24) return false
    if (this.used >= this.pool.length) {
      const g = buildHorse()
      g.rotation.order = 'YXZ'   // yaw first so gallop pitch stays body-relative
      this.scene.add(g)
      this.pool.push({
        group: g,
        legs: [
          g.getObjectByName('legFL'), g.getObjectByName('legBR'),
          g.getObjectByName('legFR'), g.getObjectByName('legBL'),
        ],
        head: g.getObjectByName('head'),
      })
    }
    const h = this.pool[this.used++]
    h.group.visible = true
    // Gallop: diagonal pairs with a slight lag, suspension bounce, body rock.
    const beat = phase * 2
    const bounce = Math.abs(Math.sin(beat + 0.6)) * 0.07
    h.group.position.set(x, y + bounce, z)
    h.group.rotation.set(Math.sin(beat) * 0.045, -facing, 0)
    const g1 = Math.sin(beat) * 0.65
    const g2 = Math.sin(beat + 0.35) * 0.65
    if (h.legs[0]) h.legs[0].rotation.x = g1
    if (h.legs[1]) h.legs[1].rotation.x = g1 * 0.9
    if (h.legs[2]) h.legs[2].rotation.x = -g2
    if (h.legs[3]) h.legs[3].rotation.x = -g2 * 0.9
    if (h.head) h.head.rotation.x = 0.35 + Math.sin(beat) * 0.08
    return true
  }

  finish(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].group.visible = false
  }
}
