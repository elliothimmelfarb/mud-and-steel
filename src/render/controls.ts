/**
 * Camera rig + unified input. Design rule: EVERYTHING is doable with mouse
 * alone or keyboard alone, on Mac or Windows — no OS-modifier dependencies,
 * every bind remappable, wheel/trackpad deltas normalized.
 */
import * as THREE from 'three'
import type { Terrain } from '../world/terrain'
import { WORLD } from '../core/config'

// ---------------------------------------------------------------------------
// Actions & default binds (KeyboardEvent.code — layout-independent)
// ---------------------------------------------------------------------------

export type Action =
  | 'panLeft' | 'panRight' | 'panUp' | 'panDown'
  | 'rotateLeft' | 'rotateRight' | 'zoomIn' | 'zoomOut'
  | 'pause' | 'speedDown' | 'speedUp'
  | 'cancel' | 'confirm' | 'sell' | 'cycleUnits' | 'rotatePlacement'
  | 'help' | 'callWave' | 'toggleMenu'
  | 'orderCover' | 'orderRapid' | 'orderBayonets' | 'orderMasks'
  | 'orderFlare' | 'orderBarrage' | 'orderTank'
  | 'build1' | 'build2' | 'build3' | 'build4' | 'build5' | 'build6'
  | 'build7' | 'build8' | 'build9' | 'build10' | 'build11' | 'build12'
  | 'buildD1' | 'buildD2' | 'buildD3' | 'buildD4' | 'buildD5' | 'buildD6'

export const DEFAULT_BINDS: Record<Action, string> = {
  panLeft: 'KeyA', panRight: 'KeyD', panUp: 'KeyW', panDown: 'KeyS',
  rotateLeft: 'KeyQ', rotateRight: 'KeyE', zoomIn: 'KeyZ', zoomOut: 'KeyX',
  pause: 'Space', speedDown: 'BracketLeft', speedUp: 'BracketRight',
  cancel: 'Escape', confirm: 'Enter', sell: 'Delete', cycleUnits: 'Tab', rotatePlacement: 'KeyR',
  help: 'KeyH', callWave: 'KeyN', toggleMenu: 'Escape',
  orderCover: 'KeyC', orderRapid: 'KeyF', orderBayonets: 'KeyB', orderMasks: 'KeyG',
  orderFlare: 'KeyV', orderBarrage: 'KeyJ', orderTank: 'KeyT',
  build1: 'Digit1', build2: 'Digit2', build3: 'Digit3', build4: 'Digit4',
  build5: 'Digit5', build6: 'Digit6', build7: 'Digit7', build8: 'Digit8',
  build9: 'Digit9', build10: 'Digit0', build11: 'Minus', build12: 'Equal',
  buildD1: 'F1', buildD2: 'F2', buildD3: 'F3', buildD4: 'F4', buildD5: 'F5', buildD6: 'F6',
}

/** Hardwired alternates that always work (arrow keys pan, etc). */
const ALT_BINDS: Partial<Record<Action, string>> = {
  panLeft: 'ArrowLeft', panRight: 'ArrowRight', panUp: 'ArrowUp', panDown: 'ArrowDown',
}

/** Human label for a KeyboardEvent.code, for HUD chips. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const map: Record<string, string> = {
    Space: 'Space', Escape: 'Esc', Enter: '⏎', Delete: 'Del', Tab: 'Tab',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  }
  return map[code] ?? code
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export class Input {
  private binds: Record<Action, string>
  private down = new Set<string>()
  private pressedActions = new Set<Action>()
  private actionHandlers = new Map<Action, Array<() => void>>()
  private captureCb: ((code: string) => void) | null = null

  /** Pointer state in CSS pixels + NDC. */
  readonly pointer = {
    x: 0, y: 0, ndcX: 0, ndcY: 0, inside: false,
    dragButton: -1, dragging: false, dragStartX: 0, dragStartY: 0,
  }
  onPointerMove: ((ndcX: number, ndcY: number) => void) | null = null
  onClick: ((ndcX: number, ndcY: number, button: number) => void) | null = null
  onDrag: ((dx: number, dy: number, button: number) => void) | null = null
  onWheelZoom: ((delta: number) => void) | null = null

  private el: HTMLElement
  /** While placing with the keyboard, arrows drive the cursor, not the camera. */
  arrowCursorMode = false

  constructor(el: HTMLElement, binds?: Record<string, string>) {
    this.el = el
    this.binds = { ...DEFAULT_BINDS, ...(binds as Partial<Record<Action, string>> | undefined) }
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointerleave', () => { this.pointer.inside = false })
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  setBinds(binds: Record<string, string>): void {
    this.binds = { ...DEFAULT_BINDS, ...(binds as Partial<Record<Action, string>>) }
  }
  getBinds(): Record<Action, string> { return { ...this.binds } }
  bindFor(action: Action): string { return this.binds[action] }

  /** Next keydown is captured (for rebinding UI) instead of dispatched. */
  captureNextKey(cb: (code: string) => void): void { this.captureCb = cb }

  /** Abandon a pending rebind capture (settings closed mid-listen). */
  cancelCapture(): void { this.captureCb = null }

  /** Drop queued edge-triggered presses (called while a modal owns the keys). */
  clearPressed(): void { this.pressedActions.clear() }

  isDown(action: Action): boolean {
    if (this.down.has(this.binds[action])) return true
    const alt = ALT_BINDS[action]
    if (alt === undefined) return false
    if (this.arrowCursorMode && alt.startsWith('Arrow')) return false
    return this.down.has(alt)
  }

  /** Raw arrow-key direction (for the keyboard placement cursor). */
  arrowDir(): { x: number; z: number } {
    return {
      x: (this.down.has('ArrowRight') ? 1 : 0) - (this.down.has('ArrowLeft') ? 1 : 0),
      z: (this.down.has('ArrowDown') ? 1 : 0) - (this.down.has('ArrowUp') ? 1 : 0),
    }
  }

  /** Edge-triggered: true once per key press. */
  consume(action: Action): boolean {
    if (this.pressedActions.has(action)) { this.pressedActions.delete(action); return true }
    return false
  }

  on(action: Action, fn: () => void): void {
    let arr = this.actionHandlers.get(action)
    if (!arr) { arr = []; this.actionHandlers.set(action, arr) }
    arr.push(fn)
  }

  /** True while any typing-capable element has focus (suppress game keys). */
  private typing(): boolean {
    const a = document.activeElement
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.captureCb) {
      e.preventDefault()
      const cb = this.captureCb
      this.captureCb = null
      cb(e.code)
      return
    }
    if (this.typing()) return
    // Swallow browser defaults for our binds (F1..F6 defences, Tab focus, Space scroll...)
    const bound = (Object.values(this.binds) as string[]).includes(e.code)
    if (bound || e.code === 'Tab' || e.code === 'Space') e.preventDefault()
    if (this.down.has(e.code)) return // ignore auto-repeat
    this.down.add(e.code)
    for (const [action, code] of Object.entries(this.binds) as Array<[Action, string]>) {
      if (code === e.code || ALT_BINDS[action] === e.code) {
        this.pressedActions.add(action)
        const arr = this.actionHandlers.get(action)
        if (arr) for (const fn of arr) fn()
      }
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => { this.down.delete(e.code) }
  private onBlur = (): void => { this.down.clear() }

  /** Refresh pointer coords from any event (clicks may arrive without a move). */
  private syncPointer(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect()
    const p = this.pointer
    p.x = e.clientX - r.left; p.y = e.clientY - r.top
    p.ndcX = (p.x / r.width) * 2 - 1
    p.ndcY = -(p.y / r.height) * 2 + 1
    p.inside = true
  }

  private onMove = (e: PointerEvent): void => {
    this.syncPointer(e)
    const p = this.pointer
    if (p.dragButton >= 0) {
      const dx = e.movementX, dy = e.movementY
      if (!p.dragging && Math.hypot(p.x - p.dragStartX, p.y - p.dragStartY) > 5) p.dragging = true
      if (p.dragging) this.onDrag?.(dx, dy, p.dragButton)
    }
    this.onPointerMove?.(p.ndcX, p.ndcY)
  }

  private onDown = (e: PointerEvent): void => {
    this.syncPointer(e)
    const p = this.pointer
    p.dragButton = e.button
    p.dragging = false
    p.dragStartX = p.x; p.dragStartY = p.y
    try { this.el.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
  }

  private onUp = (e: PointerEvent): void => {
    this.syncPointer(e)
    const p = this.pointer
    if (!p.dragging && p.dragButton === e.button) {
      this.onClick?.(p.ndcX, p.ndcY, e.button)
    }
    p.dragButton = -1
    p.dragging = false
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    // Normalize: pixels (trackpads) vs lines (mice) vs pages. Pinch gestures
    // arrive as ctrl+wheel on both macOS and Windows — treat as faster zoom.
    let d = e.deltaY
    if (e.deltaMode === 1) d *= 16
    else if (e.deltaMode === 2) d *= 120
    if (e.ctrlKey) d *= 2.5
    this.onWheelZoom?.(d)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }
}

// ---------------------------------------------------------------------------
// Camera rig
// ---------------------------------------------------------------------------

export class CameraRig {
  /** Ground point the camera orbits. */
  readonly target = new THREE.Vector3(0, 0, WORLD.frontTrenchZ + 25)
  yaw = 0                      // 0 = camera south of target, looking north at the enemy
  dist = 78
  private curYaw = 0
  private curDist = 78
  private curTarget = this.target.clone()
  private shake = 0
  edgePan = false
  invertZoom = false
  speedMul = 1

  constructor(private camera: THREE.PerspectiveCamera, private terrain: Terrain) {}

  addShake(v: number): void { this.shake = Math.min(1.2, this.shake + v) }

  zoomBy(wheelDelta: number): void {
    const dir = this.invertZoom ? -1 : 1
    this.dist = clamp(this.dist * Math.pow(1.0016, wheelDelta * dir), 24, 150)
  }

  rotateBy(dx: number): void { this.yaw += dx * 0.005 }

  panByScreen(dx: number, dy: number): void {
    // Middle-drag "grab the map": same frame math as keyboard panning,
    // with the drag inverted (pull the world under the cursor).
    const scale = this.curDist * 0.0016
    const sin = Math.sin(this.curYaw), cos = Math.cos(this.curYaw)
    const mx = -dx, mz = -dy
    this.target.x += (mx * cos + mz * sin) * scale
    this.target.z += (-mx * sin + mz * cos) * scale
    this.clampTarget()
  }

  update(dt: number, input: Input, pointerEdge: { x: number; y: number; inside: boolean }, uiHasFocus: boolean): void {
    const panSpeed = this.curDist * 0.85 * this.speedMul
    let mx = 0, mz = 0
    if (!uiHasFocus) {
      if (input.isDown('panLeft')) mx -= 1
      if (input.isDown('panRight')) mx += 1
      if (input.isDown('panUp')) mz -= 1
      if (input.isDown('panDown')) mz += 1
      if (input.isDown('rotateLeft')) this.yaw -= 1.7 * dt
      if (input.isDown('rotateRight')) this.yaw += 1.7 * dt
      if (input.isDown('zoomIn')) this.dist = clamp(this.dist * (1 - 1.3 * dt), 24, 150)
      if (input.isDown('zoomOut')) this.dist = clamp(this.dist * (1 + 1.3 * dt), 24, 150)
    }
    if (this.edgePan && pointerEdge.inside && document.hasFocus()) {
      const m = 14
      if (pointerEdge.x < m) mx -= 1
      if (pointerEdge.x > window.innerWidth - m) mx += 1
      if (pointerEdge.y < m) mz -= 1
      if (pointerEdge.y > window.innerHeight - m) mz += 1
    }
    if (mx !== 0 || mz !== 0) {
      const len = Math.hypot(mx, mz)
      const sin = Math.sin(this.curYaw), cos = Math.cos(this.curYaw)
      // Forward (mz=-1) moves toward -z when yaw=0.
      this.target.x += ((mx * cos + mz * sin) / len) * panSpeed * dt
      this.target.z += ((-mx * sin + mz * cos) / len) * panSpeed * dt
      this.clampTarget()
    }

    // Smooth follow.
    const k = 1 - Math.exp(-dt * 9)
    this.curYaw += (this.yaw - this.curYaw) * k
    this.curDist += (this.dist - this.curDist) * k
    this.curTarget.lerp(this.target, k)

    // Pitch rises as you zoom out: trench-level drama up close, map view far out.
    const zf = (this.curDist - 24) / (150 - 24)
    const pitch = (34 + zf * 30) * (Math.PI / 180)

    const groundY = this.terrain.heightAt(this.curTarget.x, this.curTarget.z)
    const cy = Math.sin(pitch) * this.curDist
    const ch = Math.cos(pitch) * this.curDist
    this.camera.position.set(
      this.curTarget.x + Math.sin(this.curYaw) * ch,
      groundY + cy,
      this.curTarget.z + Math.cos(this.curYaw) * ch,
    )
    if (this.shake > 0.001) {
      this.shake *= Math.exp(-dt * 5)
      const s = this.shake * this.shake * 1.6
      this.camera.position.x += (Math.random() - 0.5) * s
      this.camera.position.y += (Math.random() - 0.5) * s * 0.7
      this.camera.position.z += (Math.random() - 0.5) * s
    }
    this.camera.lookAt(this.curTarget.x, groundY + 1, this.curTarget.z)
  }

  private clampTarget(): void {
    this.target.x = clamp(this.target.x, -WORLD.width / 2 - 10, WORLD.width / 2 + 10)
    this.target.z = clamp(this.target.z, -WORLD.depth / 2 - 10, WORLD.depth / 2 + 30)
  }

  /** Camera pos + facing for the audio listener. */
  listenerPose(): { x: number; y: number; z: number; yaw: number } {
    return { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: this.curYaw }
  }
}

/**
 * Precise ray→heightfield intersection by ray-marching with bisection refine.
 * Used for placement/selection cursor (cheaper + truer than mesh raycast).
 */
export function rayGround(
  camera: THREE.PerspectiveCamera, ndcX: number, ndcY: number, terrain: Terrain,
  out: THREE.Vector3,
): boolean {
  const origin = camera.position
  const dir = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(origin).normalize()
  let t = 0
  const maxT = 900
  const step = 4
  let prevT = 0
  let prevAbove = true
  for (t = 2; t < maxT; t += step) {
    const x = origin.x + dir.x * t
    const z = origin.z + dir.z * t
    const y = origin.y + dir.y * t
    const above = y > terrain.heightAt(x, z)
    if (!above) {
      // Bisect between prevT and t.
      let lo = prevT, hi = t
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2
        const my = origin.y + dir.y * mid
        const mx = origin.x + dir.x * mid
        const mz = origin.z + dir.z * mid
        if (my > terrain.heightAt(mx, mz)) lo = mid
        else hi = mid
      }
      const ft = (lo + hi) / 2
      out.set(origin.x + dir.x * ft, origin.y + dir.y * ft, origin.z + dir.z * ft)
      return true
    }
    prevT = t
    prevAbove = above
    void prevAbove
  }
  return false
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
