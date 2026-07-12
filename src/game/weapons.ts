/**
 * The player's arsenal in first person. Every buildable unit has a weapon
 * profile here: how its trigger behaves, how its viewmodel is built, and — the
 * heart of it — how one discharge turns into the SAME physically-simulated
 * bullet, lobbed bomb, flat shell, flame cone or gas drum that the AI crews
 * fire. Man a rifleman and you work a bolt; man the Vickers and you hold the
 * spade grips while the jacket boils; man the Stokes and you drop bombs where
 * your sight is laid. One data table, one discharge switch — the sim does the
 * rest exactly as it does for everyone else on the field.
 */
import * as THREE from 'three'
import type { Soldier, Unit, UnitKindId, Vec3 } from '../core/types'
import { COMBAT, UNIT_DEFS } from '../core/config'
import { fireBullet, standSurface } from '../sim/ballistics'
import {
  spawnGrenade, spawnMortarBombAt, spawnDirectShell, spawnGasShell,
} from '../sim/projectiles'
import { flameCone } from '../sim/soldiers'
import type { Ctx } from '../sim/sim'
import type { SfxName } from '../audio/audio'
import type { Game } from './game'

// ---------------------------------------------------------------------------
// Profile shape
// ---------------------------------------------------------------------------

/**
 * How the trigger behaves:
 *  bolt      — one shot per click, then work the bolt (rifle, sniper)
 *  semi      — one shot per click, quick reset (officer's Webley)
 *  auto      — held: repeats at the cyclic rate (Lewis, Vickers)
 *  throw     — click lobs a grenade to the aim point on the ground
 *  lob       — click drops indirect ordnance on the ground reticle (mortar, gas)
 *  directgun — click fires a flat shell down the sight line (18-pounder)
 *  flame     — held: a cone of burning fuel (flame projector)
 *  tool      — held: mend/heal by hand (sapper, stretcher bearer — no ordnance)
 */
export type FireControl =
  | 'bolt' | 'semi' | 'auto' | 'throw' | 'lob' | 'directgun' | 'flame' | 'tool'

export type AmmoKind = 'mag' | 'grenades' | 'shells' | 'bombs' | 'drums' | 'fuel' | 'none'

export interface VmPose { x: number; y: number; z: number; rx: number; ry: number; rz?: number }

export interface Viewmodel {
  group: THREE.Group
  /** Local-space muzzle tip (for flash placement in poses that want it). */
  muzzle: THREE.Vector3
  /** Bolt handle mesh (bolt-action weapons animate it after each shot). */
  bolt?: THREE.Mesh
  /** A part that slides straight back on recoil (field-gun barrel, MG bolt). */
  recoilPart?: THREE.Object3D
  restRecoilZ?: number
}

export interface WeaponProfile {
  id: UnitKindId
  name: string
  control: FireControl
  ammoKind: AmmoKind
  /** Rounds/shells/bombs/drums/grenades before a reload (fuel/tool ignore). */
  magSize: number
  /** Seconds between discharges (bolt cycle, semi reset, auto cyclic period). */
  fireInterval: number
  reloadTime: number
  /** Recoil impulse, 0..~1.4. Drives kick, screen shake and viewmodel punch. */
  recoil: number
  hipFov: number
  adsFov: number
  /** Emplaced weapons pin the man to his gun — traverse and elevate, don't walk. */
  emplaced: boolean
  scope: boolean
  /** Vickers: sustained fire boils the jacket; player watches the heat gauge. */
  heat: boolean
  spreadHip: number
  spreadAds: number
  category: string
  sound: SfxName
  tracerChance: number
  /** HUD ammunition label, e.g. '.303 SMLE'. */
  ammoName: string
  /** One-line controls hint under the ammo counter. */
  controlsHint: string
  /** Indirect/thrown weapons clamp their aim point to this band (metres). */
  minRange: number
  maxRange: number
  hip: VmPose
  aim: VmPose
  build: () => Viewmodel
}

// ---------------------------------------------------------------------------
// Shared viewmodel materials (session-lived, safe to share across meshes)
// ---------------------------------------------------------------------------

const EM = 0.55 // emissive lift so the viewmodel reads with the sun behind you

function mkMat(color: number, rough: number, metal: number, emissive: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, emissive, emissiveIntensity: EM,
  })
}

const MAT = {
  wood: mkMat(0x8a5c30, 0.72, 0.04, 0x241505),
  darkWood: mkMat(0x6b4423, 0.78, 0.04, 0x1b0f04),
  steel: mkMat(0x4a4e55, 0.42, 0.72, 0x0c0e12),
  blued: mkMat(0x2e3238, 0.35, 0.8, 0x08090c),
  brass: mkMat(0x9a7a42, 0.5, 0.6, 0x1a1206),
  canvas: mkMat(0x6d6a4c, 0.9, 0.02, 0x161507),
  copper: mkMat(0x7d5233, 0.5, 0.55, 0x180c05),
  paint: mkMat(0x55603f, 0.75, 0.2, 0x121607), // field-grey ordnance paint
  glass: mkMat(0x0a0d10, 0.2, 0.3, 0x05070a),
  dressing: mkMat(0xd8cfb4, 0.85, 0.0, 0x2a271d),
  flesh: mkMat(0xa97a55, 0.85, 0.0, 0x201509),
} as const

function part(
  g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material,
  x: number, y: number, z: number, rx = 0, ry = 0, rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  m.rotation.set(rx, ry, rz)
  g.add(m)
  return m
}

function finish(g: THREE.Group, scale: number): void {
  g.scale.setScalar(scale)
  g.traverse((o) => { (o as THREE.Mesh).castShadow = false; o.frustumCulled = false })
}

// ---------------------------------------------------------------------------
// Viewmodel builders — butt/breech toward +Z, muzzle toward −Z
// ---------------------------------------------------------------------------

function buildRifle(scope = false): Viewmodel {
  const g = new THREE.Group()
  part(g, new THREE.BoxGeometry(0.055, 0.11, 0.34), MAT.wood, 0, -0.02, 0.28)
  part(g, new THREE.BoxGeometry(0.05, 0.075, 0.28), MAT.darkWood, 0, 0.005, -0.02)
  part(g, new THREE.BoxGeometry(0.052, 0.06, 0.16), MAT.steel, 0, 0.045, -0.03)
  part(g, new THREE.BoxGeometry(0.048, 0.062, 0.62), MAT.wood, 0, 0.015, -0.42)
  const barrel = new THREE.CylinderGeometry(0.011, 0.011, 0.78, 8); barrel.rotateX(Math.PI / 2)
  part(g, barrel, MAT.steel, 0, 0.052, -0.5)
  part(g, new THREE.BoxGeometry(0.012, 0.035, 0.012), MAT.steel, 0, 0.082, -0.86)
  part(g, new THREE.BoxGeometry(0.05, 0.03, 0.02), MAT.steel, 0, 0.075, -0.12)
  part(g, new THREE.BoxGeometry(0.03, 0.014, 0.1), MAT.brass, 0, -0.005, 0.1)
  const bolt = new THREE.CylinderGeometry(0.012, 0.012, 0.07, 8)
  const boltMesh = part(g, bolt, MAT.steel, 0.05, 0.05, 0.02); boltMesh.rotation.z = -0.9
  if (scope) {
    const tube = new THREE.CylinderGeometry(0.02, 0.02, 0.3, 12); tube.rotateX(Math.PI / 2)
    part(g, tube, MAT.blued, 0, 0.11, -0.18)
    part(g, new THREE.CylinderGeometry(0.026, 0.026, 0.03, 12).rotateX(Math.PI / 2), MAT.blued, 0, 0.11, -0.33)
    part(g, new THREE.BoxGeometry(0.012, 0.05, 0.012), MAT.steel, 0, 0.085, -0.08)
    part(g, new THREE.BoxGeometry(0.012, 0.05, 0.012), MAT.steel, 0, 0.085, -0.28)
  }
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.052, -0.89), bolt: boltMesh }
  finish(g, 0.82)
  return vm
}

function buildLewis(): Viewmodel {
  const g = new THREE.Group()
  // Fat aluminium cooling shroud + slim barrel inside.
  const shroud = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 14); shroud.rotateX(Math.PI / 2)
  part(g, shroud, MAT.steel, 0, 0.03, -0.5)
  const barrel = new THREE.CylinderGeometry(0.014, 0.014, 0.2, 8); barrel.rotateX(Math.PI / 2)
  part(g, barrel, MAT.blued, 0, 0.03, -0.86)
  // Receiver + wooden butt + pistol grip.
  part(g, new THREE.BoxGeometry(0.07, 0.09, 0.3), MAT.blued, 0, 0.02, -0.05)
  part(g, new THREE.BoxGeometry(0.05, 0.1, 0.22), MAT.darkWood, 0, -0.01, 0.24)
  part(g, new THREE.BoxGeometry(0.04, 0.11, 0.05), MAT.darkWood, 0, -0.08, 0.06, 0.25)
  // The signature drum: a flat pan magazine lying flat on top.
  const pan = new THREE.CylinderGeometry(0.1, 0.1, 0.04, 20)
  part(g, pan, MAT.steel, 0, 0.09, -0.02)
  part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12), MAT.blued, 0, 0.1, -0.02)
  // Bipod hint near the muzzle.
  part(g, new THREE.BoxGeometry(0.012, 0.14, 0.012), MAT.steel, 0.035, -0.05, -0.7, 0, 0, 0.35)
  part(g, new THREE.BoxGeometry(0.012, 0.14, 0.012), MAT.steel, -0.035, -0.05, -0.7, 0, 0, -0.35)
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.03, -0.95) }
  finish(g, 0.8)
  return vm
}

function buildVickers(): Viewmodel {
  const g = new THREE.Group()
  // Corrugated water jacket — the thing that lets it fire all day.
  const jacket = new THREE.CylinderGeometry(0.075, 0.075, 0.66, 16); jacket.rotateX(Math.PI / 2)
  part(g, jacket, MAT.steel, 0, 0.06, -0.5)
  // Barrel poking from the jacket + muzzle cone.
  part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8).rotateX(Math.PI / 2), MAT.blued, 0, 0.06, -0.9)
  part(g, new THREE.CylinderGeometry(0.045, 0.03, 0.06, 10).rotateX(Math.PI / 2), MAT.blued, 0, 0.06, -0.84)
  // Feed block + brass belt stub on the right.
  part(g, new THREE.BoxGeometry(0.16, 0.12, 0.22), MAT.blued, 0, 0.04, -0.06)
  part(g, new THREE.BoxGeometry(0.03, 0.06, 0.14), MAT.brass, 0.11, 0.03, -0.05)
  // Twin spade grips + the thumb trigger you're pressing.
  part(g, new THREE.BoxGeometry(0.03, 0.13, 0.03), MAT.blued, 0.09, -0.06, 0.12, -0.25)
  part(g, new THREE.BoxGeometry(0.03, 0.13, 0.03), MAT.blued, -0.09, -0.06, 0.12, 0.25)
  part(g, new THREE.BoxGeometry(0.22, 0.03, 0.03), MAT.blued, 0, 0.0, 0.16)
  // Tripod cradle dropping out of view.
  part(g, new THREE.BoxGeometry(0.02, 0.24, 0.02), MAT.paint, 0, -0.22, 0.02, 0.15)
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.06, -0.96) }
  finish(g, 0.82)
  return vm
}

function buildPistol(): Viewmodel {
  const g = new THREE.Group()
  part(g, new THREE.BoxGeometry(0.03, 0.06, 0.12), MAT.blued, 0, 0.01, -0.03) // frame
  const barrel = new THREE.CylinderGeometry(0.01, 0.01, 0.13, 8); barrel.rotateX(Math.PI / 2)
  part(g, barrel, MAT.blued, 0, 0.03, -0.12)
  part(g, new THREE.CylinderGeometry(0.028, 0.028, 0.05, 12).rotateX(Math.PI / 2), MAT.steel, 0, 0.01, -0.02) // cylinder
  part(g, new THREE.BoxGeometry(0.028, 0.1, 0.045), MAT.darkWood, 0, -0.06, 0.05, 0.38) // grip
  part(g, new THREE.BoxGeometry(0.008, 0.02, 0.008), MAT.steel, 0, 0.055, -0.17) // front sight
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.03, -0.19) }
  finish(g, 0.95)
  return vm
}

function buildGrenade(): Viewmodel {
  const g = new THREE.Group()
  // A throwing hand cradling a Mills bomb, cocked back ready to hurl.
  part(g, new THREE.BoxGeometry(0.08, 0.05, 0.1), MAT.flesh, 0, 0, 0.02) // palm
  for (let i = 0; i < 4; i++) {
    part(g, new THREE.BoxGeometry(0.016, 0.02, 0.05), MAT.flesh, -0.03 + i * 0.02, 0.02, -0.04, -0.5)
  }
  const bomb = new THREE.SphereGeometry(0.045, 12, 10); bomb.scale(1, 1.2, 1)
  part(g, bomb, MAT.paint, 0, 0.05, -0.02)
  // Cast-iron fragmentation grooves.
  for (let i = 0; i < 3; i++) {
    part(g, new THREE.TorusGeometry(0.046, 0.006, 6, 14), MAT.blued, 0, 0.02 + i * 0.03, -0.02, Math.PI / 2)
  }
  part(g, new THREE.CylinderGeometry(0.012, 0.012, 0.03, 8), MAT.steel, 0, 0.1, -0.02) // lever/spoon top
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.05, -0.02) }
  finish(g, 1.0)
  return vm
}

function buildMortar(): Viewmodel {
  const g = new THREE.Group()
  // Stokes tube rising up and away over the parapet; you drop bombs down it.
  const tube = new THREE.CylinderGeometry(0.06, 0.065, 0.85, 16)
  const tubeMesh = part(g, tube, MAT.blued, 0, 0.12, -0.42)
  tubeMesh.rotation.x = -1.15 // muzzle up-and-forward
  part(g, new THREE.CylinderGeometry(0.07, 0.07, 0.04, 16), MAT.steel, 0.32, 0.44, -0.72, -1.15) // muzzle collar
  // Baseplate at your feet + bipod.
  part(g, new THREE.BoxGeometry(0.26, 0.03, 0.22), MAT.paint, 0, -0.16, -0.1)
  part(g, new THREE.BoxGeometry(0.02, 0.3, 0.02), MAT.steel, 0.1, 0.0, -0.35, 0, 0, -0.35)
  part(g, new THREE.BoxGeometry(0.02, 0.3, 0.02), MAT.steel, -0.1, 0.0, -0.35, 0, 0, 0.35)
  part(g, new THREE.BoxGeometry(0.03, 0.03, 0.14), MAT.brass, 0.02, 0.16, -0.28) // elevation screw
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0.34, 0.46, -0.76) }
  finish(g, 0.85)
  return vm
}

function buildFieldgun(): Viewmodel {
  const g = new THREE.Group()
  // You crouch behind the breech; the shield frames the view, barrel poking out.
  part(g, new THREE.BoxGeometry(0.5, 0.42, 0.04), MAT.paint, 0, 0.05, -0.28) // shield
  part(g, new THREE.BoxGeometry(0.12, 0.1, 0.06), MAT.blued, 0.12, 0.16, -0.27) // sight box on shield
  const barrel = new THREE.CylinderGeometry(0.05, 0.055, 0.7, 16); barrel.rotateX(Math.PI / 2)
  const barrelMesh = part(g, barrel, MAT.blued, 0, 0.06, -0.55)
  part(g, new THREE.CylinderGeometry(0.06, 0.06, 0.05, 16).rotateX(Math.PI / 2), MAT.steel, 0, 0.06, -0.88) // muzzle
  // Breech block + interrupted-screw handle right in front of you.
  part(g, new THREE.BoxGeometry(0.16, 0.16, 0.16), MAT.steel, 0, 0.05, -0.02)
  part(g, new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12).rotateX(Math.PI / 2), MAT.blued, 0, 0.05, 0.06)
  part(g, new THREE.BoxGeometry(0.03, 0.14, 0.03), MAT.darkWood, 0.12, -0.02, 0.02, 0, 0, -0.3) // firing lever
  // Recoil cylinder under the barrel.
  part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.5, 10).rotateX(Math.PI / 2), MAT.paint, 0, -0.02, -0.5)
  const vm: Viewmodel = {
    group: g, muzzle: new THREE.Vector3(0, 0.06, -0.9),
    recoilPart: barrelMesh, restRecoilZ: barrelMesh.position.z,
  }
  finish(g, 0.9)
  return vm
}

function buildFlamer(): Viewmodel {
  const g = new THREE.Group()
  // Lance held to the right, nozzle forward; the tank rides your back off-screen.
  const lance = new THREE.CylinderGeometry(0.016, 0.016, 0.8, 10); lance.rotateX(Math.PI / 2)
  part(g, lance, MAT.steel, 0, 0.0, -0.4)
  part(g, new THREE.CylinderGeometry(0.03, 0.018, 0.1, 12).rotateX(Math.PI / 2), MAT.blued, 0, 0.0, -0.82) // nozzle
  part(g, new THREE.TorusGeometry(0.03, 0.008, 6, 12), MAT.copper, 0, 0.0, -0.78, Math.PI / 2) // igniter ring
  part(g, new THREE.BoxGeometry(0.03, 0.1, 0.04), MAT.darkWood, 0.0, -0.07, 0.06, 0.3) // grip
  part(g, new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8).rotateX(Math.PI / 2), MAT.canvas, -0.02, -0.02, 0.16, 0, 0.3) // fuel hose
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.0, -0.9) }
  finish(g, 0.9)
  return vm
}

function buildGasProjector(): Viewmodel {
  const g = new THREE.Group()
  // A Livens drum seated in its buried tube, fired by the exploder box you hold.
  const tube = new THREE.CylinderGeometry(0.11, 0.12, 0.5, 16)
  const tubeMesh = part(g, tube, MAT.paint, 0.12, 0.0, -0.4); tubeMesh.rotation.x = -1.28
  const drum = new THREE.CylinderGeometry(0.095, 0.095, 0.16, 16)
  part(g, drum, MAT.copper, 0.19, 0.2, -0.55, -1.28) // gas drum in the mouth
  part(g, new THREE.BoxGeometry(0.14, 0.09, 0.1), MAT.darkWood, -0.14, -0.06, 0.04) // exploder dynamo box
  part(g, new THREE.CylinderGeometry(0.012, 0.012, 0.08, 8), MAT.steel, -0.14, 0.02, 0.04) // plunger
  part(g, new THREE.BoxGeometry(0.24, 0.03, 0.2), MAT.paint, 0.05, -0.2, -0.14) // baseplate
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0.2, 0.24, -0.6) }
  finish(g, 0.85)
  return vm
}

function buildToolkit(kind: 'medic' | 'engineer'): Viewmodel {
  const g = new THREE.Group()
  part(g, new THREE.BoxGeometry(0.08, 0.05, 0.11), MAT.flesh, 0.0, -0.02, 0.0) // hand
  for (let i = 0; i < 4; i++) {
    part(g, new THREE.BoxGeometry(0.016, 0.02, 0.05), MAT.flesh, -0.03 + i * 0.02, 0.0, -0.06, -0.4)
  }
  if (kind === 'medic') {
    // A rolled field dressing with a red cross.
    const roll = new THREE.CylinderGeometry(0.035, 0.035, 0.08, 14); roll.rotateZ(Math.PI / 2)
    part(g, roll, MAT.dressing, 0, 0.03, -0.05)
    part(g, new THREE.BoxGeometry(0.05, 0.012, 0.016), mkMat(0xa8302a, 0.7, 0.0, 0x2a0806), 0, 0.066, -0.05)
    part(g, new THREE.BoxGeometry(0.016, 0.012, 0.05), mkMat(0xa8302a, 0.7, 0.0, 0x2a0806), 0, 0.066, -0.05)
  } else {
    // An entrenching spade held ready to shore up the parapet.
    part(g, new THREE.CylinderGeometry(0.01, 0.01, 0.34, 8).rotateX(Math.PI / 2), MAT.darkWood, 0, 0.02, -0.16)
    part(g, new THREE.BoxGeometry(0.12, 0.02, 0.14), MAT.steel, 0, 0.02, -0.34)
  }
  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0, -0.1) }
  finish(g, 1.0)
  return vm
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const RIFLE_HIP: VmPose = { x: 0.19, y: -0.22, z: -0.46, rx: 0.06, ry: 0.06 }
const RIFLE_AIM: VmPose = { x: 0, y: -0.083, z: -0.32, rx: 0, ry: 0 }

export const WEAPON_PROFILES: Record<UnitKindId, WeaponProfile> = {
  rifleman: {
    id: 'rifleman', name: 'Rifleman', control: 'bolt', ammoKind: 'mag',
    magSize: 10, fireInterval: 1.05, reloadTime: 3.0, recoil: 1,
    hipFov: 55, adsFov: 32, emplaced: false, scope: false, heat: false,
    spreadHip: 0.012, spreadAds: 0.0022, category: 'rifle', sound: 'rifle', tracerChance: COMBAT.tracerFraction,
    ammoName: '.303 SMLE', controlsHint: 'LMB fire · RMB aim · R reload · C stance · SHIFT run',
    minRange: 0, maxRange: 0, hip: RIFLE_HIP, aim: RIFLE_AIM, build: () => buildRifle(false),
  },
  lewis: {
    id: 'lewis', name: 'Lewis Gunner', control: 'auto', ammoKind: 'mag',
    magSize: 47, fireInterval: 0.11, reloadTime: 3.6, recoil: 0.62,
    hipFov: 58, adsFov: 40, emplaced: false, scope: false, heat: false,
    spreadHip: 0.02, spreadAds: 0.007, category: 'rifle', sound: 'mg', tracerChance: 0.5,
    ammoName: '.303 Lewis pan', controlsHint: 'HOLD LMB fire · RMB aim · R reload · C stance',
    minRange: 0, maxRange: 0,
    hip: { x: 0.16, y: -0.2, z: -0.42, rx: 0.05, ry: 0.05 },
    aim: { x: 0, y: -0.11, z: -0.34, rx: 0, ry: 0 }, build: buildLewis,
  },
  vickers: {
    id: 'vickers', name: 'Vickers MG', control: 'auto', ammoKind: 'mag',
    magSize: 250, fireInterval: 0.09, reloadTime: 5.0, recoil: 0.4,
    hipFov: 52, adsFov: 40, emplaced: true, scope: false, heat: true,
    spreadHip: 0.011, spreadAds: 0.006, category: 'mg', sound: 'mg', tracerChance: 0.5,
    ammoName: '.303 belt', controlsHint: 'HOLD LMB fire · watch HEAT · R new belt',
    minRange: 0, maxRange: 0,
    hip: { x: 0, y: -0.24, z: -0.36, rx: 0.02, ry: 0 },
    aim: { x: 0, y: -0.24, z: -0.34, rx: 0, ry: 0 }, build: buildVickers,
  },
  sniper: {
    id: 'sniper', name: 'Sniper', control: 'bolt', ammoKind: 'mag',
    magSize: 5, fireInterval: 1.7, reloadTime: 3.4, recoil: 1.05,
    hipFov: 55, adsFov: 11, emplaced: false, scope: true, heat: false,
    spreadHip: 0.02, spreadAds: 0.0006, category: 'sniper', sound: 'sniper', tracerChance: 0,
    ammoName: '.303 SMLE (scoped)', controlsHint: 'RMB scope · LMB fire · R reload · C stance',
    minRange: 0, maxRange: 0, hip: RIFLE_HIP, aim: RIFLE_AIM, build: () => buildRifle(true),
  },
  grenadier: {
    id: 'grenadier', name: 'Bomber', control: 'throw', ammoKind: 'grenades',
    magSize: 10, fireInterval: 1.1, reloadTime: 2.4, recoil: 0.8,
    hipFov: 58, adsFov: 50, emplaced: false, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: 'rifle', sound: 'whistle_attack', tracerChance: 0,
    ammoName: 'Mills bombs', controlsHint: 'LMB throw at reticle · look to range · R resupply',
    minRange: 6, maxRange: 40,
    hip: { x: 0.16, y: -0.16, z: -0.3, rx: 0, ry: 0 },
    aim: { x: 0.12, y: -0.14, z: -0.28, rx: -0.2, ry: 0 }, build: buildGrenade,
  },
  mortar: {
    id: 'mortar', name: 'Stokes Mortar', control: 'lob', ammoKind: 'bombs',
    magSize: 8, fireInterval: 1.6, reloadTime: 4.0, recoil: 0.5,
    hipFov: 60, adsFov: 52, emplaced: true, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: 'artillery', sound: 'mortar_launch', tracerChance: 0,
    ammoName: '3-inch bombs', controlsHint: 'Aim reticle downrange · LMB drop · R re-stock',
    minRange: 45, maxRange: 190,
    hip: { x: 0.05, y: -0.28, z: -0.34, rx: 0, ry: 0 },
    aim: { x: 0.05, y: -0.28, z: -0.34, rx: 0, ry: 0 }, build: buildMortar,
  },
  fieldgun: {
    id: 'fieldgun', name: '18-Pounder', control: 'directgun', ammoKind: 'shells',
    magSize: 6, fireInterval: 2.4, reloadTime: 4.5, recoil: 1.4,
    hipFov: 54, adsFov: 30, emplaced: true, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: 'artillery', sound: 'fieldgun', tracerChance: 0,
    ammoName: '18-pdr HE', controlsHint: 'RMB lay the sight · LMB fire · R load shell',
    minRange: 0, maxRange: 0,
    hip: { x: 0, y: -0.22, z: -0.3, rx: 0.01, ry: 0 },
    aim: { x: 0, y: -0.2, z: -0.28, rx: 0, ry: 0 }, build: buildFieldgun,
  },
  flamer: {
    id: 'flamer', name: 'Flame Projector', control: 'flame', ammoKind: 'fuel',
    magSize: 0, fireInterval: 0.07, reloadTime: 0, recoil: 0.15,
    hipFov: 60, adsFov: 55, emplaced: false, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: 'flame', sound: 'gas_pop', tracerChance: 0,
    ammoName: 'Fuel', controlsHint: 'HOLD LMB to burn · short range · let it cool',
    minRange: 0, maxRange: 26,
    hip: { x: 0.2, y: -0.16, z: -0.32, rx: 0, ry: 0 },
    aim: { x: 0.16, y: -0.15, z: -0.3, rx: 0, ry: 0 }, build: buildFlamer,
  },
  medic: {
    id: 'medic', name: 'Stretcher Bearer', control: 'tool', ammoKind: 'none',
    magSize: 0, fireInterval: 0, reloadTime: 0, recoil: 0,
    hipFov: 58, adsFov: 55, emplaced: false, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: '', sound: 'build', tracerChance: 0,
    ammoName: 'Field dressings', controlsHint: 'HOLD LMB to bandage the nearest wounded man',
    minRange: 0, maxRange: 10,
    hip: { x: 0.16, y: -0.16, z: -0.26, rx: 0, ry: 0 },
    aim: { x: 0.1, y: -0.14, z: -0.22, rx: -0.25, ry: 0 }, build: () => buildToolkit('medic'),
  },
  officer: {
    id: 'officer', name: 'Officer', control: 'semi', ammoKind: 'mag',
    magSize: 6, fireInterval: 0.34, reloadTime: 2.6, recoil: 0.7,
    hipFov: 56, adsFov: 42, emplaced: false, scope: false, heat: false,
    spreadHip: 0.03, spreadAds: 0.012, category: 'rifle', sound: 'pistol', tracerChance: 0,
    ammoName: 'Webley .455', controlsHint: 'LMB fire · RMB aim · R reload · C stance',
    minRange: 0, maxRange: 0,
    hip: { x: 0.18, y: -0.2, z: -0.34, rx: 0.05, ry: 0.04 },
    aim: { x: 0, y: -0.12, z: -0.3, rx: 0, ry: 0 }, build: buildPistol,
  },
  engineer: {
    id: 'engineer', name: 'Sapper', control: 'tool', ammoKind: 'none',
    magSize: 0, fireInterval: 0, reloadTime: 0, recoil: 0,
    hipFov: 58, adsFov: 55, emplaced: false, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: '', sound: 'build', tracerChance: 0,
    ammoName: 'Entrenching tools', controlsHint: 'HOLD LMB to shore up parapet / mend wire',
    minRange: 0, maxRange: 14,
    hip: { x: 0.16, y: -0.18, z: -0.28, rx: 0, ry: 0 },
    aim: { x: 0.12, y: -0.16, z: -0.26, rx: -0.2, ry: 0 }, build: () => buildToolkit('engineer'),
  },
  gasproj: {
    id: 'gasproj', name: 'Livens Projector', control: 'lob', ammoKind: 'drums',
    magSize: 4, fireInterval: 2.2, reloadTime: 5.0, recoil: 0.6,
    hipFov: 60, adsFov: 54, emplaced: true, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: 'gas', sound: 'gas_pop', tracerChance: 0,
    ammoName: 'Gas drums', controlsHint: 'Aim reticle · LMB launch · mind the wind · R reload',
    minRange: 70, maxRange: 200,
    hip: { x: 0.05, y: -0.26, z: -0.32, rx: 0, ry: 0 },
    aim: { x: 0.05, y: -0.26, z: -0.32, rx: 0, ry: 0 }, build: buildGasProjector,
  },
}

// ---------------------------------------------------------------------------
// Aim helpers
// ---------------------------------------------------------------------------

export interface GroundHit { x: number; z: number; y: number; dist: number }

/**
 * March the aim ray down to the terrain — the point under the crosshair on the
 * ground. Indirect and thrown weapons drop their ordnance here. Rays that never
 * dip to earth (aimed at or above the horizon) clamp to maxDist along the
 * flattened bearing so the reticle still has somewhere to sit.
 */
export function groundHit(
  ctx: Ctx, ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number, maxDist: number,
): GroundHit {
  const step = 1.2
  for (let dist = 1; dist <= maxDist; dist += step) {
    const px = ox + dx * dist, py = oy + dy * dist, pz = oz + dz * dist
    if (py <= ctx.terrain.heightAt(px, pz)) {
      return { x: px, z: pz, y: ctx.terrain.heightAt(px, pz), dist }
    }
  }
  const fl = Math.hypot(dx, dz) || 1
  const px = ox + (dx / fl) * maxDist, pz = oz + (dz / fl) * maxDist
  return { x: px, z: pz, y: ctx.terrain.heightAt(px, pz), dist: maxDist }
}

/** Clamp a target point into a weapon's [minRange, maxRange] band about the gun. */
export function clampToBand(fromX: number, fromZ: number, tx: number, tz: number, min: number, max: number): { x: number; z: number } {
  let dx = tx - fromX, dz = tz - fromZ
  const d = Math.hypot(dx, dz) || 1
  const cd = d < min ? min : d > max ? max : d
  if (cd === d) return { x: tx, z: tz }
  dx = (dx / d) * cd; dz = (dz / d) * cd
  return { x: fromX + dx, z: fromZ + dz }
}

// ---------------------------------------------------------------------------
// Discharge — turn one trigger event into real ordnance
// ---------------------------------------------------------------------------

export interface FireCtx {
  game: Game
  ctx: Ctx
  unit: Unit
  soldier: Soldier
  /** Camera/eye world position. */
  camPos: Vec3
  /** Aim unit vector (camera forward). */
  dir: Vec3
  yaw: number
  pitch: number
  ads: number
  moving: boolean
  /** Ground point under the crosshair (indirect/thrown weapons). */
  ground: GroundHit | null
  /** World position of the viewmodel's muzzle tip — where the flash belongs. */
  muzzleWorld?: Vec3
}

/**
 * Fire one discharge of `profile`. All ammo/heat/interval gating is the
 * caller's job; by the time we're here the shot is happening. Returns nothing —
 * every consequence is a real entity in the sim.
 */
export function dischargeWeapon(profile: WeaponProfile, f: FireCtx): void {
  switch (profile.control) {
    case 'bolt': case 'semi': case 'auto': return fireBulletShot(profile, f)
    case 'throw': return throwGrenade(profile, f)
    case 'lob': return lobBomb(profile, f)
    case 'directgun': return fireGun(profile, f)
    case 'flame': return sprayFlame(profile, f)
    case 'tool': return // continuous; handled frame-by-frame by FpsMode
  }
}

function fireBulletShot(profile: WeaponProfile, f: FireCtx): void {
  const { ctx, game, soldier, unit } = f
  const def = UNIT_DEFS[profile.id]
  let spread = lerp(profile.spreadHip, profile.spreadAds, f.ads)
  spread *= soldier.stance === 'prone' ? 0.7 : soldier.stance === 'crouch' ? 0.88 : 1
  if (f.moving) spread *= 1.9
  spread *= 1 + soldier.suppression * 1.6
  if (profile.heat) spread *= 1 + unit.heat * 0.6 // a boiling Vickers walks its group

  let damage = def.damage
  if (profile.id === 'rifleman' || profile.id === 'lewis') damage *= ctx.mods.rifleDmg
  if (profile.id === 'sniper' && ctx.rand() < ctx.mods.sniperCrit) damage *= 3

  const from: Vec3 = {
    x: f.camPos.x + f.dir.x * 0.7,
    y: f.camPos.y + f.dir.y * 0.7 - 0.06,
    z: f.camPos.z + f.dir.z * 0.7,
  }
  fireBullet(ctx, {
    team: 'brit', from, dir: { x: f.dir.x, y: f.dir.y, z: f.dir.z }, speed: COMBAT.bulletSpeed,
    damage, spread, category: profile.category, shooterUnitId: unit.id, shooterId: soldier.id,
    tracer: ctx.rand() < profile.tracerChance,
  })
  soldier.facing = f.yaw

  if (profile.heat) {
    unit.heat = Math.min(1, unit.heat + COMBAT.vickersHeatPerShot * ctx.mods.heatRate)
    if (unit.heat >= 1) game.audio.play('steam_vent', { x: unit.pos.x, y: 1, z: unit.pos.z })
  }
  const big = profile.id === 'vickers'
  game.audio.play(profile.sound, { x: from.x, y: from.y, z: from.z, gain: profile.id === 'sniper' ? 1 : 0.9 })
  // First person only: the flash itself is welded to the viewmodel barrel in
  // FpsMode; from here we just kick the world ejecta (sparks, smoke, brass) off
  // the real muzzle tip. `core=false` suppresses the world-space flash sprite.
  const m = f.muzzleWorld ?? from
  game.effects.muzzleFlash(m.x, m.y, m.z, f.dir.x, f.dir.z, big, 0.5, false)
}

function throwGrenade(profile: WeaponProfile, f: FireCtx): void {
  const { ctx, game, soldier, unit } = f
  const g = f.ground
  if (!g) return
  const p = clampToBand(soldier.pos.x, soldier.pos.z, g.x, g.z, profile.minRange, profile.maxRange)
  soldier.facing = f.yaw
  spawnGrenade(ctx, soldier, p.x, p.z, UNIT_DEFS.grenadier.damage * ctx.mods.grenDmg,
    UNIT_DEFS.grenadier.aoe + ctx.mods.grenAoe, unit.id)
  game.audio.play('whistle_attack', { x: soldier.pos.x, y: 1.6, z: soldier.pos.z, gain: 0.2, rate: 1.6 })
}

function lobBomb(profile: WeaponProfile, f: FireCtx): void {
  const { ctx, game, soldier, unit } = f
  const g = f.ground
  if (!g) return
  const p = clampToBand(soldier.pos.x, soldier.pos.z, g.x, g.z, profile.minRange, profile.maxRange)
  const fromY = standSurface(ctx, soldier.pos.x, soldier.pos.z) + 0.8
  if (profile.id === 'gasproj') {
    for (let i = 0; i < 6; i++) {
      spawnGasShell(ctx, soldier.pos.x, soldier.pos.z, p.x + (ctx.rand() - 0.5) * 14, p.z + (ctx.rand() - 0.5) * 14)
    }
    ctx.s.stats.gasClouds++
    game.effects.muzzleFlash(soldier.pos.x, fromY, soldier.pos.z, f.dir.x, f.dir.z, true)
  } else {
    spawnMortarBombAt(ctx, soldier.pos.x, soldier.pos.z, fromY, p.x, p.z,
      UNIT_DEFS.mortar.damage, UNIT_DEFS.mortar.aoe, unit.id)
    ctx.s.stats.shellsFired++
  }
}

function fireGun(profile: WeaponProfile, f: FireCtx): void {
  const { ctx, game, soldier, unit } = f
  const from: Vec3 = {
    x: f.camPos.x + f.dir.x * 1.1,
    y: f.camPos.y + f.dir.y * 1.1 - 0.05,
    z: f.camPos.z + f.dir.z * 1.1,
  }
  spawnDirectShell(ctx, from.x, from.y, from.z, f.dir.x, f.dir.y, f.dir.z, 260,
    UNIT_DEFS.fieldgun.damage, UNIT_DEFS.fieldgun.aoe, unit.id)
  ctx.s.stats.shellsFired++
  soldier.facing = f.yaw
  game.audio.play('fieldgun', { x: from.x, y: from.y, z: from.z })
  // Barrel flash is welded to the viewmodel in FpsMode; keep only the world
  // ejecta and the big burst light out here (core=false).
  const m = f.muzzleWorld ?? from
  game.effects.muzzleFlash(m.x, m.y, m.z, f.dir.x, f.dir.z, true, 0.5, false)
  game.effects.flash(m.x, m.y, m.z, 0xffb060, 34, 0.14)
  void profile
}

let flameSndT = 0
function sprayFlame(profile: WeaponProfile, f: FireCtx): void {
  const { ctx, game, soldier, unit } = f
  soldier.facing = f.yaw
  // The cone is instant-area; we call it in short puffs, so scale the bite to
  // roughly a satisfying close-range DPS without vaporising the whole wave.
  flameCone(ctx, soldier, 'brit', profile.maxRange, UNIT_DEFS.flamer.damage * 0.42, unit.id)
  flameSndT -= profile.fireInterval
  if (flameSndT <= 0) {
    flameSndT = 0.22
    game.audio.play('gas_pop', { x: soldier.pos.x, y: 1.4, z: soldier.pos.z, gain: 0.32, rate: 0.6 })
  }
}

// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }
