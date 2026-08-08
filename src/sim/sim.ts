/**
 * Sim state container + the shared context handed to every sim system.
 * Deliberately no spatial index: entity caps (~200 enemies, ~40 units) keep
 * brute-force queries cheap at 30 Hz and the code honest.
 */
import type {
  ActiveBarrage, AssaultGroup, Bullet, CasualtyRecord, CreepingBarrage, Defence, Difficulty, DirectorMemory, Enemy,
  FpsFeedbackEvent, FxEvent, GamePhase, GasCloud, MatchOutcome,
  MatchLength, Projectile, RunStats, SoundEvent, Squad, Team, TrenchSection,
  Unit, Vehicle, WavePlan,
} from '../core/types'
import type { EventBus } from '../core/events'
import type { Rand } from '../core/rng'
import type { Terrain } from '../world/terrain'
import type { Weather } from '../world/weather'
import type { FlowField } from './pathfind'
import type { Mods } from './mods'

/** A body left on the field (render-only, capped). */
export interface Corpse {
  x: number; z: number; y: number
  facing: number
  team: Team
  deadT: number
  seed: number
  mounted: boolean
}

export interface ActiveOrders {
  coverT: number      // seconds remaining
  rapidT: number
  bayonetT: number
  cooldowns: { takecover: number; rapidfire: number; bayonets: number; flare: number; barrage: number; marktank: number }
}

export interface SimState {
  seed: number
  /** Which game this is: the classic defence campaign or the Big Push. */
  mode: 'classic' | 'bigpush'
  time: number
  /** Fixed 30 Hz tick counter. Commands are stamped with and applied at ticks. */
  tick: number
  wave: number
  phase: GamePhase
  /** Run configuration; sim data so twin sims and replays agree. */
  difficulty: Difficulty
  endless: boolean
  outcome: MatchOutcome
  buildTimer: number
  req: number
  breach: number            // 0..COMBAT.breachMax; 0 = the line is broken
  masksOn: boolean
  /** The German commander's respirator order (Big Push). */
  germanMasksOn: boolean
  /**
   * Soldier id the player is embodying in first person (-1 = none). The AI
   * must not move, pose or fire this man — the player does. SIM STATE (set
   * only by the possess/release commands, hashed): every lockstep peer and
   * every replay must agree on whose trigger the sim doesn't pull.
   */
  possessedSoldierId: number
  /**
   * Unit id whose weapon the player is operating in first person (-1 =
   * none). The whole unit stands down from auto-firing — the player is the
   * gunner; other crew merely feed and load. Also gates a manned medic's or
   * sapper's automatic work. Commanded and hashed like possessedSoldierId.
   */
  possessedUnitId: number
  /** Requisition banked by calling the wave early; paid out at wave end. */
  earlyCallBonus: number
  /** Big Push: the German commander's purse — a human's or the AI's. */
  germanReq: number
  /**
   * The German commander's stores and standing orders. Symmetric with
   * `upgrades`/`orders` above, which are the British commander's: in the Big
   * Push each side buys its own doctrine and runs its own cooldowns, so
   * neither can spend or trip the other's. Unused in classic mode.
   */
  germanUpgrades: Set<string>
  germanOrders: ActiveOrders
  /** Big Push battalion strength per side — a loss condition AND the clock. */
  strength: { brit: number; german: number }
  /** Big Push match setup: length id and the whistle (sim seconds; 0 = untimed). */
  matchLen: MatchLength
  timeLimit: number
  /** Attrition: continuous seconds each side has held a majority of the
   *  ENEMY's front-line sections. */
  holdT: { brit: number; german: number }
  /**
   * Farthest-forward living soldier per side along the advance axis
   * (brit advances toward -z so this is a min; german a max). Floors at each
   * side's own front-trench line. Feeds the Big Push camera leash.
   */
  advance: { brit: number; german: number }

  units: Unit[]
  enemies: Enemy[]
  squads: Squad[]
  /** Big Push assault groups (either side). */
  assaults: AssaultGroup[]
  vehicles: Vehicle[]
  projectiles: Projectile[]
  /** In-flight small-arms rounds, physically integrated each tick. */
  bullets: Bullet[]
  clouds: GasCloud[]
  defences: Defence[]
  corpses: Corpse[]
  sections: TrenchSection[]

  /** Presentation queues, drained each render frame. */
  fx: FxEvent[]
  sounds: SoundEvent[]

  orders: ActiveOrders
  upgrades: Set<string>
  director: DirectorMemory
  stats: RunStats
  casualties: CasualtyRecord[]

  /** Currently running wave plan (assault phase). */
  plan: WavePlan | null
  planCursor: number        // next spawn index
  planBarrageCursor: number
  waveStartTime: number

  /** Active off-map barrage shoots + each commander's creeping barrage (was
   *  module state in barrage.ts — moved here so saves/twin-sims see it).
   *  At most one curtain per side is ever in `creepings`. */
  barrages: ActiveBarrage[]
  creepings: CreepingBarrage[]
  /** Gas-gong pacing (was module state in gas.ts). */
  gasAlarmCooldown: number
  /** Terrain-wetness push cadence (wetness changes mud → sim-affecting). */
  wetnessTimer: number
  /** Last sim time the flow fields were rebuilt (rebuild cadence is sim). */
  lastFlowRebuild: number

  nextId: number
}

export interface Ctx {
  s: SimState
  terrain: Terrain
  weather: Weather
  flowInf: FlowField
  flowVeh: FlowField
  events: EventBus
  rand: Rand
  /** The British commander's upgrade-derived modifiers. Reach for it through
   *  `modsOf(ctx, side)` in anything that can run for either side. */
  mods: Mods
  /** The German commander's — his own stores, his own multipliers. */
  modsGerman: Mods
  /** Set true by anything that invalidates pathing; game rebuilds flow on a cadence. */
  flowDirty: boolean
  /** Difficulty knobs resolved at run start. */
  night: boolean
  /**
   * FPS Lab only: while true, the possessed soldier can be hit (so hurt feedback
   * still fires) but is never dropped below a sliver of hp — killSoldier never
   * runs on him, so a lethal round can't leave him stuck in the 'dead' stance
   * with a corpse under the camera. FpsMode mirrors its `debugInvincible` here
   * each frame and tops his hp back up. Always false in a normal game.
   */
  fpsInvincible: boolean
  /**
   * Transient first-person feedback for the embodied player: hit/kill
   * confirmations on rounds the possessed soldier fired, and directional
   * "you were hit from over there" signals when he is the one struck. This
   * lives on `Ctx`, NOT `SimState` — it is pure presentation bookkeeping,
   * drained (and fully cleared) by FpsMode every render frame, and must
   * never be part of a save or a deterministic replay. Push through
   * `pushFpsFeedback` below, which is the natural `possessedSoldierId`-gated
   * choke point.
   */
  fpsFeedback: FpsFeedbackEvent[]
}

export function makeStats(): RunStats {
  return { kills: 0, losses: 0, shellsFired: 0, gasClouds: 0, sectionsLost: 0, reqEarned: 0, score: 0 }
}

export function makeDirector(): DirectorMemory {
  return { dmgByCategory: {}, lossesLastWave: 0, playerLossesLastWave: 0, wireDensity: 0 }
}

/** A side's standing orders — a fresh, quiet set. */
export function makeOrders(): ActiveOrders {
  return {
    coverT: 0, rapidT: 0, bayonetT: 0,
    cooldowns: { takecover: 0, rapidfire: 0, bayonets: 0, flare: 0, barrage: 0, marktank: 0 },
  }
}

// -- tiny helpers used across systems ---------------------------------------

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz
  return dx * dx + dz * dz
}

export function fx(s: SimState, e: FxEvent): void {
  if (s.fx.length < 400) s.fx.push(e)
}

export function snd(s: SimState, e: SoundEvent): void {
  if (s.sounds.length < 120) s.sounds.push(e)
}

/**
 * Queue one first-person feedback event for the embodied player. Capped like
 * `fx`/`snd` above so a wild frame (a burst that lands several confirmed
 * hits, or the rare case a drain gets skipped) can never grow this past a
 * HUD's worth of events — FpsMode empties it completely every render frame
 * regardless, so in the ordinary case this never gets anywhere near the cap.
 */
export function pushFpsFeedback(ctx: Ctx, e: FpsFeedbackEvent): void {
  if (ctx.fpsFeedback.length < 16) ctx.fpsFeedback.push(e)
}

/**
 * All living soldiers of a team. Both pools are searched: a team's men are its
 * units' crews AND (for the Germans in classic wave-defence) the loose enemy
 * soldiers. In the Big Push the enemy pool is empty and both sides are units.
 */
export function* livingSoldiers(s: SimState, team: Team): Generator<import('../core/types').Soldier> {
  for (const u of s.units) {
    if (u.disbanded || u.side !== team) continue
    for (const c of u.crew) if (c.hp > 0) yield c
  }
  if (team === 'german') {
    for (const e of s.enemies) if (e.hp > 0) yield e
  }
}

// ---------------------------------------------------------------------------
// Per-side lookups. Both commanders keep their own purse, stores and standing
// orders; every sim system that can run for either side reads through these
// rather than reaching for the British field directly.
// ---------------------------------------------------------------------------

export function reqOf(s: SimState, side: Team): number {
  return side === 'brit' ? s.req : s.germanReq
}

/** Move `delta` requisition into (or out of) a side's purse. */
export function addReq(ctx: Ctx, side: Team, delta: number): void {
  const s = ctx.s
  if (side === 'brit') {
    s.req += delta
    ctx.events.emit('reqChanged', { req: s.req })
  } else {
    s.germanReq += delta
    ctx.events.emit('reqChanged', { req: s.germanReq, side })
  }
}

export function upgradesOf(s: SimState, side: Team): Set<string> {
  return side === 'brit' ? s.upgrades : s.germanUpgrades
}

export function ordersOf(s: SimState, side: Team): ActiveOrders {
  return side === 'brit' ? s.orders : s.germanOrders
}

export function modsOf(ctx: Ctx, side: Team): Mods {
  return side === 'brit' ? ctx.mods : ctx.modsGerman
}

/** The side a soldier is fighting against. */
export function opposing(side: Team): Team {
  return side === 'brit' ? 'german' : 'brit'
}

/**
 * Every living soldier hostile to `side`, wherever he is kept — the opposing
 * commander's unit crews, plus the loose enemy pool when the Germans are the
 * hostiles. This is THE faction question in targeting, melee and flame, and
 * having one answer is what keeps both sides fighting the same war.
 */
export function* hostileSoldiers(s: SimState, side: Team): Generator<import('../core/types').Soldier> {
  yield* livingSoldiers(s, opposing(side))
}
