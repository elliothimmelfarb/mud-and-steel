/**
 * The headless tick driver. Owns the sim context, the command queue, the wave
 * lifecycle and the fixed 30 Hz step — everything the battle IS, with zero
 * render, audio or DOM dependencies. The Game drives one of these and reads
 * its state; the twin-sim probe drives two of them in one process; the AI
 * commander and lockstep multiplayer submit envelopes into the same queue.
 *
 * Determinism contract: same seed + same envelope log (tick/side/seq) →
 * identical state, hash-for-hash. All randomness flows from forks of the run
 * seed; commands apply only at tick boundaries, in (tick, side, seq) order.
 */
import type { DefenceKindId, Difficulty, Unit, UnitKindId } from '../core/types'
import {
  COMBAT, DIRECTOR, ECONOMY, SCORE, SIM_DT, UNIT_DEFS, WORLD, XP_PER_WAVE,
} from '../core/config'
import { forkRand, hashString, type Rand } from '../core/rng'
import { waveName } from '../core/flavor'
import { EventBus } from '../core/events'
import type { RunSave } from '../core/save'
import { Terrain } from '../world/terrain'
import { Weather } from '../world/weather'
import { FlowField } from './pathfind'
import { Mods } from './mods'
import {
  makeDirector, makeOrders, makeStats, type Ctx, type SimState,
} from './sim'
import { buildSections } from './trench'
import { awardXp } from './veterancy'
import { updateUnits } from './soldiers'
import { updateEnemies } from './enemies'
import { updateVehicles } from './vehicles'
import { updateProjectiles } from './projectiles'
import { updateBullets } from './ballistics'
import { updateGas } from './gas'
import { updateCapture } from './trench'
import { planWave, updateWaveSpawns, noteWireDensity } from './waves'
import { updateBarrages } from './barrage'
import { rebuildFlow } from './flow'
import {
  applyEnvelope, createDefence, createUnit, placeStartingWire,
  type CmdHost, type Envelope,
} from './commands'

export interface RunnerOpts {
  seedStr: string
  difficulty: Difficulty
  resume?: RunSave | null
  /** Share the game's bus so UI subscriptions survive; headless makes its own. */
  events?: EventBus
  /** Headless runs drain fx/sound queues each tick (nobody renders them). */
  headless?: boolean
  /** Probe/balance-lab override for starting requisition (same on twin sims!). */
  startReq?: number
}

export class SimRunner implements CmdHost {
  readonly ctx: Ctx
  readonly terrain: Terrain
  readonly weather: Weather
  readonly events: EventBus
  readonly headless: boolean
  /** Full envelope log of the run — the replay/rejoin record. */
  readonly log: Envelope[] = []

  private waveRand: Rand
  private pending: Envelope[] = []
  private seqCounter = 0
  private draining = false

  constructor(opts: RunnerOpts) {
    const seed = hashString(opts.seedStr)
    const resume = opts.resume ?? null
    this.headless = opts.headless ?? false
    this.events = opts.events ?? new EventBus()
    this.waveRand = forkRand(seed, 'waves')

    const mods = new Mods()
    const upgrades = new Set<string>(resume?.upgrades ?? [])
    mods.recompute(upgrades)

    this.terrain = new Terrain(seed)
    this.weather = new Weather(seed)

    const sections = buildSections(this.terrain, mods.parapetMult)
    const s: SimState = {
      seed,
      time: 0,
      tick: 0,
      wave: resume?.wave ?? 1,
      phase: 'debrief',
      difficulty: opts.difficulty,
      endless: resume ? resume.wave > DIRECTOR.victoryWave : false,
      outcome: 'ongoing',
      buildTimer: 0,
      req: opts.startReq ?? resume?.req ?? Math.round(ECONOMY.startReq[opts.difficulty]),
      breach: resume?.breach ?? COMBAT.breachMax,
      masksOn: resume?.masksOn ?? false,
      earlyCallBonus: 0,
      advance: { brit: WORLD.frontTrenchZ, german: -WORLD.frontTrenchZ },
      units: [], enemies: [], squads: [], vehicles: [], projectiles: [], bullets: [],
      clouds: [], defences: [], corpses: [],
      sections,
      fx: [], sounds: [],
      orders: makeOrders(),
      upgrades,
      director: makeDirector(),
      stats: resume?.stats ?? makeStats(),
      casualties: resume?.casualties ?? [],
      plan: null, planCursor: 0, planBarrageCursor: 0, waveStartTime: 0,
      barrages: [], creeping: null,
      gasAlarmCooldown: 0,
      wetnessTimer: 0,
      lastFlowRebuild: 0,
      nextId: 1,
    }

    const flowInf = new FlowField({
      cols: Math.floor(WORLD.width / (WORLD.cell * 2)),
      rows: Math.floor(WORLD.depth / (WORLD.cell * 2)),
      originX: -WORLD.width / 2, originZ: -WORLD.depth / 2, cellSize: WORLD.cell * 2,
    })
    const flowVeh = new FlowField({
      cols: flowInf.cols, rows: flowInf.rows,
      originX: -WORLD.width / 2, originZ: -WORLD.depth / 2, cellSize: WORLD.cell * 2,
    })

    this.ctx = {
      s, terrain: this.terrain, weather: this.weather,
      flowInf, flowVeh,
      events: this.events, rand: forkRand(seed, 'combat'),
      mods, flowDirty: true, night: false,
      possessedSoldierId: -1, possessedUnitId: -1,
      fpsInvincible: false,
      fpsFeedback: [],
    }

    // Restore a saved position. Order matters: defences first (sandbags bump
    // parapetMax as a side effect), THEN the authoritative saved section state
    // overwrites — otherwise the sandbag bonus compounds on every load.
    if (resume) {
      this.terrain.replayCraterOps(resume.craterOps)
      for (const su of resume.units) this.restoreUnit(su)
      for (const sd of resume.defences) {
        createDefence(this.ctx, sd.kind as DefenceKindId, sd.x, sd.z, 0)
        const d = s.defences[s.defences.length - 1]
        if (d) { d.hp = sd.hp; d.maxHp = sd.maxHp; d.wear = sd.wear }
      }
      resume.sectionState.forEach((st, i) => {
        if (s.sections[i]) {
          s.sections[i].parapetHp = st.parapetHp
          s.sections[i].parapetMax = st.parapetMax
          s.sections[i].captured = st.captured
        }
      })
      this.weather.state.tod = resume.weather.tod
      this.weather.state.wetness = resume.weather.wetness
      this.terrain.setWetness(resume.weather.wetness)
    } else {
      // Fresh sector: two years of occupation means the line starts wired.
      placeStartingWire(s)
    }

    rebuildFlow(this.ctx)
  }

  /** Plan the first wave. Call AFTER subscribing to events. */
  begin(): void {
    this.prepareNextWave()
  }

  // -------------------------------------------------------------------------
  // Command intake
  // -------------------------------------------------------------------------

  enqueue(env: Envelope): void {
    this.pending.push(env)
  }

  /**
   * Local convenience: stamp with the current tick (applies next boundary).
   * A submit made WHILE the queue is draining (i.e. from an event handler
   * reacting to another command) stamps tick+1 — live it would miss the
   * current drain, so the log must say so or a replay would apply it a
   * boundary early.
   */
  submit(side: 'brit' | 'german', cmds: Envelope['cmds']): void {
    if (cmds.length === 0) return
    const tick = this.ctx.s.tick + (this.draining ? 1 : 0)
    this.enqueue({ tick, side, seq: this.seqCounter++, cmds })
  }

  private drainQueue(): void {
    if (this.pending.length === 0) return
    const s = this.ctx.s
    const due: Envelope[] = []
    let w = 0
    for (const env of this.pending) {
      if (env.tick <= s.tick) due.push(env)
      else this.pending[w++] = env
    }
    this.pending.length = w
    if (due.length === 0) return
    due.sort((a, b) =>
      a.tick - b.tick ||
      (a.side < b.side ? -1 : a.side > b.side ? 1 : 0) ||
      a.seq - b.seq)
    this.draining = true
    for (const env of due) {
      applyEnvelope(this, env)
      // The log records the tick the envelope was APPLIED at, not the stamp —
      // a late arrival (lockstep jitter) must replay at its real boundary.
      this.log.push(env.tick === s.tick ? env : { ...env, tick: s.tick })
    }
    this.draining = false
  }

  // -------------------------------------------------------------------------
  // The fixed tick
  // -------------------------------------------------------------------------

  step(dt: number = SIM_DT): void {
    const ctx = this.ctx
    const s = ctx.s

    // Commands apply only at the tick boundary — before anything moves.
    this.drainQueue()
    if (s.outcome !== 'ongoing') return

    s.time += dt
    s.tick++

    // Weather & terrain wetness (wetness → mud → movement costs: sim).
    const { thunder } = this.weather.update(dt)
    if (thunder) ctx.events.emit('thunder', {})
    s.wetnessTimer += dt
    if (s.wetnessTimer > 4) {
      s.wetnessTimer = 0
      this.terrain.setWetness(this.weather.state.wetness)
    }

    // Orders tick.
    const o = s.orders
    o.coverT = Math.max(0, o.coverT - dt)
    o.rapidT = Math.max(0, o.rapidT - dt)
    o.bayonetT = Math.max(0, o.bayonetT - dt)
    for (const k of Object.keys(o.cooldowns) as Array<keyof typeof o.cooldowns>) {
      o.cooldowns[k] = Math.max(0, o.cooldowns[k] - dt)
    }

    if (s.phase === 'build') {
      s.buildTimer -= dt
      if (s.buildTimer <= 0) this.startAssault()
    } else if (s.phase === 'assault') {
      const elapsed = s.time - s.waveStartTime
      const active = updateWaveSpawns(ctx, elapsed)
      updateBarrages(ctx, dt, elapsed)
      if (!active) {
        this.endWave()
        this.finishTick()
        return
      }
    }

    // Fixed system order — the determinism spine. Do not reorder.
    updateUnits(ctx, dt)
    updateEnemies(ctx, dt)
    updateVehicles(ctx, dt)
    updateProjectiles(ctx, dt)
    updateBullets(ctx, dt)
    updateGas(ctx, dt)
    updateCapture(ctx, dt)

    for (const c of s.corpses) c.deadT += dt

    // Flow rebuild cadence.
    if (ctx.flowDirty && s.time - s.lastFlowRebuild > 2.5) {
      s.lastFlowRebuild = s.time
      rebuildFlow(ctx)
    }

    this.updateAdvance()

    if (s.breach <= 0 && s.outcome === 'ongoing') this.finish(false)
    this.finishTick()
  }

  private finishTick(): void {
    if (this.headless) {
      this.ctx.s.fx.length = 0
      this.ctx.s.sounds.length = 0
    }
  }

  /** Farthest-forward living soldier per side, floored at each side's own front line. */
  private updateAdvance(): void {
    const s = this.ctx.s
    let brit: number = WORLD.frontTrenchZ
    for (const u of s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) {
        if (c.hp > 0 && c.pos.z < brit) brit = c.pos.z
      }
    }
    let ger: number = -WORLD.frontTrenchZ
    for (const e of s.enemies) {
      if (e.hp > 0 && e.pos.z > ger) ger = e.pos.z
    }
    s.advance.brit = brit
    s.advance.german = ger
  }

  // -------------------------------------------------------------------------
  // Wave lifecycle (sim-mechanical parts; presentation reacts via events)
  // -------------------------------------------------------------------------

  prepareNextWave(): void {
    const ctx = this.ctx
    const s = ctx.s
    s.phase = 'debrief'
    s.barrages.length = 0
    s.creeping = null
    noteWireDensity(ctx)
    const plan = planWave(ctx, s.wave, s.difficulty, this.waveRand)
    plan.name = waveName(s.wave, plan.name || 'probe', this.waveRand)
    s.plan = plan
    s.planCursor = 0
    s.planBarrageCursor = 0
    this.weather.advanceWave(plan.night, plan.weatherBias)
    ctx.events.emit('wavePrepared', { wave: s.wave })
  }

  private startAssault(): void {
    const s = this.ctx.s
    s.phase = 'assault'
    s.waveStartTime = s.time
    rebuildFlow(this.ctx)
    this.ctx.events.emit('waveStart', { wave: s.wave, name: s.plan?.name ?? '' })
  }

  private endWave(): void {
    const ctx = this.ctx
    const s = ctx.s
    const bonus = ECONOMY.waveBonusBase + ECONOMY.waveBonusPerWave * s.wave +
      ctx.mods.waveIncome + Math.round(s.earlyCallBonus)
    s.earlyCallBonus = 0
    s.req += bonus
    s.stats.reqEarned += bonus

    // Field hospital: some of the fallen come back.
    let hospitalReturned = 0
    if (ctx.mods.hospitalReturn > 0) {
      for (const u of s.units) {
        if (u.disbanded) continue
        for (const c of u.crew) {
          if (c.hp <= 0 && ctx.rand() < ctx.mods.hospitalReturn) {
            c.hp = c.maxHp * 0.5
            c.stance = 'stand'
            c.morale = 0.6
            hospitalReturned++
            const idx = s.casualties.findIndex((r) => r.name.last === c.name.last && r.name.first === c.name.first)
            if (idx >= 0) s.casualties.splice(idx, 1)
          }
        }
      }
    }

    // Weapons cool, morale settles, orders reset between waves. Every position
    // that came through the assault with a living man earns a wave's experience
    // and a notch on its service — longevity, not just kills, makes veterans.
    for (const u of s.units) {
      u.heat = 0
      u.fallenBack = false
      const survived = u.crew.some((c) => c.hp > 0)
      for (const c of u.crew) {
        if (c.hp > 0) { c.suppression = 0; c.morale = Math.max(c.morale, 0.75) }
      }
      if (survived && !u.disbanded) {
        u.wavesServed++
        awardXp(ctx, u, XP_PER_WAVE)
      }
    }
    s.clouds.length = 0
    s.projectiles.length = 0
    s.bullets.length = 0

    // The director broods on recent lessons more than old ones.
    for (const k of Object.keys(s.director.dmgByCategory)) {
      s.director.dmgByCategory[k] *= 0.55
    }

    ctx.events.emit('waveEnd', { wave: s.wave, bonus, hospitalReturned })

    s.wave++
    if (s.wave > DIRECTOR.victoryWave && !s.endless) {
      this.finish(true)
      return
    }
    this.prepareNextWave()
  }

  private finish(victory: boolean): void {
    const s = this.ctx.s
    s.phase = 'debrief'
    s.outcome = victory ? 'victory' : 'defeat'
    let score = s.stats.kills * SCORE.perKill + (s.wave - 1) * SCORE.perWave + Math.round(s.req * SCORE.perReqRemaining)
    for (const sec of s.sections) if (!sec.captured) score += SCORE.perSectionHeld
    s.stats.score = score
    this.ctx.events.emit('gameOver', { victory })
  }

  // -------------------------------------------------------------------------
  // Save restore
  // -------------------------------------------------------------------------

  private restoreUnit(su: RunSave['units'][number]): void {
    const kind = su.kind as UnitKindId
    if (!UNIT_DEFS[kind]) return
    const u = createUnit(this.ctx, kind, su.x, su.z, false)
    u.xp = su.xp
    u.vet = su.vet as Unit['vet']
    u.deeds = su.deeds ?? 0
    u.wavesServed = su.wavesServed ?? 0
    u.targeting = su.targeting
    u.heat = su.heat
    u.ammo = su.ammo
    su.crew.forEach((c, i) => {
      if (u.crew[i]) {
        u.crew[i].name = { first: c.first, last: c.last }
        u.crew[i].hp = c.hp
        u.crew[i].kills = c.kills ?? 0
        if (c.hp <= 0) u.crew[i].stance = 'dead'
      }
    })
  }
}
