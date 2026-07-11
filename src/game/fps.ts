/**
 * First-person embodiment: take over any soldier in your line and fight his
 * war yourself. Pointer-lock mouselook, stance-aware movement through real
 * trench geometry, and a bolt-action SMLE viewmodel that fires the same
 * physically-simulated bullets as everyone else on the field. The AI treats
 * you as one more man — enemies will shoot back at *you*.
 *
 * Enter: select a unit and press M, or double-click a soldier.
 * Exit:  M or Esc (or death, which is very much period-authentic).
 */
import * as THREE from 'three'
import type { Soldier, Unit } from '../core/types'
import { UNIT_DEFS, COMBAT, WORLD } from '../core/config'
import { fireBullet, standSurface } from '../sim/ballistics'
import type { Game } from './game'

const EYE_HEIGHT = { stand: 1.68, crouch: 1.1, prone: 0.5, dead: 0.3 } as const
const MOVE_SPEED = { stand: 3.3, crouch: 1.7, prone: 0.85, dead: 0 } as const
const SPRINT_SPEED = 5.3
const MAG_SIZE = 10
const BOLT_TIME = 1.05      // seconds between aimed shots (work the bolt)
const RELOAD_TIME = 3.0     // charger clips, fumbled in the cold
const HIP_FOV = 55
const ADS_FOV = 32

export class FpsMode {
  active = false
  yaw = 0
  private pitch = 0
  private unit: Unit | null = null
  private soldier: Soldier | null = null

  // weapon state
  private ammo = MAG_SIZE
  private boltT = 0
  private reloadT = 0
  private ads = 0            // 0 hip → 1 sighted
  private adsHeld = false
  private recoil = 0
  private lastHp = 0
  private swayT = 0
  private prevSpeed: Game['speed'] = 1

  // input state (owned entirely by this mode while active)
  private keys = new Set<string>()

  // three.js
  private viewmodel: THREE.Group
  private boltHandle!: THREE.Mesh
  private muzzleTip = new THREE.Vector3()
  private flashLight: THREE.PointLight

  // DOM
  private hudRoot: HTMLDivElement
  private crosshair!: HTMLDivElement
  private ammoEl!: HTMLDivElement
  private healthEl!: HTMLDivElement
  private stanceEl!: HTMLDivElement
  private hintEl!: HTMLDivElement

  constructor(private game: Game) {
    this.viewmodel = this.buildRifle()
    this.viewmodel.visible = false
    game.renderer.camera.add(this.viewmodel)
    this.flashLight = new THREE.PointLight(0xffc87a, 0, 9, 2)
    this.flashLight.position.set(0.06, -0.02, -1.0)
    game.renderer.camera.add(this.flashLight)

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
    this.game.ctx.possessedSoldierId = soldier.id
    this.yaw = soldier.facing
    this.pitch = 0
    this.ammo = MAG_SIZE
    this.boltT = 0.3
    this.reloadT = 0
    this.ads = 0
    this.adsHeld = false
    this.recoil = 0
    this.lastHp = soldier.hp
    this.keys.clear()
    this.prevSpeed = this.game.speed
    this.game.speed = 1 // war at watch-tick speed only
    this.game.paused = false
    this.game.setBuildSelection(null)
    this.game.selectedUnitId = unit.id // keep the unit selected for re-entry
    this.game.input.releaseAll() // no stuck pan keys across the mode switch
    this.viewmodel.visible = true
    this.hudRoot.style.display = 'block'
    document.body.classList.add('ms-fps') // clear the map table off the periscope
    this.hintEl.textContent = `${soldier.name.first} ${soldier.name.last} — M or Esc to return to command`
    this.requestLock()
    this.game.audio.play('ui_click', { gain: 0.5 })
  }

  /** True while the browser has actually handed us the mouse. */
  private get locked(): boolean {
    return document.pointerLockElement === this.game.renderer.renderer.domElement
  }

  /**
   * Ask for the mouse. Chrome only grants it inside a user gesture and refuses
   * for ~1.3s after an Esc release, so this can silently fail — mouselook and
   * the trigger stay gated on `locked`, and the next click re-requests. No
   * half-active state where you can fire but not aim.
   */
  private requestLock(): void {
    const p = this.game.renderer.renderer.domElement.requestPointerLock() as unknown
    if (p instanceof Promise) p.catch(() => { /* click to lock */ })
  }

  exit(): void {
    if (!this.active) return
    this.active = false
    this.game.ctx.possessedSoldierId = -1
    if (document.pointerLockElement) document.exitPointerLock()
    this.viewmodel.visible = false
    this.flashLight.intensity = 0
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
    // Browser released the pointer (Esc) → leave the trench.
    if (this.active && document.pointerLockElement !== this.game.renderer.renderer.domElement) {
      this.exit()
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return
    this.keys.add(e.code)
    if (e.code === 'KeyM') { this.exit(); e.stopPropagation(); e.preventDefault(); return }
    if (e.code === 'KeyC') this.cycleStance()
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
    this.pitch = clamp(this.pitch - e.movementY * sens, -1.35, 1.35)
    e.stopPropagation()
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.active) return
    e.stopPropagation()
    e.preventDefault()
    // Not holding the mouse yet (initial grab failed, or user clicked away and
    // came back)? The click buys the lock — it does not also fire.
    if (!this.locked) { this.requestLock(); return }
    if (e.button === 0) this.tryFire()
    else if (e.button === 2) this.adsHeld = true
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (!this.active) return
    if (e.button === 2) this.adsHeld = false
    e.stopPropagation()
  }

  // -------------------------------------------------------------------------
  // Soldiering
  // -------------------------------------------------------------------------

  private cycleStance(): void {
    const s = this.soldier
    if (!s || s.stance === 'dead') return
    s.stance = s.stance === 'stand' ? 'crouch' : s.stance === 'crouch' ? 'prone' : 'stand'
  }

  private startReload(): void {
    if (!this.soldier || this.reloadT > 0 || this.ammo >= MAG_SIZE) return
    this.reloadT = RELOAD_TIME
    this.game.audio.play('reload', {
      x: this.soldier.pos.x, y: 1.5, z: this.soldier.pos.z, gain: 0.7,
    })
  }

  private tryFire(): void {
    const s = this.soldier
    if (!s || s.hp <= 0) return
    if (this.reloadT > 0 || this.boltT > 0) return
    if (this.ammo <= 0) {
      this.game.audio.play('ui_click', { gain: 0.35, rate: 1.7 }) // dead man's click
      this.startReload()
      return
    }
    this.ammo--
    this.boltT = BOLT_TIME
    this.recoil = 1

    const ctx = this.game.ctx
    const cam = this.game.renderer.camera
    // Aim = camera axis; spread from stance, sights, movement and nerves.
    const dir = camDir(this.yaw, this.pitch)
    const moving = this.moveInput().len > 0.1
    let spread = lerp(0.012, 0.0022, this.ads)
    spread *= s.stance === 'prone' ? 0.7 : s.stance === 'crouch' ? 0.88 : 1
    if (moving) spread *= 1.9
    spread *= 1 + s.suppression * 1.6

    const from = {
      x: cam.position.x + dir.x * 0.7,
      y: cam.position.y + dir.y * 0.7 - 0.06,
      z: cam.position.z + dir.z * 0.7,
    }
    fireBullet(ctx, {
      team: 'brit',
      from,
      dir: { x: dir.x, y: dir.y, z: dir.z },
      speed: COMBAT.bulletSpeed,
      damage: UNIT_DEFS.rifleman.damage * ctx.mods.rifleDmg,
      spread,
      category: 'rifle',
      shooterUnitId: this.unit?.id ?? -1,
      shooterId: s.id,
      tracer: ctx.rand() < COMBAT.tracerFraction,
    })
    s.facing = this.yaw

    // Report, flash, kick.
    this.game.audio.play('rifle', { x: from.x, y: from.y, z: from.z, gain: 0.95 })
    this.game.effects.muzzleFlash(from.x, from.y, from.z, dir.x, dir.z)
    this.flashLight.intensity = 26
  }

  private moveInput(): { x: number; z: number; len: number } {
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
    const g = this.game
    if (!this.active || !s) return

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
    let speed = sprinting ? SPRINT_SPEED : MOVE_SPEED[s.stance]
    speed *= 1 - g.ctx.terrain.mudAt(s.pos.x, s.pos.z) * 0.45
    speed *= 1 - Math.min(0.35, g.ctx.terrain.slopeAt(s.pos.x, s.pos.z) * 0.5)
    if (mv.len > 0.1) {
      const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw)
      // forward = (sin yaw, -cos yaw); right = (cos yaw, sin yaw)
      const dx = (sinY * mv.z + cosY * mv.x) * speed * dt
      const dz = (-cosY * mv.z + sinY * mv.x) * speed * dt
      s.pos.x = clamp(s.pos.x + dx, -WORLD.width / 2 + 2, WORLD.width / 2 - 2)
      s.pos.z = clamp(s.pos.z + dz, -WORLD.depth / 2 + 2, WORLD.depth / 2 - 2)
      s.animPhase += dt * (sprinting ? 11 : 7)
    }
    s.facing = this.yaw

    // -- weapon timers ----------------------------------------------------------
    if (this.boltT > 0) this.boltT -= dt
    if (this.reloadT > 0) {
      this.reloadT -= dt
      if (this.reloadT <= 0) { this.ammo = MAG_SIZE }
    }
    this.recoil = Math.max(0, this.recoil - dt * 5)
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 300)
    const adsTarget = this.adsHeld && this.reloadT <= 0 ? 1 : 0
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * 10)

    // -- camera -----------------------------------------------------------------
    this.swayT += dt
    const cam = g.renderer.camera
    const eyeBase = standSurface(g.ctx, s.pos.x, s.pos.z) + EYE_HEIGHT[s.stance]
    const bob = Math.abs(Math.sin(s.animPhase * 0.9)) * 0.035 * mv.len * (sprinting ? 1.6 : 1)
    cam.position.set(s.pos.x, eyeBase + bob, s.pos.z)
    const breathe = Math.sin(this.swayT * 1.7) * 0.0016 * (1 + s.suppression * 5) * (1 - this.ads * 0.6)
    const kick = this.recoil * this.recoil * 0.028
    cam.rotation.order = 'YXZ'
    cam.rotation.y = -this.yaw
    cam.rotation.x = this.pitch + breathe + kick
    cam.rotation.z = Math.sin(this.swayT * 1.1) * 0.0012
    const fov = lerp(HIP_FOV, ADS_FOV, this.ads)
    if (Math.abs(cam.fov - fov) > 0.1) { cam.fov = fov; cam.updateProjectionMatrix() }

    // -- viewmodel ----------------------------------------------------------------
    this.poseViewmodel(dt, mv.len, sprinting)

    // -- HUD ------------------------------------------------------------------------
    const locked = this.locked
    this.crosshair.style.opacity = String(locked ? 0.75 * (1 - this.ads) : 0)
    this.hintEl.textContent = locked
      ? `${s.name.first} ${s.name.last} — M or Esc to return to command`
      : 'Click to take aim'
    this.ammoEl.textContent = this.reloadT > 0
      ? `RELOADING ${'▮'.repeat(Math.ceil((1 - this.reloadT / RELOAD_TIME) * 5)).padEnd(5, '▯')}`
      : `${this.ammo} / ${MAG_SIZE}`
    const hpFrac = Math.max(0, s.hp / s.maxHp)
    this.healthEl.style.background =
      `linear-gradient(90deg, ${hpFrac > 0.4 ? '#7fae5a' : '#a04a3a'} ${hpFrac * 100}%, rgba(255,255,255,0.12) ${hpFrac * 100}%)`
    this.stanceEl.textContent = s.stance === 'stand' ? 'STANDING' : s.stance === 'crouch' ? 'CROUCHED' : 'PRONE'
  }

  // -------------------------------------------------------------------------
  // Viewmodel
  // -------------------------------------------------------------------------

  private buildRifle(): THREE.Group {
    const rifle = new THREE.Group()
    // A touch of emissive keeps the viewmodel readable with the sun behind you.
    const wood = new THREE.MeshStandardMaterial({
      color: 0x8a5c30, roughness: 0.72, metalness: 0.04, emissive: 0x241505, emissiveIntensity: 0.55,
    })
    const darkWood = new THREE.MeshStandardMaterial({
      color: 0x6b4423, roughness: 0.78, metalness: 0.04, emissive: 0x1b0f04, emissiveIntensity: 0.55,
    })
    const steel = new THREE.MeshStandardMaterial({
      color: 0x4a4e55, roughness: 0.42, metalness: 0.72, emissive: 0x0c0e12, emissiveIntensity: 0.6,
    })
    const brass = new THREE.MeshStandardMaterial({
      color: 0x9a7a42, roughness: 0.5, metalness: 0.6, emissive: 0x1a1206, emissiveIntensity: 0.5,
    })

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      rifle.add(m)
      return m
    }
    // Butt → muzzle runs along -Z.
    add(new THREE.BoxGeometry(0.055, 0.11, 0.34), wood, 0, -0.02, 0.28)          // butt stock
    add(new THREE.BoxGeometry(0.05, 0.075, 0.28), darkWood, 0, 0.005, -0.02)     // wrist + receiver wood
    add(new THREE.BoxGeometry(0.052, 0.06, 0.16), steel, 0, 0.045, -0.03)        // receiver
    add(new THREE.BoxGeometry(0.048, 0.062, 0.62), wood, 0, 0.015, -0.42)        // forestock
    const barrel = new THREE.CylinderGeometry(0.011, 0.011, 0.78, 8)
    barrel.rotateX(Math.PI / 2)
    add(barrel, steel, 0, 0.052, -0.5)                                            // barrel
    add(new THREE.BoxGeometry(0.012, 0.035, 0.012), steel, 0, 0.082, -0.86)      // front sight post
    add(new THREE.BoxGeometry(0.05, 0.03, 0.02), steel, 0, 0.075, -0.12)         // rear sight
    add(new THREE.BoxGeometry(0.03, 0.014, 0.1), brass, 0, -0.005, 0.1)          // magazine plate
    const bolt = new THREE.CylinderGeometry(0.012, 0.012, 0.07, 8)
    this.boltHandle = add(bolt, steel, 0.05, 0.05, 0.02)                          // bolt handle
    this.boltHandle.rotation.z = -0.9
    this.muzzleTip.set(0, 0.052, -0.89)
    rifle.scale.setScalar(0.82)
    rifle.traverse((o) => { (o as THREE.Mesh).castShadow = false; o.frustumCulled = false })
    return rifle
  }

  private poseViewmodel(dt: number, moveLen: number, sprinting: boolean): void {
    void dt
    const vm = this.viewmodel
    const t = this.swayT
    // Hip ←→ sighted positions (sight line meets the camera axis at ads=1).
    const hip = { x: 0.19, y: -0.22, z: -0.46, rx: 0.06, ry: 0.06 }
    const aim = { x: 0, y: -0.083, z: -0.32, rx: 0, ry: 0 }
    const a = this.ads
    const sway = (1 - a * 0.85) * (moveLen > 0.1 ? 1 : 0.35)
    const bobX = Math.sin(t * (sprinting ? 9 : 6)) * 0.006 * sway
    const bobY = Math.abs(Math.cos(t * (sprinting ? 9 : 6))) * 0.007 * sway
    const kick = this.recoil * this.recoil
    vm.position.set(
      lerp(hip.x, aim.x, a) + bobX,
      lerp(hip.y, aim.y, a) - bobY,
      lerp(hip.z, aim.z, a) + kick * 0.06,
    )
    vm.rotation.set(lerp(hip.rx, aim.rx, a) + kick * 0.09, lerp(hip.ry, aim.ry, a), 0)
    // Bolt work: handle lifts and draws back after each shot.
    const bt = BOLT_TIME - Math.max(0, this.boltT)
    let boltLift = 0, boltPull = 0
    if (this.boltT > 0 && bt > 0.18) {
      const ph = Math.min(1, (bt - 0.18) / (BOLT_TIME - 0.3))
      boltLift = Math.sin(ph * Math.PI) * 1.0
      boltPull = Math.sin(ph * Math.PI) * 0.06
    }
    this.boltHandle.rotation.z = -0.9 + boltLift
    this.boltHandle.position.z = 0.02 + boltPull
    // Reload: rifle dips out of the shoulder.
    if (this.reloadT > 0) {
      const r = this.reloadT / RELOAD_TIME
      vm.position.y -= Math.sin(r * Math.PI) * 0.12
      vm.rotation.x += Math.sin(r * Math.PI) * 0.35
    }
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  private buildHud(): HTMLDivElement {
    // While embodied, the commander's HUD stands down.
    const style = document.createElement('style')
    style.textContent = 'body.ms-fps .ui-scaled { display: none !important; }'
    document.head.appendChild(style)

    const root = document.createElement('div')
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;display:none;z-index:60;' +
      'font-family:inherit;color:#e8e0c8;text-shadow:0 1px 2px rgba(0,0,0,0.8)'

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
    const ammoLabel = document.createElement('div')
    ammoLabel.style.cssText = 'font-size:11px;opacity:0.75'
    ammoLabel.textContent = '.303 SMLE — R TO RELOAD · C STANCE · SHIFT RUN'
    panel.appendChild(ammoLabel)
    root.appendChild(panel)

    const left = document.createElement('div')
    left.style.cssText = 'position:absolute;left:22px;bottom:18px;width:180px'
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
