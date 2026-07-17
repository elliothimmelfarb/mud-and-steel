/**
 * First-person embodiment: take over ANY man in your line — rifleman or Lewis
 * gunner, sniper or bomber, the Vickers on its tripod, the Stokes mortar, the
 * 18-pounder over open sights, the flame projector, the Livens gas battery, or
 * the stretcher-bearer and sapper — and fight his war yourself. Pointer-lock
 * mouselook, stance-aware movement through real trench geometry, and a weapon
 * that fires the SAME physically-simulated ordnance every AI crew fires. The
 * enemy treats you as one more man on the field; they will shoot back at *you*.
 *
 * Each weapon's behaviour lives in a data profile (weapons.ts). This mode is
 * the shell around it: trigger semantics, reload, heat, fuel, aim reticle,
 * scope, the viewmodel it hangs off the camera, and the HUD that reads it out.
 *
 * Enter: select a unit and press M, or double-click a soldier.
 * Exit:  M or Esc (or death, which is very much period-authentic).
 */
import * as THREE from 'three'
import type { Bullet, Soldier, Unit, UnitKindId } from '../core/types'
import { COMBAT, WORLD } from '../core/config'
import { standSurface } from '../sim/ballistics'
import { sectionAt } from '../sim/trench'
import { dist2 } from '../sim/sim'
import {
  WEAPON_PROFILES, dischargeWeapon, groundHit, clampToBand,
  type WeaponProfile, type Viewmodel, type GroundHit,
} from './weapons'
import type { Game } from './game'

const EYE_HEIGHT = { stand: 1.68, crouch: 1.1, prone: 0.5, dead: 0.3 } as const
const MOVE_SPEED = { stand: 3.3, crouch: 1.7, prone: 0.85, dead: 0 } as const
const SPRINT_SPEED = 5.3

// Supersonic whiz-by (see scanWhizByes): a round need not actually HIT you to
// announce itself — real rifle rounds break the sound barrier, so a close
// pass cracks past the ear well before (and separately from) the report of
// the gun that fired it. `WHIZ_RADIUS` is the closest-approach distance that
// still reads as "close enough to notice"; `WHIZ_SLOTS` caps how many of
// THIS frame's qualifying rounds actually get a crack, so a machine-gun burst
// or a heavy firefight can't pile ten cracks on top of each other at once —
// see the scratch-array field comment below for how the cap is enforced
// without a per-frame allocation.
const WHIZ_RADIUS = 2.2
const WHIZ_SLOTS = 3

// Hit marker / directional damage feedback (see updateFeedback): how long a
// plain hit vs. a kill confirmation stays lit on the crosshair, how many
// simultaneous "hit from over there" wedges the pool can hold, and how long
// one of those wedges takes to fade. Kept short and snappy — this is a
// confirmation, not a status display.
const HIT_MARKER_DUR = 0.18
const HIT_MARKER_KILL_DUR = 0.5
const HURT_SLOTS = 4
const HURT_INDICATOR_DUR = 1.2

export class FpsMode {
  active = false
  yaw = 0
  private pitch = 0
  private unit: Unit | null = null
  private soldier: Soldier | null = null

  // active weapon
  private profile: WeaponProfile = WEAPON_PROFILES.rifleman
  private vm: Viewmodel = null as unknown as Viewmodel
  private vmCache = new Map<UnitKindId, Viewmodel>()

  // weapon state (semantics vary by profile)
  private ammo = 10
  private fuel = 1            // flamer only
  private boltT = 0           // seconds until the next shot is ready
  private reloadT = 0
  private toolProgress = 0    // medic/sapper action feedback 0..1
  private ads = 0
  private adsHeld = false
  private triggerDown = false
  // Recoil model: four independent accumulators, all rendered-only offsets on
  // top of the player's actual aimed yaw/pitch. Each springs back toward zero
  // every frame in update() (see applyRecoil() for what feeds them and why);
  // none of them is ever written into `yaw`/`pitch` themselves, which is what
  // guarantees recover-to-aim — release the trigger and the view settles back
  // to exactly where the mouse is pointed, never a permanent drift.
  private kick = 0        // 0..~1.6 sharp per-shot punch; spring rate ~16/s
  private climbPitch = 0  // accumulated upward view offset (rad); ~5-7/s, clamped
  private swayYaw = 0     // accumulated horizontal wander (rad); ~8/s
  private fovKick = 0     // additive FOV punch; ~8/s
  private lastHp = 0
  private swayT = 0
  private prevSpeed: Game['speed'] = 1
  private reticle: GroundHit | null = null

  // Whiz-by scratch: the WHIZ_SLOTS closest qualifying rounds found by THIS
  // frame's scanWhizByes() pass, kept in fixed-size arrays (not a fresh array
  // + sort every frame) so scanning a few hundred live bullets never touches
  // the heap. Each slot holds a bullet reference, its squared closest-approach
  // distance, and the closest-approach point — worst-of-N eviction during the
  // scan keeps only the nearest few without ever sorting the whole list.
  private readonly whizBullet: (Bullet | null)[] = new Array(WHIZ_SLOTS).fill(null)
  private readonly whizD2 = new Float64Array(WHIZ_SLOTS)
  private readonly whizCx = new Float64Array(WHIZ_SLOTS)
  private readonly whizCy = new Float64Array(WHIZ_SLOTS)
  private readonly whizCz = new Float64Array(WHIZ_SLOTS)

  // Combat feedback: hit markers + directional damage, drained each frame
  // from `game.ctx.fpsFeedback` by `updateFeedback()`. Hit marker is a single
  // shared state (only one crosshair, so no pool needed); directional wedges
  // get a small fixed pool since a firefight can wound the player from more
  // than one direction inside the same fade window.
  //
  // `hitMarkerT`/`hurtT` are dt-driven countdowns (like `swayT`), never
  // wall-clock — they hit zero exactly like every other timer in this file.
  private hitMarkerT = 0
  private hitMarkerKill = false
  // Per-slot countdown and the WORLD bearing (not screen angle) the shot came
  // from — storing the world bearing, not a precomputed screen angle, means
  // the wedge keeps pointing at the right place even as the player goes on
  // turning after the hit lands; the screen angle is re-derived from the
  // current `yaw` fresh every frame in updateFeedback(). `hurtT[k] <= 0`
  // means slot k is free.
  private readonly hurtT = new Float64Array(HURT_SLOTS)
  private readonly hurtBearing = new Float64Array(HURT_SLOTS)

  // input state (owned entirely by this mode while active)
  private keys = new Set<string>()

  // FPS Lab: when set, the mode runs without the browser pointer lock so a
  // harness can drive yaw/pitch/trigger from script and inspect every weapon.
  debugUnlocked = false
  // FPS Lab invincibility: pinned inside update() BEFORE the death check (not on
  // a separate rAF), so not even a one-shot that dropped hp to 0 can end the
  // session — the restore and the check live in the same function, ordering-proof.
  debugInvincible = false
  private flashHold = false
  // FPS Lab turntable: lift the active viewmodel front-and-centre and spin it so
  // every side of the gun can be examined. Overrides the normal weapon pose while
  // `inspect` is on (see poseInspect); has no effect in a normal game session.
  private inspect = false
  private inspectYaw = 0
  private inspectPitch = 0
  private inspectDist = 1.15
  private inspectSpin = false

  // three.js
  private flashLight: THREE.PointLight
  // A dim, short-range fill welded to the eye. The sun is directional, so with
  // it behind you the whole viewmodel falls into shadow and reads as a dark
  // lump; this lights the weapon's camera-facing side so it stays legible
  // whichever way you turn. Short range keeps it off the world beyond the gun.
  private fillLight: THREE.PointLight
  private aimRing: THREE.Mesh
  private _muzzleWorld = new THREE.Vector3() // scratch: viewmodel muzzle → world
  // Muzzle flash bolted to the gun model itself, so it stays welded to the
  // barrel through recoil kick, sway and mouselook — a world-space flash would
  // drift off the muzzle the instant the camera moved after the shot.
  //
  // Two camera-facing billboards, not 3D geometry: an outer soft amber glow
  // and an inner spiky hot star. A real cone/ball reads fine from the side but
  // collapses to a flat, hard-edged polygon (or a CA-fringed white ball) the
  // instant you look nearly straight down the barrel — which first person
  // does constantly, since that is where the gun sits. A billboard always
  // presents its painted flame shape flat to the eye, so it reads as fire from
  // every angle including head-on. Sprites (not manually-oriented planes)
  // because their position still rides the viewmodel's full local transform —
  // recoil, sway, everything — while their orientation stays camera-facing for
  // free; only `SpriteMaterial.rotation` needs driving for the in-plane spin.
  private muzzleFlash: THREE.Sprite     // outer glow
  private muzzleFlashCore: THREE.Sprite // inner hot star
  // Session-lived textures backing the two billboards (see buildGlowTexture /
  // buildStarTexture at the bottom of this file). Built once; disposed with
  // the mode.
  private flashGlowTex: THREE.CanvasTexture
  private flashStarTex: THREE.CanvasTexture
  private flashT = 0        // seconds of flash left
  private flashDur = 0.055  // how long one flash burns
  private flashSize = 0.42  // this shot's flash magnitude (local units)
  // Live-tunable flame shape (outer glow radius, inner star radius, how far
  // ahead of the crown the star floats, plume/core opacity). Exposed so the
  // FPS Lab can dial it in without a recompile; these defaults were tuned
  // there. Deliberately modest — "roughly muzzle-sized", not a fireball that
  // fills the screen.
  flashShape = { oR: 1.9, cR: 0.85, cFwd: 0.14, oA: 0.85, cA: 1.0 }

  // DOM
  private hudRoot: HTMLDivElement
  private crosshair!: HTMLDivElement
  private scopeEl!: HTMLDivElement
  private gunsightEl!: HTMLDivElement
  private ammoEl!: HTMLDivElement
  private ammoLabelEl!: HTMLDivElement
  private controlsEl!: HTMLDivElement
  private gaugeWrap!: HTMLDivElement
  private gaugeLabel!: HTMLDivElement
  private gaugeBar!: HTMLDivElement
  private healthEl!: HTMLDivElement
  private stanceEl!: HTMLDivElement
  private hintEl!: HTMLDivElement
  private hitMarkerEl!: HTMLDivElement
  // One rotated, zero-size "clock hand" element per pooled wedge — see
  // buildHud(). Rotating this wrapper (not the wedge itself) keeps the
  // wedge's own triangle geometry fixed and simple.
  private readonly hurtIndicatorEls: HTMLDivElement[] = []

  constructor(private game: Game) {
    this.flashLight = new THREE.PointLight(0xffc87a, 0, 9, 2)
    this.flashLight.position.set(0.06, -0.02, -1.0)
    game.renderer.camera.add(this.flashLight)

    // Viewmodel fill (see field comment). Sits just above and behind the eye so
    // it rakes across the gun from the shooter's side. Off until embodied.
    this.fillLight = new THREE.PointLight(0xffe8cc, 0, 3.0, 2)
    this.fillLight.position.set(0.1, 0.22, 0.4)
    game.renderer.camera.add(this.fillLight)

    // Billboards, not 3D flame cones — see the field comment above for why.
    // Depth testing stays on (matching the old meshes) so the barrel and
    // foresight still occlude whichever part of the flash sits behind them;
    // it just no longer collapses to a flat polygon when viewed head-on.
    this.flashGlowTex = buildGlowTexture()
    this.flashStarTex = buildStarTexture()
    this.muzzleFlash = makeFlashSprite(this.flashGlowTex, 0xff8a24)
    // Warm, not pure white: against the bright sky an additive near-white core
    // clips straight through the bloom threshold into a white smear, so the hot
    // heart is a hot amber that blooms as fire instead.
    this.muzzleFlashCore = makeFlashSprite(this.flashStarTex, 0xffcf8a)
    for (const s of [this.muzzleFlash, this.muzzleFlashCore]) {
      s.visible = false
      s.frustumCulled = false
      s.renderOrder = 4
    }

    // Landing reticle for thrown/indirect fire (added to the world, not the cam).
    const ringGeo = new THREE.TorusGeometry(1.7, 0.16, 6, 24)
    ringGeo.rotateX(Math.PI / 2)
    this.aimRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xe0a94a, transparent: true, opacity: 0.85, depthTest: false,
    }))
    this.aimRing.renderOrder = 5
    this.aimRing.visible = false
    this.aimRing.frustumCulled = false
    game.renderer.scene.add(this.aimRing)

    this.hudRoot = this.buildHud()
    document.body.appendChild(this.hudRoot)

    document.addEventListener('pointerlockchange', this.onLockChange)
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('mousemove', this.onMouseMove, true)
    window.addEventListener('mousedown', this.onMouseDown, true)
    window.addEventListener('mouseup', this.onMouseUp, true)
  }

  // -------------------------------------------------------------------------
  // Mode lifecycle
  // -------------------------------------------------------------------------

  enter(unit: Unit, soldier: Soldier): void {
    if (this.active || soldier.hp <= 0) return
    this.active = true
    this.unit = unit
    this.soldier = soldier
    this.profile = WEAPON_PROFILES[unit.kind] ?? WEAPON_PROFILES.rifleman
    this.equip(unit.kind)
    this.game.ctx.possessedSoldierId = soldier.id
    this.game.ctx.possessedUnitId = unit.id
    // Emplaced crews stand at their gun; snap the man onto the mounting.
    if (this.profile.emplaced) {
      soldier.pos.x = unit.pos.x
      soldier.pos.z = unit.pos.z
      soldier.stance = 'stand'
    }
    this.yaw = soldier.facing
    // mortars/gas lay high; guns lay a touch low; everyone else level.
    this.pitch = this.profile.startPitch ?? (this.profile.control === 'lob' ? -0.35 : 0)
    this.ammo = this.profile.magSize
    this.fuel = 1
    this.boltT = 0.3
    this.reloadT = 0
    this.toolProgress = 0
    this.ads = 0
    this.adsHeld = false
    this.triggerDown = false
    this.kick = 0
    this.climbPitch = 0
    this.swayYaw = 0
    this.fovKick = 0
    this.lastHp = soldier.hp
    this.reticle = null
    // No feedback carries over from a previous embodiment (or the sliver of
    // queue that could theoretically have built up before possession, though
    // the push side is itself gated on possessedSoldierId).
    this.hitMarkerT = 0
    this.hitMarkerKill = false
    this.hurtT.fill(0)
    this.game.ctx.fpsFeedback.length = 0
    if (this.profile.heat) { unit.heat = 0; unit.venting = false }
    this.keys.clear()
    this.prevSpeed = this.game.speed
    this.game.speed = 1 // war at watch-tick speed only
    this.game.paused = false
    this.game.setBuildSelection(null)
    this.game.selectedUnitId = unit.id // keep the unit selected for re-entry
    this.game.input.releaseAll() // no stuck pan keys across the mode switch
    this.vm.group.visible = true
    // fillLight intensity is now driven per-frame by nightFactor in update().
    this.hudRoot.style.display = 'block'
    document.body.classList.add('ms-fps') // clear the map table off the periscope
    this.hintEl.textContent = `${soldier.name.first} ${soldier.name.last} — M or Esc to return to command`
    if (!this.debugUnlocked) this.requestLock()
    this.game.audio.play('ui_click', { gain: 0.5 })
  }

  /** Build (or reuse) the viewmodel for a kind and make it the active one. */
  private equip(kind: UnitKindId): void {
    // Hide whatever was shown last.
    if (this.vm) this.vm.group.visible = false
    let v = this.vmCache.get(kind)
    if (!v) {
      v = (WEAPON_PROFILES[kind] ?? WEAPON_PROFILES.rifleman).build()
      v.group.visible = false
      this.game.renderer.camera.add(v.group)
      this.vmCache.set(kind, v)
    }
    this.vm = v
    // Weld the flash billboards to this gun's muzzle. Adding to the new node
    // detaches them from the old one; positioning in its local space means they
    // ride every pose the barrel does. Prefer the RECOIL sub-part when a weapon
    // has one (the field gun): its rest frame coincides with the group's, so
    // vm.muzzle stays the right local offset, and the flash then rides the barrel
    // back on recoil instead of hanging in space ahead of the receded crown.
    this.flashT = 0
    this.flashHold = false // never carry a held-lit lab flash across a weapon swap
    this.muzzleFlash.visible = false
    this.muzzleFlashCore.visible = false
    ;(v.recoilPart ?? v.group).add(this.muzzleFlash, this.muzzleFlashCore)
    this.positionMuzzleFlash(0)
  }

  /** True while the browser has actually handed us the mouse. */
  private get locked(): boolean {
    return this.debugUnlocked ||
      document.pointerLockElement === this.game.renderer.renderer.domElement
  }

  /**
   * Ask for the mouse. Chrome only grants it inside a user gesture and refuses
   * for ~1.3s after an Esc release, so this can silently fail — mouselook and
   * the trigger stay gated on `locked`, and the next click re-requests.
   */
  private requestLock(): void {
    const p = this.game.renderer.renderer.domElement.requestPointerLock() as unknown
    if (p instanceof Promise) p.catch(() => { /* click to lock */ })
  }

  exit(): void {
    if (!this.active) return
    this.active = false
    this.game.ctx.possessedSoldierId = -1
    this.game.ctx.possessedUnitId = -1
    this.game.ctx.fpsInvincible = false // no possessed man to shield once we're out
    if (document.pointerLockElement) document.exitPointerLock()
    if (this.vm) this.vm.group.visible = false
    this.flashLight.intensity = 0
    this.fillLight.intensity = 0
    this.flashT = 0
    this.muzzleFlash.visible = false
    this.muzzleFlashCore.visible = false
    this.aimRing.visible = false
    this.hudRoot.style.display = 'none'
    document.body.classList.remove('ms-fps')
    this.game.speed = this.prevSpeed
    this.game.input.releaseAll() // and none stuck on the way out either
    const cam = this.game.renderer.camera
    cam.fov = 50
    cam.rotation.z = 0
    cam.updateProjectionMatrix()
    // Hand the rig a sensible continuation of the view.
    if (this.soldier) {
      this.game.rig.target.set(this.soldier.pos.x, 0, this.soldier.pos.z)
      // Rig yaw is the camera's bearing FROM the target; to keep looking the
      // way the soldier faced, the camera must sit behind him: yaw = -facing.
      this.game.rig.yaw = -wrapAngle(this.yaw)
      this.game.rig.pitch = 0.75
      this.game.rig.dist = 42
    }
    this.unit = null
    this.soldier = null
  }

  dispose(): void {
    document.removeEventListener('pointerlockchange', this.onLockChange)
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('mousemove', this.onMouseMove, true)
    window.removeEventListener('mousedown', this.onMouseDown, true)
    window.removeEventListener('mouseup', this.onMouseUp, true)
    this.flashGlowTex.dispose()
    this.flashStarTex.dispose()
    this.hudRoot.remove()
  }

  // -------------------------------------------------------------------------
  // Input (window-level, capture phase, only while active)
  // -------------------------------------------------------------------------

  private onLockChange = (): void => {
    if (this.debugUnlocked) return // the lab drives the view without a real lock
    if (this.active && document.pointerLockElement !== this.game.renderer.renderer.domElement) {
      this.exit()
    }
  }

  /** Let clicks/keys aimed at the FPS Lab control panel through to the DOM. */
  private isLabEvent(e: Event): boolean {
    if (!this.debugUnlocked) return false
    const t = e.target as HTMLElement | null
    return !!t?.closest?.('[data-fpslab]')
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active || this.isLabEvent(e)) return
    this.keys.add(e.code)
    if (e.code === 'KeyM') { this.exit(); e.stopPropagation(); e.preventDefault(); return }
    if (e.code === 'KeyC' && !this.profile.emplaced) this.cycleStance()
    if (e.code === 'KeyR') this.startReload()
    e.stopPropagation()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.active || this.isLabEvent(e)) return
    this.keys.delete(e.code)
    e.stopPropagation()
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active || document.pointerLockElement !== this.game.renderer.renderer.domElement) return
    const sens = 0.0021 * (1 - this.ads * 0.55)
    this.yaw += e.movementX * sens
    this.pitch = clamp(this.pitch - e.movementY * sens, -1.4, 1.4)
    e.stopPropagation()
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.active || this.isLabEvent(e)) return
    e.stopPropagation()
    e.preventDefault()
    // Not holding the mouse yet? The click buys the lock — it does not fire.
    if (!this.locked) { this.requestLock(); return }
    if (e.button === 0) {
      this.triggerDown = true
      // Single-discharge weapons fire on the click; held weapons fire in update.
      if (this.isSingleShot()) this.tryFire()
    } else if (e.button === 2) {
      this.adsHeld = true
    }
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (!this.active || this.isLabEvent(e)) return
    if (e.button === 0) this.triggerDown = false
    if (e.button === 2) this.adsHeld = false
    e.stopPropagation()
  }

  private isSingleShot(): boolean {
    const c = this.profile.control
    return c === 'bolt' || c === 'semi' || c === 'throw' || c === 'lob' || c === 'directgun'
  }

  // -------------------------------------------------------------------------
  // Soldiering
  // -------------------------------------------------------------------------

  private cycleStance(): void {
    const s = this.soldier
    if (!s || s.stance === 'dead') return
    s.stance = s.stance === 'stand' ? 'crouch' : s.stance === 'crouch' ? 'prone' : 'stand'
  }

  private canReload(): boolean {
    const p = this.profile
    return p.ammoKind !== 'none' && p.ammoKind !== 'fuel' && this.ammo < p.magSize
  }

  private startReload(): void {
    if (!this.soldier || this.reloadT > 0 || !this.canReload()) return
    this.reloadT = this.profile.reloadTime
    this.game.audio.play('reload', {
      x: this.soldier.pos.x, y: 1.5, z: this.soldier.pos.z, gain: 0.7,
    })
  }

  /** One trigger event. Gates on ammo/heat/timers, then discharges the weapon. */
  private tryFire(): void {
    const s = this.soldier
    const u = this.unit
    if (!s || !u || s.hp <= 0) return
    if (this.reloadT > 0 || this.boltT > 0) return
    if (this.profile.heat && u.venting) return // Vickers jacket boiled dry
    if (this.profile.ammoKind === 'fuel') { if (this.fuel <= 0.05) return }
    else if (this.profile.ammoKind !== 'none') {
      if (this.ammo <= 0) {
        this.game.audio.play('ui_click', { gain: 0.35, rate: 1.7 }) // dead man's click
        this.startReload()
        return
      }
    }

    const cam = this.game.renderer.camera
    const dir = camDir(this.yaw, this.pitch)
    const moving = this.moveInput().len > 0.1
    dischargeWeapon(this.profile, {
      game: this.game, ctx: this.game.ctx, unit: u, soldier: s,
      camPos: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      dir, yaw: this.yaw, pitch: this.pitch, ads: this.ads, moving, ground: this.reticle,
      muzzleWorld: this.muzzleWorldPos(),
    })

    // Spend the discharge.
    this.boltT = this.profile.fireInterval
    this.applyRecoil()
    // A brief warm pop from the muzzle. Kept modest: the viewmodels are now
    // bright, self-lit meshes ~1 m from the eye, so a strong point light here
    // blows them (and the ground underfoot) past the bloom threshold into a
    // white smear. This is a night-time garnish, not the flash itself.
    this.flashLight.intensity = this.profile.control === 'directgun' ? 13
      : this.profile.control === 'lob' || this.profile.control === 'throw' ? 0
        : this.profile.heat ? 5 : 8
    // Light the barrel flash for direct-fire weapons (lobs/flame/tools have none).
    this.igniteBarrelFlash()
    if (this.profile.ammoKind === 'fuel') this.fuel = Math.max(0, this.fuel - 0.014)
    else if (this.profile.ammoKind !== 'none') this.ammo--
  }

  /**
   * One discharge's worth of recoil impulse. Called once per shot from
   * tryFire() — never per frame — and feeds the accumulators update() springs
   * back toward zero every frame:
   *  - `kick` is the sharp punch that reads as THIS shot, distinct from the
   *    sustained rise of a burst.
   *  - `climbPitch` is that sustained rise: it builds shot over shot while the
   *    trigger stays down and clamps well short of the sky, which is what
   *    makes holding an auto weapon climb-then-cap rather than wandering
   *    forever or snapping identically every round.
   *  - `swayYaw` adds a little horizontal wander so a long burst doesn't climb
   *    in an unnaturally dead-straight line.
   *  - `fovKick` lurches the field of view — the 18-pounder's shove should be
   *    felt in the lens, not just the crosshair.
   * ADS visibly steadies the weapon: `steady` damps how much each impulse
   * ADDS (not how fast it decays), so aiming down sights tightens the group
   * and flattens the climb without touching decay/settle timing.
   *
   * The per-weapon `recoilKickMul`/`recoilClimbMul`/`recoilSwayMul`/
   * `recoilClimbCap` overrides give characterful weapons (sniper's one heavy
   * punch, Lewis/Vickers's fast climb, the pistol's light snap) without
   * touching every profile — see weapons.ts.
   *
   * Random jitter here is Math.random(), never ctx.rand(): it's cosmetic view
   * shake, not sim-affecting, so it must not perturb the seeded RNG stream
   * (matches the convention in render/effects.ts).
   */
  private applyRecoil(): void {
    const p = this.profile
    const r = p.recoil
    const steady = 1 - this.ads * 0.4
    const kickMul = p.recoilKickMul ?? 1
    const climbMul = p.recoilClimbMul ?? 1
    const climbCap = p.recoilClimbCap ?? 0.16
    const swayMul = p.recoilSwayMul ?? 1

    this.kick = Math.min(1.6, this.kick + (r * 0.55 + 0.18) * kickMul * steady)
    this.climbPitch = Math.min(climbCap,
      this.climbPitch + r * 0.018 * (0.8 + Math.random() * 0.4) * climbMul * steady)
    this.swayYaw += (Math.random() - 0.5) * r * 0.02 * swayMul * steady
    this.fovKick += r * (p.control === 'directgun' ? 6 : 1.3)

    // Heavy ordnance also punches the whole screen. Rifles/MGs get NO shake —
    // that reads through kick/climb instead, so recoil doesn't feel like two
    // unrelated effects (weapon motion + camera noise) stacked on each other.
    if (p.control === 'directgun') this.game.renderer.addShock(r * 0.25)
    else if (p.control === 'lob' && p.id === 'mortar') this.game.renderer.addShock(r * 0.12)
  }

  /** Light the barrel-welded flash for a direct-fire discharge. */
  private igniteBarrelFlash(): void {
    const c = this.profile.control
    if (c !== 'bolt' && c !== 'semi' && c !== 'auto' && c !== 'directgun') return
    const base = c === 'directgun' ? 0.34 : this.profile.id === 'vickers' ? 0.2 : 0.15
    this.flashSize = base * (this.profile.flashScale ?? 1) * (0.85 + this.game.ctx.rand() * 0.3)
    this.flashT = this.flashDur
    // Seed this burn's silhouette/orientation. Purely cosmetic — the sim never
    // sees it — so Math.random(), not the seeded stream: a sprite's rotation
    // is an in-plane spin (SpriteMaterial.rotation), unlike the old meshes'
    // Object3D.rotation.z, which a billboard ignores entirely for its facing.
    // updateMuzzleFlash re-rolls both every LIVE frame for the flicker; this
    // is what a held/frozen lab inspection actually shows.
    this.muzzleFlashCore.material.rotation = Math.random() * Math.PI * 2
    this.setFlashCoreVariant(Math.floor(Math.random() * FLASH_STAR_CELLS))
  }

  // -------------------------------------------------------------------------
  // FPS Lab hooks — a script harness drives these to inspect every weapon
  // without needing pointer lock or the full build → possess flow.
  // -------------------------------------------------------------------------

  debugFire(): void { this.tryFire() }
  debugHold(on: boolean): void { this.triggerDown = on }
  debugAds(on: boolean): void { this.adsHeld = on }
  debugLook(yaw: number, pitch: number): void {
    this.yaw = yaw
    this.pitch = clamp(pitch, -1.4, 1.4)
  }
  debugStance(st: 'stand' | 'crouch' | 'prone'): void {
    if (this.soldier && !this.profile.emplaced) this.soldier.stance = st
  }
  /** Hold the barrel flash lit so its placement can be inspected frame-by-frame. */
  debugFreezeFlash(on: boolean): void {
    this.flashHold = on
    if (on) this.igniteBarrelFlash()
  }
  /**
   * Turntable inspect: float the active weapon front-and-centre and let the
   * harness spin it on two axes to examine the model from every side. Toggling
   * it on seeds a three-quarter view; off restores the normal hands/emplacement
   * pose next frame.
   */
  debugInspectMode(on: boolean): void {
    this.inspect = on
    if (on) { this.inspectYaw = 0.7; this.inspectPitch = 0.18 }
  }
  debugInspectActive(): boolean { return this.inspect }
  debugInspectRotate(dYaw: number, dPitch: number): void {
    this.inspectYaw += dYaw
    this.inspectPitch = clamp(this.inspectPitch + dPitch, -1.45, 1.45)
  }
  debugInspectZoom(dz: number): void { this.inspectDist = clamp(this.inspectDist + dz, 0.55, 2.4) }
  debugInspectSpin(on: boolean): void { this.inspectSpin = on }
  get debugName(): string { return this.profile?.name ?? '' }

  /**
   * World position of the active viewmodel's muzzle tip. The flash itself is
   * welded to the model (see updateMuzzleFlash); this feeds the world-space
   * ejecta — sparks, smoke, spent brass — so they leave from the real barrel.
   * The group is a child of the camera; refresh its world matrix first because
   * this can run before the frame's pose/camera update.
   */
  private muzzleWorldPos(): { x: number; y: number; z: number } {
    const vm = this.vm
    if (!vm) { const c = this.game.renderer.camera.position; return { x: c.x, y: c.y, z: c.z } }
    // Anchor to the recoiling part when there is one so the ejecta leaves from the
    // barrel's ACTUAL (receded) crown mid-recoil, matching the flash weld above.
    const anchor = vm.recoilPart ?? vm.group
    anchor.updateWorldMatrix(true, false)
    this._muzzleWorld.copy(vm.muzzle)
    anchor.localToWorld(this._muzzleWorld)
    return { x: this._muzzleWorld.x, y: this._muzzleWorld.y, z: this._muzzleWorld.z }
  }

  /**
   * Fade the barrel-welded flash. Scale pops big then collapses as it burns,
   * and — while actually firing — both billboards re-roll their rotation,
   * scale jitter and (for the spiky core) which texture cell they show every
   * single frame. Turbulent burning gas never holds one silhouette for two
   * frames running, and a static decal is exactly what the old fixed cone/ball
   * looked like.
   */
  private updateMuzzleFlash(dt: number): void {
    if (this.flashHold) {
      // Lab inspection: hold a representative MID-burn frame (not the peak
      // frame-1 pop) and skip the re-roll below, so the shape stays put long
      // enough to actually examine placement instead of chattering forever.
      this.flashT = this.flashDur * 0.5
    } else if (this.flashT <= 0) {
      if (this.muzzleFlash.visible) { this.muzzleFlash.visible = false; this.muzzleFlashCore.visible = false }
      return
    } else {
      this.flashT -= dt
    }
    const k = Math.max(0, this.flashT / this.flashDur) // 1 → 0 over the burn
    // Pop wide on the first frame, then gutter down. Alpha trails the size so
    // the flame reads as burning gas venting, not a static decal. Down the
    // sights it shrinks so a peak flash never whites out the target.
    const size = this.flashSize * (0.6 + 0.55 * k) * (1 - this.ads * 0.35)
    const alpha = Math.min(1, k * 1.6)
    const sh = this.flashShape
    this.muzzleFlash.visible = true
    this.muzzleFlashCore.visible = true
    this.positionMuzzleFlash(size)

    if (!this.flashHold) {
      // Cosmetic jitter — Math.random(), the sim never touches this. A fresh
      // in-plane rotation and cell for the spiky core, plus independent scale
      // wobble on both billboards, is what sells "turbulent gas" over "sprite".
      this.muzzleFlashCore.material.rotation = Math.random() * Math.PI * 2
      this.setFlashCoreVariant(Math.floor(Math.random() * FLASH_STAR_CELLS))
    }
    const outerJitter = 0.92 + Math.random() * 0.16
    const coreJitter = 0.88 + Math.random() * 0.24

    // Outer glow: roughly round, a touch tall — a soft amber halo, not a cone.
    this.muzzleFlash.scale.set(size * sh.oR * outerJitter, size * sh.oR * 1.08 * outerJitter, 1)
    // Inner star: a compact hot knot, noticeably smaller than the glow.
    const cr = size * sh.cR * coreJitter
    this.muzzleFlashCore.scale.set(cr, cr, 1)
    this.muzzleFlash.material.opacity = alpha * sh.oA
    this.muzzleFlashCore.material.opacity = alpha * sh.cA
  }

  /** Pick which of the star atlas's cells the spiky core billboard shows. */
  private setFlashCoreVariant(i: number): void {
    this.flashStarTex.offset.x = i / FLASH_STAR_CELLS
  }

  /**
   * Anchor the outer glow right at the muzzle tip and float the inner hot
   * star a touch further forward — both extend on the viewmodel's local −Z,
   * so the whole flash sits beyond the barrel crown rather than fused into a
   * single flat disc with the barrel poking through it.
   */
  private positionMuzzleFlash(size: number): void {
    const m = this.vm.muzzle
    this.muzzleFlash.position.set(m.x, m.y, m.z - 0.02)
    const fwd = 0.02 + size * this.flashShape.cFwd
    this.muzzleFlashCore.position.set(m.x, m.y, m.z - fwd)
  }

  /** Medic/sapper: mend by hand while the trigger is held. */
  private applyTool(dt: number): void {
    const s = this.soldier
    const g = this.game
    if (!s) return
    if (this.profile.id === 'medic') {
      const worst = this.nearestWounded()
      if (worst) {
        worst.hp = Math.min(worst.maxHp, worst.hp + 14 * g.ctx.mods.healRate * dt)
        this.toolProgress = worst.hp / worst.maxHp
        if (g.ctx.rand() < dt * 1.5) g.audio.play('build', { x: s.pos.x, y: 1, z: s.pos.z, gain: 0.25 })
      } else this.toolProgress = 0
    } else {
      // Engineer: parapet first, then torn wire — same priorities as the AI.
      const sec = sectionAt(g.ctx.s.sections, s.pos.x, s.pos.z)
      if (sec && !sec.captured && sec.parapetHp < sec.parapetMax) {
        sec.parapetHp = Math.min(sec.parapetMax, sec.parapetHp + 18 * g.ctx.mods.repairRate * dt)
        this.toolProgress = sec.parapetHp / sec.parapetMax
        if (g.ctx.rand() < dt * 0.6) g.audio.play('build', { x: s.pos.x, y: 1, z: s.pos.z, gain: 0.35 })
        return
      }
      let mended = false
      for (const d of g.ctx.s.defences) {
        if (d.kind !== 'wire' || d.hp >= d.maxHp || d.hp <= 0) continue
        if (dist2(d.pos.x, d.pos.z, s.pos.x, s.pos.z) > (this.profile.maxRange) ** 2) continue
        d.hp = Math.min(d.maxHp, d.hp + 14 * g.ctx.mods.repairRate * dt)
        d.wear = Math.max(0, d.wear - 0.2 * dt)
        this.toolProgress = d.hp / d.maxHp
        if (g.ctx.rand() < dt * 0.6) g.audio.play('wire_snip', { x: s.pos.x, y: 1, z: s.pos.z, gain: 0.3 })
        mended = true
        break
      }
      if (!mended && !(sec && sec.parapetHp < sec.parapetMax)) this.toolProgress = 0
    }
  }

  private nearestWounded(): Soldier | null {
    const s = this.soldier
    if (!s) return null
    let worst: Soldier | null = null
    let worstFrac = 0.999
    for (const u of this.game.ctx.s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) {
        if (c.hp <= 0 || c === s) continue
        if (dist2(c.pos.x, c.pos.z, s.pos.x, s.pos.z) > (this.profile.maxRange) ** 2) continue
        const frac = c.hp / c.maxHp
        if (frac < worstFrac) { worstFrac = frac; worst = c }
      }
    }
    return worst
  }

  private moveInput(): { x: number; z: number; len: number } {
    if (this.profile.emplaced) return { x: 0, z: 0, len: 0 }
    const k = this.keys
    let f = 0, r = 0
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1
    const len = Math.hypot(f, r)
    return { x: f === 0 && r === 0 ? 0 : r / (len || 1), z: f === 0 && r === 0 ? 0 : f / (len || 1), len }
  }

  /** Per-render-frame update. Owns the camera completely while active. */
  update(dt: number): void {
    const s = this.soldier
    const u = this.unit
    const g = this.game
    if (!this.active || !s || !u) return

    // FPS Lab invincibility — pin the man before the death check below so a lab
    // session is never cut short by German fire, not even by a lethal one-shot
    // (the previous separate-rAF pin skipped restores once hp hit 0 and let those
    // through). The sim-side guard (ctx.fpsInvincible, mirrored here) stops
    // killSoldier from ever running on him so no lethal round leaves him stuck in
    // the 'dead' stance; this tops his hp back up and clears suppression/gas.
    g.ctx.fpsInvincible = this.debugInvincible
    if (this.debugInvincible) {
      s.hp = s.maxHp; s.suppression = 0; s.gasExposure = 0
      if (s.stance === 'dead') s.stance = 'stand' // belt-and-braces: recover any non-combat kill
    }

    // Death is not negotiable.
    if (s.hp <= 0) {
      g.renderer.addShock(0.9)
      g.renderer.setHurt(1)
      g.hud?.toast(`${s.name.first} ${s.name.last} has fallen. Command passes back to you.`, 'danger')
      this.exit()
      return
    }

    // Hit feedback.
    if (s.hp < this.lastHp - 0.5) {
      g.renderer.setHurt(Math.min(1, (this.lastHp - s.hp) / 30))
      g.renderer.addShock(Math.min(0.4, (this.lastHp - s.hp) / 80))
    }
    this.lastHp = s.hp

    // -- movement -------------------------------------------------------------
    const mv = this.moveInput()
    const sprinting = this.keys.has('ShiftLeft') && s.stance === 'stand' && mv.z > 0.5
    if (mv.len > 0.1) {
      let speed = sprinting ? SPRINT_SPEED : MOVE_SPEED[s.stance]
      speed *= 1 - g.ctx.terrain.mudAt(s.pos.x, s.pos.z) * 0.45
      speed *= 1 - Math.min(0.35, g.ctx.terrain.slopeAt(s.pos.x, s.pos.z) * 0.5)
      const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw)
      const dx = (sinY * mv.z + cosY * mv.x) * speed * dt
      const dz = (-cosY * mv.z + sinY * mv.x) * speed * dt
      s.pos.x = clamp(s.pos.x + dx, -WORLD.width / 2 + 2, WORLD.width / 2 - 2)
      s.pos.z = clamp(s.pos.z + dz, -WORLD.depth / 2 + 2, WORLD.depth / 2 - 2)
      s.animPhase += dt * (sprinting ? 11 : 7)
    }
    s.facing = this.yaw

    // -- held-trigger weapons -------------------------------------------------
    let firedThisFrame = false
    if (this.triggerDown && this.locked) {
      if (this.profile.control === 'auto' || this.profile.control === 'flame') {
        if (this.boltT <= 0 && this.reloadT <= 0) { this.tryFire(); firedThisFrame = true }
      } else if (this.profile.control === 'tool') {
        this.applyTool(dt)
      }
    }
    if (this.profile.control === 'tool' && !(this.triggerDown && this.locked)) this.toolProgress = 0

    // -- fuel (flamer) --------------------------------------------------------
    if (this.profile.ammoKind === 'fuel' && !firedThisFrame) {
      this.fuel = Math.min(1, this.fuel + 0.06 * dt)
    }

    // -- weapon heat (Vickers) — the player now nurses the jacket -------------
    if (this.profile.heat) {
      if (u.venting || u.heat >= 1) {
        u.venting = true
        u.heat -= dt / COMBAT.vickersVentTime
        if (u.heat <= 0.35) { u.heat = 0.35; u.venting = false }
        if (g.ctx.rand() < dt * 2) {
          const y = g.ctx.terrain.heightAt(u.pos.x, u.pos.z) + 1.1
          g.effects?.steam(u.pos.x, y, u.pos.z)
        }
      } else if (!firedThisFrame) {
        u.heat = Math.max(0, u.heat - COMBAT.vickersCoolRate * dt)
      }
    }

    // -- weapon timers --------------------------------------------------------
    if (this.boltT > 0) this.boltT -= dt
    if (this.reloadT > 0) {
      this.reloadT -= dt
      if (this.reloadT <= 0) { this.ammo = this.profile.magSize }
    }
    // Spring every recoil accumulator back toward zero. Multiplicative decay
    // (x -= x*rate*dt) reads as a fast snap that EASES into the settle rather
    // than a linear ramp that stops dead — much closer to an actual spring,
    // and it's why holding an auto weapon shows a climb that visibly slows as
    // it nears its cap instead of climbing in identical steps. Rates chosen
    // so `kick` (the sharp per-shot punch) settles in ~0.1s while `climbPitch`
    // (the sustained rise across a burst) and `swayYaw` linger a beat longer,
    // reading as muzzle climb rather than an instant twitch.
    this.kick -= this.kick * Math.min(1, dt * 16)
    this.climbPitch -= this.climbPitch * Math.min(1, dt * 6)
    this.swayYaw -= this.swayYaw * Math.min(1, dt * 8)
    this.fovKick -= this.fovKick * Math.min(1, dt * 8)
    if (this.inspect && this.inspectSpin) this.inspectYaw += dt * 0.7
    // Viewmodel fill: dim by day (so the bright self-lit meshes don't blow out
    // against the sky), ramped up warm at night so the gun reads as a warm
    // object floating in cold dark — then the per-shot flashLight punch and the
    // world muzzle/tracer/flare light carve it out of the blackness on top.
    this.fillLight.intensity = 2.2 + this.game.sky.nightFactor * 4.3
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 300)
    this.updateMuzzleFlash(dt)
    const canAds = !this.profile.emplaced || this.profile.control === 'directgun'
    const adsTarget = this.adsHeld && this.reloadT <= 0 && canAds ? 1 : 0
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * 10)

    // -- camera ---------------------------------------------------------------
    this.swayT += dt
    const cam = g.renderer.camera
    const eyeH = this.profile.eyeHeight ?? EYE_HEIGHT[s.stance]
    const eyeBase = standSurface(g.ctx, s.pos.x, s.pos.z) + eyeH
    const bob = Math.abs(Math.sin(s.animPhase * 0.9)) * 0.035 * mv.len * (sprinting ? 1.6 : 1)
    cam.position.set(s.pos.x, eyeBase + bob, s.pos.z)
    const breathe = Math.sin(this.swayT * 1.7) * 0.0016 * (1 + s.suppression * 5) * (1 - this.ads * 0.6)
    cam.rotation.order = 'YXZ'
    // swayYaw rides on top of the player's actual yaw as a wander, same as
    // climbPitch/kick ride on pitch below — recover-to-aim means we only ever
    // ADD a decaying offset here, never write back into `this.yaw`/`this.pitch`.
    cam.rotation.y = -this.yaw - this.swayYaw
    // climbPitch is the sustained muzzle rise across a burst; kick is the
    // sharp jolt from THIS shot riding on top of it. Sign matches the old
    // single-scalar kick term this replaces: positive raises the view.
    cam.rotation.x = this.pitch + breathe + this.climbPitch + this.kick * 0.02
    // A little kick-driven roll on top of the existing idle sway gives a shot
    // some character without a full third axis of recoil to track.
    cam.rotation.z = Math.sin(this.swayT * 1.1) * 0.0012 + this.kick * 0.006
    const fov = lerp(this.profile.hipFov, this.profile.adsFov, this.ads) + this.fovKick
    if (Math.abs(cam.fov - fov) > 0.1) { cam.fov = fov; cam.updateProjectionMatrix() }

    // -- supersonic whiz-by: enemy rounds cracking past the camera this frame,
    // independent of what the player is doing with the trigger --------------
    this.scanWhizByes(cam.position.x, cam.position.y, cam.position.z)

    // -- aim reticle for thrown / indirect fire (needs the fresh camera) ------
    this.updateReticle()

    // -- viewmodel ------------------------------------------------------------
    this.poseViewmodel(mv.len, sprinting)

    // -- combat feedback: hit markers + directional damage --------------------
    this.updateFeedback(dt)

    // -- HUD ------------------------------------------------------------------
    this.updateHud()
  }

  /**
   * Drain `ctx.fpsFeedback` (see the field doc on `Ctx.fpsFeedback` in
   * sim/sim.ts) and advance the hit-marker / directional-wedge timers. Runs
   * every render frame while embodied, regardless of whether the queue has
   * anything in it this frame — the countdowns still need to tick down even
   * on a quiet frame between hits.
   *
   * The queue is read in full and its length reset to zero unconditionally:
   * this is the ONE consumer, so nothing else will ever see these events,
   * and leaving even one behind would let the array creep upward frame over
   * frame (exactly what the spec's "must not accumulate unboundedly" rules
   * out).
   */
  private updateFeedback(dt: number): void {
    const q = this.game.ctx.fpsFeedback
    for (let i = 0; i < q.length; i++) {
      const e = q[i]
      if (e.t === 'hit') {
        // A kill marker always wins over a plain hit landing the same frame
        // (a double-tap that finishes a man off); a plain hit never
        // downgrades a kill marker that is still fading from a moment ago.
        if (e.kill || this.hitMarkerT <= 0 || !this.hitMarkerKill) {
          this.hitMarkerKill = e.kill
          this.hitMarkerT = e.kill ? HIT_MARKER_KILL_DUR : HIT_MARKER_DUR
        }
      } else {
        // 'hurt' — claim a free wedge slot; if the pool is already full,
        // steal whichever slot is closest to fading out anyway (a genuinely
        // fresh hit is always more useful to show than an old one's last
        // instant on screen).
        let slot = -1
        for (let k = 0; k < HURT_SLOTS; k++) if (this.hurtT[k] <= 0) { slot = k; break }
        if (slot < 0) {
          let minT = Infinity
          for (let k = 0; k < HURT_SLOTS; k++) if (this.hurtT[k] < minT) { minT = this.hurtT[k]; slot = k }
        }
        // World bearing of the shooter, matching the game's yaw convention
        // (yaw 0 looks toward -z; dir = (sin yaw, -cos yaw)) — see the
        // module doc on Soldier.facing in core/types.ts.
        this.hurtBearing[slot] = Math.atan2(e.fromX, -e.fromZ)
        this.hurtT[slot] = HURT_INDICATOR_DUR
      }
    }
    q.length = 0 // full drain — see the doc above for why this must be unconditional

    // -- hit marker: count down and reflect into the DOM ---------------------
    if (this.hitMarkerT > 0) this.hitMarkerT = Math.max(0, this.hitMarkerT - dt)
    const hmDur = this.hitMarkerKill ? HIT_MARKER_KILL_DUR : HIT_MARKER_DUR
    const hmLive = this.hitMarkerT > 0
    const hmK = hmLive ? this.hitMarkerT / hmDur : 0 // 1 → 0 across the burn
    // Alpha races ahead of the lifetime so the marker pops in immediately and
    // then visibly gutters out, rather than fading linearly the whole time.
    this.hitMarkerEl.style.opacity = hmLive ? String(Math.min(1, hmK * 1.8)) : '0'
    this.hitMarkerEl.style.setProperty('--hm-scale', String(1 + (hmLive ? (1 - hmK) * 0.4 : 0)))
    this.hitMarkerEl.classList.toggle('fps-hitmarker--kill', hmLive && this.hitMarkerKill)

    // -- directional wedges: count down and rotate to the CURRENT view -------
    for (let k = 0; k < HURT_SLOTS; k++) {
      if (this.hurtT[k] > 0) this.hurtT[k] = Math.max(0, this.hurtT[k] - dt)
      const el = this.hurtIndicatorEls[k]
      if (this.hurtT[k] <= 0) { el.style.opacity = '0'; continue }
      // Screen angle = world bearing minus the player's own yaw — turning
      // toward the shooter always brings his wedge toward the top (12
      // o'clock) of the ring, whichever way the player is currently facing.
      const screenAngle = this.hurtBearing[k] - this.yaw
      el.style.transform = `rotate(${(screenAngle * (180 / Math.PI)).toFixed(1)}deg)`
      const frac = this.hurtT[k] / HURT_INDICATOR_DUR
      el.style.opacity = String(Math.min(1, frac * 1.5))
    }
  }

  /** Where the crosshair meets the ground — the drop point for lob/throw. */
  private updateReticle(): void {
    const s = this.soldier
    const c = this.profile.control
    if (!s || (c !== 'lob' && c !== 'throw')) { this.aimRing.visible = false; this.reticle = null; return }
    const cam = this.game.renderer.camera
    const dir = camDir(this.yaw, this.pitch)
    const raw = groundHit(this.game.ctx, cam.position.x, cam.position.y, cam.position.z,
      dir.x, dir.y, dir.z, this.profile.maxRange + 20)
    // Show the ring where the round will ACTUALLY land — clamped into the
    // weapon's range band — so the reticle never lies about the fall of shot.
    const cl = clampToBand(s.pos.x, s.pos.z, raw.x, raw.z, this.profile.minRange, this.profile.maxRange)
    const gy = this.game.ctx.terrain.heightAt(cl.x, cl.z)
    this.reticle = { x: cl.x, z: cl.z, y: gy, dist: Math.hypot(cl.x - s.pos.x, cl.z - s.pos.z) }
    this.aimRing.visible = this.locked
    this.aimRing.position.set(cl.x, gy + 0.15, cl.z)
    // Amber when the raw aim sat inside the band; a washed red at the clamped
    // limit warns you the crosshair is past the gun's reach.
    const rawD = Math.hypot(raw.x - s.pos.x, raw.z - s.pos.z)
    const atLimit = rawD < this.profile.minRange || rawD > this.profile.maxRange
    ;(this.aimRing.material as THREE.MeshBasicMaterial).color.setHex(atLimit ? 0xc98a3a : 0xe0a94a)
  }

  /**
   * Supersonic crack/whiz-by: enemy rounds that pass close to the embodied
   * camera get a sharp sound, a tiny air-snap wisp and a small camera flinch,
   * on top of (and independent from) whatever hit-registration/suppression
   * the sim itself does. This is pure presentation — a round that misses the
   * player's body by inches still says so.
   *
   * Runs once per RENDER frame (not per sim tick) over every live bullet, so
   * it must be cheap and allocation-free: closest point of approach between
   * the round's THIS-TICK segment (`b.prev` → `b.pos`) and the camera point,
   * scalar-only (see the module doc above `WHIZ_RADIUS`). Only the closest
   * `WHIZ_SLOTS` qualifying rounds actually crack this frame — anything
   * bumped out of the scratch list simply gets reconsidered next frame
   * (the sim hasn't ticked `prev`/`pos` again yet), which is what keeps a
   * heavy volley from piling ten cracks on top of each other at once.
   */
  private scanWhizByes(px: number, py: number, pz: number): void {
    const s = this.soldier
    if (!s) return
    const bullets = this.game.ctx.s.bullets
    const myId = this.game.ctx.possessedSoldierId
    const myTeam = s.team
    const r2 = WHIZ_RADIUS * WHIZ_RADIUS

    for (let k = 0; k < WHIZ_SLOTS; k++) { this.whizD2[k] = Infinity; this.whizBullet[k] = null }

    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i]
      // Only rounds that could plausibly be shooting AT the player: not his
      // own outgoing fire, not a teammate's, and not one already cracked.
      if (b.whizzed || b.shooterId === myId || b.team === myTeam) continue
      const ax = b.prev.x, ay = b.prev.y, az = b.prev.z
      const sx = b.pos.x - ax, sy = b.pos.y - ay, sz = b.pos.z - az
      const segLen2 = sx * sx + sy * sy + sz * sz
      // Closest point of a point to a segment: project, then clamp to [0,1]
      // — the degenerate (near-zero-length) segment just tests the point A.
      let t = 0
      if (segLen2 > 1e-8) {
        t = ((px - ax) * sx + (py - ay) * sy + (pz - az) * sz) / segLen2
        t = t < 0 ? 0 : t > 1 ? 1 : t
      }
      const cx = ax + sx * t, cy = ay + sy * t, cz = az + sz * t
      const dx = px - cx, dy = py - cy, dz = pz - cz
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > r2) continue
      // Worst-of-N eviction: replace whichever kept slot is currently
      // furthest away, if this crossing is actually closer than it.
      let worst = 0
      for (let k = 1; k < WHIZ_SLOTS; k++) if (this.whizD2[k] > this.whizD2[worst]) worst = k
      if (d2 < this.whizD2[worst]) {
        this.whizD2[worst] = d2
        this.whizBullet[worst] = b
        this.whizCx[worst] = cx
        this.whizCy[worst] = cy
        this.whizCz[worst] = cz
      }
    }

    for (let k = 0; k < WHIZ_SLOTS; k++) {
      const b = this.whizBullet[k]
      if (!b) continue
      b.whizzed = true // dedup — this round has had its one crack
      const d = Math.sqrt(this.whizD2[k])
      const prox = 1 - clamp(d / WHIZ_RADIUS, 0, 1) // 0 at the edge of the radius, 1 dead-on
      const g = this.game
      // A dedicated supersonic crack — the ballistic N-wave — louder and
      // sharper the closer the round actually passed, played at the closest-
      // approach point so 3D panning throws it past the ear convincingly
      // rather than gluing it to the shooter's muzzle. Distinct from the
      // descending whine of a ricochet and from the distant muzzle report.
      g.audio.play('supersonic_crack', {
        x: this.whizCx[k], y: this.whizCy[k], z: this.whizCz[k],
        gain: 0.34 + prox * 0.5, rate: 0.9 + prox * 0.5,
      })
      // A tiny air-snap wisp at the crossing point — reuses the same faint
      // powder-smoke puff the tracer trail leaves (effects.ts's tracerTrail);
      // it is generic enough to read as a wisp of disturbed air, and this
      // stays within budget without adding a new pooled effect. One puff
      // normally, a second only on a genuinely close pass.
      g.effects?.tracerTrail(this.whizCx[k], this.whizCy[k], this.whizCz[k])
      if (prox > 0.55) g.effects?.tracerTrail(this.whizCx[k], this.whizCy[k], this.whizCz[k])
      // A small flinch — deliberately subtle (see module doc): the battlefield
      // is already busy, and this must never read as a seizure trigger.
      g.renderer.addShock(0.02 + prox * 0.03)
    }
  }

  // -------------------------------------------------------------------------
  // Viewmodel posing
  // -------------------------------------------------------------------------

  private poseViewmodel(moveLen: number, sprinting: boolean): void {
    const vm = this.vm
    if (!vm) return
    // FPS Lab turntable: float the model out front and spin it; skip the normal
    // hands/emplacement pose, recoil, bolt cycle and scope-away entirely.
    if (this.inspect) { this.poseInspect(); return }
    // Looking through the optic (sniper scope OR the field-gun dial sight): the
    // weapon drops away so the magnified sight picture fills the eye.
    const scopedAway = (this.profile.scope || !!this.profile.gunsight) && this.ads > 0.85
    vm.group.visible = !scopedAway
    if (scopedAway) return
    const t = this.swayT
    const hip = this.profile.hip
    const aim = this.profile.aim
    const a = this.ads
    const sway = (1 - a * 0.85) * (moveLen > 0.1 ? 1 : 0.35)
    const bobX = Math.sin(t * (sprinting ? 9 : 6)) * 0.006 * sway
    const bobY = Math.abs(Math.cos(t * (sprinting ? 9 : 6))) * 0.007 * sway
    // Drive the viewmodel punch from the sharp `kick` accumulator (not the
    // sustained `climbPitch` — that's a camera-only effect; the gun in your
    // hands should show THIS shot's jolt, not the whole burst's drift).
    const kick = this.kick

    if (this.profile.control === 'throw') {
      // Overarm bowl: the arm cocks back on release, then whips forward as
      // the punch decays — driven by `kick` so the whip's tempo tracks
      // whatever impulse this profile's recoil actually produced.
      const swing = Math.min(1, this.kick) // 1 at release → 0
      vm.group.position.set(
        lerp(hip.x, aim.x, a),
        lerp(hip.y, aim.y, a) + swing * 0.12,
        lerp(hip.z, aim.z, a) + (1 - swing) * -0.05,
      )
      vm.group.rotation.set(lerp(hip.rx, aim.rx, a) - swing * 1.4, lerp(hip.ry, aim.ry, a), 0)
      return
    }

    // Punch amounts run roughly 2-3x the old single-scalar model so the kick
    // actually reads: this is where a rifle vs. a Lewis vs. an 18-pounder
    // should look and feel like fundamentally different weapons in the hands.
    vm.group.position.set(
      lerp(hip.x, aim.x, a) + bobX,
      lerp(hip.y, aim.y, a) - bobY,
      lerp(hip.z, aim.z, a) + kick * 0.15,
    )
    vm.group.rotation.set(
      lerp(hip.rx, aim.rx, a) + kick * 0.22,
      lerp(hip.ry, aim.ry, a),
      hip.rz ?? 0,
    )

    // Bolt-action: the handle lifts and draws back after each shot.
    if (vm.bolt && this.profile.control === 'bolt') {
      const bt = this.profile.fireInterval - Math.max(0, this.boltT)
      let lift = 0, pull = 0
      if (this.boltT > 0 && bt > 0.18) {
        const ph = Math.min(1, (bt - 0.18) / (this.profile.fireInterval - 0.3))
        lift = Math.sin(ph * Math.PI) * 1.0
        pull = Math.sin(ph * Math.PI) * 0.06
      }
      vm.bolt.rotation.z = -0.9 + lift
      vm.bolt.position.z = 0.02 + pull
    }

    // Field-gun barrel slams back into its cradle and rides home on the buffer.
    if (vm.recoilPart && vm.restRecoilZ !== undefined) {
      vm.recoilPart.position.z = vm.restRecoilZ + kick * 0.32
    }

    // Reload: the weapon dips out of the shoulder.
    if (this.reloadT > 0 && this.profile.reloadTime > 0) {
      const r = this.reloadT / this.profile.reloadTime
      vm.group.position.y -= Math.sin(r * Math.PI) * 0.12
      vm.group.rotation.x += Math.sin(r * Math.PI) * 0.35
    }
  }

  /**
   * Turntable pose (FPS Lab): hold the weapon dead-centre at `inspectDist` and
   * orient it by the two accumulated inspect angles so every side — breech,
   * sights, muzzle, underside — can be brought into view. Bolt/recoil sub-parts
   * keep whatever rest transform their builder gave them.
   */
  private poseInspect(): void {
    const vm = this.vm
    vm.group.visible = true
    vm.group.position.set(0, -0.12, -this.inspectDist)
    vm.group.rotation.set(this.inspectPitch, this.inspectYaw, 0)
    // Settle the recoil/bolt sub-parts to rest — the normal pose path (which
    // drives them off `kick`) is skipped here, so a gun fired an instant before
    // inspecting would otherwise sit frozen mid-recoil for the whole turntable.
    if (vm.recoilPart && vm.restRecoilZ !== undefined) vm.recoilPart.position.z = vm.restRecoilZ
    if (vm.bolt) { vm.bolt.rotation.z = -0.9; vm.bolt.position.z = 0.02 }
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  private updateHud(): void {
    const s = this.soldier
    const u = this.unit
    if (!s || !u) return
    const p = this.profile
    const locked = this.locked

    // Sight picture: the aperture tightens as the weapon comes to the shoulder
    // and opens slightly while moving. It disappears under an optic (the sniper
    // telescope OR the field-gun dial sight).
    const scoped = (p.scope || !!p.gunsight) && this.ads > 0.6
    const moving = this.moveInput().len > 0.1
    const gap = 11 - this.ads * 6 + (moving ? 4 : 0) + s.suppression * 10
    this.crosshair.style.setProperty('--sight-gap', `${gap.toFixed(1)}px`)
    this.crosshair.style.setProperty('--sight-alpha', String(0.82 - this.ads * 0.22))
    this.crosshair.style.opacity = String(locked && !scoped ? 1 : 0)
    this.crosshair.classList.toggle('fps-sight--ads', this.ads > 0.65)
    this.crosshair.classList.toggle('fps-sight--blocked', this.reloadT > 0 || this.boltT > 0.08)
    // Fade in whichever optic this weapon lays through — the plain reticle scope
    // for the sniper, the amber telescopic graticule for the gun.
    const opticAlpha = scoped ? Math.min(1, (this.ads - 0.6) / 0.3) : 0
    this.scopeEl.style.opacity = String(p.scope ? opticAlpha : 0)
    this.gunsightEl.style.opacity = String(p.gunsight ? opticAlpha : 0)

    this.hintEl.textContent = locked
      ? `${s.name.first} ${s.name.last} · ${p.name} — M or Esc to return to command`
      : 'Click to take up the weapon'

    // Ammo / status readout.
    this.ammoEl.textContent = this.ammoReadout()
    this.ammoLabelEl.textContent = p.ammoName.toUpperCase()
    this.controlsEl.textContent = p.controlsHint.toUpperCase()

    // Heat / fuel gauge.
    const showHeat = p.heat
    const showFuel = p.ammoKind === 'fuel'
    this.gaugeWrap.style.display = showHeat || showFuel ? 'block' : 'none'
    if (showHeat) {
      const h = u.heat
      this.gaugeLabel.textContent = u.venting ? 'JACKET VENTING — HOLD' : 'BARREL HEAT'
      this.gaugeBar.style.background =
        `linear-gradient(90deg, ${h > 0.8 ? '#d06a34' : h > 0.5 ? '#c9a53a' : '#7fae5a'} ${h * 100}%, rgba(255,255,255,0.12) ${h * 100}%)`
    } else if (showFuel) {
      this.gaugeLabel.textContent = 'FUEL'
      this.gaugeBar.style.background =
        `linear-gradient(90deg, ${this.fuel > 0.25 ? '#c98a3a' : '#a04a3a'} ${this.fuel * 100}%, rgba(255,255,255,0.12) ${this.fuel * 100}%)`
    }

    // Stance (walking weapons only) + health.
    this.stanceEl.style.display = p.emplaced ? 'none' : 'block'
    this.stanceEl.textContent = s.stance === 'stand' ? '↑  STANDING' : s.stance === 'crouch' ? '⌄  CROUCHED' : '—  PRONE'
    const hpFrac = Math.max(0, s.hp / s.maxHp)
    this.healthEl.style.background =
      `linear-gradient(90deg, ${hpFrac > 0.4 ? '#7fae5a' : '#a04a3a'} ${hpFrac * 100}%, rgba(255,255,255,0.12) ${hpFrac * 100}%)`
  }

  private ammoReadout(): string {
    const p = this.profile
    if (this.reloadT > 0) {
      const filled = Math.ceil((1 - this.reloadT / p.reloadTime) * 5)
      return `RELOADING ${'▮'.repeat(filled).padEnd(5, '▯')}`
    }
    switch (p.ammoKind) {
      case 'mag': return `${this.ammo} / ${p.magSize}`
      case 'grenades': return `${this.ammo} BOMBS`
      case 'shells': return `${this.ammo} SHELLS`
      case 'bombs': return `${this.ammo} BOMBS`
      case 'drums': return `${this.ammo} DRUMS`
      case 'fuel': return `${Math.round(this.fuel * 100)}%`
      case 'none': {
        const pct = Math.round(this.toolProgress * 100)
        const verb = p.id === 'medic' ? 'BANDAGING' : 'MENDING'
        return this.toolProgress > 0 ? `${verb} ${pct}%` : 'READY'
      }
    }
  }

  private buildHud(): HTMLDivElement {
    // While embodied, the commander's HUD stands down.
    const style = document.createElement('style')
    style.textContent = 'body.ms-fps .ui-scaled { display: none !important; }'
    document.head.appendChild(style)

    const root = document.createElement('div')
    root.className = 'fps-hud'
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;display:none;z-index:60;' +
      'font-family:inherit;color:#e8e0c8;text-shadow:0 1px 2px rgba(0,0,0,0.8)'

    // Sniper scope overlay (black surround + reticle), sits under the crosshair.
    this.scopeEl = document.createElement('div')
    this.scopeEl.style.cssText =
      'position:absolute;inset:0;opacity:0;transition:opacity 0.08s;' +
      'background:radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 27%, rgba(0,0,0,0.55) 30%, #000 34%);'
    const reticleV = document.createElement('div')
    reticleV.style.cssText = 'position:absolute;left:50%;top:50%;width:1px;height:150px;margin:-75px 0 0 0;background:rgba(20,20,15,0.9)'
    const reticleH = document.createElement('div')
    reticleH.style.cssText = 'position:absolute;left:50%;top:50%;width:150px;height:1px;margin:0 0 0 -75px;background:rgba(20,20,15,0.9)'
    this.scopeEl.appendChild(reticleV)
    this.scopeEl.appendChild(reticleH)
    root.appendChild(this.scopeEl)

    // Artillery telescopic gun sight (the 18-pounder lays through this): a round
    // amber-tinted field with a laid graticule — a fine crosshair, a central
    // aiming pip, a range ladder falling below the line of sight and deflection
    // ticks to either side. Fades in on ADS in place of the plain scope surround.
    this.gunsightEl = document.createElement('div')
    this.gunsightEl.style.cssText = 'position:absolute;inset:0;opacity:0;transition:opacity 0.1s;pointer-events:none'
    const gunVign = document.createElement('div')
    gunVign.style.cssText =
      'position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,' +
      'rgba(120,86,36,0.15) 0%, rgba(120,86,36,0.05) 26%, rgba(0,0,0,0) 31%,' +
      'rgba(6,8,10,0.62) 34%, #05070a 46%)'
    this.gunsightEl.appendChild(gunVign)
    const gunRing = document.createElement('div')
    gunRing.style.cssText =
      'position:absolute;left:50%;top:50%;width:64vmin;height:64vmin;transform:translate(-50%,-50%);' +
      'border-radius:50%;border:1.5px solid rgba(230,192,122,0.22);box-shadow:inset 0 0 42px rgba(0,0,0,0.55)'
    this.gunsightEl.appendChild(gunRing)
    const gunReticle = document.createElement('div')
    gunReticle.style.cssText =
      'position:absolute;left:50%;top:50%;width:62vmin;height:62vmin;transform:translate(-50%,-50%)'
    gunReticle.innerHTML =
      '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;overflow:visible">' +
      '<g fill="none" stroke="#e6c07a" stroke-width="0.35" opacity="0.9" stroke-linecap="round">' +
      '<line x1="50" y1="10" x2="50" y2="43"/><line x1="50" y1="57" x2="50" y2="90"/>' +
      '<line x1="10" y1="50" x2="43" y2="50"/><line x1="57" y1="50" x2="90" y2="50"/>' +
      '<g stroke-width="0.45"><line x1="43.5" y1="61" x2="56.5" y2="61"/>' +
      '<line x1="45" y1="69" x2="55" y2="69"/><line x1="46" y1="77" x2="54" y2="77"/>' +
      '<line x1="47" y1="85" x2="53" y2="85"/></g>' +
      '<g stroke-width="0.45"><line x1="30" y1="47" x2="30" y2="53"/><line x1="40" y1="48" x2="40" y2="52"/>' +
      '<line x1="60" y1="48" x2="60" y2="52"/><line x1="70" y1="47" x2="70" y2="53"/></g>' +
      '</g>' +
      '<path d="M50 50 L47.6 55.4 L52.4 55.4 Z" fill="#e6c07a" stroke="none" opacity="0.95"/>' +
      '<circle cx="50" cy="50" r="0.9" fill="#e6c07a"/>' +
      '<g fill="#e6c07a" opacity="0.8" font-family="ui-monospace,monospace" font-size="2.5" text-anchor="middle">' +
      '<text x="59" y="62">5</text><text x="57.5" y="70">10</text><text x="56.5" y="78">15</text>' +
      '</g></svg>'
    this.gunsightEl.appendChild(gunReticle)
    root.appendChild(this.gunsightEl)

    this.crosshair = document.createElement('div')
    this.crosshair.className = 'fps-sight'
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const mark = document.createElement('i')
      mark.className = `fps-sight__mark fps-sight__mark--${side}`
      this.crosshair.appendChild(mark)
    }
    const bead = document.createElement('b')
    bead.className = 'fps-sight__bead'
    this.crosshair.appendChild(bead)
    root.appendChild(this.crosshair)

    // Hit marker: an X that pops over the crosshair when a round WE fired
    // connects (see updateFeedback). `--hm-scale` drives the pop-then-settle
    // via the CSS transform in style.css; the element itself just toggles
    // opacity and the `--kill` modifier for the bigger red confirmation.
    this.hitMarkerEl = document.createElement('div')
    this.hitMarkerEl.className = 'fps-hitmarker'
    for (const bar of ['a', 'b']) {
      const b = document.createElement('i')
      b.className = `fps-hitmarker__bar fps-hitmarker__bar--${bar}`
      this.hitMarkerEl.appendChild(b)
    }
    root.appendChild(this.hitMarkerEl)

    // Directional damage: a pooled ring of wedges (see HURT_SLOTS). Each
    // `.fps-hurtdir` is a zero-size element pinned at screen centre
    // (left:50%;top:50%;width:0;height:0), so rotating IT — not the wedge
    // child, which is merely offset upward by a fixed pixel amount in CSS —
    // is a pure rotation about that centre point: the wedge child swings
    // around the crosshair on a ring at whatever angle updateFeedback()
    // computes this frame.
    for (let k = 0; k < HURT_SLOTS; k++) {
      const hand = document.createElement('div')
      hand.className = 'fps-hurtdir'
      const wedge = document.createElement('div')
      wedge.className = 'fps-hurtdir__wedge'
      hand.appendChild(wedge)
      root.appendChild(hand)
      this.hurtIndicatorEls.push(hand)
    }

    const panel = document.createElement('div')
    panel.style.cssText =
      'position:absolute;right:22px;bottom:18px;text-align:right;letter-spacing:0.08em'
    this.ammoEl = document.createElement('div')
    this.ammoEl.style.cssText = 'font-size:26px;font-weight:bold'
    this.ammoEl.textContent = '10 / 10'
    panel.appendChild(this.ammoEl)
    this.ammoLabelEl = document.createElement('div')
    this.ammoLabelEl.style.cssText = 'font-size:11px;opacity:0.8;margin-top:2px'
    this.ammoLabelEl.textContent = '.303 SMLE'
    panel.appendChild(this.ammoLabelEl)
    this.controlsEl = document.createElement('div')
    this.controlsEl.style.cssText = 'font-size:10px;opacity:0.6;margin-top:2px'
    panel.appendChild(this.controlsEl)
    root.appendChild(panel)

    const left = document.createElement('div')
    left.style.cssText = 'position:absolute;left:22px;bottom:18px;width:200px'
    // Heat / fuel gauge.
    this.gaugeWrap = document.createElement('div')
    this.gaugeWrap.style.cssText = 'display:none;margin-bottom:9px'
    this.gaugeLabel = document.createElement('div')
    this.gaugeLabel.style.cssText = 'font-size:10px;letter-spacing:0.12em;margin-bottom:4px;opacity:0.85'
    this.gaugeBar = document.createElement('div')
    this.gaugeBar.style.cssText =
      'height:7px;border:1px solid rgba(232,224,200,0.5);background:rgba(255,255,255,0.12)'
    this.gaugeWrap.appendChild(this.gaugeLabel)
    this.gaugeWrap.appendChild(this.gaugeBar)
    left.appendChild(this.gaugeWrap)

    this.stanceEl = document.createElement('div')
    this.stanceEl.style.cssText = 'font-size:12px;letter-spacing:0.14em;margin-bottom:5px;opacity:0.9'
    this.stanceEl.textContent = 'STANDING'
    left.appendChild(this.stanceEl)
    this.healthEl = document.createElement('div')
    this.healthEl.style.cssText =
      'height:7px;border:1px solid rgba(232,224,200,0.55);' +
      'background:linear-gradient(90deg,#7fae5a 100%,transparent 100%)'
    left.appendChild(this.healthEl)
    root.appendChild(left)

    this.hintEl = document.createElement('div')
    this.hintEl.style.cssText =
      'position:absolute;top:14px;left:50%;transform:translateX(-50%);' +
      'font-size:11px;letter-spacing:0.12em;opacity:0.7'
    root.appendChild(this.hintEl)
    return root
  }
}

// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Muzzle-flash billboards — procedural textures + the sprites that wear them
// -----------------------------------------------------------------------------
//
// A cone/ball read fine from the side but collapsed to a flat, hard-edged
// polygon (or a CA-fringed white ball) staring down the barrel — exactly the
// view first person has of its own weapon. Billboards fix that structurally:
// a sprite always presents its painted flame shape flat to the eye, whichever
// way the barrel points, so "does it look like fire head-on" stops being a
// geometry problem and becomes a texture-painting one.
//
// Two textures, built once at startup (session-lived, trivial GPU cost):
//  - a single soft radial glow cell (the outer amber halo — perfectly round,
//    so it needs no variants; its own scale/opacity animation sells it as
//    living gas).
//  - three INDEPENDENT jittered "hot star" cells side by side in one atlas
//    (spikes + a bright core, each seeded differently) so the spiky inner
//    core can hop between genuinely different silhouettes shot to shot and
//    frame to frame — see `updateMuzzleFlash`'s per-frame variant swap.

const FLASH_CELL = 96          // px per star-atlas cell
const FLASH_STAR_CELLS = 3

/** Tiny deterministic hash for jittering the (fixed, startup-only) atlas art. */
function flashHash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}

/** Thin gradient spike drawn along local +x, radiating outward from the origin. */
function paintFlashSpike(ctx: CanvasRenderingContext2D, len: number, thin: number, alpha: number): void {
  ctx.save()
  ctx.scale(1, thin)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, len)
  g.addColorStop(0, `rgba(255,255,255,${alpha})`)
  g.addColorStop(0.4, `rgba(255,255,255,${alpha * 0.5})`)
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, len, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Outer glow: one wide, soft gaussian falloff — a halo, not a hard disc. */
function buildGlowTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = FLASH_CELL
  const ctx = cv.getContext('2d')
  if (ctx === null) throw new Error('fps: 2d canvas context unavailable')
  const c = FLASH_CELL / 2
  const g = ctx.createRadialGradient(c, c, 0, c, c, c)
  g.addColorStop(0, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.75, 'rgba(255,255,255,0.16)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, FLASH_CELL, FLASH_CELL)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

/**
 * Inner hot star: `FLASH_STAR_CELLS` independent cells laid out side by side,
 * each a jittered burst of spikes plus a bright core — mirrors the style of
 * `render/effects.ts`'s `buildAtlas` SPR.FLASH cell, but as its own small
 * atlas so `updateMuzzleFlash` can swap the visible cell (via `texture.offset`)
 * for a genuinely different silhouette rather than just spinning one shape.
 */
function buildStarTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = FLASH_CELL * FLASH_STAR_CELLS
  cv.height = FLASH_CELL
  const ctx = cv.getContext('2d')
  if (ctx === null) throw new Error('fps: 2d canvas context unavailable')
  for (let cell = 0; cell < FLASH_STAR_CELLS; cell++) {
    const ox = cell * FLASH_CELL
    const cx = ox + FLASH_CELL / 2, cy = FLASH_CELL / 2
    ctx.save()
    ctx.beginPath()
    ctx.rect(ox, 0, FLASH_CELL, FLASH_CELL)
    ctx.clip()
    ctx.translate(cx, cy)
    const spikes = 5 + (cell % 2)
    for (let i = 0; i < spikes; i++) {
      const ang = (i / spikes) * Math.PI * 2 + (flashHash(i, cell * 7.7 + 1) - 0.5) * 0.9
      const len = FLASH_CELL * (0.3 + flashHash(i, cell * 3.3 + 2) * 0.18)
      ctx.save()
      ctx.rotate(ang)
      paintFlashSpike(ctx, len, 0.16 + flashHash(i, cell * 9.1 + 3) * 0.1, 0.9)
      ctx.restore()
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, FLASH_CELL * 0.22)
    core.addColorStop(0, 'rgba(255,255,255,1)')
    core.addColorStop(0.5, 'rgba(255,255,255,0.8)')
    core.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(0, 0, FLASH_CELL * 0.22, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.repeat.set(1 / FLASH_STAR_CELLS, 1)
  tex.needsUpdate = true
  return tex
}

/**
 * One flash billboard. `depthTest` stays on (matching the old meshes) so the
 * barrel/foresight can still occlude it; `depthWrite` stays off so flashes
 * never punch holes in each other or the world behind them.
 */
function makeFlashSprite(tex: THREE.Texture, color: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: tex,
    color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
  })
  return new THREE.Sprite(mat)
}

function camDir(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch)
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
