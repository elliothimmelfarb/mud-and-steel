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
  /**
   * Optical gun sight: RMB lays the shot through a magnified telescopic sight
   * (an amber graticule overlay + strong zoom), the artillery analogue of the
   * sniper's `scope`. The 18-pounder lays over its dial-sight telescope.
   */
  gunsight?: boolean
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
  /**
   * Eye height (m) while manning this weapon, overriding the stance table.
   * Emplaced crews crouch to their gun, so they sit lower than a standing man —
   * this is what drops you behind the Vickers or breech to look ALONG it rather
   * than towering over a dark lump.
   */
  eyeHeight?: number
  /** Pitch the view starts laid at (radians, − is down). Guns lay a touch low. */
  startPitch?: number
  /** Scales the barrel muzzle flash (1 = rifle-sized). A pistol wants ~0.6. */
  flashScale?: number
  /**
   * Recoil CHARACTER overrides — all optional, all defaulting to a neutral
   * 1x (or the model's own default) so most profiles never touch them; the
   * base `recoil` field alone already drives a sensible generic kick/climb/
   * sway. Set these only where a weapon should read distinctly: the sniper's
   * one heavy punch, the Lewis/Vickers's fast climb-then-cap, the officer's
   * light snappy pistol, the 18-pounder's huge single punch. See fps.ts's
   * applyRecoil() for how each multiplies into the shared spring model.
   */
  recoilKickMul?: number   // multiplies the sharp per-shot punch (default 1)
  recoilClimbMul?: number  // multiplies the accumulating muzzle-climb rate (default 1)
  recoilClimbCap?: number  // overrides the muzzle-climb clamp, radians (default 0.16)
  recoilSwayMul?: number   // multiplies the horizontal wander rate (default 1)
  hip: VmPose
  aim: VmPose
  build: () => Viewmodel
}

// ---------------------------------------------------------------------------
// Shared viewmodel materials (session-lived, safe to share across meshes)
// ---------------------------------------------------------------------------

const EM = 0.8 // emissive lift so the viewmodel reads even with the sun behind you

// Every viewmodel material, tracked so night can dim their fake self-glow. The
// constant emissive floor is exactly what made the gun ignore the time of day;
// at night we drop it and hand the job to real light (fill lamp + muzzle fire).
const VM_MATERIALS: THREE.MeshStandardMaterial[] = []

function mkMat(color: number, rough: number, metal: number, emissive: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, emissive, emissiveIntensity: EM,
  })
  VM_MATERIALS.push(m)
  return m
}

/**
 * Scale the shared viewmodel materials' emissive floor by the time of day.
 * nightFactor 0 (day) keeps the full EM=0.8 lift so the gun reads against a
 * bright sky; nightFactor 1 (full dark) drops it to ~0.25 — low enough that the
 * fill lamp, moonlight, muzzle flashes and passing tracers visibly rake the
 * metal, high enough that no face falls to pure black before any fire lands.
 * Called once per frame from Game.render (these materials are viewmodel-only).
 */
export function setViewmodelEmissive(nightFactor: number): void {
  const em = EM - nightFactor * 0.55
  for (let i = 0; i < VM_MATERIALS.length; i++) VM_MATERIALS[i].emissiveIntensity = em
}

// Viewmodel metals are deliberately LOW-metalness: with no environment map a
// physically-metallic surface has almost no diffuse term and renders near-black
// in daylight, which turned the guns into featureless silhouettes. Treating them
// as bright, lightly-specular painted/oiled steel keeps their form legible held
// up against the sky, and the emissive floor stops any face going fully black.
const MAT = {
  wood: mkMat(0xa4703c, 0.7, 0.05, 0x2e1c0a),
  darkWood: mkMat(0x86552c, 0.74, 0.05, 0x241606),
  steel: mkMat(0x9298a3, 0.48, 0.35, 0x23262d),
  blued: mkMat(0x5c636e, 0.4, 0.4, 0x1a1e24),
  brass: mkMat(0xc39a52, 0.44, 0.45, 0x2e2109),
  canvas: mkMat(0x8c8863, 0.88, 0.03, 0x1e1c0f),
  copper: mkMat(0xa66c44, 0.48, 0.42, 0x241206),
  paint: mkMat(0x707c52, 0.72, 0.2, 0x1a1e10), // field-grey ordnance paint
  glass: mkMat(0x1a2630, 0.18, 0.35, 0x0a1016),
  dressing: mkMat(0xe4dcc4, 0.85, 0.0, 0x35322a),
  flesh: mkMat(0xc08f64, 0.82, 0.0, 0x2c1f12),
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
  // Crisp near-black for iron sights so they read as a hard silhouette against sky.
  const sightBlk = mkMat(0x2c3038, 0.5, 0.22, 0x090b0e)

  // --- BUTT / STOCK (walnut) -------------------------------------------------
  // Main butt, toe dropping slightly toward the shoulder.
  part(g, new THREE.BoxGeometry(0.052, 0.10, 0.30), MAT.wood, 0, -0.02, 0.30, 0.04)
  // Raised comb where the cheek sits.
  part(g, new THREE.BoxGeometry(0.044, 0.03, 0.17), MAT.wood, 0, 0.03, 0.20, 0.02)
  // Small-of-stock / wrist grip behind the trigger.
  part(g, new THREE.BoxGeometry(0.038, 0.062, 0.14), MAT.darkWood, 0, 0.0, 0.11, -0.06)
  // A hint of grip checkering on the wrist — thin raised slats each side.
  for (let i = 0; i < 3; i++) {
    part(g, new THREE.BoxGeometry(0.006, 0.03, 0.008), MAT.wood, 0.02, 0.0, 0.06 + i * 0.03)
    part(g, new THREE.BoxGeometry(0.006, 0.03, 0.008), MAT.wood, -0.02, 0.0, 0.06 + i * 0.03)
  }
  // Gunmetal butt plate with heel/toe screws (well back, small — never a screen wall).
  part(g, new THREE.BoxGeometry(0.05, 0.10, 0.014), MAT.brass, 0, -0.014, 0.455, 0.04)
  part(g, new THREE.BoxGeometry(0.008, 0.008, 0.008), MAT.blued, 0, 0.028, 0.452)
  part(g, new THREE.BoxGeometry(0.008, 0.008, 0.008), MAT.blued, 0, -0.05, 0.458)

  // --- RECEIVER / ACTION (blued) --------------------------------------------
  part(g, new THREE.BoxGeometry(0.05, 0.062, 0.20), MAT.blued, 0, 0.038, -0.02)
  // Charger bridge over the rear of the receiver.
  part(g, new THREE.BoxGeometry(0.052, 0.024, 0.028), MAT.blued, 0, 0.074, 0.03)
  // Two .303 rounds thumbed into the bridge — brass noses just showing.
  part(g, new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8).rotateX(Math.PI / 2), MAT.brass, 0.009, 0.072, -0.01)
  part(g, new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8).rotateX(Math.PI / 2), MAT.brass, -0.009, 0.072, -0.01)
  // Bright bolt body running forward through the action.
  part(g, new THREE.CylinderGeometry(0.013, 0.013, 0.19, 10).rotateX(Math.PI / 2), MAT.steel, 0.013, 0.045, 0.0)
  // Cocking piece + knurled bolt-shroud knob at the tail.
  part(g, new THREE.CylinderGeometry(0.016, 0.016, 0.03, 10).rotateX(Math.PI / 2), MAT.steel, 0.013, 0.045, 0.12)
  part(g, new THREE.CylinderGeometry(0.011, 0.011, 0.03, 8).rotateX(Math.PI / 2), MAT.blued, 0.013, 0.045, 0.145)
  // Ejection port cut on the right of the receiver.
  part(g, new THREE.BoxGeometry(0.006, 0.03, 0.075), mkMat(0x14171c, 0.6, 0.2, 0x05070a), 0.027, 0.05, -0.02)
  // Safety catch flag on the left rear.
  part(g, new THREE.BoxGeometry(0.01, 0.032, 0.012), MAT.steel, -0.03, 0.05, 0.09, 0, 0, -0.3)
  part(g, new THREE.SphereGeometry(0.008, 10, 8), MAT.steel, -0.038, 0.062, 0.09)

  // --- BOLT HANDLE (animated) -----------------------------------------------
  // MUST keep base position z=0.02 and rotation.z=-0.9 — fps.ts drives these.
  const bolt = new THREE.CylinderGeometry(0.011, 0.011, 0.075, 8)
  const boltMesh = part(g, bolt, MAT.steel, 0.05, 0.05, 0.02); boltMesh.rotation.z = -0.9
  // Turned-down ball knob welded to the tip, so it lifts and draws with the handle.
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 10), MAT.steel)
  knob.position.set(0, 0.045, 0); boltMesh.add(knob)

  // --- TRIGGER GROUP ---------------------------------------------------------
  // Trigger-guard bow (torus in the vertical fore/aft plane).
  part(g, new THREE.TorusGeometry(0.028, 0.006, 8, 16), MAT.blued, 0, -0.028, 0.06, 0, Math.PI / 2)
  // Guard tang strap fairing it into the wood.
  part(g, new THREE.BoxGeometry(0.016, 0.012, 0.13), MAT.blued, 0, -0.008, 0.055)
  // Curved trigger blade.
  part(g, new THREE.BoxGeometry(0.008, 0.028, 0.01), MAT.steel, 0, -0.026, 0.05, 0.35)

  // --- MAGAZINE (10-round box, ahead of the guard) --------------------------
  part(g, new THREE.BoxGeometry(0.038, 0.058, 0.08), MAT.blued, 0, -0.03, -0.02)
  part(g, new THREE.BoxGeometry(0.044, 0.01, 0.088), MAT.blued, 0, -0.06, -0.02) // floor plate
  part(g, new THREE.BoxGeometry(0.01, 0.012, 0.014), MAT.steel, 0, -0.008, 0.025) // mag catch

  // --- FOREND & HAND-GUARD (walnut) -----------------------------------------
  // Long lower fore-stock the support hand grips.
  part(g, new THREE.BoxGeometry(0.05, 0.05, 0.66), MAT.wood, 0, 0.012, -0.44)
  // Upper hand-guard capping the barrel (rear-sight gap left open ahead of the action).
  part(g, new THREE.BoxGeometry(0.044, 0.03, 0.54), MAT.wood, 0, 0.072, -0.48)
  // Finger grooves down the forend for grip.
  part(g, new THREE.BoxGeometry(0.006, 0.01, 0.2), MAT.darkWood, 0.026, 0.012, -0.34)
  part(g, new THREE.BoxGeometry(0.006, 0.01, 0.2), MAT.darkWood, -0.026, 0.012, -0.34)

  // --- BARREL ----------------------------------------------------------------
  const barrel = new THREE.CylinderGeometry(0.011, 0.011, 0.82, 10); barrel.rotateX(Math.PI / 2)
  part(g, barrel, MAT.steel, 0, 0.052, -0.47)

  // --- BANDS, NOSE CAP, BAYONET ---------------------------------------------
  // Inner barrel band clamping fore-stock to barrel.
  part(g, new THREE.BoxGeometry(0.058, 0.052, 0.022), MAT.blued, 0, 0.04, -0.55)
  // Signature snub blunt nose cap wrapping the muzzle.
  part(g, new THREE.BoxGeometry(0.06, 0.07, 0.09), MAT.blued, 0, 0.045, -0.8)
  part(g, new THREE.BoxGeometry(0.066, 0.02, 0.09), MAT.steel, 0, 0.012, -0.8) // nose-cap underlug
  // Bayonet lug + bar hanging under the nose cap.
  part(g, new THREE.BoxGeometry(0.014, 0.028, 0.05), MAT.steel, 0, -0.005, -0.83)
  part(g, new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8).rotateX(Math.PI / 2), MAT.steel, 0, 0.0, -0.86)
  // Muzzle crown just proud of the cap.
  part(g, new THREE.CylinderGeometry(0.014, 0.013, 0.03, 10).rotateX(Math.PI / 2), MAT.steel, 0, 0.052, -0.865)

  // --- FRONT SIGHT (blade + protective ears) --------------------------------
  part(g, new THREE.BoxGeometry(0.05, 0.02, 0.04), MAT.blued, 0, 0.082, -0.81) // block
  part(g, new THREE.BoxGeometry(0.006, 0.03, 0.008), sightBlk, 0, 0.102, -0.81) // blade
  part(g, new THREE.BoxGeometry(0.006, 0.034, 0.04), MAT.blued, 0.021, 0.1, -0.81) // ear R
  part(g, new THREE.BoxGeometry(0.006, 0.034, 0.04), MAT.blued, -0.021, 0.1, -0.81) // ear L

  // --- REAR SIGHT (leaf + slider) -------------------------------------------
  part(g, new THREE.BoxGeometry(0.05, 0.02, 0.06), MAT.blued, 0, 0.07, -0.15) // base bed
  part(g, new THREE.BoxGeometry(0.032, 0.07, 0.006), MAT.blued, 0, 0.105, -0.13, -0.18) // upright leaf
  part(g, new THREE.BoxGeometry(0.028, 0.006, 0.006), sightBlk, 0, 0.09, -0.132) // graduation
  part(g, new THREE.BoxGeometry(0.028, 0.006, 0.006), sightBlk, 0, 0.11, -0.128) // graduation
  part(g, new THREE.BoxGeometry(0.036, 0.01, 0.008), MAT.steel, 0, 0.122, -0.126) // aperture slider

  // --- VOLLEY (long-range) SIGHT on the left forend -------------------------
  part(g, new THREE.CylinderGeometry(0.018, 0.018, 0.008, 12).rotateZ(Math.PI / 2), MAT.brass, -0.03, 0.02, -0.06)
  part(g, new THREE.BoxGeometry(0.006, 0.05, 0.006), MAT.brass, -0.036, 0.05, -0.06, 0, 0, 0.2) // pointer arm

  // --- SLING SWIVELS + a scrap of canvas sling ------------------------------
  part(g, new THREE.TorusGeometry(0.014, 0.004, 8, 14), MAT.steel, 0, -0.02, -0.55) // front swivel
  part(g, new THREE.TorusGeometry(0.014, 0.004, 8, 14), MAT.steel, 0, -0.06, 0.22)   // rear swivel
  part(g, new THREE.BoxGeometry(0.02, 0.045, 0.01), MAT.canvas, 0, -0.05, -0.55, 0.2) // sling tab

  // --- SCOPE (No.3 pattern, offset LEFT on tall mounts) ---------------------
  if (scope) {
    const bl = -0.045 // left offset of the optical axis
    const tube = new THREE.CylinderGeometry(0.018, 0.018, 0.3, 14); tube.rotateX(Math.PI / 2)
    part(g, tube, MAT.blued, bl, 0.12, -0.18)
    // Brass objective bell + ocular, brass clamp rings.
    part(g, new THREE.CylinderGeometry(0.024, 0.02, 0.05, 14).rotateX(Math.PI / 2), MAT.brass, bl, 0.12, -0.34)
    part(g, new THREE.CylinderGeometry(0.023, 0.02, 0.045, 14).rotateX(Math.PI / 2), MAT.brass, bl, 0.12, -0.02)
    part(g, new THREE.CylinderGeometry(0.021, 0.021, 0.012, 14).rotateX(Math.PI / 2), MAT.brass, bl, 0.12, -0.1)
    part(g, new THREE.CylinderGeometry(0.021, 0.021, 0.012, 14).rotateX(Math.PI / 2), MAT.brass, bl, 0.12, -0.27)
    // Dark objective glass.
    part(g, new THREE.CylinderGeometry(0.018, 0.018, 0.004, 14).rotateX(Math.PI / 2), MAT.glass, bl, 0.12, -0.362)
    // Windage/elevation drum on top.
    part(g, new THREE.CylinderGeometry(0.012, 0.012, 0.018, 12), MAT.brass, bl, 0.14, -0.16)
    // Tall blued mount posts up from the receiver.
    part(g, new THREE.BoxGeometry(0.012, 0.07, 0.016), MAT.blued, bl, 0.082, -0.07)
    part(g, new THREE.BoxGeometry(0.012, 0.07, 0.016), MAT.blued, bl, 0.082, -0.29)
    part(g, new THREE.BoxGeometry(0.014, 0.02, 0.04), MAT.blued, bl, 0.108, -0.07) // mount saddle
    part(g, new THREE.BoxGeometry(0.014, 0.02, 0.04), MAT.blued, bl, 0.108, -0.29)
  }

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.052, -0.89), bolt: boltMesh }
  finish(g, 0.82)
  return vm
}

function buildLewis(): Viewmodel {
  const g = new THREE.Group()
  // Distinct materials just for the Lewis: bright anodised-aluminium radiator
  // casing, drab pan-magazine steel, and a near-black port recess. Low metalness
  // keeps them legible with no env-map; emissive floors track base colour x~0.15.
  const alu = mkMat(0xb9bec6, 0.5, 0.32, 0x1b1c1f)
  const drum = mkMat(0x767b82, 0.52, 0.3, 0x161719)
  const recess = mkMat(0x24272d, 0.6, 0.18, 0x070809)

  // ---- The signature: fat finned aluminium cooling shroud -----------------
  const shroud = new THREE.CylinderGeometry(0.052, 0.052, 0.56, 16); shroud.rotateX(Math.PI / 2)
  part(g, shroud, alu, 0, 0.03, -0.5)
  // Stepped collar where the casing bolts onto the receiver.
  const collar = new THREE.CylinderGeometry(0.06, 0.06, 0.06, 16); collar.rotateX(Math.PI / 2)
  part(g, collar, alu, 0, 0.03, -0.22)
  // Flared radiator MOUTH at the front — wide at the muzzle end (-Z).
  // radiusBottom (the -Z end after rotateX(+PI/2)) must be the wide one.
  const mouth = new THREE.CylinderGeometry(0.052, 0.078, 0.07, 16); mouth.rotateX(Math.PI / 2)
  part(g, mouth, alu, 0, 0.03, -0.775)
  // Dark tube seen recessed inside the bright mouth.
  const boreTube = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14); boreTube.rotateX(Math.PI / 2)
  part(g, boreTube, MAT.blued, 0, 0.03, -0.79)
  // Longitudinal cooling fins ringing the casing.
  const nFins = 8
  for (let i = 0; i < nFins; i++) {
    const th = (i / nFins) * Math.PI * 2
    const R = 0.056
    part(g, new THREE.BoxGeometry(0.006, 0.02, 0.5), alu,
      Math.sin(th) * R, 0.03 + Math.cos(th) * R, -0.5, 0, 0, -th)
  }
  // Two steel clamp bands hooping the casing (torus default already circles +Z).
  part(g, new THREE.TorusGeometry(0.057, 0.007, 8, 24), MAT.steel, 0, 0.03, -0.35)
  part(g, new THREE.TorusGeometry(0.057, 0.007, 8, 24), MAT.steel, 0, 0.03, -0.64)

  // ---- Barrel + crown poking out of the radiator mouth --------------------
  const barrel = new THREE.CylinderGeometry(0.015, 0.015, 0.2, 10); barrel.rotateX(Math.PI / 2)
  part(g, barrel, MAT.blued, 0, 0.03, -0.85)
  part(g, new THREE.TorusGeometry(0.02, 0.006, 8, 16), MAT.steel, 0, 0.03, -0.945)

  // ---- Receiver / action ---------------------------------------------------
  part(g, new THREE.BoxGeometry(0.075, 0.09, 0.32), MAT.blued, 0, 0.02, -0.05)
  // Round magazine post the pan sits on.
  part(g, new THREE.CylinderGeometry(0.062, 0.062, 0.03, 16), MAT.blued, 0, 0.075, -0.02)
  // Ejection port recess + lip on the right side.
  part(g, new THREE.BoxGeometry(0.008, 0.032, 0.1), recess, 0.039, 0.03, -0.06)
  part(g, new THREE.BoxGeometry(0.01, 0.008, 0.11), MAT.steel, 0.04, 0.05, -0.06)
  // Cocking handle: arm + knob on the right.
  part(g, new THREE.BoxGeometry(0.05, 0.014, 0.014), MAT.blued, 0.06, 0.0, 0.03)
  const cockKnob = new THREE.CylinderGeometry(0.014, 0.014, 0.03, 10); cockKnob.rotateZ(Math.PI / 2)
  part(g, cockKnob, MAT.steel, 0.088, 0.0, 0.03)

  // ---- Flat PAN magazine on top (the other signature) ---------------------
  part(g, new THREE.CylinderGeometry(0.1, 0.1, 0.04, 24), drum, 0, 0.088, -0.02)
  part(g, new THREE.CylinderGeometry(0.084, 0.084, 0.022, 24), drum, 0, 0.118, -0.02)
  // Concentric ridges reading as the pan's segmented top (hoop the vertical axis).
  part(g, new THREE.TorusGeometry(0.07, 0.005, 8, 28).rotateX(Math.PI / 2), MAT.steel, 0, 0.13, -0.02)
  part(g, new THREE.TorusGeometry(0.046, 0.005, 8, 24).rotateX(Math.PI / 2), MAT.steel, 0, 0.131, -0.02)
  // Radial rib spokes suggesting the cartridge partitions.
  const nSpokes = 6
  for (let i = 0; i < nSpokes; i++) {
    const ph = (i / nSpokes) * Math.PI * 2
    part(g, new THREE.BoxGeometry(0.006, 0.006, 0.07), MAT.steel,
      Math.sin(ph) * 0.045, 0.129, -0.02 + Math.cos(ph) * 0.045, 0, ph, 0)
  }
  // Central spindle + retaining nut.
  part(g, new THREE.CylinderGeometry(0.016, 0.016, 0.05, 12), MAT.steel, 0, 0.148, -0.02)
  part(g, new THREE.CylinderGeometry(0.022, 0.022, 0.012, 12), MAT.blued, 0, 0.166, -0.02)

  // ---- Rear tangent/aperture sight ----------------------------------------
  part(g, new THREE.BoxGeometry(0.04, 0.02, 0.03), MAT.blued, 0, 0.078, 0.1)
  part(g, new THREE.BoxGeometry(0.03, 0.05, 0.008), MAT.blued, 0, 0.105, 0.1)
  part(g, new THREE.TorusGeometry(0.012, 0.004, 8, 16), MAT.steel, 0, 0.115, 0.106)

  // ---- Front blade sight with protective ears -----------------------------
  part(g, new THREE.BoxGeometry(0.022, 0.02, 0.03), alu, 0, 0.09, -0.7)
  part(g, new THREE.BoxGeometry(0.008, 0.04, 0.008), MAT.blued, 0, 0.115, -0.7)
  part(g, new THREE.BoxGeometry(0.006, 0.042, 0.01), MAT.steel, 0.017, 0.115, -0.7)
  part(g, new THREE.BoxGeometry(0.006, 0.042, 0.01), MAT.steel, -0.017, 0.115, -0.7)

  // ---- Wooden butt stock ---------------------------------------------------
  part(g, new THREE.BoxGeometry(0.05, 0.092, 0.24), MAT.darkWood, 0, 0.0, 0.24)
  part(g, new THREE.BoxGeometry(0.046, 0.02, 0.14), MAT.darkWood, 0, 0.055, 0.21)
  part(g, new THREE.BoxGeometry(0.05, 0.096, 0.02), MAT.blued, 0, 0.0, 0.365)

  // ---- Pistol grip + trigger group ----------------------------------------
  part(g, new THREE.BoxGeometry(0.04, 0.11, 0.05), MAT.darkWood, 0, -0.07, 0.06, 0.32)
  // Suggestion of checkering: thin raised slats up the grip.
  for (let i = 0; i < 3; i++) {
    part(g, new THREE.BoxGeometry(0.03, 0.006, 0.006), MAT.wood, 0, -0.055 - i * 0.02, 0.085, 0.32)
  }
  part(g, new THREE.TorusGeometry(0.028, 0.006, 8, 16).rotateY(Math.PI / 2), MAT.blued, 0, -0.045, 0.03)
  part(g, new THREE.BoxGeometry(0.008, 0.03, 0.008), MAT.steel, 0, -0.032, 0.03, 0.2)

  // ---- Sling swivels -------------------------------------------------------
  part(g, new THREE.TorusGeometry(0.012, 0.004, 8, 14), MAT.steel, 0, -0.065, -0.5)
  part(g, new THREE.TorusGeometry(0.012, 0.004, 8, 14), MAT.steel, 0, -0.052, 0.32)

  // ---- Bipod hint clamped near the muzzle ---------------------------------
  part(g, new THREE.BoxGeometry(0.03, 0.03, 0.05), MAT.blued, 0, -0.05, -0.68)
  part(g, new THREE.BoxGeometry(0.01, 0.16, 0.01), MAT.steel, 0.035, -0.13, -0.68, 0, 0, 0.4)
  part(g, new THREE.BoxGeometry(0.01, 0.16, 0.01), MAT.steel, -0.035, -0.13, -0.68, 0, 0, -0.4)
  part(g, new THREE.BoxGeometry(0.02, 0.012, 0.03), MAT.steel, 0.065, -0.2, -0.68, 0, 0, 0.4)
  part(g, new THREE.BoxGeometry(0.02, 0.012, 0.03), MAT.steel, -0.065, -0.2, -0.68, 0, 0, -0.4)

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.03, -0.96) }
  finish(g, 0.8)
  return vm
}

function buildVickers(): Viewmodel {
  const g = new THREE.Group()
  const hose = mkMat(0x4a4438, 0.9, 0.06, 0x0f0e0a)   // rubber/canvas steam hose
  const cy = 0.06                                       // bore axis height (jacket centreline)

  // --- Corrugated water jacket: the signature that lets it fire all day. ----
  const jacket = new THREE.CylinderGeometry(0.072, 0.072, 0.6, 16); jacket.rotateX(Math.PI / 2)
  part(g, jacket, MAT.steel, 0, cy, -0.5)
  // Ring corrugations swaged along its length (default torus encircles the Z bore).
  for (let i = 0; i < 8; i++) {
    part(g, new THREE.TorusGeometry(0.077, 0.007, 8, 20), MAT.steel, 0, cy, -0.28 - i * 0.064)
  }
  // Front bearing gland + rear collar where the jacket meets the receiver.
  part(g, new THREE.CylinderGeometry(0.06, 0.055, 0.06, 16).rotateX(Math.PI / 2), MAT.steel, 0, cy, -0.81)
  part(g, new THREE.CylinderGeometry(0.083, 0.083, 0.05, 16).rotateX(Math.PI / 2), MAT.blued, 0, cy, -0.2)
  // Brass water-filler cap standing proud on top of the jacket.
  part(g, new THREE.CylinderGeometry(0.017, 0.017, 0.03, 10), MAT.brass, 0, cy + 0.078, -0.42)
  // Front foresight blade on the jacket crown.
  part(g, new THREE.BoxGeometry(0.008, 0.032, 0.01), MAT.steel, 0, cy + 0.088, -0.79)

  // --- Steam condenser: a tube leaves the front gland and drops to the can. --
  part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8).rotateX(Math.PI / 2), hose, 0, cy - 0.04, -0.8)
  part(g, new THREE.CylinderGeometry(0.013, 0.013, 0.2, 8), hose, 0.01, -0.02, -0.72, 0.5, 0, 0.15)
  part(g, new THREE.CylinderGeometry(0.013, 0.013, 0.22, 8), hose, 0.04, -0.2, -0.58, 0.2, 0, 0.35)
  part(g, new THREE.CylinderGeometry(0.05, 0.05, 0.14, 12), MAT.steel, 0.07, -0.3, -0.46)         // condenser can, half out of view
  part(g, new THREE.TorusGeometry(0.05, 0.006, 6, 16), MAT.blued, 0.07, -0.24, -0.46, Math.PI / 2) // can rim

  // --- Barrel + muzzle: a short-recoil group that chatters back on each shot. -
  const recoil = new THREE.Group()
  part(recoil, new THREE.CylinderGeometry(0.018, 0.018, 0.22, 10).rotateX(Math.PI / 2), MAT.blued, 0, cy, -0.9)
  part(recoil, new THREE.CylinderGeometry(0.046, 0.03, 0.06, 12).rotateX(Math.PI / 2), MAT.blued, 0, cy, -0.85) // muzzle booster gland
  part(recoil, new THREE.CylinderGeometry(0.03, 0.026, 0.04, 12).rotateX(Math.PI / 2), MAT.blued, 0, cy, -0.95) // muzzle cup
  g.add(recoil)

  // --- Receiver body, top cover + fusee-spring cover on the left. -----------
  part(g, new THREE.BoxGeometry(0.15, 0.13, 0.21), MAT.blued, 0, 0.04, -0.06)
  part(g, new THREE.BoxGeometry(0.13, 0.035, 0.19), MAT.steel, 0, 0.11, -0.06)        // hinged top cover
  part(g, new THREE.BoxGeometry(0.02, 0.022, 0.17), MAT.blued, 0, 0.132, -0.06)       // cover rib
  part(g, new THREE.BoxGeometry(0.035, 0.1, 0.17), MAT.steel, -0.086, 0.03, -0.02)    // fusee spring cover (left)
  part(g, new THREE.BoxGeometry(0.01, 0.07, 0.02), MAT.blued, -0.105, 0.03, -0.07)    // fusee cover rib
  part(g, new THREE.BoxGeometry(0.01, 0.07, 0.02), MAT.blued, -0.105, 0.03, 0.04)     // fusee cover rib

  // --- Feed block + fabric belt with visible brass rounds on the right. ------
  part(g, new THREE.BoxGeometry(0.055, 0.06, 0.17), MAT.blued, 0.088, 0.09, -0.06)    // feed block
  part(g, new THREE.BoxGeometry(0.03, 0.03, 0.15), MAT.steel, 0.095, 0.125, -0.06)    // top pawl cover
  part(g, new THREE.BoxGeometry(0.15, 0.022, 0.055), MAT.canvas, 0.19, 0.075, -0.05)  // belt feeding in
  part(g, new THREE.BoxGeometry(0.03, 0.16, 0.055), MAT.canvas, 0.27, -0.02, -0.05, 0, 0, 0.4) // belt drooping away
  for (let i = 0; i < 6; i++) {                                                        // rounds in the horizontal run
    part(g, new THREE.CylinderGeometry(0.009, 0.006, 0.05, 8).rotateX(Math.PI / 2), MAT.brass, 0.13 + i * 0.024, 0.075, -0.03)
  }
  for (let i = 0; i < 3; i++) {                                                        // rounds in the drooping run
    part(g, new THREE.CylinderGeometry(0.009, 0.006, 0.048, 8).rotateX(Math.PI / 2), MAT.brass, 0.255 + i * 0.02, 0.03 - i * 0.03, -0.03)
  }

  // --- Cocking crank handle on the right of the receiver. -------------------
  part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.03, 10).rotateX(Math.PI / 2), MAT.steel, 0.085, 0.05, 0.07)
  part(g, new THREE.BoxGeometry(0.018, 0.075, 0.018), MAT.blued, 0.105, 0.018, 0.07, 0, 0, -0.5)
  part(g, new THREE.SphereGeometry(0.02, 10, 8), MAT.darkWood, 0.13, -0.012, 0.07)

  // --- Rear leaf sight standing on the back of the receiver. -----------------
  part(g, new THREE.BoxGeometry(0.05, 0.02, 0.04), MAT.steel, 0, 0.125, 0.03)         // sight bed
  part(g, new THREE.BoxGeometry(0.009, 0.085, 0.012), MAT.blued, -0.017, 0.175, 0.03) // leaf post
  part(g, new THREE.BoxGeometry(0.009, 0.085, 0.012), MAT.blued, 0.017, 0.175, 0.03)  // leaf post
  part(g, new THREE.BoxGeometry(0.043, 0.012, 0.012), MAT.blued, 0, 0.212, 0.03)      // leaf crossbar
  part(g, new THREE.BoxGeometry(0.05, 0.014, 0.016), MAT.brass, 0, 0.155, 0.03)       // graduated slider

  // --- Twin spade grips + central thumb trigger the crouching gunner presses.-
  part(g, new THREE.BoxGeometry(0.25, 0.05, 0.05), MAT.blued, 0, 0.0, 0.16)           // rear crosshandle frame
  const grip = new THREE.BoxGeometry(0.04, 0.14, 0.038)
  part(g, grip, MAT.darkWood, 0.11, -0.07, 0.165, 0, 0, -0.13)                        // right spade grip
  part(g, grip, MAT.darkWood, -0.11, -0.07, 0.165, 0, 0, 0.13)                        // left spade grip
  part(g, new THREE.SphereGeometry(0.024, 10, 8), MAT.blued, 0.121, 0.01, 0.165)      // grip cap
  part(g, new THREE.SphereGeometry(0.024, 10, 8), MAT.blued, -0.121, 0.01, 0.165)     // grip cap
  for (let i = 0; i < 3; i++) {                                                        // suggestion of checkering
    part(g, new THREE.BoxGeometry(0.044, 0.008, 0.006), MAT.blued, 0.107, -0.05 - i * 0.028, 0.186)
    part(g, new THREE.BoxGeometry(0.044, 0.008, 0.006), MAT.blued, -0.113, -0.05 - i * 0.028, 0.186)
  }
  part(g, new THREE.BoxGeometry(0.06, 0.022, 0.016), MAT.steel, 0, -0.01, 0.14)       // butterfly thumb trigger
  part(g, new THREE.BoxGeometry(0.024, 0.02, 0.03), MAT.blued, 0.06, 0.02, 0.155)     // safety catch

  // --- Tripod cradle + elevating gear dropping out of the bottom of view. ----
  part(g, new THREE.BoxGeometry(0.07, 0.07, 0.09), MAT.paint, 0, -0.06, 0.02)         // pintle / cradle trunnion
  part(g, new THREE.BoxGeometry(0.026, 0.3, 0.026), MAT.paint, 0, -0.26, 0.0, 0.15)   // front leg dropping away
  part(g, new THREE.BoxGeometry(0.026, 0.24, 0.026), MAT.paint, 0.06, -0.22, 0.12, -0.3, 0.3, 0) // splayed leg
  part(g, new THREE.CylinderGeometry(0.011, 0.011, 0.16, 8), MAT.brass, -0.03, -0.14, 0.09) // elevating screw

  const vm: Viewmodel = {
    group: g, muzzle: new THREE.Vector3(0, cy, -0.98),
    recoilPart: recoil, restRecoilZ: recoil.position.z,
  }
  finish(g, 0.82)
  return vm
}

function buildPistol(): Viewmodel {
  // Webley Mk VI .455 — the officer's top-break service revolver. Six-shot
  // fluted cylinder, squared barrel with a sighting rib, stirrup top-latch,
  // external hammer and the squared birdshead grip with its lanyard ring,
  // held in the right fist. Butt/breech +Z, muzzle −Z; bore line ~y 0.04.
  const g = new THREE.Group()

  // Extra tones just for this model: near-black recesses, darker walnut grooves.
  const hole = mkMat(0x14171c, 0.6, 0.15, 0x050608)
  const gripDk = mkMat(0x5c3a1e, 0.82, 0.04, 0x180e05)

  // ---- Frame / standing breech (rear body carrying hammer, latch, grip) ----
  part(g, new THREE.BoxGeometry(0.03, 0.082, 0.055), MAT.blued, 0, 0.004, 0.02)
  // Recoil shield: the disc the cartridge heads seat against at the cylinder rear.
  part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.012, 14).rotateX(Math.PI / 2), MAT.blued, 0, 0.01, -0.004)

  // ---- Six-shot fluted cylinder ----
  part(g, new THREE.CylinderGeometry(0.028, 0.028, 0.05, 14).rotateX(Math.PI / 2), MAT.steel, 0, 0.01, -0.03)
  part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.008, 14).rotateX(Math.PI / 2), MAT.blued, 0, 0.01, -0.007) // rear ratchet ring
  // Lengthwise flutes — dark recesses between the six chambers.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    part(g, new THREE.BoxGeometry(0.006, 0.006, 0.046), hole, Math.cos(a) * 0.026, 0.01 + Math.sin(a) * 0.026, -0.03)
  }
  // Chamber mouths at the front face.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6
    part(g, new THREE.CylinderGeometry(0.005, 0.005, 0.016, 8).rotateX(Math.PI / 2), hole, Math.cos(a) * 0.016, 0.01 + Math.sin(a) * 0.016, -0.05)
  }
  // Centre pin / ejector rod poking out of the cylinder face + star boss.
  part(g, new THREE.CylinderGeometry(0.009, 0.009, 0.006, 8).rotateX(Math.PI / 2), MAT.steel, 0, 0.01, -0.055)
  part(g, new THREE.CylinderGeometry(0.004, 0.004, 0.03, 8).rotateX(Math.PI / 2), MAT.steel, 0, 0.01, -0.066)

  // ---- Top strap + squared barrel (the Mk VI's flat-sided barrel) ----
  part(g, new THREE.BoxGeometry(0.018, 0.01, 0.08), MAT.blued, 0, 0.05, -0.02) // top strap over cylinder
  part(g, new THREE.BoxGeometry(0.028, 0.03, 0.135), MAT.blued, 0, 0.04, -0.122) // squared barrel
  part(g, new THREE.BoxGeometry(0.024, 0.014, 0.05), MAT.blued, 0, 0.02, -0.058) // barrel lug under the breech end
  // Sighting rib — twin rails leaving a dark central groove down the barrel.
  part(g, new THREE.BoxGeometry(0.004, 0.007, 0.135), MAT.blued, 0.006, 0.058, -0.122)
  part(g, new THREE.BoxGeometry(0.004, 0.007, 0.135), MAT.blued, -0.006, 0.058, -0.122)

  // ---- Top-break hinge (front-bottom pivot the whole barrel swings on) ----
  part(g, new THREE.CylinderGeometry(0.007, 0.007, 0.05, 10).rotateZ(Math.PI / 2), MAT.steel, 0, 0.012, -0.062)
  part(g, new THREE.BoxGeometry(0.008, 0.022, 0.016), MAT.blued, 0.017, 0.012, -0.062)
  part(g, new THREE.BoxGeometry(0.008, 0.022, 0.016), MAT.blued, -0.017, 0.012, -0.062)

  // ---- Stirrup top latch (the Webley signature; thumb-piece on the left) ----
  part(g, new THREE.BoxGeometry(0.026, 0.016, 0.03), MAT.steel, 0, 0.055, 0.028)
  part(g, new THREE.BoxGeometry(0.008, 0.024, 0.022), MAT.blued, -0.02, 0.05, 0.028, 0, 0, 0.2) // thumb lever, left side
  part(g, new THREE.CylinderGeometry(0.004, 0.004, 0.032, 8).rotateZ(Math.PI / 2), MAT.steel, 0, 0.05, 0.034) // latch pivot pin

  // ---- Rear V-notch sight (milled into the standing-breech top) ----
  part(g, new THREE.BoxGeometry(0.018, 0.009, 0.012), MAT.blued, 0, 0.061, 0.006)
  part(g, new THREE.BoxGeometry(0.005, 0.011, 0.01), MAT.steel, 0.006, 0.065, 0.006)
  part(g, new THREE.BoxGeometry(0.005, 0.011, 0.01), MAT.steel, -0.006, 0.065, 0.006)

  // ---- Front blade sight on the squared barrel ----
  part(g, new THREE.BoxGeometry(0.014, 0.01, 0.022), MAT.blued, 0, 0.057, -0.176)
  part(g, new THREE.BoxGeometry(0.005, 0.022, 0.008), MAT.steel, 0, 0.07, -0.176)

  // ---- Muzzle crown + bore ----
  part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.01, 12).rotateX(Math.PI / 2), MAT.blued, 0, 0.04, -0.19)
  part(g, new THREE.CylinderGeometry(0.006, 0.006, 0.014, 10).rotateX(Math.PI / 2), hole, 0, 0.04, -0.193)

  // ---- External hammer with a checkered spur, leaning back over the grip ----
  part(g, new THREE.BoxGeometry(0.01, 0.03, 0.014), MAT.steel, 0, 0.052, 0.05, 0.4)
  part(g, new THREE.BoxGeometry(0.013, 0.009, 0.017), MAT.blued, 0, 0.07, 0.06, 0.4) // spur thumb-piece
  for (let i = 0; i < 3; i++) {
    part(g, new THREE.BoxGeometry(0.009, 0.0015, 0.003), hole, 0, 0.072 + i * 0.001, 0.055 + i * 0.005, 0.4) // spur checkering
  }
  part(g, new THREE.CylinderGeometry(0.004, 0.004, 0.024, 8).rotateZ(Math.PI / 2), MAT.steel, 0, 0.048, 0.05) // hammer pivot

  // ---- Trigger + rounded guard bow ----
  part(g, new THREE.TorusGeometry(0.02, 0.004, 8, 18), MAT.blued, 0, -0.022, 0.03, 0, Math.PI / 2, 0) // guard loop
  part(g, new THREE.BoxGeometry(0.007, 0.022, 0.007), MAT.steel, 0, -0.014, 0.03, -0.2) // trigger blade
  part(g, new THREE.BoxGeometry(0.007, 0.008, 0.01), MAT.steel, 0, -0.026, 0.026, -0.7) // trigger tip curl
  part(g, new THREE.BoxGeometry(0.012, 0.012, 0.01), MAT.blued, 0, -0.006, 0.014) // guard front tang

  // ---- Squared birdshead grip (raked to sit in the working hip/aim pose) ----
  const rake = 0.36
  part(g, new THREE.BoxGeometry(0.026, 0.1, 0.048), MAT.darkWood, 0, -0.062, 0.052, rake)
  part(g, new THREE.BoxGeometry(0.007, 0.09, 0.044), gripDk, 0.016, -0.06, 0.052, rake) // right walnut panel
  part(g, new THREE.BoxGeometry(0.007, 0.09, 0.044), gripDk, -0.016, -0.06, 0.052, rake) // left walnut panel
  part(g, new THREE.BoxGeometry(0.011, 0.1, 0.008), MAT.blued, 0, -0.062, 0.077, rake) // backstrap
  part(g, new THREE.BoxGeometry(0.011, 0.09, 0.008), MAT.blued, 0, -0.058, 0.027, rake) // frontstrap
  part(g, new THREE.BoxGeometry(0.032, 0.016, 0.052), MAT.blued, 0, -0.108, 0.036, rake) // birdshead butt cap
  // Checkering — thin diagonal slats crosshatching both panels.
  for (let i = 0; i < 4; i++) {
    const cy = -0.035 - i * 0.017
    const cz = 0.05 - i * 0.006
    part(g, new THREE.BoxGeometry(0.009, 0.0018, 0.03), hole, 0.018, cy, cz, rake, 0, 0.3)
    part(g, new THREE.BoxGeometry(0.009, 0.0018, 0.03), hole, -0.018, cy, cz, rake, 0, -0.3)
  }
  // Lanyard ring + swivel at the butt heel.
  part(g, new THREE.CylinderGeometry(0.004, 0.004, 0.01, 8), MAT.steel, 0, -0.116, 0.03)
  part(g, new THREE.TorusGeometry(0.009, 0.0025, 8, 12), MAT.steel, 0, -0.126, 0.03)

  // ---- Hint of the firing hand on the grip (right fist, MAT.flesh) ----
  part(g, new THREE.BoxGeometry(0.03, 0.05, 0.03), MAT.flesh, 0.006, -0.05, 0.076, rake) // heel / back of hand
  for (let i = 0; i < 4; i++) {
    part(g, new THREE.BoxGeometry(0.03, 0.013, 0.016), MAT.flesh, 0.004, -0.03 - i * 0.016, 0.022 - i * 0.004, rake, 0, 0.05) // curled fingers
  }
  part(g, new THREE.BoxGeometry(0.014, 0.038, 0.016), MAT.flesh, -0.021, -0.008, 0.05, 0.5, 0, 0.15) // thumb
  part(g, new THREE.BoxGeometry(0.014, 0.016, 0.014), MAT.flesh, -0.023, 0.02, 0.038, 0.2) // thumb tip near the frame

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.04, -0.195) }
  finish(g, 0.95)
  return vm
}

function buildGrenade(): Viewmodel {
  const g = new THREE.Group()
  // A right hand cradling a Mills bomb No.5, thumb clamping the spring lever,
  // cocked back and about to hurl. Cast-iron ovoid with the famous waffle grid
  // (both vertical ribs and horizontal grooves — a cross-hatch, not just rings).

  // Dark cast-iron body — distinct from the field-grey ordnance paint so the
  // bright steel waffle and the polished lever both read against it.
  const iron = mkMat(0x4d4f46, 0.72, 0.2, 0x0b0c0a)

  const bx = 0, by = 0.052, bz = -0.015 // bomb centre
  const bR = 0.046 // equatorial radius
  const halfH = bR * 1.28 // ovoid half-height (~0.059)

  // ---- hand: palm, heel, rolled-sleeve cuff ----
  part(g, new THREE.BoxGeometry(0.078, 0.042, 0.088), MAT.flesh, 0.006, -0.016, 0.024, -0.15, 0.05, 0.05) // palm
  part(g, new THREE.BoxGeometry(0.07, 0.05, 0.05), MAT.flesh, 0.004, -0.03, 0.058, -0.2) // heel/wrist
  part(g, new THREE.CylinderGeometry(0.05, 0.056, 0.055, 12).rotateX(Math.PI / 2), MAT.canvas, 0.004, -0.036, 0.088) // cuff

  // ---- four curling fingers wrapping the lower front ----
  const proxGeo = new THREE.BoxGeometry(0.016, 0.02, 0.05)
  const distGeo = new THREE.BoxGeometry(0.015, 0.018, 0.03)
  const knuGeo = new THREE.SphereGeometry(0.009, 8, 6)
  for (let i = 0; i < 4; i++) {
    const fx = -0.03 + i * 0.02
    const lift = (i === 1 || i === 2) ? 0.005 : 0 // middle fingers reach a touch higher
    part(g, proxGeo, MAT.flesh, fx, -0.006 + lift, -0.044, 0.5) // proximal — up the front
    part(g, knuGeo, MAT.flesh, fx, 0.008 + lift, -0.052) // knuckle
    part(g, distGeo, MAT.flesh, fx, 0.024 + lift, -0.057, 1.2) // distal — curled over
  }

  // ---- thumb clamping the safety lever (inner side) ----
  part(g, new THREE.BoxGeometry(0.022, 0.02, 0.04), MAT.flesh, 0.046, -0.004, 0.0, 0, 0.2, -0.45) // base
  part(g, new THREE.BoxGeometry(0.02, 0.018, 0.032), MAT.flesh, 0.035, 0.024, 0.016, 0.4, 0.25, -0.3) // mid
  part(g, new THREE.BoxGeometry(0.02, 0.016, 0.024), MAT.flesh, 0.023, 0.05, 0.03, 0.7, 0.2, -0.18) // tip pressing lever

  // ---- bomb body (ovoid cast iron) ----
  const body = new THREE.SphereGeometry(bR, 14, 12); body.scale(1, 1.28, 1)
  part(g, body, iron, bx, by, bz)

  // ---- waffle grid: horizontal grooves (latitude rings, radius follows the ovoid) ----
  for (const dy of [-0.04, -0.02, 0, 0.02, 0.04]) {
    const f = Math.sqrt(Math.max(0, 1 - (dy / halfH) ** 2))
    part(g, new THREE.TorusGeometry(bR * f + 0.001, 0.004, 8, 20), MAT.steel, bx, by + dy, bz, Math.PI / 2)
  }
  // ---- waffle grid: vertical ribs (meridians) ----
  const ribGeo = new THREE.BoxGeometry(0.007, 0.06, 0.012)
  for (let i = 0; i < 8; i++) {
    const th = (i / 8) * Math.PI * 2
    part(g, ribGeo, MAT.steel, bx + Math.sin(th) * 0.043, by, bz + Math.cos(th) * 0.043, 0, th, 0)
  }

  // ---- base plug + detonator boss ----
  part(g, new THREE.CylinderGeometry(0.022, 0.024, 0.02, 6), MAT.blued, bx, by - halfH + 0.005, bz) // hex base plug
  part(g, new THREE.CylinderGeometry(0.013, 0.013, 0.012, 8), MAT.blued, bx, by - halfH - 0.011, bz) // detonator boss

  // ---- top fuze assembly ----
  part(g, new THREE.CylinderGeometry(0.02, 0.022, 0.016, 12), MAT.steel, bx, by + halfH - 0.002, bz) // fuze collar
  part(g, new THREE.CylinderGeometry(0.013, 0.013, 0.016, 10), MAT.steel, bx, by + halfH + 0.012, bz) // striker cap

  // ---- spring safety lever (the spoon) running down the front face ----
  part(g, new THREE.BoxGeometry(0.02, 0.014, 0.026), MAT.steel, 0.008, by + halfH + 0.006, bz + 0.014, 0.5) // top hook over striker
  part(g, new THREE.BoxGeometry(0.018, 0.1, 0.006), MAT.steel, 0.01, 0.058, 0.033, -0.08) // long spoon strip
  part(g, new THREE.BoxGeometry(0.018, 0.02, 0.016), MAT.steel, 0.01, 0.008, 0.028, 0.7) // lower foot tucking under

  // ---- split-pin + pull ring at the top ----
  part(g, new THREE.CylinderGeometry(0.0025, 0.0025, 0.028, 6), MAT.steel, -0.012, by + halfH + 0.004, bz + 0.004, 0, 0, Math.PI / 2) // pin
  part(g, new THREE.TorusGeometry(0.012, 0.0028, 8, 16), MAT.steel, -0.03, by + halfH + 0.004, bz + 0.006) // pull ring

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.075, -0.05) }
  finish(g, 1.0)
  return vm
}

function buildMortar(): Viewmodel {
  const g = new THREE.Group()

  // Two shades not in the shared palette: cloth propellant-ring tan and a dull
  // bomb olive. Low metalness + a dim emissive floor so they read against sky.
  const cloth = mkMat(0xb8a878, 0.9, 0.03, 0x1b1810)
  const bombOlive = mkMat(0x556149, 0.78, 0.18, 0x14180f)

  // --- Tube axis -----------------------------------------------------------
  // The Stokes tube tilts muzzle-up-and-forward; everything welded to it shares
  // the same X-tilt. ty()/tz() return a point on the bore axis at parametric
  // distance t (local units, +t toward the muzzle) from the tube centre, so
  // collars, bands and the muzzle land exactly on the tilted line.
  const TILT = -1.15
  const C = Math.cos(TILT), S = Math.sin(TILT)
  const ty = (t: number) => 0.12 + C * t
  const tz = (t: number) => -0.42 + S * t

  // A camera-facing knurled brass hand-wheel: rim + hub + three spokes (six-spoke
  // look) + a stubby grab-handle on the rim. Used for the laying gear below.
  const wheel = (cx: number, cy: number, cz: number, R: number, tb: number, mat: THREE.Material) => {
    part(g, new THREE.TorusGeometry(R, tb, 8, 18), mat, cx, cy, cz)                                   // rim
    part(g, new THREE.CylinderGeometry(R * 0.3, R * 0.3, tb * 2.4, 10).rotateX(Math.PI / 2), mat, cx, cy, cz) // hub
    for (let i = 0; i < 3; i++)
      part(g, new THREE.BoxGeometry(R * 1.75, tb * 0.7, tb * 0.7), mat, cx, cy, cz, 0, 0, i * Math.PI / 3) // spokes
    part(g, new THREE.CylinderGeometry(tb * 1.2, tb * 1.2, tb * 3, 8).rotateX(Math.PI / 2), MAT.steel,
      cx + R * 0.82, cy + R * 0.42, cz + tb * 1.6)                                                    // grab handle
  }

  // --- The tube ------------------------------------------------------------
  part(g, new THREE.CylinderGeometry(0.058, 0.064, 0.86, 16), MAT.blued, 0, 0.12, -0.42, TILT)
  // Reinforcing bands stepping up the barrel.
  part(g, new THREE.CylinderGeometry(0.07, 0.07, 0.03, 16), MAT.steel, 0, ty(0.30), tz(0.30), TILT)
  part(g, new THREE.CylinderGeometry(0.07, 0.07, 0.03, 16), MAT.steel, 0, ty(0.02), tz(0.02), TILT)
  part(g, new THREE.CylinderGeometry(0.072, 0.072, 0.035, 16), MAT.steel, 0, ty(-0.26), tz(-0.26), TILT)
  // Muzzle collar + flared crown lip at the mouth.
  part(g, new THREE.CylinderGeometry(0.074, 0.074, 0.05, 16), MAT.steel, 0, ty(0.39), tz(0.39), TILT)
  part(g, new THREE.CylinderGeometry(0.08, 0.062, 0.04, 16), MAT.blued, 0, ty(0.44), tz(0.44), TILT)
  // Rounded base cap seating into the plate socket (the fixed firing pin lives here).
  const cap = new THREE.SphereGeometry(0.07, 12, 10); cap.scale(1, 0.8, 1)
  part(g, cap, MAT.blued, 0, ty(-0.44), tz(-0.44))

  // --- Base plate + spade at your feet -------------------------------------
  part(g, new THREE.BoxGeometry(0.28, 0.035, 0.26), MAT.paint, 0, -0.175, -0.05)      // heavy plate
  part(g, new THREE.CylinderGeometry(0.055, 0.06, 0.055, 14), MAT.steel, 0, -0.14, -0.04) // ball-socket boss
  part(g, new THREE.BoxGeometry(0.02, 0.02, 0.24), MAT.steel, 0.09, -0.152, -0.05)    // rib
  part(g, new THREE.BoxGeometry(0.02, 0.02, 0.24), MAT.steel, -0.09, -0.152, -0.05)   // rib
  part(g, new THREE.BoxGeometry(0.24, 0.1, 0.02), MAT.blued, 0, -0.205, 0.075, 0.6)   // spade cleat, angled, biting in
  part(g, new THREE.TorusGeometry(0.04, 0.008, 6, 14), MAT.steel, 0, -0.157, -0.185, Math.PI / 2) // lifting ring

  // --- Bipod: two splayed legs, cross-tie, feet ----------------------------
  part(g, new THREE.BoxGeometry(0.022, 0.32, 0.022), MAT.paint, 0.0975, -0.06, -0.345, 0.1, 0, 0.5)  // right leg
  part(g, new THREE.BoxGeometry(0.022, 0.32, 0.022), MAT.paint, -0.0975, -0.06, -0.345, 0.1, 0, -0.5) // left leg
  part(g, new THREE.BoxGeometry(0.26, 0.018, 0.018), MAT.steel, 0, -0.075, -0.35)     // cross-tie
  part(g, new THREE.BoxGeometry(0.05, 0.02, 0.05), MAT.steel, 0.165, -0.2, -0.365)    // right foot spade
  part(g, new THREE.BoxGeometry(0.05, 0.02, 0.05), MAT.steel, -0.165, -0.2, -0.365)   // left foot spade
  // Clamp collar gripping the tube where the bipod meets it + hanging bracket.
  part(g, new THREE.CylinderGeometry(0.076, 0.076, 0.055, 16), MAT.steel, 0, ty(-0.10), tz(-0.10), TILT)
  part(g, new THREE.BoxGeometry(0.05, 0.09, 0.04), MAT.blued, 0.03, ty(-0.10) - 0.05, tz(-0.10) + 0.02)

  // --- Laying gear ---------------------------------------------------------
  // Vertical elevation screw (threaded rod + brass hand-wheel) on the right.
  part(g, new THREE.CylinderGeometry(0.01, 0.01, 0.17, 8), MAT.brass, 0.105, 0.0, -0.315, -0.12, 0, -0.05)
  for (let i = 0; i < 3; i++)
    part(g, new THREE.TorusGeometry(0.013, 0.004, 5, 10), MAT.brass, 0.105, -0.04 + i * 0.035, -0.315, Math.PI / 2)
  part(g, new THREE.CylinderGeometry(0.008, 0.008, 0.06, 8).rotateZ(Math.PI / 2), MAT.brass, 0.135, -0.02, -0.31) // cross-shaft
  wheel(0.17, -0.02, -0.30, 0.05, 0.011, MAT.brass)
  // Horizontal traversing screw (threaded rod + crank wheel) across the front.
  part(g, new THREE.CylinderGeometry(0.009, 0.009, 0.22, 8).rotateZ(Math.PI / 2), MAT.brass, 0, -0.06, -0.30)
  for (let i = 0; i < 3; i++)
    part(g, new THREE.TorusGeometry(0.012, 0.0035, 5, 10), MAT.brass, -0.05 + i * 0.05, -0.06, -0.30, 0, Math.PI / 2)
  wheel(-0.14, -0.06, -0.30, 0.033, 0.009, MAT.brass)

  // --- 3-inch bomb staged ready beside the plate ---------------------------
  // Laid on the ground to the right, tail toward you so the fins + ring charges
  // read at a glance; nose points downrange (−Z).
  const bx = 0.235, by = -0.135
  part(g, new THREE.CylinderGeometry(0.045, 0.045, 0.19, 14).rotateX(Math.PI / 2), bombOlive, bx, by, -0.165) // body
  part(g, new THREE.SphereGeometry(0.045, 12, 10), bombOlive, bx, by, -0.26)                     // rounded nose
  part(g, new THREE.CylinderGeometry(0.015, 0.022, 0.035, 10).rotateX(Math.PI / 2), MAT.brass, bx, by, -0.29) // nose fuze
  part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.09, 10).rotateX(Math.PI / 2), MAT.blued, bx, by, -0.025)   // tail tube
  for (let i = 0; i < 3; i++)
    part(g, new THREE.TorusGeometry(0.03, 0.012, 6, 14), cloth, bx, by, -0.05 + i * 0.015)        // ring charges
  part(g, new THREE.BoxGeometry(0.004, 0.075, 0.05), MAT.steel, bx, by, 0.0)                      // fin plate (vertical pair)
  part(g, new THREE.BoxGeometry(0.075, 0.004, 0.05), MAT.steel, bx, by, 0.0)                      // fin plate (horizontal pair)
  part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.02, 8).rotateX(Math.PI / 2), MAT.brass, bx, by, 0.03) // shotgun cartridge

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, ty(0.47), tz(0.47)) }
  finish(g, 0.85)
  return vm
}

/** A brass-spoked artillery handwheel (elevation / traverse gear). */
function buildHandwheel(rim: number, spokes: number): THREE.Group {
  const w = new THREE.Group()
  part(w, new THREE.TorusGeometry(rim, rim * 0.16, 8, 20), MAT.brass, 0, 0, 0)
  part(w, new THREE.CylinderGeometry(rim * 0.24, rim * 0.24, rim * 0.5, 10).rotateX(Math.PI / 2), MAT.steel, 0, 0, 0)
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2
    part(w, new THREE.BoxGeometry(rim * 0.09, rim * 1.7, rim * 0.09), MAT.brass, 0, 0, 0, 0, 0, a)
  }
  part(w, new THREE.CylinderGeometry(rim * 0.13, rim * 0.13, rim * 0.5, 8).rotateX(Math.PI / 2), MAT.darkWood, rim * 0.85, rim * 0.55, rim * 0.5)
  return w
}

/**
 * QF 18-pounder over open sights, seen from the layer's seat behind the breech.
 *
 * The old viewmodel was a single flat 0.5 m shield plate hung off the eye — welded
 * to the camera it read as a grey wall filling the lower screen wherever you
 * turned. This rebuild is the actual gun: a recoiling barrel + interrupted-screw
 * breech riding a cradle, hydro-pneumatic recuperators above and below, a dial
 * sight up on the left you lay through, brass elevation/traverse handwheels, and a
 * shield kept LOW (its top under the bore line) with two side wings so you sight
 * OVER it at the battlefield instead of into a plate. The barrel + breech ride a
 * recoil sub-group so the whole mass slams back into the cradle on discharge
 * (see poseViewmodel), and the dial-sight bracket is the optic ADS zooms through.
 */
function buildFieldgun(): Viewmodel {
  const g = new THREE.Group()

  // -- recoiling mass: barrel + breech ride this sub-group, slamming back on fire.
  const recoil = new THREE.Group()
  g.add(recoil)
  const barrel = new THREE.CylinderGeometry(0.044, 0.05, 1.02, 18); barrel.rotateX(Math.PI / 2)
  part(recoil, barrel, MAT.blued, 0, 0.02, -0.44)
  part(recoil, new THREE.CylinderGeometry(0.062, 0.066, 0.2, 18).rotateX(Math.PI / 2), MAT.blued, 0, 0.02, 0.04) // reinforced chase
  part(recoil, new THREE.CylinderGeometry(0.054, 0.05, 0.07, 18).rotateX(Math.PI / 2), MAT.steel, 0, 0.02, -0.94) // muzzle swell
  part(recoil, new THREE.CylinderGeometry(0.047, 0.047, 0.02, 18).rotateX(Math.PI / 2), MAT.blued, 0, 0.02, -0.99) // muzzle collar
  part(recoil, new THREE.CylinderGeometry(0.082, 0.082, 0.12, 12).rotateX(Math.PI / 2), MAT.steel, 0, 0.02, 0.12) // breech ring
  part(recoil, new THREE.CylinderGeometry(0.07, 0.07, 0.09, 14).rotateX(Math.PI / 2), MAT.blued, 0.055, 0.02, 0.15) // swinging block
  part(recoil, new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12).rotateX(Math.PI / 2), MAT.brass, 0.055, 0.02, 0.2) // mushroom head
  part(recoil, new THREE.BoxGeometry(0.03, 0.16, 0.03), MAT.darkWood, 0.11, -0.03, 0.14, 0, 0, -0.4) // breech lever

  // -- cradle / saddle wrapping the barrel at the trunnions (static).
  part(g, new THREE.BoxGeometry(0.17, 0.12, 0.26), MAT.paint, 0, -0.03, 0.0)
  part(g, new THREE.CylinderGeometry(0.032, 0.032, 0.22, 12), MAT.steel, 0, -0.02, 0.0, 0, 0, Math.PI / 2) // trunnion axle
  // Hydro-pneumatic recuperator cylinders above and below the barrel (18-pdr signature).
  part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.66, 12).rotateX(Math.PI / 2), MAT.paint, 0, 0.092, -0.28)
  part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.66, 12).rotateX(Math.PI / 2), MAT.paint, 0, -0.062, -0.28)
  part(g, new THREE.CylinderGeometry(0.034, 0.034, 0.05, 12).rotateX(Math.PI / 2), MAT.steel, 0, 0.092, -0.6) // gland nut
  part(g, new THREE.CylinderGeometry(0.034, 0.034, 0.05, 12).rotateX(Math.PI / 2), MAT.steel, 0, -0.062, -0.6)

  // -- shield: two low side wings + an apron, kept BELOW the bore line so the
  //    layer sights OVER the top at the battlefield rather than into a plate.
  const wingGeo = new THREE.BoxGeometry(0.22, 0.4, 0.02)
  part(g, wingGeo, MAT.paint, -0.24, -0.13, -0.52, 0.05, 0.2, 0) // left wing, canted in
  part(g, wingGeo, MAT.paint, 0.24, -0.13, -0.52, 0.05, -0.2, 0) // right wing
  part(g, new THREE.BoxGeometry(0.58, 0.16, 0.02), MAT.paint, 0, -0.32, -0.52, -0.06, 0, 0) // lower apron
  for (let i = 0; i < 5; i++) {
    const ry = 0.0 - i * 0.075
    part(g, new THREE.SphereGeometry(0.008, 6, 5), MAT.steel, -0.135, ry, -0.51)
    part(g, new THREE.SphereGeometry(0.008, 6, 5), MAT.steel, 0.135, ry, -0.51)
  }

  // -- dial sight up on the left: bracket post, brass 'scope tube, dark lens, eyecup.
  part(g, new THREE.BoxGeometry(0.02, 0.2, 0.02), MAT.steel, -0.16, 0.08, -0.06) // bracket post
  part(g, new THREE.BoxGeometry(0.05, 0.04, 0.05), MAT.blued, -0.16, 0.18, -0.06) // sight head
  const tube = new THREE.CylinderGeometry(0.017, 0.017, 0.13, 12); tube.rotateX(Math.PI / 2)
  const sight = part(g, tube, MAT.brass, -0.16, 0.2, 0.02, -0.35, 0, 0) // angled telescope
  part(g, new THREE.CylinderGeometry(0.022, 0.022, 0.02, 12).rotateX(Math.PI / 2), MAT.glass, -0.16, 0.215, 0.08, -0.35, 0, 0) // eyepiece glass
  part(g, new THREE.CylinderGeometry(0.024, 0.024, 0.018, 12).rotateX(Math.PI / 2), MAT.blued, -0.16, 0.218, 0.088, -0.35, 0, 0) // rubber eyecup
  part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.03, 12), MAT.brass, -0.155, 0.13, -0.04, 0, 0, Math.PI / 2) // range drum

  // -- elevation handwheel (right) + traverse handwheel (lower-left).
  const elev = buildHandwheel(0.075, 6); elev.position.set(0.2, -0.05, 0.1); elev.rotation.y = 0.15; g.add(elev)
  const trav = buildHandwheel(0.06, 6); trav.position.set(-0.17, -0.16, 0.14); trav.rotation.set(0.4, 0, 0); g.add(trav)

  // -- carriage trail / axle dropping out of the bottom of view.
  part(g, new THREE.BoxGeometry(0.1, 0.14, 0.16), MAT.paint, 0, -0.24, 0.06)
  part(g, new THREE.BoxGeometry(0.08, 0.1, 0.34), MAT.paint, 0, -0.3, 0.22, 0.2, 0, 0) // trail beam sloping down-back

  const vm: Viewmodel = {
    group: g, muzzle: new THREE.Vector3(0, 0.02, -1.02),
    recoilPart: recoil, restRecoilZ: recoil.position.z,
  }
  void sight
  finish(g, 0.85)
  return vm
}

function buildFlamer(): Viewmodel {
  const g = new THREE.Group()
  // A WWI portable flame lance: a long steel wand held to the right, a copper-
  // igniter BURNER at the muzzle with an ever-lit pilot flame, a fuel valve wheel
  // and pressure gauge by the grip, and a canvas-wrapped hose snaking back over
  // your shoulder to the tank that rides off-screen on your back.

  // Hot pilot flame at the igniter — glows even before you squeeze the lever.
  const pilot = mkMat(0xffb04a, 0.4, 0.0, 0xff5a18)
  // Sooted burner bore + rubberised hose black.
  const soot = mkMat(0x2c2b2e, 0.9, 0.12, 0x0d0d0f)

  // --- Main lance tube -----------------------------------------------------
  const lance = new THREE.CylinderGeometry(0.017, 0.018, 0.76, 12); lance.rotateX(Math.PI / 2)
  part(g, lance, MAT.steel, 0, 0.0, -0.37)
  part(g, new THREE.BoxGeometry(0.006, 0.008, 0.6), MAT.blued, 0, 0.02, -0.4) // welded top seam
  part(g, new THREE.TorusGeometry(0.02, 0.006, 6, 14), MAT.blued, 0, 0, -0.2) // reinforcement collars
  part(g, new THREE.TorusGeometry(0.02, 0.006, 6, 14), MAT.blued, 0, 0, -0.45)

  // --- Burner / nozzle at the muzzle --------------------------------------
  part(g, new THREE.CylinderGeometry(0.023, 0.02, 0.12, 12).rotateX(Math.PI / 2), MAT.blued, 0, 0, -0.7) // throat
  part(g, new THREE.CylinderGeometry(0.043, 0.026, 0.08, 14).rotateX(Math.PI / 2), MAT.blued, 0, 0, -0.81) // flared burner cup, wide end forward
  part(g, new THREE.CylinderGeometry(0.03, 0.026, 0.05, 14).rotateX(Math.PI / 2), soot, 0, 0, -0.85) // sooted bore inside the cup
  part(g, new THREE.TorusGeometry(0.04, 0.007, 8, 18), MAT.copper, 0, 0, -0.83) // copper igniter ring around the mouth
  part(g, new THREE.TorusGeometry(0.03, 0.005, 8, 16), MAT.copper, 0, 0, -0.73) // igniter coil behind it
  part(g, new THREE.CylinderGeometry(0.005, 0.005, 0.62, 8).rotateX(Math.PI / 2), MAT.copper, 0.016, 0.021, -0.5) // igniter gas line up the top of the lance
  part(g, new THREE.CylinderGeometry(0.008, 0.006, 0.05, 8).rotateX(Math.PI / 2), MAT.copper, 0.026, 0.03, -0.79) // pilot head
  part(g, new THREE.SphereGeometry(0.011, 10, 8), pilot, 0.026, 0.03, -0.84) // ever-lit pilot spark flame

  // --- Fuel control valve (handwheel on top, by the grip) -----------------
  part(g, new THREE.BoxGeometry(0.045, 0.045, 0.05), MAT.steel, 0, 0.035, -0.06) // valve body
  part(g, new THREE.CylinderGeometry(0.007, 0.007, 0.05, 8), MAT.blued, 0, 0.078, -0.06) // stem
  part(g, new THREE.TorusGeometry(0.035, 0.006, 8, 16), MAT.steel, 0, 0.1, -0.06, Math.PI / 2) // handwheel rim
  part(g, new THREE.BoxGeometry(0.06, 0.006, 0.006), MAT.steel, 0, 0.1, -0.06) // spoke
  part(g, new THREE.BoxGeometry(0.006, 0.006, 0.06), MAT.steel, 0, 0.1, -0.06) // spoke
  part(g, new THREE.CylinderGeometry(0.009, 0.009, 0.024, 8), MAT.blued, 0, 0.1, -0.06) // hub

  // --- Pressure gauge angled back toward you ------------------------------
  part(g, new THREE.BoxGeometry(0.008, 0.03, 0.008), MAT.steel, -0.028, 0.03, 0.02) // gauge mount stem
  part(g, new THREE.CylinderGeometry(0.026, 0.026, 0.02, 14).rotateX(Math.PI / 2), MAT.blued, -0.03, 0.055, 0.03, -0.5) // gauge can
  part(g, new THREE.CylinderGeometry(0.022, 0.022, 0.004, 14).rotateX(Math.PI / 2), MAT.dressing, -0.03, 0.062, 0.041, -0.5) // dial face
  part(g, new THREE.BoxGeometry(0.002, 0.018, 0.002), MAT.blued, -0.03, 0.064, 0.043, -0.5, 0, 0.6) // needle

  // --- Firing grip ---------------------------------------------------------
  part(g, new THREE.BoxGeometry(0.034, 0.12, 0.045), MAT.darkWood, 0.0, -0.075, 0.05, 0.32) // grip core
  part(g, new THREE.TorusGeometry(0.024, 0.005, 6, 12), MAT.canvas, 0.0, -0.04, 0.037, Math.PI / 2) // cord-wrap turns
  part(g, new THREE.TorusGeometry(0.024, 0.005, 6, 12), MAT.canvas, 0.0, -0.075, 0.048, Math.PI / 2)
  part(g, new THREE.TorusGeometry(0.024, 0.005, 6, 12), MAT.canvas, 0.0, -0.11, 0.059, Math.PI / 2)
  part(g, new THREE.BoxGeometry(0.012, 0.05, 0.01), MAT.steel, 0.0, -0.05, 0.01, -0.2) // lever trigger
  part(g, new THREE.TorusGeometry(0.03, 0.005, 6, 14), MAT.blued, 0.0, -0.06, 0.02, 0.32) // trigger guard loop

  // --- Gloved hand on the grip (a hint) -----------------------------------
  part(g, new THREE.BoxGeometry(0.05, 0.055, 0.05), MAT.flesh, 0.006, -0.055, 0.085, 0.3) // back of hand
  for (let i = 0; i < 3; i++) {
    part(g, new THREE.BoxGeometry(0.05, 0.013, 0.02), MAT.flesh, 0.006, -0.035 - i * 0.02, 0.03, 0.3) // fingers curling over the front
  }
  part(g, new THREE.BoxGeometry(0.014, 0.04, 0.016), MAT.flesh, -0.02, -0.05, 0.06, 0.3, 0, 0.4) // thumb
  part(g, new THREE.TorusGeometry(0.03, 0.008, 6, 12), MAT.canvas, 0.01, -0.03, 0.11, 1.2) // canvas glove cuff

  // --- Fuel hose snaking back over the shoulder ---------------------------
  part(g, new THREE.CylinderGeometry(0.017, 0.017, 0.03, 10), MAT.brass, 0.0, -0.125, 0.055) // hose inlet fitting
  part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.18, 10).rotateX(Math.PI / 2), soot, 0.03, -0.09, 0.16, 0.5, 0.4, 0) // hose segment
  part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.16, 10).rotateX(Math.PI / 2), soot, 0.07, -0.02, 0.27, 0.3, 0.5, 0) // hose segment
  part(g, new THREE.TorusGeometry(0.045, 0.014, 8, 16), soot, 0.1, 0.03, 0.3, 0.4, 0.3, 0) // coiled loop at the shoulder
  part(g, new THREE.TorusGeometry(0.042, 0.013, 8, 16), soot, 0.11, 0.08, 0.33, 0.5, 0.2, 0) // coiled loop
  part(g, new THREE.TorusGeometry(0.015, 0.004, 6, 12), MAT.canvas, 0.045, -0.06, 0.2, 0.5, 0.4, 0) // canvas reinforcement rib
  part(g, new THREE.TorusGeometry(0.015, 0.004, 6, 12), MAT.canvas, 0.085, 0.0, 0.29, 0.3, 0.5, 0) // canvas reinforcement rib

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.0, -0.9) }
  finish(g, 0.9)
  return vm
}

function buildGasProjector(): Viewmodel {
  const g = new THREE.Group()
  // A Livens drum seated in its buried tube, fired by the wooden exploder box
  // you hold in the left hand — T-plunger, terminals and a twisted firing lead
  // running out to the tube. The whole assembly tilts up-and-forward (out of −Z).

  // Local frame for the buried tube. TILT lays the Y-axis cylinder up-forward,
  // so D is the tube axis, e1/e2 the two radial directions around it.
  const TILT = -1.28
  const D = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT))  // tube axis → up-forward
  const C = new THREE.Vector3(0.12, 0.0, -0.4)                    // tube centre
  const e1 = new THREE.Vector3(1, 0, 0)                           // radial ⟂ D (screen-right)
  const e2 = new THREE.Vector3().crossVectors(D, e1).normalize()  // radial ⟂ D (down-forward)
  const on = (b: THREE.Vector3, t: number) => b.clone().addScaledVector(D, t)
  const cable = mkMat(0x2a2620, 0.72, 0.06, 0x0a0908) // dark gutta-percha firing lead

  // A slack firing lead between two points, rendered as one thin cylinder.
  const link = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
    const dir = new THREE.Vector3().subVectors(b, a)
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
    const m = part(g, new THREE.CylinderGeometry(r, r, dir.length(), 8), cable, mid.x, mid.y, mid.z)
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
    return m
  }

  // --- Buried projector tube, field-grey, seated in the baseplate -------------
  part(g, new THREE.CylinderGeometry(0.11, 0.12, 0.5, 16), MAT.paint, C.x, C.y, C.z, TILT)
  let p = on(C, -0.2) // seating / reinforcing iron collar low on the tube
  part(g, new THREE.TorusGeometry(0.128, 0.02, 8, 18).rotateX(Math.PI / 2), MAT.blued, p.x, p.y, p.z, TILT)
  p = on(C, -0.02)
  part(g, new THREE.TorusGeometry(0.122, 0.012, 8, 16).rotateX(Math.PI / 2), MAT.blued, p.x, p.y, p.z, TILT)
  const collarC = on(C, 0.19) // bright reinforced muzzle rim with a ring of rivets
  part(g, new THREE.TorusGeometry(0.118, 0.016, 8, 20).rotateX(Math.PI / 2), MAT.steel, collarC.x, collarC.y, collarC.z, TILT)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const rp = collarC.clone().addScaledVector(e1, Math.cos(a) * 0.12).addScaledVector(e2, Math.sin(a) * 0.12)
    part(g, new THREE.SphereGeometry(0.011, 8, 8), MAT.blued, rp.x, rp.y, rp.z)
  }

  // --- Gas drum seated proud of the tube mouth --------------------------------
  const Dc = new THREE.Vector3(0.19, 0.2, -0.55)
  part(g, new THREE.CylinderGeometry(0.095, 0.095, 0.16, 16), MAT.copper, Dc.x, Dc.y, Dc.z, TILT)
  let dp = on(Dc, -0.045) // riveted retaining bands
  part(g, new THREE.TorusGeometry(0.099, 0.01, 8, 16).rotateX(Math.PI / 2), MAT.blued, dp.x, dp.y, dp.z, TILT)
  dp = on(Dc, 0.045)
  part(g, new THREE.TorusGeometry(0.099, 0.01, 8, 16).rotateX(Math.PI / 2), MAT.blued, dp.x, dp.y, dp.z, TILT)
  dp = on(Dc, 0.085) // brass filler cap + hex nut on the exposed face
  part(g, new THREE.CylinderGeometry(0.032, 0.032, 0.03, 12), MAT.brass, dp.x, dp.y, dp.z, TILT)
  dp = on(Dc, 0.11)
  part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.02, 6), MAT.steel, dp.x, dp.y, dp.z, TILT)
  // lifting rings (carrying handles) on the drum sides
  part(g, new THREE.TorusGeometry(0.02, 0.006, 6, 12).rotateY(Math.PI / 2), MAT.blued, Dc.x + 0.095, Dc.y, Dc.z)
  part(g, new THREE.TorusGeometry(0.02, 0.006, 6, 12).rotateY(Math.PI / 2), MAT.blued, Dc.x - 0.095, Dc.y, Dc.z)
  // brass igniter terminal on the tube where the firing lead lands
  const ign = new THREE.Vector3(0.1, -0.055, -0.2)
  part(g, new THREE.BoxGeometry(0.024, 0.024, 0.024), MAT.brass, ign.x, ign.y, ign.z)

  // --- Wooden exploder dynamo box (held in the left hand) ---------------------
  const B = new THREE.Vector3(-0.14, -0.06, 0.04)
  part(g, new THREE.BoxGeometry(0.14, 0.09, 0.1), MAT.darkWood, B.x, B.y, B.z)
  part(g, new THREE.BoxGeometry(0.152, 0.016, 0.108), MAT.brass, B.x, -0.008, B.z)      // brass-bound lid
  part(g, new THREE.BoxGeometry(0.014, 0.086, 0.012), MAT.brass, -0.206, -0.06, 0.088)   // front corner strap L
  part(g, new THREE.BoxGeometry(0.014, 0.086, 0.012), MAT.brass, -0.075, -0.06, 0.088)   // front corner strap R
  // dial gauge on the front face
  part(g, new THREE.CylinderGeometry(0.028, 0.028, 0.008, 14).rotateX(Math.PI / 2), MAT.steel, -0.165, -0.045, 0.093)
  part(g, new THREE.TorusGeometry(0.028, 0.006, 8, 16), MAT.brass, -0.165, -0.045, 0.096)
  part(g, new THREE.BoxGeometry(0.004, 0.024, 0.004), MAT.blued, -0.165, -0.04, 0.1, 0, 0, 0.7) // needle
  part(g, new THREE.BoxGeometry(0.062, 0.022, 0.005), MAT.dressing, -0.115, -0.088, 0.093)       // instruction label
  // T-plunger you push to fire
  part(g, new THREE.CylinderGeometry(0.022, 0.022, 0.03, 10), MAT.brass, B.x, 0.006, B.z)            // gland
  part(g, new THREE.CylinderGeometry(0.011, 0.011, 0.14, 8), MAT.steel, B.x, 0.08, B.z)              // rod
  part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.12, 10).rotateZ(Math.PI / 2), MAT.darkWood, B.x, 0.15, B.z) // T-bar
  part(g, new THREE.SphereGeometry(0.018, 12, 10), MAT.darkWood, B.x - 0.06, 0.15, B.z)              // knob L
  part(g, new THREE.SphereGeometry(0.018, 12, 10), MAT.darkWood, B.x + 0.06, 0.15, B.z)              // knob R
  // terminals + twisted firing leads out to the tube
  const tA = new THREE.Vector3(-0.085, 0.02, 0.02)
  const tB = new THREE.Vector3(-0.085, 0.02, 0.06)
  part(g, new THREE.CylinderGeometry(0.007, 0.007, 0.04, 8), MAT.brass, tA.x, tA.y, tA.z)
  part(g, new THREE.SphereGeometry(0.011, 8, 8), MAT.brass, tA.x, tA.y + 0.022, tA.z)
  part(g, new THREE.CylinderGeometry(0.007, 0.007, 0.04, 8), MAT.brass, tB.x, tB.y, tB.z)
  part(g, new THREE.SphereGeometry(0.011, 8, 8), MAT.brass, tB.x, tB.y + 0.022, tB.z)
  const sag1 = new THREE.Vector3(-0.02, -0.14, -0.06)
  const sag2 = new THREE.Vector3(-0.02, -0.12, -0.01)
  link(new THREE.Vector3(tA.x, tA.y + 0.03, tA.z), sag1, 0.006); link(sag1, ign, 0.006)
  link(new THREE.Vector3(tB.x, tB.y + 0.03, tB.z), sag2, 0.006); link(sag2, ign, 0.006)

  // --- Baseplate (kept small — do NOT enlarge) + ground pickets ---------------
  part(g, new THREE.BoxGeometry(0.24, 0.03, 0.2), MAT.paint, 0.05, -0.2, -0.14)
  part(g, new THREE.CylinderGeometry(0.009, 0.006, 0.13, 8), MAT.blued, 0.16, -0.245, -0.06, 0.3, 0, 0.2)
  part(g, new THREE.CylinderGeometry(0.009, 0.006, 0.13, 8), MAT.blued, -0.05, -0.245, -0.2, -0.2, 0, -0.25)

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0.2, 0.25, -0.64) }
  finish(g, 0.85)
  return vm
}

function buildToolkit(kind: 'medic' | 'engineer'): Viewmodel {
  const g = new THREE.Group()

  // Bandage linen is a warm, deliberately DIM cream — NOT MAT.dressing's near
  // white. Held a hand's-breadth from the lens a bright white surface punches
  // through the bloom threshold (0.86) and the grade pass's chromatic aberration
  // splits that hard edge into an ugly magenta/cyan fringe. A warm cream stays
  // under the threshold and, if it does bloom, clips amber like everything else.
  const cream = mkMat(0xcdbf98, 0.92, 0.0, 0x11100a) // unbleached field-dressing linen
  const gauze = mkMat(0xb9ad86, 0.92, 0.0, 0x15140d) // shadowed winding turns / frayed edge
  const red = mkMat(0xa8302a, 0.7, 0.0, 0x2a0806)    // red-cross ink (game dressing-red)
  const tin = mkMat(0x7a5636, 0.55, 0.2, 0x17100a)   // japanned iodine tin
  const edge = mkMat(0x9aa2ad, 0.38, 0.28, 0x1c2027) // beaten cutting edge (kept under bloom)

  // --- HAND (shared) — a bare working hand: opposed thumb, curled fingers, cuff.
  part(g, new THREE.BoxGeometry(0.085, 0.05, 0.10), MAT.flesh, 0, -0.02, 0.0)     // palm
  part(g, new THREE.BoxGeometry(0.08, 0.02, 0.022), MAT.flesh, 0, 0.002, -0.045)  // knuckle ridge
  part(g, new THREE.BoxGeometry(0.07, 0.045, 0.05), MAT.flesh, 0, -0.022, 0.04)   // heel / wrist stub
  // Four fingers: a proximal + a curling distal segment + a fingertip nub each.
  for (let i = 0; i < 4; i++) {
    const fx = -0.03 + i * 0.02
    part(g, new THREE.BoxGeometry(0.016, 0.017, 0.045), MAT.flesh, fx, -0.004, -0.072, -0.42)
    part(g, new THREE.BoxGeometry(0.014, 0.016, 0.03), MAT.flesh, fx, -0.03, -0.088, -1.0)
    part(g, new THREE.SphereGeometry(0.0085, 8, 8), MAT.flesh, fx, -0.046, -0.083)
  }
  // Opposed thumb wrapping up over the near (+X) side to pin the tool.
  part(g, new THREE.BoxGeometry(0.02, 0.018, 0.03), MAT.flesh, 0.046, 0.006, -0.012, 0, 0.5, -0.3)
  part(g, new THREE.BoxGeometry(0.016, 0.016, 0.032), MAT.flesh, 0.05, 0.02, -0.042, -0.3, 0.7, 0)
  part(g, new THREE.SphereGeometry(0.0095, 10, 8), MAT.flesh, 0.03, 0.03, -0.062)
  // Webbing wrist cuff: canvas ring + a steel buckle + a short strap tail.
  part(g, new THREE.TorusGeometry(0.052, 0.014, 10, 18), MAT.canvas, 0, -0.016, 0.048)
  part(g, new THREE.BoxGeometry(0.022, 0.014, 0.014), MAT.steel, 0, 0.03, 0.052)
  part(g, new THREE.BoxGeometry(0.016, 0.03, 0.008), MAT.canvas, 0, 0.028, 0.066, 0.35)

  if (kind === 'medic') {
    // --- FIELD DRESSING — a part-unrolled bandage with a trailing loose end. ---
    const roll = new THREE.CylinderGeometry(0.032, 0.032, 0.075, 14); roll.rotateZ(Math.PI / 2)
    part(g, roll, cream, 0, 0.03, -0.07)
    // Gauze end-caps standing slightly proud so the wound layers read at the ends.
    part(g, new THREE.CylinderGeometry(0.034, 0.034, 0.006, 14).rotateZ(Math.PI / 2), gauze, 0.038, 0.03, -0.07)
    part(g, new THREE.CylinderGeometry(0.034, 0.034, 0.006, 14).rotateZ(Math.PI / 2), gauze, -0.038, 0.03, -0.07)
    // Two winding turns encircling the roll (torus turned to encircle the X axis).
    part(g, new THREE.TorusGeometry(0.033, 0.0035, 8, 16), gauze, -0.014, 0.03, -0.07, 0, Math.PI / 2)
    part(g, new THREE.TorusGeometry(0.033, 0.0035, 8, 16), gauze, 0.014, 0.03, -0.07, 0, Math.PI / 2)
    // The bandage peels off the underside and drapes back toward the shoulder in
    // three segments curling ever steeper, ending in a frayed loose tongue.
    part(g, new THREE.BoxGeometry(0.05, 0.006, 0.045), cream, 0, 0.006, -0.048, 0.55)
    part(g, new THREE.BoxGeometry(0.052, 0.006, 0.042), cream, 0, -0.028, -0.024, 0.95)
    part(g, new THREE.BoxGeometry(0.055, 0.006, 0.045), cream, 0, -0.058, 0.004, 1.25)
    part(g, new THREE.BoxGeometry(0.05, 0.005, 0.024), gauze, 0, -0.084, 0.024, 1.45)
    // Red cross printed on the crown of the roll.
    part(g, new THREE.BoxGeometry(0.05, 0.008, 0.014), red, 0, 0.062, -0.07)
    part(g, new THREE.BoxGeometry(0.014, 0.008, 0.05), red, 0, 0.062, -0.07)
    // Japanned iodine tin pinched between thumb & forefinger on the near side.
    part(g, new THREE.BoxGeometry(0.03, 0.046, 0.024), tin, 0.062, -0.018, -0.05, 0, 0, 0.2)
    part(g, new THREE.BoxGeometry(0.033, 0.009, 0.026), MAT.brass, 0.06, 0.006, -0.05, 0, 0, 0.2)
    part(g, new THREE.BoxGeometry(0.006, 0.024, 0.016), cream, 0.078, -0.02, -0.05, 0, 0, 0.2)
  } else {
    // --- ENTRENCHING SPADE — helve → socketed neck → beaten blade. -----------
    // Wooden helve with a fatter grip swell where the hand closes on it.
    part(g, new THREE.CylinderGeometry(0.011, 0.012, 0.30, 10).rotateX(Math.PI / 2), MAT.darkWood, 0, 0.02, -0.17)
    part(g, new THREE.CylinderGeometry(0.016, 0.013, 0.055, 10).rotateX(Math.PI / 2), MAT.darkWood, 0, 0.02, -0.04)
    // Two blued ferrule bands bound round the haft.
    part(g, new THREE.TorusGeometry(0.014, 0.004, 8, 14), MAT.blued, 0, 0.02, -0.095)
    part(g, new THREE.TorusGeometry(0.014, 0.004, 8, 14), MAT.blued, 0, 0.02, -0.205)
    // Tapered steel socket taking the blade tang, with two split langet straps.
    part(g, new THREE.CylinderGeometry(0.021, 0.013, 0.06, 12).rotateX(Math.PI / 2), MAT.steel, 0, 0.017, -0.29)
    part(g, new THREE.BoxGeometry(0.008, 0.006, 0.06), MAT.steel, 0.012, 0.02, -0.26, 0, 0.15, 0)
    part(g, new THREE.BoxGeometry(0.008, 0.006, 0.06), MAT.steel, -0.012, 0.02, -0.26, 0, -0.15, 0)
    // Two rivets pinning the socket to the tang.
    part(g, new THREE.SphereGeometry(0.0055, 8, 8), MAT.blued, 0.013, 0.028, -0.305)
    part(g, new THREE.SphereGeometry(0.0055, 8, 8), MAT.blued, -0.013, 0.028, -0.305)
    // Blade — angled down/forward, a raised central spine, a bright beaten edge.
    // Kept small & tilted so its broad face points downrange, never a grey wall.
    part(g, new THREE.BoxGeometry(0.13, 0.11, 0.018), MAT.steel, 0, 0.0, -0.35, 0.32)
    part(g, new THREE.BoxGeometry(0.02, 0.095, 0.01), MAT.blued, 0, 0.003, -0.338, 0.32)
    part(g, new THREE.BoxGeometry(0.128, 0.016, 0.024), edge, 0, -0.052, -0.383, 0.32)
    // A corkscrew wiring picket lashed alongside the haft (the sapper's 2nd tool).
    part(g, new THREE.CylinderGeometry(0.006, 0.006, 0.17, 8).rotateX(Math.PI / 2), MAT.blued, -0.032, -0.006, -0.15, 0, 0, 0.08)
    part(g, new THREE.TorusGeometry(0.013, 0.0035, 8, 12), MAT.blued, -0.03, -0.006, -0.066, Math.PI / 2, 0, 0)
    part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.006, 8).rotateX(Math.PI / 2), MAT.blued, -0.034, -0.006, -0.226, 0.4, 0, 0.08)
    part(g, new THREE.BoxGeometry(0.024, 0.012, 0.022), MAT.canvas, -0.018, 0.006, -0.12) // lashing
  }

  const vm: Viewmodel = { group: g, muzzle: new THREE.Vector3(0, 0.0, -0.12) }
  finish(g, 1.3)
  return vm
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const RIFLE_HIP: VmPose = { x: 0.19, y: -0.22, z: -0.46, rx: 0.06, ry: 0.06 }
// Held further out and level than the old pose so you sight DOWN the barrel — the
// detailed SMLE is bulky enough that the old close aim (z -0.32) filled the whole
// screen with the receiver at ADS instead of presenting a sight picture.
const RIFLE_AIM: VmPose = { x: 0.02, y: -0.1, z: -0.72, rx: -0.01, ry: 0 }

export const WEAPON_PROFILES: Record<UnitKindId, WeaponProfile> = {
  rifleman: {
    id: 'rifleman', name: 'Rifleman', control: 'bolt', ammoKind: 'mag',
    magSize: 10, fireInterval: 1.05, reloadTime: 3.0, recoil: 1,
    hipFov: 55, adsFov: 40, emplaced: false, scope: false, heat: false,
    spreadHip: 0.012, spreadAds: 0.0022, category: 'rifle', sound: 'rifle', tracerChance: COMBAT.tracerFraction,
    ammoName: '.303 SMLE', controlsHint: 'LMB fire · RMB aim · R reload · C stance · SHIFT run',
    minRange: 0, maxRange: 0, hip: RIFLE_HIP, aim: RIFLE_AIM, build: () => buildRifle(false),
  },
  lewis: {
    id: 'lewis', name: 'Lewis Gunner', control: 'auto', ammoKind: 'mag',
    magSize: 47, fireInterval: 0.11, reloadTime: 3.6, recoil: 0.62,
    hipFov: 58, adsFov: 44, emplaced: false, scope: false, heat: false,
    spreadHip: 0.02, spreadAds: 0.007, category: 'rifle', sound: 'mg', tracerChance: 0.5,
    ammoName: '.303 Lewis pan', controlsHint: 'HOLD LMB fire · RMB aim · R reload · C stance',
    minRange: 0, maxRange: 0,
    // Hand-held light MG: it climbs fast the moment you hold the trigger down,
    // wandering a touch off a dead-straight line, capping well short of the
    // sky rather than every round reading identical.
    recoilClimbMul: 3.4, recoilSwayMul: 1.4,
    hip: { x: 0.16, y: -0.2, z: -0.42, rx: 0.05, ry: 0.05 },
    // Held further out + lower than the old pose so the fat pan magazine + shroud
    // don't fill the screen at ADS; you sight along the barrel under the pan.
    aim: { x: 0.02, y: -0.17, z: -0.6, rx: -0.015, ry: 0 }, build: buildLewis,
  },
  vickers: {
    id: 'vickers', name: 'Vickers MG', control: 'auto', ammoKind: 'mag',
    magSize: 250, fireInterval: 0.09, reloadTime: 5.0, recoil: 0.4,
    hipFov: 52, adsFov: 40, emplaced: true, scope: false, heat: true,
    spreadHip: 0.011, spreadAds: 0.006, category: 'mg', sound: 'mg_vickers', tracerChance: 0.5,
    ammoName: '.303 belt', controlsHint: 'HOLD LMB fire · watch HEAT · R new belt',
    minRange: 0, maxRange: 0, eyeHeight: 1.16, startPitch: -0.06,
    // Tripod-mounted: it still climbs hard over a sustained burst (that's the
    // jacket boiling, the man wrestling the spade grips), but the cradle caps
    // it a little lower than the hand-held Lewis and damps the sideways wander.
    recoilClimbMul: 2.6, recoilClimbCap: 0.13, recoilSwayMul: 0.8,
    hip: { x: 0, y: -0.4, z: -0.56, rx: 0.05, ry: 0 },
    aim: { x: 0, y: -0.4, z: -0.52, rx: 0.03, ry: 0 }, build: buildVickers,
  },
  sniper: {
    id: 'sniper', name: 'Sniper', control: 'bolt', ammoKind: 'mag',
    magSize: 5, fireInterval: 1.7, reloadTime: 3.4, recoil: 1.05,
    hipFov: 55, adsFov: 11, emplaced: false, scope: true, heat: false,
    spreadHip: 0.02, spreadAds: 0.0006, category: 'sniper', sound: 'sniper', tracerChance: 0,
    ammoName: '.303 SMLE (scoped)', controlsHint: 'RMB scope · LMB fire · R reload · C stance',
    minRange: 0, maxRange: 0,
    // Heaviest single punch in the arsenal — one hard snap up per shot, then
    // a quick settle back onto the scope before the bolt's even worked.
    recoilKickMul: 1.35,
    hip: RIFLE_HIP, aim: RIFLE_AIM, build: () => buildRifle(true),
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
    minRange: 45, maxRange: 190, eyeHeight: 1.5,
    hip: { x: 0.06, y: -0.4, z: -0.32, rx: 0, ry: 0 },
    aim: { x: 0.06, y: -0.4, z: -0.32, rx: 0, ry: 0 }, build: buildMortar,
  },
  fieldgun: {
    id: 'fieldgun', name: '18-Pounder', control: 'directgun', ammoKind: 'shells',
    magSize: 6, fireInterval: 2.4, reloadTime: 4.5, recoil: 1.4,
    hipFov: 54, adsFov: 13, emplaced: true, scope: false, gunsight: true, heat: false,
    spreadHip: 0, spreadAds: 0, category: 'artillery', sound: 'fieldgun', tracerChance: 0,
    ammoName: '18-pdr HE', controlsHint: 'RMB lay through the sight · LMB fire · R load shell',
    minRange: 0, maxRange: 0, eyeHeight: 1.32, startPitch: -0.03,
    // Nothing else on the field should feel like this: a violent single punch
    // well beyond a rifle's, on top of the FOV lurch and screen shake that
    // applyRecoil() already gives every directgun discharge.
    recoilKickMul: 1.6,
    // Sit low behind the breech: the gun frames the lower third and you sight
    // over the shield downrange. (aim ≈ hip — the gun doesn't shoulder; RMB just
    // zooms the dial-sight optic in.)
    hip: { x: 0.01, y: -0.24, z: -0.34, rx: 0.02, ry: 0 },
    aim: { x: 0.01, y: -0.24, z: -0.34, rx: 0.02, ry: 0 }, build: buildFieldgun,
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
    hip: { x: 0.14, y: -0.16, z: -0.46, rx: 0, ry: 0 },
    aim: { x: 0.1, y: -0.15, z: -0.42, rx: -0.25, ry: 0 }, build: () => buildToolkit('medic'),
  },
  officer: {
    id: 'officer', name: 'Officer', control: 'semi', ammoKind: 'mag',
    magSize: 6, fireInterval: 0.34, reloadTime: 2.6, recoil: 0.7,
    hipFov: 56, adsFov: 42, emplaced: false, scope: false, heat: false,
    spreadHip: 0.03, spreadAds: 0.012, category: 'rifle', sound: 'pistol', tracerChance: 0,
    ammoName: 'Webley .455', controlsHint: 'LMB fire · RMB aim · R reload · C stance',
    minRange: 0, maxRange: 0, flashScale: 0.6,
    // A light service revolver: a snappy little flick of the wrist, not a punch.
    recoilKickMul: 0.55,
    hip: { x: 0.18, y: -0.2, z: -0.4, rx: 0.05, ry: 0.04 },
    aim: { x: 0, y: -0.12, z: -0.34, rx: 0, ry: 0 }, build: buildPistol,
  },
  engineer: {
    id: 'engineer', name: 'Sapper', control: 'tool', ammoKind: 'none',
    magSize: 0, fireInterval: 0, reloadTime: 0, recoil: 0,
    hipFov: 58, adsFov: 55, emplaced: false, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: '', sound: 'build', tracerChance: 0,
    ammoName: 'Entrenching tools', controlsHint: 'HOLD LMB to shore up parapet / mend wire',
    minRange: 0, maxRange: 14,
    hip: { x: 0.14, y: -0.18, z: -0.48, rx: 0, ry: 0 },
    aim: { x: 0.12, y: -0.17, z: -0.44, rx: -0.2, ry: 0 }, build: () => buildToolkit('engineer'),
  },
  gasproj: {
    id: 'gasproj', name: 'Livens Projector', control: 'lob', ammoKind: 'drums',
    magSize: 4, fireInterval: 2.2, reloadTime: 5.0, recoil: 0.6,
    hipFov: 60, adsFov: 54, emplaced: true, scope: false, heat: false,
    spreadHip: 0, spreadAds: 0, category: 'gas', sound: 'gas_pop', tracerChance: 0,
    ammoName: 'Gas drums', controlsHint: 'Aim reticle · LMB launch · mind the wind · R reload',
    minRange: 70, maxRange: 200, eyeHeight: 1.34,
    hip: { x: 0.06, y: -0.38, z: -0.3, rx: 0, ry: 0 },
    aim: { x: 0.06, y: -0.38, z: -0.3, rx: 0, ry: 0 }, build: buildGasProjector,
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

/**
 * Everything one trigger event needs to know, minus the sim itself. Built by
 * FpsMode at the moment of the click, carried verbatim inside an `fpsfire`
 * command, and consumed by `dischargeWeaponSim` at the next tick boundary —
 * so both lockstep sims (and every replay) spawn the identical ordnance.
 */
export interface FireParams {
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
  muzzle: Vec3
}

/**
 * SIM half of a discharge: spawn the ordnance and nothing else. No Game, no
 * audio, no effects — those played the instant the trigger dropped (see
 * `presentDischarge`). Runs only from `applyCmd` at a tick boundary, which is
 * what makes every `ctx.rand` draw here (sniper crit, tracer chance, gas
 * scatter) land identically on every lockstep peer and in every replay.
 * All ammo/heat/interval gating is the submitting client's job; by the time
 * we're here the shot is happening.
 */
export function dischargeWeaponSim(profile: WeaponProfile, ctx: Ctx, unit: Unit, soldier: Soldier, f: FireParams): void {
  switch (profile.control) {
    case 'bolt': case 'semi': case 'auto': return fireBulletShot(profile, ctx, unit, soldier, f)
    case 'throw': return throwGrenade(profile, ctx, unit, soldier, f)
    case 'lob': return lobBomb(profile, ctx, unit, soldier, f)
    case 'directgun': return fireGun(profile, ctx, unit, soldier, f)
    case 'flame': return sprayFlame(profile, ctx, unit, soldier, f)
    case 'tool': return // continuous; rides fpstool commands instead
  }
}

function fireBulletShot(profile: WeaponProfile, ctx: Ctx, unit: Unit, soldier: Soldier, f: FireParams): void {
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
    // Ballistics ride the boresight `from` (aim-true); the visible barrel tip is
    // ~0.5 m below the eye, so hand the renderer the real muzzle to weld the
    // tracer's launch streak to the flash instead of the screen centre.
    muzzle: f.muzzle,
  })
  soldier.facing = f.yaw
  // NO heat here: the jacket is the player's to nurse — his local heat model
  // rides in on the fpspose stream, so both sims read the same value without
  // double-counting a shot's warmth.
}

function throwGrenade(profile: WeaponProfile, ctx: Ctx, unit: Unit, soldier: Soldier, f: FireParams): void {
  const g = f.ground
  if (!g) return
  const p = clampToBand(soldier.pos.x, soldier.pos.z, g.x, g.z, profile.minRange, profile.maxRange)
  soldier.facing = f.yaw
  spawnGrenade(ctx, soldier, p.x, p.z, UNIT_DEFS.grenadier.damage * ctx.mods.grenDmg,
    UNIT_DEFS.grenadier.aoe + ctx.mods.grenAoe, unit.id)
}

function lobBomb(profile: WeaponProfile, ctx: Ctx, unit: Unit, soldier: Soldier, f: FireParams): void {
  const g = f.ground
  if (!g) return
  const p = clampToBand(soldier.pos.x, soldier.pos.z, g.x, g.z, profile.minRange, profile.maxRange)
  const fromY = standSurface(ctx, soldier.pos.x, soldier.pos.z) + 0.8
  if (profile.id === 'gasproj') {
    for (let i = 0; i < 6; i++) {
      spawnGasShell(ctx, soldier.pos.x, soldier.pos.z, p.x + (ctx.rand() - 0.5) * 14, p.z + (ctx.rand() - 0.5) * 14)
    }
    ctx.s.stats.gasClouds++
  } else {
    spawnMortarBombAt(ctx, soldier.pos.x, soldier.pos.z, fromY, p.x, p.z,
      UNIT_DEFS.mortar.damage, UNIT_DEFS.mortar.aoe, unit.id)
    ctx.s.stats.shellsFired++
  }
}

function fireGun(profile: WeaponProfile, ctx: Ctx, unit: Unit, soldier: Soldier, f: FireParams): void {
  const from: Vec3 = {
    x: f.camPos.x + f.dir.x * 1.1,
    y: f.camPos.y + f.dir.y * 1.1 - 0.05,
    z: f.camPos.z + f.dir.z * 1.1,
  }
  spawnDirectShell(ctx, from.x, from.y, from.z, f.dir.x, f.dir.y, f.dir.z, 260,
    UNIT_DEFS.fieldgun.damage, UNIT_DEFS.fieldgun.aoe, unit.id)
  ctx.s.stats.shellsFired++
  soldier.facing = f.yaw
  void profile
}

function sprayFlame(profile: WeaponProfile, ctx: Ctx, unit: Unit, soldier: Soldier, f: FireParams): void {
  soldier.facing = f.yaw
  // The cone is instant-area; we call it in short puffs, so scale the bite to
  // roughly a satisfying close-range DPS without vaporising the whole wave.
  flameCone(ctx, soldier, 'brit', profile.maxRange, UNIT_DEFS.flamer.damage * 0.42, unit.id)
}

/**
 * PRESENTATION half of a discharge: the report and the world ejecta, played
 * the very frame the trigger drops — feel never waits for a tick boundary.
 * The barrel flash itself is welded to the viewmodel in FpsMode; audio here is
 * game-local (never the sim sound queue), so a lockstep peer hears our shots
 * through the sim's own snd events instead, exactly as it hears AI fire.
 * `soldier` may lag the camera by ≤1 tick; at audio ranges that is nothing.
 */
let flameSndT = 0
export function presentDischarge(profile: WeaponProfile, game: Game, soldier: Soldier, f: FireParams): void {
  switch (profile.control) {
    case 'bolt': case 'semi': case 'auto': {
      const fx = f.camPos.x + f.dir.x * 0.7
      const fy = f.camPos.y + f.dir.y * 0.7 - 0.06
      const fz = f.camPos.z + f.dir.z * 0.7
      game.audio.play(profile.sound, { x: fx, y: fy, z: fz, gain: profile.id === 'sniper' ? 1 : 0.9 })
      // Kick the world ejecta (sparks, smoke, brass) off the real muzzle tip.
      // `core=false` suppresses the world-space flash sprite.
      game.effects.muzzleFlash(f.muzzle.x, f.muzzle.y, f.muzzle.z, f.dir.x, f.dir.z,
        profile.id === 'vickers', 0.5, false)
      return
    }
    case 'throw':
      game.audio.play('whistle_attack', { x: soldier.pos.x, y: 1.6, z: soldier.pos.z, gain: 0.2, rate: 1.6 })
      return
    case 'lob':
      // The launch pop/whistle arrives via the sim sound queue with the bomb
      // itself (≤1 tick); only the Livens' visible battery flash is instant.
      if (profile.id === 'gasproj') {
        const fromY = standSurface(game.ctx, soldier.pos.x, soldier.pos.z) + 0.8
        game.effects.muzzleFlash(soldier.pos.x, fromY, soldier.pos.z, f.dir.x, f.dir.z, true)
      }
      return
    case 'directgun': {
      const fx = f.camPos.x + f.dir.x * 1.1
      const fy = f.camPos.y + f.dir.y * 1.1 - 0.05
      const fz = f.camPos.z + f.dir.z * 1.1
      game.audio.play('fieldgun', { x: fx, y: fy, z: fz })
      // Barrel flash is welded to the viewmodel in FpsMode; keep only the world
      // ejecta out here (core=false). muzzleFlash now throws its own big
      // night-scaled ground light in both views, so no separate flash() call.
      game.effects.muzzleFlash(f.muzzle.x, f.muzzle.y, f.muzzle.z, f.dir.x, f.dir.z, true, 0.5, false)
      return
    }
    case 'flame':
      flameSndT -= profile.fireInterval
      if (flameSndT <= 0) {
        flameSndT = 0.22
        game.audio.play('gas_pop', { x: soldier.pos.x, y: 1.4, z: soldier.pos.z, gain: 0.32, rate: 0.6 })
      }
      return
    case 'tool': return
  }
}

// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }
