/**
 * FPS Lab — a dev-only verification harness for first-person mode.
 *
 * Enabled with `?fpslab` on the URL. It skips the title/briefing, drops you on
 * a live battlefield in build phase, and gives a floating panel that embodies
 * any weapon or emplacement in one click — no build economy, no pointer lock.
 *
 * Every control also hangs off `window.__fpslab` so a screenshot script can
 * cycle weapons, aim, fire, and freeze the muzzle flash to inspect placement:
 *
 *   __fpslab.enter('vickers'); __fpslab.look(0,-0.05); __fpslab.freezeFlash(true)
 *
 * None of this ships in a normal boot — main.ts only imports it behind the flag.
 */
import type { Game } from './game'
import type { UnitKindId } from '../core/types'

interface LabWeapon { kind: UnitKindId; label: string }

const WEAPONS: LabWeapon[] = [
  { kind: 'rifleman', label: 'Rifleman' },
  { kind: 'officer', label: 'Officer · Webley' },
  { kind: 'sniper', label: 'Sniper (scope)' },
  { kind: 'lewis', label: 'Lewis Gun' },
  { kind: 'vickers', label: 'Vickers (emplaced)' },
  { kind: 'grenadier', label: 'Bomber' },
  { kind: 'flamer', label: 'Flame Projector' },
  { kind: 'mortar', label: 'Stokes Mortar (emplaced)' },
  { kind: 'fieldgun', label: '18-Pounder (emplaced)' },
  { kind: 'gasproj', label: 'Livens Projector (emplaced)' },
  { kind: 'medic', label: 'Stretcher Bearer' },
  { kind: 'engineer', label: 'Sapper' },
]

export interface FpsLabApi {
  enter(kind: UnitKindId): boolean
  fire(): void
  hold(on: boolean): void
  ads(on: boolean): void
  look(yaw: number, pitch: number): void
  stance(st: 'stand' | 'crouch' | 'prone'): void
  freezeFlash(on: boolean): void
  targets(count?: number, range?: number): void
  /** Pin the embodied man's hp so a test run isn't cut short by German fire.
   *  Omit the argument to toggle; returns the resulting state. Default: on. */
  invincible(on?: boolean): boolean
  /** Wipe every enemy off the field for undisturbed inspection. */
  clearFoes(): void
  /** Turntable: float the current weapon out front to examine from every angle.
   *  Omit the argument to toggle; returns the resulting state. */
  inspect(on?: boolean): boolean
  /** Nudge the turntable orientation (radians): +yaw spins right, +pitch tips up. */
  rotate(dYaw: number, dPitch?: number): void
  /** Auto-spin the turntable so every side comes round on its own. */
  spin(on: boolean): void
  /** Dolly the inspected model nearer (−) or further (+). */
  zoomModel(dz: number): void
  list(): LabWeapon[]
  current(): string
}

export function startFpsLab(game: Game): void {
  // A fixed seed keeps the test field identical across reloads.
  game.startRun('fpslab', 'front')

  // Dismiss the intel briefing the moment it mounts, then hold build phase open
  // indefinitely so the sandbox never times out into an assault on its own.
  let dismissed = false
  const dismiss = (): void => {
    const btn = document.querySelector('.intel-begin') as HTMLElement | null
    if (btn) { btn.click(); dismissed = true }
    if (!dismissed) { requestAnimationFrame(dismiss); return }
    game.ctx.s.buildTimer = 1e9
  }
  requestAnimationFrame(dismiss)

  // Keep the embodied man on his feet so a test session isn't cut short by the
  // German rifles downrange. On by default. The actual pin lives inside
  // FpsMode.update() (game.fpsMode.debugInvincible), BEFORE the death check —
  // ordering-proof, so unlike the old separate-rAF pin even a one-shot that
  // dropped hp to 0 can't slip a death through. Toggle it OFF to exercise damage
  // feedback (hurt vignette / directional hits).
  game.fpsMode.debugInvincible = true

  const api: FpsLabApi = {
    enter: (kind) => game.debugPossessKind(kind),
    fire: () => game.fpsMode.debugFire(),
    hold: (on) => game.fpsMode.debugHold(on),
    ads: (on) => game.fpsMode.debugAds(on),
    look: (yaw, pitch) => game.fpsMode.debugLook(yaw, pitch),
    stance: (st) => game.fpsMode.debugStance(st),
    freezeFlash: (on) => game.fpsMode.debugFreezeFlash(on),
    targets: (count, range) => game.debugSpawnTargets(count, range),
    invincible: (on) => {
      const v = on === undefined ? !game.fpsMode.debugInvincible : on
      game.fpsMode.debugInvincible = v
      return v
    },
    clearFoes: () => { game.ctx.s.enemies.length = 0 },
    inspect: (on) => {
      const v = on === undefined ? !game.fpsMode.debugInspectActive() : on
      game.fpsMode.debugInspectMode(v)
      return v
    },
    rotate: (dYaw, dPitch) => game.fpsMode.debugInspectRotate(dYaw, dPitch ?? 0),
    spin: (on) => game.fpsMode.debugInspectSpin(on),
    zoomModel: (dz) => game.fpsMode.debugInspectZoom(dz),
    list: () => WEAPONS.slice(),
    current: () => game.fpsMode.debugName,
  }
  ;(window as unknown as { __fpslab: FpsLabApi }).__fpslab = api

  const panel = buildPanel(game, api)

  // Deep-link: ?fpslab&w=<kind>[&inspect][&spin] boots straight into a weapon
  // (optionally on the turntable). Survives dev-server reloads, so a screenshot
  // pass always lands in the same state without a scripted enter() afterwards.
  // Drives the panel setters (not the api directly) so the buttons/pad stay in
  // sync with the turntable state.
  const q = new URLSearchParams(location.search)
  const autoKind = q.get('w') as UnitKindId | null
  if (autoKind && WEAPONS.some((w) => w.kind === autoKind)) {
    const tryAuto = (): void => {
      if (game.modalOpen) { requestAnimationFrame(tryAuto); return } // wait out the briefing
      if (!api.enter(autoKind)) { requestAnimationFrame(tryAuto); return }
      if (q.has('inspect')) panel.setInspect(true)
      if (q.has('spin')) panel.setSpin(true)
    }
    requestAnimationFrame(tryAuto)
  }

  // eslint-disable-next-line no-console
  console.log('[FPS Lab] ready — window.__fpslab. Weapons:', WEAPONS.map((w) => w.kind).join(', '))
}

function buildPanel(game: Game, api: FpsLabApi): { setInspect: (on: boolean) => void; setSpin: (on: boolean) => void } {
  const panel = document.createElement('div')
  panel.setAttribute('data-fpslab', '') // FpsMode lets clicks on this through
  panel.style.cssText =
    'position:fixed;top:10px;left:10px;z-index:9999;width:186px;padding:9px;' +
    'background:rgba(18,16,12,0.86);border:1px solid #5a5038;border-radius:6px;' +
    'font:11px/1.35 ui-monospace,Menlo,monospace;color:#e8e0c8;' +
    'box-shadow:0 6px 20px rgba(0,0,0,0.5);backdrop-filter:blur(3px)'

  const title = document.createElement('div')
  title.textContent = 'FPS LAB'
  title.style.cssText = 'font-weight:bold;letter-spacing:0.18em;margin-bottom:7px;color:#e0a94a'
  panel.appendChild(title)

  const grid = document.createElement('div')
  grid.style.cssText = 'display:grid;grid-template-columns:1fr;gap:3px'
  const btns: HTMLButtonElement[] = []
  const mkBtn = (label: string, cb: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText =
      'text-align:left;padding:4px 6px;background:#2a2519;color:#e8e0c8;' +
      'border:1px solid #4a4130;border-radius:4px;cursor:pointer;font:inherit'
    b.onmouseenter = () => { b.style.background = '#3a3320' }
    b.onmouseleave = () => { if (!b.dataset.active) b.style.background = '#2a2519' }
    b.onclick = cb
    return b
  }

  for (const w of WEAPONS) {
    const b = mkBtn(w.label, () => {
      if (!api.enter(w.kind)) return
      for (const other of btns) { delete other.dataset.active; other.style.background = '#2a2519' }
      b.dataset.active = '1'
      b.style.background = '#5a4a1e'
    })
    btns.push(b)
    grid.appendChild(b)
  }
  panel.appendChild(grid)

  const tools = document.createElement('div')
  tools.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-top:7px'
  const flashHeld = { on: false }
  // Invincibility is ON by default (see startFpsLab), so seed the button lit.
  const invBtn = mkBtn('Invincible ✓', () => {
    const on = api.invincible()
    invBtn.textContent = on ? 'Invincible ✓' : 'Invincible ✗'
    if (on) { invBtn.dataset.active = '1'; invBtn.style.background = '#2f4a24' }
    else { delete invBtn.dataset.active; invBtn.style.background = '#2a2519' }
  })
  invBtn.dataset.active = '1'
  invBtn.style.background = '#2f4a24'
  // Turntable inspect: float the current weapon out front and spin it. The pad
  // + Spin button appear once Inspect is lit.
  // Inspect/Spin state lives in these setters so BOTH the panel buttons AND the
  // deep-link (?inspect/?spin) drive the same path — the engine flag, the button
  // lit state and the drag-pad visibility never desync, and clicking a button is
  // always an explicit set (no blind toggle that could invert after a deep-link).
  const inspectState = { on: false, spin: false }
  const setInspectBtn = (b: HTMLButtonElement, on: boolean, label: string, lit: string): void => {
    b.textContent = on ? `${label} ✓` : label
    if (on) { b.dataset.active = '1'; b.style.background = lit } else { delete b.dataset.active; b.style.background = '#2a2519' }
  }
  const spinBtn = mkBtn('Spin', () => setSpin(!inspectState.spin))
  const inspectBtn = mkBtn('Inspect', () => setInspect(!inspectState.on))
  function setInspect(on: boolean): void {
    inspectState.on = on
    api.inspect(on)
    setInspectBtn(inspectBtn, on, 'Inspect', '#3a4a5a')
    pad.style.display = on ? 'flex' : 'none'
  }
  function setSpin(on: boolean): void {
    inspectState.spin = on
    api.spin(on)
    setInspectBtn(spinBtn, on, 'Spin', '#4a3a1e')
  }

  tools.append(
    mkBtn('Fire', () => api.fire()),
    mkBtn('Targets', () => api.targets(8, 70)),
    mkBtn('Flash❄', () => { flashHeld.on = !flashHeld.on; api.freezeFlash(flashHeld.on) }),
    invBtn,
    mkBtn('Clear foes', () => api.clearFoes()),
    inspectBtn,
    spinBtn,
  )
  panel.appendChild(tools)

  // Drag-to-rotate / scroll-to-zoom pad (data-fpslab, so FpsMode lets its events
  // through rather than treating them as mouselook/trigger).
  const pad = document.createElement('div')
  pad.setAttribute('data-fpslab', '')
  pad.style.cssText =
    'display:none;align-items:center;justify-content:center;text-align:center;' +
    'margin-top:7px;height:56px;border:1px dashed #5a5038;border-radius:5px;' +
    'background:rgba(58,74,90,0.18);color:#c9c0a4;font-size:10px;cursor:grab;user-select:none;touch-action:none'
  pad.textContent = 'drag to rotate · scroll to zoom'
  const drag = { on: false, x: 0, y: 0 }
  pad.addEventListener('pointerdown', (e) => {
    drag.on = true; drag.x = e.clientX; drag.y = e.clientY
    pad.setPointerCapture(e.pointerId); pad.style.cursor = 'grabbing'
  })
  pad.addEventListener('pointermove', (e) => {
    if (!drag.on) return
    api.rotate((e.clientX - drag.x) * 0.012, -(e.clientY - drag.y) * 0.012)
    drag.x = e.clientX; drag.y = e.clientY
  })
  const endDrag = (e: PointerEvent): void => { drag.on = false; pad.style.cursor = 'grab'; try { pad.releasePointerCapture(e.pointerId) } catch { /* ignore */ } }
  pad.addEventListener('pointerup', endDrag)
  pad.addEventListener('pointercancel', endDrag)
  pad.addEventListener('wheel', (e) => { e.preventDefault(); api.zoomModel(e.deltaY > 0 ? 0.09 : -0.09) }, { passive: false })
  panel.appendChild(pad)

  const hint = document.createElement('div')
  hint.style.cssText = 'margin-top:7px;opacity:0.6;font-size:10px'
  hint.textContent = 'WASD move · mouse look · LMB fire · RMB aim · window.__fpslab'
  panel.appendChild(hint)

  document.body.appendChild(panel)
  void game
  return { setInspect, setSpin }
}
