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
import type { DefenceKindId, Difficulty, MatchLength, Unit, UnitKindId } from '../core/types'
import {
  BIGPUSH, COMBAT, DIRECTOR, ECONOMY, SCORE, SIM_DT, UNIT_DEFS, WORLD, XP_PER_WAVE,
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
import { AiCommander, type AiPersona } from './ai'
import {
  applyEnvelope, createDefence, createUnit, placeStartingWire,
  type CmdHost, type Envelope,
} from './commands'

export interface RunnerOpts {
  seedStr: string
  difficulty: Difficulty
  /** 'classic' (default) = the defence campaign; 'bigpush' = two-trench mode. */
  mode?: 'classic' | 'bigpush'
  resume?: RunSave | null
  /** Share the game's bus so UI subscriptions survive; headless makes its own. */
  events?: EventBus
  /** Headless runs drain fx/sound queues each tick (nobody renders them). */
  headless?: boolean
  /** Probe/balance-lab override for starting requisition (same on twin sims!). */
  startReq?: number
  /** Big Push match length (default 'battle'). Ignored in classic. */
  matchLen?: MatchLength
  /** Big Push: the German AI commander persona (null = no AI, e.g. MP human). */
  aiPersona?: AiPersona | null
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
  private aiSeq = 0
  private draining = false
  /** Adopted mid-match (MP takeover): its envelopes ARE logged. */
  private aiAdopted = false
  /** The German AI commander (Big Push SP; also the MP disconnect fallback). */
  ai: AiCommander | null

  constructor(opts: RunnerOpts) {
    const seed = hashString(opts.seedStr)
    const resume = opts.resume ?? null
    this.headless = opts.headless ?? false
    this.events = opts.events ?? new EventBus()
    this.waveRand = forkRand(seed, 'waves')

    const mods = new Mods()
    const upgrades = new Set<string>(resume?.upgrades ?? [])
    mods.recompute(upgrades)

    const mode = opts.mode ?? 'classic'
    this.terrain = new Terrain(seed, mode === 'bigpush' ? 'bigpush' : 'classic')
    this.weather = new Weather(seed)

    const sections = buildSections(this.terrain, mods.parapetMult)
    const s: SimState = {
      seed,
      mode,
      time: 0,
      tick: 0,
      wave: resume?.wave ?? 1,
      phase: 'debrief',
      difficulty: opts.difficulty,
      endless: resume ? resume.wave > DIRECTOR.victoryWave : false,
      outcome: 'ongoing',
      buildTimer: 0,
      req: opts.startReq ?? resume?.req ?? Math.round(mode === 'bigpush' ? BIGPUSH.startReq : ECONOMY.startReq[opts.difficulty]),
      breach: resume?.breach ?? COMBAT.breachMax,
      masksOn: resume?.masksOn ?? false,
      possessedSoldierId: -1, possessedUnitId: -1,
      earlyCallBonus: 0,
      germanReq: mode === 'bigpush' ? BIGPUSH.startReq : 0,
      strength: { brit: BIGPUSH.strengthStart, german: BIGPUSH.strengthStart },
      matchLen: opts.matchLen ?? 'battle',
      timeLimit: mode === 'bigpush' ? BIGPUSH.matchSeconds[opts.matchLen ?? 'battle'] : 0,
      holdT: { brit: 0, german: 0 },
      advance: { brit: WORLD.frontTrenchZ, german: -WORLD.frontTrenchZ },
      units: [], enemies: [], squads: [], assaults: [], vehicles: [], projectiles: [], bullets: [],
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
          s.sections[i].owner = st.captured ? 'german' : 'brit'
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

    this.ai = mode === 'bigpush' && opts.aiPersona !== null
      ? new AiCommander(opts.aiPersona ?? 'methodical', forkRand(seed, 'ai'))
      : null
  }

  /** Start the match. Call AFTER subscribing to events. */
  begin(): void {
    const s = this.ctx.s
    if (s.mode === 'bigpush') {
      // No wave machine: a stand-to ceasefire to set up, then continuous war.
      s.phase = 'build'
      s.buildTimer = BIGPUSH.standToSeconds
      this.ctx.events.emit('toast', { text: 'Stand-to. The push begins in sixty seconds.', kind: 'info' })
      return
    }
    this.prepareNextWave()
  }

  // -------------------------------------------------------------------------
  // Command intake
  // -------------------------------------------------------------------------

  enqueue(env: Envelope): void {
    this.pending.push(env)
  }

  /** In-flight envelopes (stamped ahead, not yet applied). The lockstep log
   *  reply must include these — they are part of the battle a rebuilding
   *  peer has to know about, but they are not in the applied log yet. */
  get pendingEnvelopes(): readonly Envelope[] {
    return this.pending
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
      // AI envelopes are never logged: replays re-derive them from the seed.
      if (!env.ai) this.log.push(env.tick === s.tick ? env : { ...env, tick: s.tick })
    }
    this.draining = false
  }

  // -------------------------------------------------------------------------
  // The fixed tick
  // -------------------------------------------------------------------------

  step(dt: number = SIM_DT): void {
    const ctx = this.ctx
    const s = ctx.s

    // The AI commander speaks first — same deterministic envelopes on every
    // client that runs the same seed, so lockstep peers never disagree on it.
    if (this.ai && s.outcome === 'ongoing' && s.phase !== 'debrief') {
      const cmds = this.ai.think(ctx)
      if (cmds.length > 0) this.enqueue({ tick: s.tick, side: 'german', seq: this.aiSeq++, cmds, ai: this.aiAdopted ? undefined : true })
    }

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
    // for-in over the fixed key set — no per-tick Object.keys array.
    for (const k in o.cooldowns) {
      const key = k as keyof typeof o.cooldowns
      o.cooldowns[key] = Math.max(0, o.cooldowns[key] - dt)
    }

    if (s.mode === 'bigpush') {
      this.tickBigPush(dt)
      if (s.outcome !== 'ongoing') { this.finishTick(); return }
    } else if (s.phase === 'build') {
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

    if (s.mode === 'classic' && s.breach <= 0 && s.outcome === 'ongoing') this.finish(false)
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

  // -------------------------------------------------------------------------
  // The Big Push: continuous war — drip economy, strength, the whistle
  // -------------------------------------------------------------------------

  private tickBigPush(dt: number): void {
    const ctx = this.ctx
    const s = ctx.s

    if (s.phase === 'build') {
      s.buildTimer -= dt
      if (s.buildTimer <= 0) {
        s.phase = 'assault'
        s.waveStartTime = s.time
        ctx.events.emit('waveStart', { wave: 1, name: 'THE BIG PUSH' })
      }
      return
    }

    // Creeping barrages etc. still walk (no scheduled wave shoots: plan=null).
    updateBarrages(ctx, dt, s.time - s.waveStartTime)

    // Divisional supply: a steady drip, compounded by holding the sunken lane
    // and any enemy-home front sections. Aggression pays for itself.
    const lane = this.laneHolder()
    let britMul = 1, gerMul = 1
    if (lane === 'brit') britMul += BIGPUSH.laneBonus
    else if (lane === 'german') gerMul += BIGPUSH.laneBonus
    let britCaps = 0, gerCaps = 0
    for (const sec of s.sections) {
      if (sec.line !== 'front') continue
      if (sec.home === 'german' && sec.owner === 'brit') britCaps++
      if (sec.home === 'brit' && sec.owner === 'german') gerCaps++
    }
    britMul += britCaps * BIGPUSH.capturedSectionBonus
    gerMul += gerCaps * BIGPUSH.capturedSectionBonus
    const oldReq = Math.floor(s.req)
    s.req += BIGPUSH.dripPerSecond * britMul * dt
    s.germanReq += BIGPUSH.dripPerSecond * gerMul * dt
    if (Math.floor(s.req) !== oldReq) ctx.events.emit('reqChanged', { req: Math.floor(s.req) })

    // Strength break ends it outright.
    if (s.strength.brit <= 0 || s.strength.german <= 0) {
      if (s.strength.brit <= 0 && s.strength.german <= 0) this.finishDraw()
      else this.finish(s.strength.german <= 0)
      return
    }

    // Attrition (and any length): hold a MAJORITY of the enemy's front-line
    // sections for a continuous minute and their position is untenable.
    const gerFrontTotal = s.sections.filter((c) => c.line === 'front' && c.home === 'german').length
    const britFrontTotal = s.sections.filter((c) => c.line === 'front' && c.home === 'brit').length
    if (gerFrontTotal > 0 && britCaps > gerFrontTotal / 2) s.holdT.brit += dt
    else s.holdT.brit = 0
    if (britFrontTotal > 0 && gerCaps > britFrontTotal / 2) s.holdT.german += dt
    else s.holdT.german = 0
    if (s.holdT.brit >= BIGPUSH.holdWinSeconds || s.holdT.german >= BIGPUSH.holdWinSeconds) {
      if (s.holdT.brit >= BIGPUSH.holdWinSeconds && s.holdT.german >= BIGPUSH.holdWinSeconds) this.finishDraw()
      else this.finish(s.holdT.brit >= BIGPUSH.holdWinSeconds)
      return
    }

    // The final whistle (timed matches): enemy front sections held, tie
    // broken by remaining battalion strength.
    if (s.timeLimit > 0 && s.time - s.waveStartTime >= s.timeLimit) {
      if (britCaps !== gerCaps) this.finish(britCaps > gerCaps)
      else if (s.strength.brit !== s.strength.german) this.finish(s.strength.brit > s.strength.german)
      else this.finishDraw()
    }
  }

  /** Which side, if either, holds the sunken lane (living presence majority). */
  private laneHolder(): 'brit' | 'german' | null {
    const s = this.ctx.s
    let brit = 0, german = 0
    for (const u of s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) {
        if (c.hp > 0 && Math.abs(c.pos.z) < BIGPUSH.laneHalfWidth) brit++
      }
    }
    for (const e of s.enemies) {
      if (e.hp > 0 && e.behavior !== 'rout' && Math.abs(e.pos.z) < BIGPUSH.laneHalfWidth) german++
    }
    if (brit > german && brit > 0) return 'brit'
    if (german > brit && german > 0) return 'german'
    return null
  }

  private finishDraw(): void {
    const s = this.ctx.s
    s.phase = 'debrief'
    s.outcome = 'draw'
    this.ctx.events.emit('gameOver', { victory: false, draw: true })
  }

  private finish(victory: boolean): void {
    const s = this.ctx.s
    s.phase = 'debrief'
    s.outcome = victory ? 'victory' : 'defeat'
    let score = s.stats.kills * SCORE.perKill + (s.wave - 1) * SCORE.perWave + Math.round(s.req * SCORE.perReqRemaining)
    for (const sec of s.sections) if (sec.owner === 'brit') score += SCORE.perSectionHeld
    s.stats.score = score
    this.ctx.events.emit('gameOver', { victory })
  }

  // -------------------------------------------------------------------------
  // Lockstep support: mid-match AI takeover + log-replay state adoption
  // -------------------------------------------------------------------------

  /**
   * A human left the German side (MP disconnect): the AI picks up their
   * command authority. Unlike the from-start SP commander, this one's
   * envelopes ARE logged — a rejoiner cannot re-derive a takeover that
   * started at an arbitrary tick.
   */
  adoptAi(persona: AiPersona): void {
    if (this.ai) return
    this.aiAdopted = true
    this.ai = new AiCommander(persona, forkRand((this.ctx.s.seed ^ this.ctx.s.tick) >>> 0, 'ai-takeover'))
  }

  /** The absent human returned: the takeover AI stands down. */
  releaseAi(): void {
    if (this.aiAdopted) {
      this.ai = null
      this.aiAdopted = false
    }
  }

  /**
   * Adopt another runner's exact battle (lockstep resync / rejoin): the fresh
   * runner was rebuilt from the creator's envelope log; we take its state,
   * RNG and log while keeping OUR object identities (ctx, terrain, events) —
   * the render layer holds references to them.
   */
  adoptState(fresh: SimRunner): void {
    const ctx = this.ctx as { s: typeof fresh.ctx.s; rand: typeof fresh.ctx.rand; mods: typeof fresh.ctx.mods; flowInf: typeof fresh.ctx.flowInf; flowVeh: typeof fresh.ctx.flowVeh; flowDirty: boolean }
    ctx.s = fresh.ctx.s
    ctx.rand = fresh.ctx.rand
    ctx.mods = fresh.ctx.mods
    ctx.flowInf = fresh.ctx.flowInf
    ctx.flowVeh = fresh.ctx.flowVeh
    // Verbatim, NOT forced true: the rebuild cadence is part of the sim
    // (s.lastFlowRebuild) — forcing a rebuild here fires it at a tick the
    // peer doesn't, and the two flows diverge as obstacles change.
    ctx.flowDirty = fresh.ctx.flowDirty
    this.terrain.copyFrom(fresh.terrain)
    this.weather.copyFrom(fresh.weather)
    this.waveRand = fresh.waveRand
    // The fresh runner's pending queue holds the in-flight tail (envelopes
    // stamped past the replay tick, delivered via the log reply) — keep it.
    // Our own pending is superseded: everything in it is either in the log
    // or in that tail.
    this.pending.length = 0
    this.pending.push(...fresh.pending)
    this.log.length = 0
    this.log.push(...fresh.log)
    this.ai = fresh.ai
    this.aiAdopted = false
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
