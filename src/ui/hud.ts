/**
 * In-game HUD: build bar, orders, top strip (requisition/wave/breach/weather),
 * unit panel, stores (upgrades), toasts, banners, tips — plus the bridge to
 * the overlay screens (intel, letters, pause, game over).
 * Fully mouse- or keyboard-operable.
 */
import type { BuildableId, DefenceKindId, UnitKindId } from '../core/types'
import {
  BUILD_ORDER, DEFENCE_DEFS, ECONOMY, ORDER_DEFS, UNIT_DEFS, UPGRADE_DEFS,
} from '../core/config'
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
  private topInfo!: { req: HTMLElement; wave: HTMLElement; date: HTMLElement; enemies: HTMLElement; timerBtn: HTMLButtonElement; breach: HTMLElement; weather: HTMLElement; needle: HTMLElement; fps: HTMLElement; speedBtns: HTMLButtonElement[]; pauseBtn: HTMLButtonElement }
  private cards = new Map<BuildableId, { root: HTMLButtonElement; cost: HTMLElement }>()
  private orderBtns = new Map<OrderId, { root: HTMLButtonElement; fill: HTMLElement }>()
  private unitPanel!: HTMLElement
  private toastBox!: HTMLElement
  private bannerEl!: HTMLElement
  private tipEl!: HTMLElement
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
    game.hud = this
  }

  // -------------------------------------------------------------------------
  // DOM construction
  // -------------------------------------------------------------------------

  private buildTop(): void {
    const top = el('div', 'hud-top')
    top.style.pointerEvents = 'auto'

    const left = el('div')
    left.style.cssText = 'display:flex;gap:10px;align-items:center;'
    const req = el('span', 'ms-chip', '£0')
    req.title = 'Requisition — earn it holding the line, spend it on men and stores'
    const wave = el('span', 'ms-chip', 'WAVE 1')
    const date = el('span', 'ms-chip', '')
    const enemies = el('span', 'ms-chip', '')
    left.append(req, wave, date, enemies)

    const mid = el('div')
    mid.style.cssText = 'display:flex;gap:10px;align-items:center;flex:1;justify-content:center;'
    const breachWrap = el('div')
    breachWrap.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:190px;'
    breachWrap.title = 'The line — enemies breaking through past your support trench drain it'
    breachWrap.append(el('span', 'ms-chip', 'THE LINE'))
    const breachBar = el('div', 'ms-bar ms-bar--hp')
    breachBar.style.cssText = 'flex:1;'
    const breachFill = el('div', 'ms-bar__fill')
    breachBar.appendChild(breachFill)
    breachWrap.appendChild(breachBar)
    const timerBtn = el('button', 'ms-btn ms-btn--primary ms-btn--small', 'SOUND THE ADVANCE')
    timerBtn.title = 'Skip the remaining build time for bonus requisition'
    timerBtn.addEventListener('click', () => { this.game.callWaveEarly(); timerBtn.blur() })
    mid.append(breachWrap, timerBtn)

    const right = el('div')
    right.style.cssText = 'display:flex;gap:8px;align-items:center;'
    const weather = el('span', 'ms-chip', '')
    const vane = el('div', 'wind-vane')
    vane.title = 'Wind — gas drifts with it. Red means it blows toward YOUR line.'
    const needle = el('div', 'wind-vane__needle')
    vane.appendChild(needle)
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
    this.topInfo = { req, wave, date, enemies, timerBtn, breach: breachFill, weather, needle, fps, speedBtns, pauseBtn }
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
      b.title = `${def.blurb}${def.cost ? ` — £${def.cost}` : ''}`
      const label = el('span', undefined, def.name)
      const kbd = el('span', 'ms-kbd', keyLabel(this.game.input.bindFor(ORDER_ACTION[id])))
      const fill = el('div')
      fill.style.cssText = 'position:absolute;left:0;bottom:0;height:3px;background:var(--brass,#a08a4f);width:0%;'
      b.append(label, kbd, fill)
      b.addEventListener('click', () => { this.game.issueOrder(id); b.blur() })
      orders.appendChild(b)
      this.orderBtns.set(id, { root: b, fill })
    }
    const storesBtn = el('button', 'ms-btn ms-btn--primary ms-btn--small', 'STORES')
    storesBtn.title = 'Upgrades — new kit and doctrine between waves'
    storesBtn.addEventListener('click', () => { this.toggleShop(); storesBtn.blur() })
    orders.appendChild(storesBtn)
    bottom.appendChild(orders)

    // Build bar.
    const bar = el('div', 'hud-buildbar')
    for (let i = 0; i < BUILD_ORDER.length; i++) {
      const id = BUILD_ORDER[i]
      const def = this.game.isUnitKind(id) ? UNIT_DEFS[id as UnitKindId] : DEFENCE_DEFS[id as DefenceKindId]
      const card = el('button', 'hud-card')
      const action: Action = i < 12 ? (`build${i + 1}` as Action) : (`buildD${i - 11}` as Action)
      card.title = `${def.name} — £${def.cost}\n${def.blurb}`
      const icon = el('span', 'hud-card__icon', BUILD_ICONS[id])
      const name = el('span', 'hud-card__name', def.name)
      const cost = el('span', 'hud-card__cost', `£${this.game.costOf(id)}`)
      const kbd = el('span', 'ms-kbd', keyLabel(this.game.input.bindFor(action)))
      card.append(icon, name, cost, kbd)
      card.addEventListener('click', () => {
        this.game.setBuildSelection(this.game.buildSelection === id ? null : id)
        card.blur()
      })
      bar.appendChild(card)
      this.cards.set(id, { root: card, cost })
    }
    bottom.appendChild(bar)
    this.root.appendChild(bottom)
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
    t.breach.style.width = `${(s.breach / 100) * 100}%`

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
    t.fps.textContent = g.settings.showFps ? `${Math.round(g.fps)} fps` : ''
    for (let i = 0; i < t.speedBtns.length; i++) {
      const sp = [1, 2, 4][i]
      t.speedBtns[i].classList.toggle('ms-btn--primary', g.speed === sp && !g.paused)
    }
    t.pauseBtn.classList.toggle('ms-btn--primary', g.paused)

    // Build cards.
    for (const [id, card] of this.cards) {
      const cost = g.costOf(id)
      card.cost.textContent = `£${cost}`
      const fieldLocked = !g.isUnitKind(id) &&
        DEFENCE_DEFS[id as DefenceKindId].placement === 'field' && !g.fieldBuildAllowed()
      card.root.classList.toggle('hud-card--selected', g.buildSelection === id)
      card.root.classList.toggle('hud-card--disabled', s.req < cost || fieldLocked)
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

    this.maybeTip(s.phase, s.wave)
  }

  private lastSelId = -1
  private renderUnitPanel(sel: NonNullable<ReturnType<Game['selectedInfo']>>): void {
    // Rebuild only when the selected unit changes; update bars every frame.
    if (sel.unitId !== this.lastSelId) {
      this.lastSelId = sel.unitId
      this.unitPanel.textContent = ''
      const def = UNIT_DEFS[sel.kind]
      const head = el('div', undefined, `${sel.rank} ${sel.name}`)
      head.style.cssText = 'font-weight:bold;letter-spacing:0.08em;'
      const sub = el('div', undefined, `${def.name} · ${'★'.repeat(sel.vet)}${sel.vet ? ' ' : ''}${sel.kills} kills`)
      sub.style.cssText = 'opacity:0.8;font-size:0.85em;margin:2px 0 6px;'
      const hpBar = el('div', 'ms-bar ms-bar--hp')
      const hpFill = el('div', 'ms-bar__fill')
      hpFill.dataset.role = 'hp'
      hpBar.appendChild(hpFill)
      const heatBar = el('div', 'ms-bar ms-bar--heat')
      heatBar.style.marginTop = '4px'
      const heatFill = el('div', 'ms-bar__fill')
      heatFill.dataset.role = 'heat'
      heatBar.appendChild(heatFill)
      if (sel.kind !== 'vickers') heatBar.style.display = 'none'

      const targRow = el('div')
      targRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;'
      for (const p of ['nearest', 'strongest', 'officers', 'armour'] as const) {
        const b = el('button', 'ms-btn ms-btn--ghost ms-btn--small', p)
        b.dataset.targ = p
        b.addEventListener('click', () => { this.game.setTargeting(p); b.blur() })
        targRow.appendChild(b)
      }
      const sellBtn = el('button', 'ms-btn ms-btn--danger ms-btn--small', `Disband (£${sel.sellValue})`)
      sellBtn.style.marginTop = '6px'
      sellBtn.title = `Refund ${Math.round(ECONOMY.sellRefund * 100)}% (${keyLabel(this.game.input.bindFor('sell'))})`
      sellBtn.addEventListener('click', () => { this.game.sellSelected(); sellBtn.blur() })
      this.unitPanel.append(head, sub, hpBar, heatBar, targRow, sellBtn)
    }
    const hp = this.unitPanel.querySelector('[data-role="hp"]') as HTMLElement | null
    if (hp) hp.style.width = `${sel.hpFrac * 100}%`
    const heat = this.unitPanel.querySelector('[data-role="heat"]') as HTMLElement | null
    if (heat) heat.style.width = `${sel.heat * 100}%`
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
      tip('t1', 'Pick a card (or press 1–9), then click a glowing slot in the front trench. Riflemen first — they are cheap and they hold.')
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
      html: `<p>Select a card (mouse or number keys), then click a <b>slot</b> — infantry in trenches, crewed weapons on pads behind the line. Wire, mines and traps go in <b>no-man's land</b>, but only between waves.</p>
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
      title: 'The Enemy Learns',
      html: `<p>The enemy staff studies how you kill. Lean on machine guns and snipers will hunt your crews; lean on wire and pioneers come with cutters; lean on artillery and they attack dispersed. Read the intelligence report between waves — it tells you what they intend.</p>`,
    },
    {
      title: 'Credits',
      html: `<p>MUD &amp; STEEL — a WWI trench defence. Everything procedural: terrain, men, sound, letters. No two runs alike; share your seed from the game-over screen.</p><p><i>For the ones who wrote letters home.</i></p>`,
    },
  ]
}
