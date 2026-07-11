/**
 * Sim state container + the shared context handed to every sim system.
 * Deliberately no spatial index: entity caps (~200 enemies, ~40 units) keep
 * brute-force queries cheap at 30 Hz and the code honest.
 */
import type {
  CasualtyRecord, Defence, DirectorMemory, Enemy, FxEvent, GamePhase, GasCloud,
  Projectile, RunStats, SoundEvent, Squad, Team, TrenchSection, TrenchSlot,
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
  time: number
  wave: number
  phase: GamePhase
  buildTimer: number
  req: number
  breach: number            // 0..COMBAT.breachMax; 0 = the line is broken
  masksOn: boolean

  units: Unit[]
  enemies: Enemy[]
  squads: Squad[]
  vehicles: Vehicle[]
  projectiles: Projectile[]
  clouds: GasCloud[]
  defences: Defence[]
  corpses: Corpse[]
  sections: TrenchSection[]
  slots: TrenchSlot[]

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

  /** In-flight small-arms fire: resolves after travel time. */
  pendingShots: PendingShot[]

  nextId: number
}

export interface PendingShot {
  t: number                  // sim time when the round arrives
  targetKind: 'soldier' | 'vehicle'
  targetId: number
  hit: boolean
  damage: number
  category: string           // director bookkeeping
  team: Team                 // shooter's team
  // impact point (for misses: dirt + suppression)
  x: number; y: number; z: number
  shooterUnitId: number      // for XP credit (-1 for enemies)
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
