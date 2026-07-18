/**
 * Sim state container + the shared context handed to every sim system.
 * Deliberately no spatial index: entity caps (~200 enemies, ~40 units) keep
 * brute-force queries cheap at 30 Hz and the code honest.
 */
import type {
  ActiveBarrage, Bullet, CasualtyRecord, CreepingBarrage, Defence, Difficulty, DirectorMemory, Enemy,
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
  /** Requisition banked by calling the wave early; paid out at wave end. */
  earlyCallBonus: number
  /** Big Push: the German commander's purse (the AI spends it from M4). */
  germanReq: number
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

  /** Active enemy barrage shoots + the player's creeping barrage (was module
   *  state in barrage.ts — moved here so saves/twin-sims see it). */
  barrages: ActiveBarrage[]
  creeping: CreepingBarrage | null
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
  mods: Mods
  /** Set true by anything that invalidates pathing; game rebuilds flow on a cadence. */
  flowDirty: boolean
  /** Difficulty knobs resolved at run start. */
  night: boolean
  /**
   * Soldier id the player is currently embodying in first person (-1 = none).
   * The AI must not move, pose or fire this man — the player does.
   */
  possessedSoldierId: number
  /**
   * Unit id whose weapon the player is currently operating in first person
   * (-1 = none). The whole unit stands down from auto-firing — the player is
   * the gunner now; other crew merely feed and load. Also gates a manned
   * medic/sapper's automatic healing/repair, which the player performs by hand.
   */
  possessedUnitId: number
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

/** All living soldiers of a team (units' crews or enemies). */
export function* livingSoldiers(s: SimState, team: Team): Generator<import('../core/types').Soldier> {
  if (team === 'brit') {
    for (const u of s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) if (c.hp > 0) yield c
    }
  } else {
    for (const e of s.enemies) if (e.hp > 0) yield e
  }
}
