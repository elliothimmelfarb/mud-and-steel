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

// Two full armies plus their dead (Big Push): living soldiers of both sides,
// marching columns, and the corpse pool all share this instanced budget.
const CAP = 900

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

// --- small builders: limbs read as cloth-wrapped octagonal (chamfered) prisms.
// An 8-gon at soldier scale gives rounded cloth without the cost of a cylinder;
// a slight taper sells the wrap. All limb prisms hang from the pivot at y=0. ---

/** 8-gon prism hanging from the pivot (y=0) down to y=-len; rTop at the pivot,
 *  rBot at the tip. wx/dz squash the octagon into an oval cross-section. */
function prismDown(
  rTop: number, rBot: number, len: number, wx = 1, dz = 1, hSeg = 1,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, 8, hSeg)
  g.rotateY(Math.PI / 8)              // a flat faces front, not an edge
  if (wx !== 1 || dz !== 1) g.scale(wx, 1, dz)
  g.translate(0, -len / 2, 0)
  return g
}

/** Short 8-gon band centred at yc — puttee ridges, cuffs, belts, flares. */
function ring8(
  radius: number, h: number, yc: number, wx = 1, dz = 1,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, h, 8, 1)
  g.rotateY(Math.PI / 8)
  if (wx !== 1 || dz !== 1) g.scale(wx, 1, dz)
  g.translate(0, yc, 0)
  return g
}

/** Upright chamfered slab (torso masses) spanning y0..y1; topR/botR taper it. */
function column8(
  halfX: number, halfZ: number, y0: number, y1: number, topR = 1, botR = 1,
): THREE.BufferGeometry {
  const len = y1 - y0
  const g = new THREE.CylinderGeometry(topR, botR, len, 8, 1)
  g.rotateY(Math.PI / 8)
  g.scale(halfX, 1, halfZ)
  g.translate(0, y0 + len / 2, 0)
  return g
}

/** Creep mud up from the lowest vertices — grounds boots in the Flanders muck. */
function mudFoot(g: THREE.BufferGeometry, yTop: number, yBot: number, amt: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position')
  const col = g.getAttribute('color')
  const span = Math.max(1e-4, yTop - yBot)
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (yTop - pos.getY(i)) / span))
    const k = 1 - amt * t * t
    col.setX(i, col.getX(i) * k)
    col.setY(i, col.getY(i) * k)
    col.setZ(i, col.getZ(i) * k)
  }
  return g
}

/** Thigh: cloth-wrapped octagonal prism with a breeches puff at the hip.
 *  Hangs from the hip pivot down to the knee (-THIGH_L). */
function thighGeo(): THREE.BufferGeometry {
  const main = bake(prismDown(0.092, 0.078, THIGH_L, 0.84, 1.0), 1, 1, 1)
  // Breeches overhang: a fuller band puffed out over the top of the thigh.
  const puff = bake(ring8(0.108, 0.14, -0.075, 0.9, 1.05), 1, 1, 1)
  return mergeGeos([main, puff])
}

/** Knee-to-sole: bloused trouser, ridged puttee wrap, ammo boot with a distinct
 *  heel block and toe cap. Pivot at the knee; sole near y=-0.485 so the standing
 *  leg meets the ground. Boot points -z (forward). */
function calfGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const PU: [number, number, number] = [0.86, 0.80, 0.64]
  const BOOT: [number, number, number] = [0.34, 0.30, 0.27]
  const BOOT_D: [number, number, number] = [0.27, 0.24, 0.21]
  // Trouser bloused over the puttee top (slight knee overhang lip).
  parts.push(bake(prismDown(0.086, 0.07, 0.17, 0.82, 0.94), 1, 1, 1))
  parts.push(bake(ring8(0.094, 0.045, -0.02, 0.84, 0.96), 1, 1, 1))
  // Puttee: four shallow stacked bands with alternating radius = wrap ridges.
  const bandY = [-0.185, -0.245, -0.305, -0.365]
  for (let i = 0; i < 4; i++) {
    parts.push(bake(ring8(i % 2 === 0 ? 0.074 : 0.082, 0.062, bandY[i], 0.86, 0.94), ...PU))
  }
  // Boot: ankle upper, sole+toe, heel block, toe cap.
  parts.push(bake(new THREE.BoxGeometry(0.10, 0.085, 0.155).translate(0, -0.42, -0.02), ...BOOT))
  parts.push(bake(new THREE.BoxGeometry(0.106, 0.05, 0.24).translate(0, -0.462, -0.05), ...BOOT))
  parts.push(bake(new THREE.BoxGeometry(0.10, 0.06, 0.075).translate(0, -0.452, 0.058), ...BOOT_D))
  parts.push(bake(new THREE.BoxGeometry(0.094, 0.05, 0.055).translate(0, -0.44, -0.148), ...BOOT_D))
  return mudFoot(mergeGeos(parts), -0.30, -0.49, 0.42)
}

/** Field tunic + '08 webbing: chamfered torso with a skirt flare, four pockets,
 *  shoulder straps, cross-straps with a buckle, two rows of ammo pouches, a
 *  water bottle on the right hip and a bayonet scabbard on the left. Pivot at
 *  the hip, +y to the shoulders. Kit bakes drab tones over the per-team tint. */
function torsoGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const WEB: [number, number, number] = [0.60, 0.57, 0.47]
  const WEB_D: [number, number, number] = [0.48, 0.45, 0.38]
  const POUCH: [number, number, number] = [0.72, 0.68, 0.55]
  const FLAP: [number, number, number] = [0.90, 0.87, 0.78]
  const LEATHER: [number, number, number] = [0.40, 0.34, 0.27]
  // Main tunic mass (chamfered slab, chest a touch wider than the waist).
  parts.push(bake(column8(0.195, 0.118, 0.05, 0.52, 1.06, 0.94), 1, 1, 1))
  // Tunic skirt flaring below the belt.
  parts.push(bake(column8(0.198, 0.122, 0.0, 0.17, 0.92, 1.06), 1, 1, 1))
  // Belt.
  parts.push(bake(ring8(1, 0.055, 0.155, 0.205, 0.128), ...LEATHER))
  // Collar.
  parts.push(bake(new THREE.BoxGeometry(0.20, 0.05, 0.17).translate(0, TORSO_H + 0.005, -0.005), ...FLAP))
  // Shoulder straps.
  parts.push(bake(new THREE.BoxGeometry(0.055, 0.022, 0.15).translate(-0.135, 0.505, -0.01), ...FLAP))
  parts.push(bake(new THREE.BoxGeometry(0.055, 0.022, 0.15).translate(0.135, 0.505, -0.01), ...FLAP))
  // Breast + skirt pockets (front is -z).
  const pk = (x: number, y: number): THREE.BufferGeometry =>
    bake(new THREE.BoxGeometry(0.10, 0.11, 0.035).translate(x, y, -0.118), ...FLAP)
  parts.push(pk(-0.105, 0.365), pk(0.105, 0.365), pk(-0.115, 0.075), pk(0.115, 0.075))
  // Cross-straps over the chest (X) with a buckle where they meet.
  const sL = new THREE.BoxGeometry(0.05, 0.44, 0.02); sL.rotateZ(0.62); sL.translate(0, 0.33, -0.125)
  const sR = new THREE.BoxGeometry(0.05, 0.44, 0.02); sR.rotateZ(-0.62); sR.translate(0, 0.33, -0.125)
  parts.push(bake(sL, ...WEB), bake(sR, ...WEB))
  parts.push(bake(new THREE.BoxGeometry(0.05, 0.045, 0.025).translate(0, 0.33, -0.132), ...WEB_D))
  // Ammo pouches: two rows of three across the chest.
  for (let r = 0; r < 2; r++) {
    for (let c = -1; c <= 1; c++) {
      parts.push(bake(
        new THREE.BoxGeometry(0.072, 0.07, 0.045).translate(c * 0.088, 0.30 - r * 0.085, -0.14),
        ...POUCH))
    }
  }
  // Water bottle on the right hip (+x).
  const wb = new THREE.CylinderGeometry(0.052, 0.052, 0.10, 8); wb.rotateY(Math.PI / 8)
  wb.translate(0.198, 0.12, 0.03)
  parts.push(bake(wb, 0.66, 0.62, 0.50))
  const cap = new THREE.CylinderGeometry(0.03, 0.03, 0.02, 6); cap.rotateY(Math.PI / 6)
  cap.translate(0.198, 0.175, 0.03)
  parts.push(bake(cap, ...WEB_D))
  // Bayonet scabbard hanging at the left hip (-x).
  const sc = new THREE.BoxGeometry(0.028, 0.32, 0.04); sc.rotateX(-0.12); sc.translate(-0.185, -0.01, 0.06)
  parts.push(bake(sc, ...LEATHER))
  parts.push(bake(new THREE.BoxGeometry(0.04, 0.05, 0.05).translate(-0.185, 0.15, 0.045), ...WEB_D))
  return mergeGeos(parts)
}

/** Head: cranium with a narrowed jaw + chin hint and a neck stub so the helmet
 *  doesn't float. Bakes ~white; the instance color supplies skin/mask tone,
 *  the neck a touch darker for the shadow under the jaw. */
function headGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const cranium = new THREE.SphereGeometry(0.093, 8, 6)
  cranium.scale(0.95, 1.0, 0.98); cranium.translate(0, 0.015, 0)
  parts.push(bake(cranium, 1, 1, 1))
  // Jaw: narrower lower block pushed slightly forward (front is -z).
  parts.push(bake(new THREE.BoxGeometry(0.12, 0.075, 0.13).translate(0, -0.058, -0.012), 1, 1, 1))
  // Chin.
  parts.push(bake(new THREE.BoxGeometry(0.055, 0.04, 0.045).translate(0, -0.088, -0.055), 1, 1, 1))
  // Neck stub toward the collar.
  const neck = new THREE.CylinderGeometry(0.05, 0.055, 0.10, 8); neck.rotateY(Math.PI / 8)
  neck.translate(0, -0.075, 0.005)
  parts.push(bake(neck, 0.82, 0.80, 0.78))
  return mergeGeos(parts)
}

/** Brodie: a wide, thin brim under a shallow bowl with a tiny top boss.
 *  Shares the head matrix. */
function helmetBritGeo(): THREE.BufferGeometry {
  // Deep enough to clear the cranium crown (head yMax 0.108): rim tucks under the
  // brim (~0.039) while the bowl top reaches ~0.120 so no skull pokes through.
  const bowl = new THREE.SphereGeometry(0.115, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.46)
  bowl.scale(1, 0.80, 1); bowl.translate(0, 0.028, 0)
  // Broad thin brim, edge angled down a hair (topR < botR).
  const brim = new THREE.CylinderGeometry(0.188, 0.198, 0.012, 16); brim.translate(0, 0.04, 0)
  const boss = new THREE.CylinderGeometry(0.016, 0.02, 0.014, 8); boss.translate(0, 0.122, 0)
  return mergeGeos([bake(bowl, 1, 1, 1), bake(brim, 0.94, 0.94, 0.94), bake(boss, 0.90, 0.90, 0.90)])
}

/** Stahlhelm: a deep dome dropped at the back, a flared ear/neck skirt, a front
 *  visor lip and the two signature side lugs. */
function helmetGermanGeo(): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(0.116, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.56)
  dome.scale(1, 0.90, 1.05); dome.translate(0, 0.04, 0.008)
  // Flared skirt, deeper at the back (+z) for the neck guard.
  const skirt = new THREE.CylinderGeometry(0.122, 0.156, 0.06, 14)
  skirt.scale(1, 1, 1.14); skirt.translate(0, -0.01, 0.012)
  const visor = new THREE.BoxGeometry(0.15, 0.016, 0.055); visor.translate(0, 0.012, -0.15)
  // Ventilation lugs sticking out either side.
  const lugL = new THREE.CylinderGeometry(0.014, 0.014, 0.03, 6); lugL.rotateZ(Math.PI / 2); lugL.translate(-0.14, 0.03, 0.01)
  const lugR = new THREE.CylinderGeometry(0.014, 0.014, 0.03, 6); lugR.rotateZ(Math.PI / 2); lugR.translate(0.14, 0.03, 0.01)
  return mergeGeos([
    bake(dome, 1, 1, 1), bake(skirt, 0.96, 0.96, 0.96), bake(visor, 0.92, 0.92, 0.92),
    bake(lugL, 0.78, 0.78, 0.78), bake(lugR, 0.78, 0.78, 0.78),
  ])
}

/** Upper sleeve: cloth-wrapped octagonal prism, slight taper to the elbow. */
function armUpGeo(): THREE.BufferGeometry {
  return bake(prismDown(0.058, 0.052, UPARM_L, 0.95, 1.05), 1, 1, 1)
}

/** Forearm sleeve tapering to a rolled cuff, then a bare fist at the wrist.
 *  The fist bakes warm (>1) so the drab team instance color still reads skin. */
function armLoGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(bake(prismDown(0.052, 0.042, 0.235, 0.95, 1.02), 1, 1, 1))
  parts.push(bake(ring8(0.05, 0.03, -0.225, 0.98, 1.05), 0.92, 0.90, 0.82))
  const fist = new THREE.SphereGeometry(0.045, 6, 5); fist.scale(0.9, 0.95, 1.05); fist.translate(0, -0.275, 0.005)
  parts.push(bake(fist, 1.55, 1.30, 1.05))
  return mergeGeos(parts)
}

/**
 * SMLE, muzzle toward -z, pivot at the receiver: full wood stock with a dropped
 * butt and metal butt plate, barrel with a nose cap at the muzzle, receiver with
 * a right-side bolt handle knob, pronounced box magazine, trigger-guard loop,
 * front blade + rear leaf sights, and a leather sling down the left side. Real
 * wood/metal/leather tones are baked; the instance color stays near-white.
 */
function rifleGeo(): THREE.BufferGeometry {
  const WOOD: [number, number, number] = [0.36, 0.26, 0.16]
  const METAL: [number, number, number] = [0.30, 0.31, 0.34]
  const METAL_D: [number, number, number] = [0.20, 0.21, 0.23]
  const LEATHER: [number, number, number] = [0.30, 0.22, 0.14]
  const parts: THREE.BufferGeometry[] = []
  // Wood: forestock + dropped butt with a metal butt plate.
  parts.push(bake(new THREE.BoxGeometry(0.05, 0.062, 0.72).translate(0, -0.005, -0.30), ...WOOD))
  const butt = new THREE.BoxGeometry(0.052, 0.098, 0.30); butt.rotateX(0.12); butt.translate(0, -0.024, 0.24)
  parts.push(bake(butt, ...WOOD))
  const plate = new THREE.BoxGeometry(0.05, 0.10, 0.02); plate.rotateX(0.12); plate.translate(0, -0.041, 0.392)
  parts.push(bake(plate, ...METAL_D))
  // Barrel + nose cap at the muzzle.
  const barrel = new THREE.CylinderGeometry(0.015, 0.016, 0.30, 8); barrel.rotateX(Math.PI / 2); barrel.translate(0, 0.012, -0.60)
  parts.push(bake(barrel, ...METAL))
  parts.push(bake(new THREE.BoxGeometry(0.042, 0.05, 0.06).translate(0, 0.008, -0.72), ...METAL_D))
  // Receiver, pronounced magazine.
  parts.push(bake(new THREE.BoxGeometry(0.056, 0.078, 0.17).translate(0, 0.006, 0.02), ...METAL))
  parts.push(bake(new THREE.BoxGeometry(0.045, 0.09, 0.11).translate(0, -0.072, -0.02), ...METAL_D))
  // Trigger-guard loop + trigger.
  const guard = new THREE.TorusGeometry(0.024, 0.005, 4, 10); guard.rotateY(Math.PI / 2); guard.translate(0, -0.05, 0.0)
  parts.push(bake(guard, ...METAL_D))
  parts.push(bake(new THREE.BoxGeometry(0.012, 0.03, 0.012).translate(0, -0.045, 0.0), ...METAL_D))
  // Bolt: stub + spherical handle knob on the right (+x).
  parts.push(bake(new THREE.BoxGeometry(0.055, 0.02, 0.02).translate(0.05, 0.022, 0.05), ...METAL))
  const knob = new THREE.SphereGeometry(0.016, 6, 5); knob.translate(0.082, 0.022, 0.05)
  parts.push(bake(knob, ...METAL))
  // Sights: front blade + rear leaf.
  parts.push(bake(new THREE.BoxGeometry(0.012, 0.035, 0.02).translate(0, 0.036, -0.73), ...METAL_D))
  parts.push(bake(new THREE.BoxGeometry(0.045, 0.028, 0.014).translate(0, 0.05, -0.06), ...METAL_D))
  // Sling: thin flat strap down the left (-x) side, stock to forestock.
  const sling = new THREE.BoxGeometry(0.008, 0.05, 0.66); sling.rotateX(0.02); sling.translate(-0.03, -0.055, -0.14)
  parts.push(bake(sling, ...LEATHER))
  return mergeGeos(parts)
}

/** Large pack: canvas satchel, blanket roll on top, rolled groundsheet beneath,
 *  mess tin + entrenching-tool head & helve on the rear face, strap ridges and a
 *  respirator satchel on top. Instance color is the drab pack tone; kit bakes
 *  cooler (steel) or warmer (wood) offsets over it. Outer face is +z. */
function packGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const CANVAS: [number, number, number] = [0.95, 0.90, 0.78]
  const STRAP: [number, number, number] = [0.66, 0.60, 0.50]
  const STEEL: [number, number, number] = [0.90, 1.00, 1.50]
  const WOOD: [number, number, number] = [1.35, 1.05, 0.72]
  // Main body.
  parts.push(bake(new THREE.BoxGeometry(0.30, 0.30, 0.14), 1, 1, 1))
  // Blanket roll on top (horizontal cylinder along x).
  const roll = new THREE.CylinderGeometry(0.055, 0.055, 0.34, 8); roll.rotateZ(Math.PI / 2); roll.translate(0, 0.185, 0.0)
  parts.push(bake(roll, ...CANVAS))
  // Rolled groundsheet beneath the pack.
  const ground = new THREE.CylinderGeometry(0.05, 0.05, 0.32, 8); ground.rotateZ(Math.PI / 2); ground.translate(0, -0.185, 0.01)
  parts.push(bake(ground, 0.80, 0.78, 0.68))
  // Mess tin on the rear face.
  parts.push(bake(new THREE.BoxGeometry(0.14, 0.13, 0.035).translate(0.0, -0.02, 0.09), ...STEEL))
  // Entrenching-tool head (T) on the rear face.
  parts.push(bake(new THREE.BoxGeometry(0.13, 0.045, 0.03).translate(0.02, 0.10, 0.085), ...STEEL))
  parts.push(bake(new THREE.BoxGeometry(0.03, 0.10, 0.03).translate(0.02, 0.05, 0.085), ...STEEL))
  // Entrenching-tool helve strapped diagonally.
  const helve = new THREE.CylinderGeometry(0.014, 0.014, 0.30, 6); helve.rotateZ(0.5); helve.translate(-0.02, -0.02, 0.082)
  parts.push(bake(helve, ...WOOD))
  // Strap ridges over the rolls.
  parts.push(bake(new THREE.BoxGeometry(0.03, 0.34, 0.02).translate(-0.09, 0.0, 0.075), ...STRAP))
  parts.push(bake(new THREE.BoxGeometry(0.03, 0.34, 0.02).translate(0.09, 0.0, 0.075), ...STRAP))
  // Respirator satchel perched on top.
  parts.push(bake(new THREE.BoxGeometry(0.16, 0.09, 0.07).translate(-0.02, 0.27, 0.02), 0.90, 0.88, 0.80))
  return mergeGeos(parts)
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
  /** Built once; pool growth clones it (shared geometry/materials, names kept).
   *  The upgraded horse is ~60 merged parts — building 24 of them from scratch
   *  across the first frames of a cavalry charge stuttered the charge. */
  private template: THREE.Group | null = null
  constructor(private scene: THREE.Scene) {}

  begin(): void { this.used = 0 }

  push(x: number, y: number, z: number, facing: number, phase: number): boolean {
    if (this.used >= 24) return false
    if (this.used >= this.pool.length) {
      if (!this.template) this.template = buildHorse()
      const g = this.template.clone(true)
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
