/**
 * In-game HUD: build bar, orders, top strip (requisition/wave/breach/weather),
 * unit panel, stores (upgrades), toasts, banners, tips — plus the bridge to
 * the overlay screens (intel, letters, pause, game over).
 * Fully mouse- or keyboard-operable.
 */
import type { BuildableId, DefenceKindId, UnitKindId } from '../core/types'
import {
  BUILD_ORDER, DEEDS, DEFENCE_DEFS, ECONOMY, ORDER_DEFS, RANKS, UNIT_DEFS, UPGRADE_DEFS,
} from '../core/config'
import type { OrderDef } from '../core/config'
import { keyLabel, type Action } from '../render/controls'
import type { Game, HudBridge, IntelData, OrderId } from '../game/game'
import {
  createGameOverScreen, createHelpOverlay, createIntelReport, createLetterOverlay,
  createPauseMenu, createSettingsPanel, type SettingsGroup,
} from './screens'
import { defaultSettings, highScore, saveSettings } from '../core/save'

const BUILD_ICONS: Record<BuildableId, string> = {
  rifleman: 'R', lewis: 'LG', vickers: 'MG', sniper: 'SN', grenadier: 'GR', mortar: 'MT',
  fieldgun: '18', flamer: 'FP', medic: '+', officer: 'OF', engineer: 'SP', gasproj: 'GS',
  wire: '✕', mine: '●', sandbags: '▦', tanktrap: '▲', searchlight: '☀', flarepost: '✦',
}

const ORDER_LIST: OrderId[] = ['takecover', 'rapidfire', 'bayonets', 'masks', 'flare', 'barrage', 'marktank']
const ORDER_ACTION: Record<OrderId, Action> = {
  takecover: 'orderCover', rapidfire: 'orderRapid', bayonets: 'orderBayonets',
  masks: 'orderMasks', flare: 'orderFlare', barrage: 'orderBarrage', marktank: 'orderTank',
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export class Hud implements HudBridge {
  private root: HTMLDivElement
  private topInfo!: { req: HTMLElement; wave: HTMLElement; date: HTMLElement; enemies: HTMLElement; timerBtn: HTMLButtonElement; breach: HTMLElement; breachBar: HTMLElement; weather: HTMLElement; vane: HTMLElement; needle: HTMLElement; windCap: HTMLElement; fps: HTMLElement; speedBtns: HTMLButtonElement[]; pauseBtn: HTMLButtonElement }
  private cards = new Map<BuildableId, { root: HTMLButtonElement; cost: HTMLElement }>()
  private orderBtns = new Map<OrderId, { root: HTMLButtonElement; fill: HTMLElement }>()
  private unitPanel!: HTMLElement
  private toastBox!: HTMLElement
  private bannerEl!: HTMLElement
  private tipEl!: HTMLElement
  private tooltip!: HTMLElement
  private tooltipFor: HTMLElement | null = null
  private tooltipBuild: (() => HTMLElement) | null = null
  private shopEl: HTMLElement | null = null
  private overlay: { el: HTMLElement; dispose: () => void } | null = null
  private shownTips = new Set<string>(JSON.parse(localStorage.getItem('mudsteel.tips') ?? '[]') as string[])
  private bannerT = 0
  onQuitToTitle: (() => void) | null = null

  constructor(private game: Game, parent: HTMLElement) {
    this.root = el('div')
    this.root.className = 'ui-scaled'
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;'
    parent.appendChild(this.root)
    this.buildTop()
    this.buildBottom()
    this.buildUnitPanel()
    this.toastBox = el('div')
    this.toastBox.style.cssText = 'position:absolute;top:64px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;'
    this.root.appendChild(this.toastBox)
    this.bannerEl = el('div', 'wave-banner')
    this.bannerEl.style.display = 'none'
    this.root.appendChild(this.bannerEl)
    this.tipEl = el('div', 'hud-tip')
    this.tipEl.style.display = 'none'
    this.root.appendChild(this.tipEl)
    this.tooltip = el('div', 'ms-tooltip hud-tooltip')
    this.tooltip.style.display = 'none'
    this.tooltip.setAttribute('role', 'tooltip')
    this.root.appendChild(this.tooltip)
    game.hud = this
  }

  // -------------------------------------------------------------------------
  // Rich hover/focus tooltips (period-styled field cards)
  // -------------------------------------------------------------------------

  /** Wire a target so hovering or focusing it raises a briefing tooltip. */
  private attachTip(target: HTMLElement, build: () => HTMLElement): void {
    const show = (): void => {
      this.tooltipFor = target
      this.tooltipBuild = build
      this.renderTooltip()
    }
    const hide = (): void => {
      if (this.tooltipFor !== target) return
      this.tooltipFor = null
      this.tooltipBuild = null
      this.tooltip.style.display = 'none'
    }
    target.addEventListener('mouseenter', show)
    target.addEventListener('mouseleave', hide)
    target.addEventListener('focus', show)
    target.addEventListener('blur', hide)
  }

  /** (Re)build and position the live tooltip against its current target. */
  private renderTooltip(): void {
    if (!this.tooltipFor || !this.tooltipBuild) return
    const t = this.tooltip
    t.textContent = ''
    t.appendChild(this.tooltipBuild())
    t.style.display = ''
    // Measure, then clamp to the viewport and aim the arrow at the target.
    const r = this.tooltipFor.getBoundingClientRect()
    const tw = t.offsetWidth
    const half = tw / 2
    const margin = 8
    const center = r.left + r.width / 2
    const left = Math.max(half + margin, Math.min(window.innerWidth - half - margin, center))
    t.style.left = `${left}px`
    t.style.top = `${r.top - 12}px`
    t.style.setProperty('--tip-arrow', `${Math.max(12, Math.min(tw - 12, center - (left - half)))}px`)
  }

  // -------------------------------------------------------------------------
  // DOM construction
  // -------------------------------------------------------------------------

  private buildTop(): void {
    const top = el('div', 'hud-top')
    top.style.pointerEvents = 'auto'

    const left = el('div')
    left.style.cssText = 'display:flex;gap:10px;align-items:center;'
    const req = el('span', 'ms-chip ms-chip--req', '£0')
    req.title = 'Requisition — earn it holding the line, spend it on men and stores'
    const wave = el('span', 'ms-chip', 'WAVE 1')
    const date = el('span', 'ms-chip', '')
    const enemies = el('span', 'ms-chip', '')
    left.append(req, wave, date, enemies)

    const mid = el('div')
    mid.style.cssText = 'display:flex;gap:10px;align-items:center;flex:1;justify-content:center;'
    const breachWrap = el('div', 'hud-line')
    breachWrap.title = 'The line — enemies breaking through past your support trench drain it'
    breachWrap.append(el('span', 'ms-chip', 'THE LINE'))
    const breachBar = el('div', 'ms-bar ms-bar--hp hud-line__bar')
    const breachFill = el('div', 'ms-bar__fill')
    breachBar.appendChild(breachFill)
    breachWrap.appendChild(breachBar)
    const timerBtn = el('button', 'ms-btn ms-btn--primary ms-btn--small hud-advance', 'SOUND THE ADVANCE')
    timerBtn.title = 'Skip the remaining build time for bonus requisition'
    timerBtn.append(el('span', 'ms-kbd', keyLabel(this.game.input.bindFor('callWave'))))
    timerBtn.addEventListener('click', () => { this.game.callWaveEarly(); timerBtn.blur() })
    mid.append(breachWrap, timerBtn)

    const right = el('div')
    right.style.cssText = 'display:flex;gap:8px;align-items:center;'
    const weather = el('span', 'ms-chip', '')
    const vane = el('div', 'wind-vane')
    vane.title = 'Wind — gas drifts with it. Red means it blows toward YOUR line.'
    const needle = el('div', 'wind-vane__needle')
    vane.appendChild(needle)
    const windCap = el('div', 'wind-cap')
    windCap.style.display = 'none'
    vane.appendChild(windCap)
    const speedBtns: HTMLButtonElement[] = []
    for (const s of [1, 2, 4] as const) {
      const b = el('button', 'ms-btn ms-btn--ghost ms-btn--small', `${s}×`)
      b.addEventListener('click', () => { this.game.speed = s; b.blur() })
      speedBtns.push(b)
      right.appendChild(b)
    }
    const pauseBtn = el('button', 'ms-btn ms-btn--ghost ms-btn--small', 'II')
    pauseBtn.title = `Pause (${keyLabel(this.game.input.bindFor('pause'))})`
    pauseBtn.addEventListener('click', () => { this.game.paused = !this.game.paused; pauseBtn.blur() })
    const menuBtn = el('button', 'ms-btn ms-btn--ghost ms-btn--small', '☰')
    menuBtn.addEventListener('click', () => { this.openPause(); menuBtn.blur() })
    const fps = el('span', 'hud-fps', '')
    right.append(weather, vane, pauseBtn, menuBtn, fps)

    top.append(left, mid, right)
    this.root.appendChild(top)
    this.topInfo = { req, wave, date, enemies, timerBtn, breach: breachFill, breachBar, weather, vane, needle, windCap, fps, speedBtns, pauseBtn }
  }

  private buildBottom(): void {
    const bottom = el('div', 'hud-bottom')
    bottom.style.pointerEvents = 'auto'

    // Orders row.
    const orders = el('div', 'hud-orders')
    for (const id of ORDER_LIST) {
      const def = ORDER_DEFS[id]
      const b = el('button', 'ms-btn ms-btn--small')
      b.style.position = 'relative'
      b.setAttribute('aria-label', `${def.name} order`)
      const label = el('span', undefined, def.name)
      const kbd = el('span', 'ms-kbd', keyLabel(this.game.input.bindFor(ORDER_ACTION[id])))
      const fill = el('div')
      fill.style.cssText = 'position:absolute;left:0;bottom:0;height:3px;background:var(--brass,#a08a4f);width:0%;'
      b.append(label, kbd, fill)
      b.addEventListener('click', () => { this.game.issueOrder(id); b.blur() })
      this.attachTip(b, () => orderTip(def, this.game.input.bindFor(ORDER_ACTION[id])))
      orders.appendChild(b)
      this.orderBtns.set(id, { root: b, fill })
    }
    const storesBtn = el('button', 'ms-btn ms-btn--primary ms-btn--small', 'STORES')
    storesBtn.addEventListener('click', () => { this.toggleShop(); storesBtn.blur() })
    this.attachTip(storesBtn, () => tipCard('STORES', null,
      'Divisional stores — spend requisition between waves on new kit and doctrine.', []))
    orders.appendChild(storesBtn)
    bottom.appendChild(orders)

    // Build bar — grouped into the company (men) and field works (defences),
    // each row wrapping so every card stays reachable at any window width.
    const bar = el('div', 'hud-buildbar')
    const groups: Array<{ label: string; from: number; to: number }> = [
      { label: 'THE COMPANY', from: 0, to: 12 },
      { label: 'FIELD WORKS', from: 12, to: BUILD_ORDER.length },
    ]
    for (const grp of groups) {
      const group = el('div', 'hud-buildgroup')
      group.appendChild(el('span', 'hud-buildgroup__label', grp.label))
      const row = el('div', 'hud-buildgroup__row')
      for (let i = grp.from; i < grp.to; i++) {
        const id = BUILD_ORDER[i]
        const def = this.game.isUnitKind(id) ? UNIT_DEFS[id as UnitKindId] : DEFENCE_DEFS[id as DefenceKindId]
        const card = el('button', 'hud-card')
        const action: Action = i < 12 ? (`build${i + 1}` as Action) : (`buildD${i - 11}` as Action)
        card.setAttribute('aria-label', `${def.name}, £${def.cost}`)
        const icon = el('span', 'hud-card__icon', BUILD_ICONS[id])
        const name = el('span', 'hud-card__name', def.name)
        const cost = el('span', 'hud-card__cost', `£${this.game.costOf(id)}`)
        const kbd = el('span', 'ms-kbd', keyLabel(this.game.input.bindFor(action)))
        card.append(icon, name, cost, kbd)
        card.addEventListener('click', () => {
          this.game.setBuildSelection(this.game.buildSelection === id ? null : id)
          card.blur()
        })
        this.attachTip(card, () => this.buildTip(id))
        row.appendChild(card)
        this.cards.set(id, { root: card, cost })
      }
      group.appendChild(row)
      bar.appendChild(group)
    }
    bottom.appendChild(bar)
    this.root.appendChild(bottom)
  }

  /** Briefing tooltip for a placeable unit or defence: role, reach, crew, cost. */
  private buildTip(id: BuildableId): HTMLElement {
    const g = this.game
    const s = g.ctx.s
    const isUnit = g.isUnitKind(id)
    const cost = g.costOf(id)
    const stats: Array<[string, string]> = []
    if (isUnit) {
      const def = UNIT_DEFS[id as UnitKindId]
      stats.push(['Post', placementLabel(def.placement)])
      if (def.range >= 20 && def.damage > 0) stats.push(['Reach', reachLabel(def.range)])
      if (def.crew > 1) stats.push(['Crew', `${def.crew} men`])
      if (def.aoe > 0) stats.push(['Effect', 'area blast'])
      const node = tipCard(def.name, cost, def.blurb, stats)
      this.appendAffordNote(node, id, cost, s.req, false)
      return node
    }
    const def = DEFENCE_DEFS[id as DefenceKindId]
    stats.push(['Lay in', placementLabel(def.placement)])
    const fieldLocked = def.placement === 'field' && !g.fieldBuildAllowed()
    const node = tipCard(def.name, cost, def.blurb, stats)
    this.appendAffordNote(node, id, cost, s.req, fieldLocked)
    return node
  }

  private appendAffordNote(node: HTMLElement, _id: BuildableId, cost: number, req: number, fieldLocked: boolean): void {
    if (fieldLocked) {
      node.appendChild(el('div', 'tip__note', 'Laid in no-man\'s-land — between waves only.'))
    } else if (req < cost) {
      node.appendChild(el('div', 'tip__note tip__note--warn', `Short by £${cost - req}.`))
    }
  }

  private buildUnitPanel(): void {
    this.unitPanel = el('div', 'hud-unitpanel')
    this.unitPanel.style.pointerEvents = 'auto'
    this.unitPanel.style.display = 'none'
    this.root.appendChild(this.unitPanel)
  }

  // -------------------------------------------------------------------------
  // Per-frame refresh
  // -------------------------------------------------------------------------

  update(dt: number): void {
    const g = this.game
    if (!g.ctx) return
    const s = g.ctx.s
    const t = this.topInfo

    t.req.textContent = `£${s.req}`
    t.wave.textContent = `WAVE ${s.wave}`
    t.date.textContent = fieldDateShort(s.wave)
    t.enemies.textContent = s.phase === 'assault'
      ? `${s.enemies.length + s.vehicles.filter((v) => v.team === 'german' && !v.dead).length} in the open`
      : s.phase === 'build' ? `stand-to in ${Math.ceil(s.buildTimer)}s` : ''
    t.timerBtn.style.display = s.phase === 'build' ? '' : 'none'
    const lineFrac = Math.max(0, Math.min(1, s.breach / 100))
    t.breach.style.width = `${lineFrac * 100}%`
    t.breachBar.classList.toggle('hud-line__bar--warn', lineFrac <= 0.5 && lineFrac > 0.25)
    t.breachBar.classList.toggle('hud-line__bar--danger', lineFrac <= 0.25)

    const w = g.weather.state
    const wi = g.weather.windInfo()
    const parts: string[] = []
    parts.push(w.night ? 'NIGHT' : timeLabel(w.tod))
    if (w.rain > 0.4) parts.push('RAIN')
    else if (w.fog > 0.4) parts.push('FOG')
    if (s.masksOn) parts.push('MASKED')
    t.weather.textContent = parts.join(' · ')
    t.needle.style.transform = `rotate(${wi.angle + Math.PI}rad)`
    t.needle.style.background = wi.blowsTowardPlayer ? 'var(--blood,#7a2e22)' : ''
    // Gas serves whichever side the wind favours — flag a blow-back home.
    t.vane.classList.toggle('wind-vane--danger', wi.blowsTowardPlayer)
    const gasHome = wi.blowsTowardPlayer && s.masksOn
    t.windCap.style.display = gasHome ? '' : 'none'
    if (gasHome) t.windCap.textContent = 'GAS HOME'
    t.fps.textContent = g.settings.showFps ? `${Math.round(g.fps)} fps` : ''
    for (let i = 0; i < t.speedBtns.length; i++) {
      const sp = [1, 2, 4][i]
      t.speedBtns[i].classList.toggle('ms-btn--primary', g.speed === sp && !g.paused)
    }
    t.pauseBtn.classList.toggle('ms-btn--primary', g.paused)

    // Build cards — distinguish "can't afford yet" from "wrong phase to lay".
    for (const [id, card] of this.cards) {
      const cost = g.costOf(id)
      card.cost.textContent = `£${cost}`
      const fieldLocked = !g.isUnitKind(id) &&
        DEFENCE_DEFS[id as DefenceKindId].placement === 'field' && !g.fieldBuildAllowed()
      const poor = !fieldLocked && s.req < cost
      card.root.classList.toggle('hud-card--selected', g.buildSelection === id)
      card.root.classList.toggle('hud-card--locked', fieldLocked)
      card.root.classList.toggle('hud-card--poor', poor)
      card.root.classList.toggle('hud-card--disabled', fieldLocked || poor)
    }

    // Orders.
    for (const [id, o] of this.orderBtns) {
      const def = ORDER_DEFS[id]
      const gated = def.needsUpgrade && !s.upgrades.has(def.needsUpgrade)
      o.root.style.display = gated ? 'none' : ''
      if (gated) continue
      const ready = g.orderReady(id)
      o.root.classList.toggle('ms-btn--ghost', !ready)
      if (id === 'masks') {
        o.root.classList.toggle('ms-btn--primary', s.masksOn)
        o.fill.style.width = '0%'
      } else {
        const cdKey = id as keyof typeof s.orders.cooldowns
        const max = def.cooldown || 1
        o.fill.style.width = `${(1 - s.orders.cooldowns[cdKey] / max) * 100}%`
      }
    }

    // Unit panel.
    const sel = g.selectedInfo()
    if (sel) {
      this.unitPanel.style.display = ''
      this.renderUnitPanel(sel)
    } else {
      this.unitPanel.style.display = 'none'
      this.lastSelId = -1
    }

    // Banner fade.
    if (this.bannerT > 0) {
      this.bannerT -= dt
      if (this.bannerT <= 0) this.bannerEl.style.display = 'none'
    }

    // Keep a hovered card's affordability note honest as requisition changes.
    if (this.tooltipFor && this.tooltip.style.display !== 'none') this.renderTooltip()

    this.maybeTip(s.phase, s.wave)
  }

  private lastSelId = -1
  private renderUnitPanel(sel: NonNullable<ReturnType<Game['selectedInfo']>>): void {
    // Rebuild only when the selected unit changes; update bars every frame.
    if (sel.unitId !== this.lastSelId) {
      this.lastSelId = sel.unitId
      this.unitPanel.textContent = ''
      const def = UNIT_DEFS[sel.kind]
      const head = el('div', 'unit-name', `${sel.rank} ${sel.name}`)
      const subBits = [def.name]
      if (sel.vet > 0) subBits.push('★'.repeat(sel.vet))
      subBits.push(`${sel.kills} ${sel.kills === 1 ? 'kill' : 'kills'}`)
      const sub = el('div', 'unit-sub', subBits.join(' · '))

      // Service & citations for the named man — the veterancy surface.
      const svcBits: string[] = []
      if (sel.wavesServed > 0) svcBits.push(`${sel.wavesServed} wave${sel.wavesServed === 1 ? '' : 's'} served`)
      if (sel.rankProgress !== null && sel.vet < 3) svcBits.push(`${Math.round(sel.rankProgress * 100)}% to ${RANKS[sel.vet + 1]}`)
      const svc = el('div', 'unit-svc', svcBits.join(' · '))
      if (!svcBits.length) svc.style.display = 'none'
      const deeds = el('div', 'unit-deeds', sel.deeds.length ? `✠ ${sel.deeds.join(' · ')}` : '')
      if (!sel.deeds.length) deeds.style.display = 'none'

      const status = el('div', 'unit-status')
      status.dataset.role = 'status'

      const bars = el('div', 'unit-bars')
      const addBar = (label: string, role: string, cls: string): void => {
        const row = el('div', 'unit-bar')
        row.appendChild(el('span', 'unit-bar__label', label))
        const bar = el('div', `ms-bar ${cls}`)
        const fill = el('div', 'ms-bar__fill')
        fill.dataset.role = role
        bar.appendChild(fill)
        row.appendChild(bar)
        bars.appendChild(row)
      }
      addBar('Condition', 'hp', 'ms-bar--hp')
      addBar('Nerve', 'morale', 'ms-bar--morale')
      if (sel.kind === 'vickers') addBar('Heat', 'heat', 'ms-bar--heat')
      if (sel.ammoMax > 0) addBar('Pan', 'ammo', 'ms-bar--ammo')

      const targLabel = el('div', 'unit-targ-label', 'FIRE ON')
      const targRow = el('div', 'unit-targ')
      for (const p of ['nearest', 'strongest', 'officers', 'armour'] as const) {
        const b = el('button', 'ms-btn ms-btn--ghost ms-btn--small', p)
        b.dataset.targ = p
        b.addEventListener('click', () => { this.game.setTargeting(p); b.blur() })
        targRow.appendChild(b)
      }
      const sellBtn = el('button', 'ms-btn ms-btn--danger ms-btn--small unit-sell', `Disband (£${sel.sellValue})`)
      sellBtn.title = `Refund ${Math.round(ECONOMY.sellRefund * 100)}% (${keyLabel(this.game.input.bindFor('sell'))})`
      sellBtn.addEventListener('click', () => { this.game.sellSelected(); sellBtn.blur() })
      this.unitPanel.append(head, sub, svc, deeds, status, bars, targLabel, targRow, sellBtn)
    }
    const setW = (role: string, frac: number): void => {
      const e = this.unitPanel.querySelector(`[data-role="${role}"]`) as HTMLElement | null
      if (e) e.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`
    }
    setW('hp', sel.hpFrac)
    setW('morale', sel.morale)
    if (sel.kind === 'vickers') setW('heat', sel.heat)
    if (sel.ammoMax > 0) setW('ammo', sel.ammo < 0 ? 1 : sel.ammo / sel.ammoMax)

    // State pills — rebuilt each frame (crew count, nerve, ammo change live).
    const status = this.unitPanel.querySelector('[data-role="status"]') as HTMLElement | null
    if (status) {
      status.textContent = ''
      const pill = (text: string, cls = ''): void => {
        status.appendChild(el('span', `unit-pill ${cls}`.trim(), text))
      }
      pill(`${sel.crewAlive}/${sel.crewMax} crew`, sel.crewAlive < sel.crewMax ? 'unit-pill--warn' : '')
      if (sel.fallenBack) pill('Fallen back', 'unit-pill--danger')
      else if (sel.suppression > 0.55) pill('Suppressed', 'unit-pill--danger')
      else if (sel.morale < 0.4) pill('Wavering', 'unit-pill--warn')
      else pill('Steady', 'unit-pill--good')
      if (sel.ammoMax > 0 && sel.ammo >= 0 && sel.ammo <= 1) pill('Reloading', 'unit-pill--warn')
    }

    for (const b of this.unitPanel.querySelectorAll('[data-targ]')) {
      b.classList.toggle('ms-btn--primary', (b as HTMLElement).dataset.targ === sel.targeting)
    }
  }

  // -------------------------------------------------------------------------
  // HudBridge
  // -------------------------------------------------------------------------

  toast(text: string, kind: 'info' | 'warn' | 'danger' | 'good'): void {
    const t = el('div', `hud-alert${kind === 'danger' ? ' hud-alert--danger' : ''}`, text)
    t.style.width = 'max-content'
    t.style.maxWidth = '440px'
    if (kind === 'good') t.style.borderColor = 'var(--olive,#5b5b3f)'
    this.toastBox.appendChild(t)
    setTimeout(() => t.remove(), 4200)
    if (this.toastBox.children.length > 4) this.toastBox.children[0].remove()
  }

  banner(text: string): void {
    this.bannerEl.textContent = text
    this.bannerEl.style.display = ''
    this.bannerT = 3.5
  }

  showIntel(data: IntelData, beginLabel: string, onBegin: () => void): void {
    this.closeOverlay()
    const scr = createIntelReport({
      wave: data.wave, date: data.date, title: data.title,
      rows: data.rows, weatherLine: data.weatherLine, adviceLine: data.adviceLine,
      beginLabel,
      onBegin: () => {
        this.closeOverlay()
        onBegin()
        // The post's letter arrives once the briefing is read.
        if (this.pendingLetter) {
          const p = this.pendingLetter
          this.pendingLetter = null
          const letter = createLetterOverlay({ text: p.text, signature: p.signature, onClose: () => this.closeOverlay() })
          this.mount(letter)
        }
      },
    })
    this.mount(scr)
    this.game.audio.play('ui_open', { gain: 0.6 })
  }

  private pendingLetter: { text: string; signature: string } | null = null
  showLetter(text: string, signature: string): void {
    // Letters always queue behind the intel report that follows a wave;
    // showing them immediately would get them closed by the next overlay.
    this.pendingLetter = { text, signature }
  }

  gameOver(victory: boolean, canContinue: boolean): void {
    this.closeOverlay()
    const s = this.game.ctx.s
    const scr = createGameOverScreen({
      victory,
      stats: {
        waves: s.wave - 1, kills: s.stats.kills, losses: s.stats.losses,
        daysHeld: (s.wave - 1) * 2, score: s.stats.score, highScore: highScore(),
        seed: this.game.seedStr,
      },
      memorial: s.casualties.map((c) => ({
        name: `${c.name.first} ${c.name.last}`, rank: c.rank,
        kind: UNIT_DEFS[c.kind]?.name ?? c.kind, wave: c.wave, epitaph: c.epitaph,
        deeds: DEEDS.filter((d) => ((c.deeds ?? 0) & d.bit) !== 0).map((d) => d.name),
        wavesServed: c.wavesServed ?? 0,
      })),
      letter: null,
      onRestart: () => { this.closeOverlay(); this.game.startRun(this.game.seedStr, this.game.difficulty) },
      onMenu: () => { this.closeOverlay(); this.onQuitToTitle?.() },
      onContinueEndless: canContinue ? () => { this.closeOverlay(); this.game.continueEndless() } : undefined,
    })
    this.mount(scr)
  }

  refreshShop(): void {
    if (this.shopEl) { this.shopEl.remove(); this.shopEl = null; this.toggleShop() }
  }

  // -------------------------------------------------------------------------
  // Menus
  // -------------------------------------------------------------------------

  openPause(): void {
    if (this.overlay) return
    const g = this.game
    g.paused = true
    const s = g.ctx.s
    const scr = createPauseMenu({
      stats: { wave: s.wave, kills: s.stats.kills, req: s.req },
      onResume: () => { this.closeOverlay(); g.paused = false },
      onSettings: () => this.openSettings(),
      onHelp: () => this.openHelp(),
      onRestart: () => { this.closeOverlay(); g.paused = false; g.startRun(g.seedStr, g.difficulty) },
      onQuit: () => { this.closeOverlay(); this.onQuitToTitle?.() },
    })
    this.mount(scr)
  }

  openSettings(): void {
    const g = this.game
    const schema: SettingsGroup[] = settingsSchema()
    const scr = createSettingsPanel({
      schema,
      values: { ...g.settings as unknown as Record<string, unknown>, ...bindsAsValues(g) },
      onChange: (key, value) => {
        if (key.startsWith('bind.')) {
          g.settings.keybinds[key.slice(5)] = value as string
        } else {
          ;(g.settings as unknown as Record<string, unknown>)[key] = value
        }
        g.applySettings(g.settings)
        saveSettings(g.settings)
      },
      onClose: () => { g.input.cancelCapture(); this.closeTop(scr) },
      onReset: () => {
        g.settings = defaultSettings()
        g.applySettings(g.settings)
        saveSettings(g.settings)
      },
      onRebind: (_key, cb) => g.input.captureNextKey(cb),
    })
    this.mountTop(scr)
  }

  private helpOpen = false
  openHelp(): void {
    if (this.helpOpen) return
    this.helpOpen = true
    const scr = createHelpOverlay({
      sections: helpSections(),
      onClose: () => { this.helpOpen = false; this.closeTop(scr) },
    })
    this.mountTop(scr)
  }

  private toggleShop(): void {
    if (this.shopEl) { this.shopEl.remove(); this.shopEl = null; return }
    const g = this.game
    const s = g.ctx.s
    const panel = el('div', 'ms-panel ms-scroll')
    panel.style.cssText = 'position:absolute;right:12px;top:60px;bottom:120px;width:300px;overflow-y:auto;pointer-events:auto;padding:12px;'
    panel.appendChild(el('div', 'ms-stamp', 'DIVISIONAL STORES'))
    for (const tier of [1, 2, 3] as const) {
      const hdr = el('div', 'ms-divider', `TIER ${tier}`)
      panel.appendChild(hdr)
      for (const up of UPGRADE_DEFS.filter((u) => u.tier === tier)) {
        const state = g.upgradeAvailable(up.id)
        const card = el('button', 'ms-card')
        card.style.cssText = 'display:block;width:100%;text-align:left;margin:4px 0;'
        if (state === 'owned') card.classList.add('ms-card--selected')
        if (state === 'locked' || state === 'unaffordable') card.classList.add('ms-card--disabled')
        const title = el('div', undefined, `${up.name} ${state === 'owned' ? '✓' : `— £${up.cost}`}`)
        title.style.fontWeight = 'bold'
        const desc = el('div', undefined, state === 'locked' && s.wave < 99
          ? (up.requires && !s.upgrades.has(up.requires)
            ? `Requires ${UPGRADE_DEFS.find((u) => u.id === up.requires)?.name ?? up.requires}`
            : `Available from wave ${tierWave(up.tier)}`)
          : up.blurb)
        desc.style.cssText = 'font-size:0.82em;opacity:0.85;'
        card.append(title, desc)
        card.addEventListener('click', () => {
          g.buyUpgrade(up.id)
          card.blur()
        })
        panel.appendChild(card)
      }
    }
    const close = el('button', 'ms-btn ms-btn--small', 'Close')
    close.style.marginTop = '8px'
    close.addEventListener('click', () => this.toggleShop())
    panel.appendChild(close)
    this.root.appendChild(panel)
    this.shopEl = panel
  }

  // -------------------------------------------------------------------------
  // Overlay plumbing
  // -------------------------------------------------------------------------

  private mount(scr: { el: HTMLElement; dispose: () => void }): void {
    this.overlay = scr
    this.game.modalOpen = true
    scr.el.style.pointerEvents = 'auto'
    this.root.appendChild(scr.el)
  }

  private closeOverlay(): void {
    if (this.overlay) {
      this.overlay.dispose()
      this.overlay.el.remove()
      this.overlay = null
    }
    this.game.modalOpen = false
  }

  /** Secondary overlays (settings/help) stack on top of pause. */
  private stacked: Array<{ el: HTMLElement; dispose: () => void }> = []
  private mountTop(scr: { el: HTMLElement; dispose: () => void }): void {
    this.stacked.push(scr)
    scr.el.style.pointerEvents = 'auto'
    this.root.appendChild(scr.el)
  }
  private closeTop(scr: { el: HTMLElement; dispose: () => void }): void {
    const i = this.stacked.indexOf(scr)
    if (i >= 0) this.stacked.splice(i, 1)
    scr.dispose()
    scr.el.remove()
  }

  hasOverlay(): boolean { return this.overlay !== null || this.stacked.length > 0 }

  // -------------------------------------------------------------------------
  // Tips
  // -------------------------------------------------------------------------

  private maybeTip(phase: string, wave: number): void {
    const tip = (id: string, text: string) => {
      if (this.shownTips.has(id)) return false
      this.shownTips.add(id)
      localStorage.setItem('mudsteel.tips', JSON.stringify([...this.shownTips]))
      this.tipEl.textContent = text
      this.tipEl.style.display = ''
      setTimeout(() => { this.tipEl.style.display = 'none' }, 9000)
      return true
    }
    if (phase === 'build' && wave === 1) {
      tip('t1', 'Pick a card (or press 1–9), then click anywhere along the glowing front trench. Riflemen first — they are cheap and they hold.')
    } else if (phase === 'assault' && wave === 1) {
      tip('t2', 'Hold the line. Every kill earns requisition. WASD/arrows pan, Q/E rotate, wheel or Z/X zooms.')
    } else if (phase === 'build' && wave === 2) {
      tip('t3', 'Lay barbed wire (F1) in no-man\'s land — it slows them in your killing ground. Open STORES for upgrades.')
    } else if (phase === 'build' && wave === 5) {
      tip('t4', 'Shellfire digs real craters — the enemy will use them as cover. Bombers (5) and mortars (6) dig them out.')
    }
  }

  dispose(): void {
    this.closeOverlay()
    this.root.remove()
  }
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function tierWave(tier: 1 | 2 | 3): number {
  return { 1: 2, 2: 6, 3: 10 }[tier]
}

/** Human label for the zone a card is planted in. */
function placementLabel(p: 'trench' | 'pad' | 'field'): string {
  return p === 'trench' ? 'in the trench' : p === 'pad' ? 'behind the line' : 'no-man\'s-land'
}

/** Qualitative reach so the raw sim range reads at a glance. */
function reachLabel(range: number): string {
  if (range < 40) return 'point-blank'
  if (range < 100) return 'short'
  if (range < 160) return 'medium'
  if (range < 210) return 'long'
  return 'very long'
}

/** Build the shared tooltip body: title + cost, role blurb, stat chips. */
function tipCard(
  name: string, cost: number | null, blurb: string, stats: Array<[string, string]>,
): HTMLElement {
  const wrap = el('div', 'tip')
  const head = el('div', 'tip__head')
  head.appendChild(el('span', 'tip__name', name))
  if (cost !== null) head.appendChild(el('span', 'tip__cost', `£${cost}`))
  wrap.appendChild(head)
  if (blurb) wrap.appendChild(el('div', 'tip__blurb', blurb))
  if (stats.length) {
    const row = el('div', 'tip__stats')
    for (const [k, v] of stats) {
      const chip = el('span', 'tip__stat')
      chip.appendChild(el('span', 'tip__stat-k', k))
      chip.appendChild(el('span', 'tip__stat-v', v))
      row.appendChild(chip)
    }
    wrap.appendChild(row)
  }
  return wrap
}

/** Tooltip for a battle order: what it does, cost, cooldown, hotkey. */
function orderTip(def: OrderDef, code: string): HTMLElement {
  const stats: Array<[string, string]> = [['Key', keyLabel(code)]]
  if (def.cooldown) stats.push(['Cooldown', `${def.cooldown}s`])
  if (def.duration) stats.push(['Lasts', `${def.duration}s`])
  return tipCard(def.name, def.cost || null, def.blurb, stats)
}

function timeLabel(tod: number): string {
  const h = Math.floor(tod * 24)
  const m = Math.floor((tod * 24 - h) * 60)
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')} hrs`
}

function fieldDateShort(wave: number): string {
  const d = new Date(Date.UTC(1916, 6, 1))
  d.setUTCDate(d.getUTCDate() + (wave - 1) * 2)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function settingsSchema(): SettingsGroup[] {
  return [
    {
      group: 'Sound', items: [
        { key: 'volMaster', label: 'Master volume', type: 'slider' },
        { key: 'volSfx', label: 'Battle', type: 'slider' },
        { key: 'volAmbience', label: 'Ambience', type: 'slider' },
        { key: 'volUi', label: 'Interface', type: 'slider' },
      ],
    },
    {
      group: 'Graphics', items: [
        { key: 'quality', label: 'Quality', type: 'select', options: [{ value: '0', label: 'Low' }, { value: '1', label: 'Medium' }, { value: '2', label: 'High' }] },
        { key: 'shadows', label: 'Shadows', type: 'toggle' },
        { key: 'postfx', label: 'Film grade & grain', type: 'toggle' },
        { key: 'particleDensity', label: 'Particle density', type: 'slider', min: 0.25, max: 1, step: 0.05 },
        { key: 'reduceFlashes', label: 'Reduce flashes', hint: 'Dampens muzzle strobing and explosion glare', type: 'toggle' },
        { key: 'showFps', label: 'Show FPS', type: 'toggle' },
      ],
    },
    {
      group: 'Camera & Controls', items: [
        { key: 'cameraSpeed', label: 'Camera speed', type: 'slider', min: 0.5, max: 2, step: 0.1 },
        { key: 'edgePan', label: 'Edge panning', type: 'toggle' },
        { key: 'invertZoom', label: 'Invert zoom', type: 'toggle' },
        { key: 'uiScale', label: 'UI scale', type: 'slider', min: 0.8, max: 1.4, step: 0.05 },
        { key: 'colorAssist', label: 'Colour assist', hint: 'Marker chevrons over enemy troops', type: 'toggle' },
        { key: 'autoMasks', label: 'Automatic gas masks', hint: 'Requires PH Helmets upgrade in a run', type: 'toggle' },
      ],
    },
    {
      group: 'Keybinds', items: [
        { key: 'bind.panUp', label: 'Pan north', type: 'keybind' },
        { key: 'bind.panDown', label: 'Pan south', type: 'keybind' },
        { key: 'bind.panLeft', label: 'Pan west', type: 'keybind' },
        { key: 'bind.panRight', label: 'Pan east', type: 'keybind' },
        { key: 'bind.rotateLeft', label: 'Rotate left', type: 'keybind' },
        { key: 'bind.rotateRight', label: 'Rotate right', type: 'keybind' },
        { key: 'bind.zoomIn', label: 'Zoom in', type: 'keybind' },
        { key: 'bind.zoomOut', label: 'Zoom out', type: 'keybind' },
        { key: 'bind.pause', label: 'Pause', type: 'keybind' },
        { key: 'bind.orderCover', label: 'Take Cover', type: 'keybind' },
        { key: 'bind.orderRapid', label: 'Rapid Fire', type: 'keybind' },
        { key: 'bind.orderBayonets', label: 'Fix Bayonets', type: 'keybind' },
        { key: 'bind.orderMasks', label: 'Gas Masks', type: 'keybind' },
        { key: 'bind.orderFlare', label: 'Flare', type: 'keybind' },
        { key: 'bind.callWave', label: 'Sound the Advance', type: 'keybind' },
        { key: 'bind.embody', label: 'Embody soldier (first person)', type: 'keybind' },
      ],
    },
  ]
}

function bindsAsValues(g: Game): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const binds = g.input.getBinds()
  for (const [action, code] of Object.entries(binds)) {
    out[`bind.${action}`] = keyLabel(code)
  }
  return out
}

export function helpSections(): Array<{ title: string; html: string }> {
  return [
    {
      title: 'The Line',
      html: `<p>You command a battalion sector: a <b>front trench</b>, a <b>support trench</b>, and the mud between. Waves come from the north. If enemies fight past your support line, <b>THE LINE</b> meter drains — at zero, the sector falls.</p>
      <p>Hold to <b>wave 20</b> and you will be relieved. Every soldier you place has a name. Remember them.</p>`,
    },
    {
      title: 'Placement',
      html: `<p>Select a card (mouse or number keys), then click anywhere in its <b>zone</b> — infantry anywhere along a trench line, crewed weapons dug in on open ground behind the front. Wire, mines and traps go in <b>no-man's land</b>, but only between waves.</p>
      <p><span class="ms-kbd">R</span> rotates wire. Right-click cancels. <span class="ms-kbd">Tab</span> cycles your units; <span class="ms-kbd">Del</span> disbands for a 70% refund. Arrow keys move the placement cursor for keyboard-only play.</p>`,
    },
    {
      title: 'The Battlefield is Alive',
      html: `<p><b>Every shell digs a real crater.</b> Craters give the enemy cover — and when it rains they flood, slowing men and swallowing tanks whole.</p>
      <p><b>Wind matters.</b> Gas drifts with the live wind. The vane turns <b style="color:#7a2e22">red</b> when the wind blows toward YOUR trench: your own gas will come home, and theirs will arrive faster.</p>
      <p><b>Morale is ammunition.</b> Suppressed men dive into shell holes; broken men run. Officers steady the line, medics keep them breathing, flame breaks charges like nothing else.</p>`,
    },
    {
      title: 'Orders',
      html: `<p><b>Take Cover</b> (${'C'}) — heads down during a barrage; casualties drop sharply.<br>
      <b>Rapid Fire</b> (F) — the mad minute: double fire, guns heat, nerves fray.<br>
      <b>Fix Bayonets</b> (B) — front-line infantry counter-charge into no-man's land.<br>
      <b>Gas Masks</b> (G) — near-immunity to gas, but fogged eyepieces cost accuracy.<br>
      <b>Flare</b> (V) — light up night attacks. <b>Creeping Barrage</b> and the <b>Mark IV</b> unlock in STORES.</p>`,
    },
    {
      title: 'Take Up a Rifle',
      html: `<p><b>Double-click any of your soldiers</b> (or select a unit and press <span class="ms-kbd">M</span>) to step into his boots. Mouse looks, <span class="ms-kbd">WASD</span> moves, <span class="ms-kbd">Shift</span> runs, <span class="ms-kbd">C</span> cycles stance, hold <b>right-click</b> to aim down the sights, <span class="ms-kbd">R</span> reloads the ten-round magazine.</p>
      <p>Your rounds are as real as everyone else's — they drop with range, thump into parapets, and your kills pay requisition to his unit. The enemy shoots back at <i>you</i>. <span class="ms-kbd">M</span> or <span class="ms-kbd">Esc</span> returns to command. Dying also works.</p>`,
    },
    {
      title: 'The Enemy Learns',
      html: `<p>The enemy staff studies how you kill. Lean on machine guns and snipers will hunt your crews; lean on wire and pioneers come with cutters; lean on artillery and they attack dispersed. Read the intelligence report between waves — it tells you what they intend.</p>`,
    },
    {
      title: 'Credits',
      html: `<p>MUD &amp; STEEL — a WWI trench defence. Everything procedural: terrain, men, sound, letters. No two runs alike; share your seed from the game-over screen.</p><p><i>For the ones who wrote letters home.</i></p>`,
    },
  ]
}
