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
import type { Soldier, Unit, UnitKindId } from '../core/types'
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
  private recoil = 0
  private lastHp = 0
  private swayT = 0
  private prevSpeed: Game['speed'] = 1
  private reticle: GroundHit | null = null

  // input state (owned entirely by this mode while active)
  private keys = new Set<string>()

  // three.js
  private flashLight: THREE.PointLight
  private aimRing: THREE.Mesh
  private _muzzleWorld = new THREE.Vector3() // scratch: viewmodel muzzle → world
  // Muzzle flash bolted to the gun model itself, so it stays welded to the
  // barrel through recoil kick, sway and mouselook — a world-space flash would
  // drift off the muzzle the instant the camera moved after the shot.
  private muzzleFlash: THREE.Sprite
  private muzzleFlashCore: THREE.Sprite
  private flashT = 0        // seconds of flash left
  private flashDur = 0.045  // how long one flash burns
  private flashSize = 0.42  // this shot's flash radius (local units)

  // DOM
  private hudRoot: HTMLDivElement
  private crosshair!: HTMLDivElement
  private scopeEl!: HTMLDivElement
  private ammoEl!: HTMLDivElement
  private ammoLabelEl!: HTMLDivElement
  private controlsEl!: HTMLDivElement
  private gaugeWrap!: HTMLDivElement
  private gaugeLabel!: HTMLDivElement
  private gaugeBar!: HTMLDivElement
  private healthEl!: HTMLDivElement
  private stanceEl!: HTMLDivElement
  private hintEl!: HTMLDivElement

  constructor(private game: Game) {
    this.flashLight = new THREE.PointLight(0xffc87a, 0, 9, 2)
    this.flashLight.position.set(0.06, -0.02, -1.0)
    game.renderer.camera.add(this.flashLight)

    // Two stacked billboards: a broad amber glow and a hot near-white core.
    // They live on the active viewmodel (re-parented in equip) at its muzzle.
    const glowTex = makeFlashTexture(false)
    const coreTex = makeFlashTexture(true)
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffb45a, blending: THREE.AdditiveBlending,
      transparent: true, depthTest: false, depthWrite: false,
    }))
    this.muzzleFlashCore = new THREE.Sprite(new THREE.SpriteMaterial({
      map: coreTex, color: 0xffca82, blending: THREE.AdditiveBlending,
      transparent: true, depthTest: false, depthWrite: false,
    }))
    for (const s of [this.muzzleFlash, this.muzzleFlashCore]) {
      s.visible = false
      s.frustumCulled = false
      s.renderOrder = 8
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
    this.pitch = this.profile.control === 'lob' ? -0.35 : 0 // mortars start laid downrange
    this.ammo = this.profile.magSize
    this.fuel = 1
    this.boltT = 0.3
    this.reloadT = 0
    this.toolProgress = 0
    this.ads = 0
    this.adsHeld = false
    this.triggerDown = false
    this.recoil = 0
    this.lastHp = soldier.hp
    this.reticle = null
    if (this.profile.heat) { unit.heat = 0; unit.venting = false }
    this.keys.clear()
    this.prevSpeed = this.game.speed
    this.game.speed = 1 // war at watch-tick speed only
    this.game.paused = false
    this.game.setBuildSelection(null)
    this.game.selectedUnitId = unit.id // keep the unit selected for re-entry
    this.game.input.releaseAll() // no stuck pan keys across the mode switch
    this.vm.group.visible = true
    this.hudRoot.style.display = 'block'
    document.body.classList.add('ms-fps') // clear the map table off the periscope
    this.hintEl.textContent = `${soldier.name.first} ${soldier.name.last} — M or Esc to return to command`
    this.requestLock()
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
    // Weld the flash billboards to this gun's muzzle. Adding to the new group
    // detaches them from the old one; positioning in the group's local space
    // means they ride every pose the barrel does.
    this.flashT = 0
    this.muzzleFlash.visible = false
    this.muzzleFlashCore.visible = false
    v.group.add(this.muzzleFlash, this.muzzleFlashCore)
    this.muzzleFlash.position.copy(v.muzzle)
    this.muzzleFlashCore.position.copy(v.muzzle)
  }

  /** True while the browser has actually handed us the mouse. */
  private get locked(): boolean {
    return document.pointerLockElement === this.game.renderer.renderer.domElement
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
    if (document.pointerLockElement) document.exitPointerLock()
    if (this.vm) this.vm.group.visible = false
    this.flashLight.intensity = 0
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
    this.hudRoot.remove()
  }

  // -------------------------------------------------------------------------
  // Input (window-level, capture phase, only while active)
  // -------------------------------------------------------------------------

  private onLockChange = (): void => {
    if (this.active && document.pointerLockElement !== this.game.renderer.renderer.domElement) {
      this.exit()
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return
    this.keys.add(e.code)
    if (e.code === 'KeyM') { this.exit(); e.stopPropagation(); e.preventDefault(); return }
    if (e.code === 'KeyC' && !this.profile.emplaced) this.cycleStance()
    if (e.code === 'KeyR') this.startReload()
    e.stopPropagation()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.active) return
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
    if (!this.active) return
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
    if (!this.active) return
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
    this.recoil = this.profile.recoil
    this.flashLight.intensity = this.profile.control === 'directgun' ? 40
      : this.profile.control === 'lob' || this.profile.control === 'throw' ? 0
        : this.profile.heat ? 16 : 26
    // Light the barrel flash for direct-fire weapons (lobs/flame/tools have none).
    const c = this.profile.control
    if (c === 'bolt' || c === 'semi' || c === 'auto' || c === 'directgun') {
      const base = c === 'directgun' ? 0.44 : this.profile.id === 'vickers' ? 0.3 : 0.2
      this.flashSize = base * (0.85 + this.game.ctx.rand() * 0.3)
      this.flashT = this.flashDur
      this.muzzleFlash.material.rotation = this.game.ctx.rand() * Math.PI * 2
      this.muzzleFlashCore.material.rotation = this.game.ctx.rand() * Math.PI * 2
    }
    if (this.profile.ammoKind === 'fuel') this.fuel = Math.max(0, this.fuel - 0.014)
    else if (this.profile.ammoKind !== 'none') this.ammo--
  }

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
    vm.group.updateWorldMatrix(true, false)
    this._muzzleWorld.copy(vm.muzzle)
    vm.group.localToWorld(this._muzzleWorld)
    return { x: this._muzzleWorld.x, y: this._muzzleWorld.y, z: this._muzzleWorld.z }
  }

  /** Fade the barrel-welded flash. Scale pops big then collapses as it burns. */
  private updateMuzzleFlash(dt: number): void {
    if (this.flashT <= 0) {
      if (this.muzzleFlash.visible) { this.muzzleFlash.visible = false; this.muzzleFlashCore.visible = false }
      return
    }
    this.flashT -= dt
    const k = Math.max(0, this.flashT / this.flashDur) // 1 → 0 over the burn
    // Ease the size down and the brightness with it; a little forward jitter
    // reads as the flame guttering rather than a static decal.
    const size = this.flashSize * (0.7 + 0.5 * k)
    const alpha = Math.min(1, k * 1.3)
    this.muzzleFlash.visible = true
    this.muzzleFlashCore.visible = true
    this.muzzleFlash.scale.set(size, size, size)
    this.muzzleFlashCore.scale.set(size * 0.5, size * 0.5, size * 0.5)
    ;(this.muzzleFlash.material as THREE.SpriteMaterial).opacity = alpha * 0.4
    ;(this.muzzleFlashCore.material as THREE.SpriteMaterial).opacity = alpha * 0.4
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
    this.recoil = Math.max(0, this.recoil - dt * 5)
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 300)
    this.updateMuzzleFlash(dt)
    const canAds = !this.profile.emplaced || this.profile.control === 'directgun'
    const adsTarget = this.adsHeld && this.reloadT <= 0 && canAds ? 1 : 0
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * 10)

    // -- camera ---------------------------------------------------------------
    this.swayT += dt
    const cam = g.renderer.camera
    const eyeBase = standSurface(g.ctx, s.pos.x, s.pos.z) + EYE_HEIGHT[s.stance]
    const bob = Math.abs(Math.sin(s.animPhase * 0.9)) * 0.035 * mv.len * (sprinting ? 1.6 : 1)
    cam.position.set(s.pos.x, eyeBase + bob, s.pos.z)
    const breathe = Math.sin(this.swayT * 1.7) * 0.0016 * (1 + s.suppression * 5) * (1 - this.ads * 0.6)
    const kick = this.recoil * this.recoil * 0.028 * (this.profile.recoil || 0.01)
    cam.rotation.order = 'YXZ'
    cam.rotation.y = -this.yaw
    cam.rotation.x = this.pitch + breathe + kick
    cam.rotation.z = Math.sin(this.swayT * 1.1) * 0.0012
    const fov = lerp(this.profile.hipFov, this.profile.adsFov, this.ads)
    if (Math.abs(cam.fov - fov) > 0.1) { cam.fov = fov; cam.updateProjectionMatrix() }

    // -- aim reticle for thrown / indirect fire (needs the fresh camera) ------
    this.updateReticle()

    // -- viewmodel ------------------------------------------------------------
    this.poseViewmodel(mv.len, sprinting)

    // -- HUD ------------------------------------------------------------------
    this.updateHud()
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

  // -------------------------------------------------------------------------
  // Viewmodel posing
  // -------------------------------------------------------------------------

  private poseViewmodel(moveLen: number, sprinting: boolean): void {
    const vm = this.vm
    if (!vm) return
    // Looking through the scope: the rifle drops away so the optic fills the eye.
    const scopedAway = this.profile.scope && this.ads > 0.85
    vm.group.visible = !scopedAway
    if (scopedAway) return
    const t = this.swayT
    const hip = this.profile.hip
    const aim = this.profile.aim
    const a = this.ads
    const sway = (1 - a * 0.85) * (moveLen > 0.1 ? 1 : 0.35)
    const bobX = Math.sin(t * (sprinting ? 9 : 6)) * 0.006 * sway
    const bobY = Math.abs(Math.cos(t * (sprinting ? 9 : 6))) * 0.007 * sway
    const kick = this.recoil * this.recoil

    if (this.profile.control === 'throw') {
      // Overarm bowl: the arm cocks back, then whips forward as recoil decays.
      const swing = this.recoil // 1 at release → 0
      vm.group.position.set(
        lerp(hip.x, aim.x, a),
        lerp(hip.y, aim.y, a) + swing * 0.12,
        lerp(hip.z, aim.z, a) + (1 - swing) * -0.05,
      )
      vm.group.rotation.set(lerp(hip.rx, aim.rx, a) - swing * 1.4, lerp(hip.ry, aim.ry, a), 0)
      return
    }

    vm.group.position.set(
      lerp(hip.x, aim.x, a) + bobX,
      lerp(hip.y, aim.y, a) - bobY,
      lerp(hip.z, aim.z, a) + kick * 0.06,
    )
    vm.group.rotation.set(
      lerp(hip.rx, aim.rx, a) + kick * 0.09,
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
      vm.recoilPart.position.z = vm.restRecoilZ + kick * 0.14
    }

    // Reload: the weapon dips out of the shoulder.
    if (this.reloadT > 0 && this.profile.reloadTime > 0) {
      const r = this.reloadT / this.profile.reloadTime
      vm.group.position.y -= Math.sin(r * Math.PI) * 0.12
      vm.group.rotation.x += Math.sin(r * Math.PI) * 0.35
    }
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

    // Crosshair: hidden under the sniper scope, faint otherwise.
    const scoped = p.scope && this.ads > 0.6
    this.crosshair.style.opacity = String(locked && !scoped ? 0.72 * (1 - this.ads * 0.4) : 0)
    this.scopeEl.style.opacity = String(scoped ? Math.min(1, (this.ads - 0.6) / 0.3) : 0)

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
    this.stanceEl.textContent = s.stance === 'stand' ? 'STANDING' : s.stance === 'crouch' ? 'CROUCHED' : 'PRONE'
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

    this.crosshair = document.createElement('div')
    this.crosshair.style.cssText =
      'position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2px 0 0 -2px;' +
      'border-radius:50%;background:#e8e0c8;box-shadow:0 0 0 1.5px rgba(0,0,0,0.55)'
    root.appendChild(this.crosshair)

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

/**
 * A soft radial muzzle-flash decal on a canvas. `core` draws a tight hot dot;
 * otherwise a broad glow crossed by a faint four-point star so a spinning
 * billboard reads as fire rather than a disc. Additive blending does the rest.
 */
function makeFlashTexture(core: boolean): THREE.CanvasTexture {
  const N = 64, c = document.createElement('canvas')
  c.width = c.height = N
  const ctx = c.getContext('2d')!
  const mid = N / 2
  const g = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid)
  if (core) {
    // Warm, not pure white — a white core clips through the bloom pass into an
    // ugly magenta-fringed disc; amber blooms into a clean golden flash.
    g.addColorStop(0, 'rgba(255,236,198,0.95)')
    g.addColorStop(0.45, 'rgba(255,206,132,0.7)')
    g.addColorStop(1, 'rgba(255,190,110,0)')
  } else {
    g.addColorStop(0, 'rgba(255,238,196,1)')
    g.addColorStop(0.35, 'rgba(255,176,80,0.55)')
    g.addColorStop(1, 'rgba(255,150,60,0)')
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, N, N)
  if (!core) {
    // Four-point star streaks for a little muzzle-bloom character.
    ctx.strokeStyle = 'rgba(255,226,170,0.5)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(mid, 4); ctx.lineTo(mid, N - 4)
    ctx.moveTo(4, mid); ctx.lineTo(N - 4, mid)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.needsUpdate = true
  return tex
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
