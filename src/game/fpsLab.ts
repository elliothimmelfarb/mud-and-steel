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
import type { Enemy, UnitKindId } from '../core/types'
import { makeSquad, updateEnemies } from '../sim/enemies'
import { killSoldier } from '../sim/combat'
import { planWave } from '../sim/waves'
import { intelFlavor } from '../core/flavor'
import { mulberry32 } from '../core/rng'

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
  /** Headless probe: spawn a squad in the contact zone, step the sim, and
   *  report the bounding-overwatch rhythm and the NCO-death morale shock.
   *  Deterministic (seeded rng). Logs a summary and returns it. */
  tactics(): TacticsProbe
  /** Headless probe: seed the director's damage ledger with a category and
   *  confirm the next wave plan telegraphs a concrete adaptation. */
  director(category?: string): DirectorProbe
}

export interface DirectorProbe {
  /** The damage category the player has been leaning on. */
  category: string
  /** The plain-language telegraph carried on the plan (null if none). */
  adaptation: string | null
  /** The staff-officer intel line the player actually reads. */
  intelLine: string
}

export interface TacticsProbe {
  members: number
  /** How many times the moving element swapped over the run (>=2 ⇒ leapfrogging). */
  boundSwaps: number
  /** Ticks in which exactly one element was on overwatch while the other moved. */
  splitTicks: number
  /** True if at every bounding tick the overwatch men were the non-moving element. */
  elementsComplementary: boolean
  ncoBefore: number
  /** Squadmate morale drop the instant the NCO was cut down (expect a clear dip). */
  ncoMoraleDrop: number
  ncoSuppressBump: number
  /** True once the squad promoted a fresh NCO after the leader fell. */
  promotedNewLeader: boolean
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
    tactics: () => runTacticsProbe(game),
    director: (category = 'mg') => runDirectorProbe(game, category),
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

/**
 * Drive the squad tactics purely in the sim (no rendering) and report the
 * observable behaviours: the leapfrog rhythm and the NCO-death shock. Used to
 * capture hard evidence that the new AI does what it claims.
 */
function runTacticsProbe(game: Game): TacticsProbe {
  const ctx = game.ctx
  const s = ctx.s
  // Clean slate.
  s.enemies.length = 0
  s.squads.length = 0

  // A section of eight riflemen, dropped into the contact zone (within fire
  // range of the front trench) so the bound engages immediately.
  const sq = makeSquad(ctx, new Array(8).fill('einf'), 0, s.sections.find((se) => se.line === 'front')?.id ?? 0)
  const membersOf = (): Enemy[] => s.enemies.filter((e) => e.squadId === sq.id && e.hp > 0)
  for (const m of membersOf()) {
    m.pos.z = 40 + (ctx.rand() - 0.5) * 4   // north of the trench (z=80), inside the contact band
    m.pos.x = (ctx.rand() - 0.5) * 10
    m.behavior = 'advance'
  }

  const dt = 1 / 30
  let boundSwaps = 0
  let splitTicks = 0
  let elementsComplementary = true
  let prevMove = sq.moveElement
  for (let t = 0; t < 360; t++) {   // 12 seconds
    updateEnemies(ctx, dt)
    if (!sq.bounding) continue
    if (sq.moveElement !== prevMove) { boundSwaps++; prevMove = sq.moveElement }
    const mem = membersOf()
    const movers = mem.filter((m) => m.bounding && !m.overwatch)
    const watch = mem.filter((m) => m.bounding && m.overwatch)
    if (movers.length > 0 && watch.length > 0) splitTicks++
    // Every man on overwatch must belong to the non-moving element.
    for (const m of watch) if (m.element === sq.moveElement) elementsComplementary = false
  }

  // NCO-death shock: cut the leader down and measure the section's reaction.
  const leaderId = sq.leaderId
  const leader = s.enemies.find((e) => e.id === leaderId && e.hp > 0)
  const others = () => s.enemies.filter((e) => e.squadId === sq.id && e.id !== leaderId && e.hp > 0)
  const avg = (f: (e: Enemy) => number) => {
    const g = others(); return g.length ? g.reduce((a, e) => a + f(e), 0) / g.length : 0
  }
  const moraleBefore = avg((e) => e.morale)
  const suppressBefore = avg((e) => e.suppression)
  if (leader) killSoldier(ctx, leader, 'brit', -1)
  const moraleDrop = moraleBefore - avg((e) => e.morale)
  const suppressBump = avg((e) => e.suppression) - suppressBefore
  updateEnemies(ctx, dt) // let the promotion run
  const promotedNewLeader = sq.leaderId !== leaderId && sq.leaderId !== -1

  const result: TacticsProbe = {
    members: 8,
    boundSwaps,
    splitTicks,
    elementsComplementary,
    ncoBefore: leaderId,
    ncoMoraleDrop: Math.round(moraleDrop * 1000) / 1000,
    ncoSuppressBump: Math.round(suppressBump * 1000) / 1000,
    promotedNewLeader,
  }
  // eslint-disable-next-line no-console
  console.log('[tactics probe]', JSON.stringify(result))
  // Clean up so the sandbox field is left as we found it.
  s.enemies.length = 0
  s.squads.length = 0
  return result
}

/**
 * Feed the director a lopsided damage ledger (as if the player had been
 * mowing men down with a given weapon) and confirm the next plan telegraphs a
 * concrete counter. Restores the real ledger afterwards.
 */
function runDirectorProbe(game: Game, category: string): DirectorProbe {
  const ctx = game.ctx
  const saved = ctx.s.director.dmgByCategory
  ctx.s.director.dmgByCategory = { [category]: 5000 }
  // A fresh seeded stream so the probe is reproducible and never disturbs the
  // run's own wave rng.
  const rand = mulberry32(0xC0FFEE)
  const plan = planWave(ctx, 12, 'front', rand)
  ctx.s.director.dmgByCategory = saved
  const result: DirectorProbe = {
    category,
    adaptation: plan.adaptation,
    intelLine: intelFlavor(plan.intent, mulberry32(0x1916)),
  }
  // eslint-disable-next-line no-console
  console.log('[director probe]', JSON.stringify(result))
  return result
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
