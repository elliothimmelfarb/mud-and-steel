/**
 * Veterancy: the one place experience turns into rank and rank turns into
 * modest, legible perks. Experience is carried by the Unit (the crew/position
 * is the veteran entity, embodied by its senior surviving man); kills, waves
 * survived, and deeds all pour into the same pool. Deeds are recorded as bits
 * on Unit.deeds and cited by name in letters home and on the Roll of Honour.
 *
 * Numbers live in core/config.ts. Keep per-tick cost negligible: nothing here
 * allocates, and deed checks are gated behind a per-unit cooldown so they fire
 * at most a few times a second, not every frame.
 */
import type { Unit, VeterancyLevel } from '../core/types'
import {
  DEEDS, RANKS, VET_XP, XP_PER_DEED,
  VET_RALLY_BONUS, VET_SUPPRESS_RESIST,
} from '../core/config'
import type { Ctx } from './sim'

/** Rank a given experience total earns. */
export function rankForXp(xp: number): VeterancyLevel {
  let lvl = 0
  for (let i = 0; i < VET_XP.length; i++) if (xp >= VET_XP[i]) lvl = i + 1
  return lvl as VeterancyLevel
}

/**
 * Add experience to a position and promote if a threshold is crossed. Emits
 * `promoted` once per rank gained so the HUD can announce it. Safe to call with
 * amount 0.
 */
export function awardXp(ctx: Ctx, u: Unit, amount: number): void {
  if (amount <= 0 || u.disbanded) return
  u.xp += amount
  const lvl = rankForXp(u.xp)
  if (lvl > u.vet) {
    u.vet = lvl
    ctx.events.emit('promoted', { unitId: u.id, vet: lvl })
  }
}

/**
 * Record a deed by its config id, once per position. New deeds earn a despatch
 * mention (XP + a `deed` event for the toast); repeats are silently ignored so
 * the same man is not decorated twice for the same thing.
 */
export function recordDeed(ctx: Ctx, u: Unit, id: string): void {
  if (u.disbanded) return
  const def = DEEDS.find((d) => d.id === id)
  if (!def || (u.deeds & def.bit) !== 0) return
  u.deeds |= def.bit
  awardXp(ctx, u, XP_PER_DEED)
  ctx.events.emit('deed', { unitId: u.id, deed: def.id, cite: def.cite })
}

/** Has this position already been cited for the given deed id? */
export function hasDeed(u: Unit, id: string): boolean {
  const def = DEEDS.find((d) => d.id === id)
  return !!def && (u.deeds & def.bit) !== 0
}

/** The senior surviving man of a position — the named veteran shown in the UI. */
export function leadCrew(u: Unit): Unit['crew'][number] | null {
  for (const c of u.crew) if (c.hp > 0) return c
  return u.crew[0] ?? null
}

// -- Perk accessors (small, legible bonuses) --------------------------------

/** Suppression clears this much faster per rank; also damps how fast it builds. */
export function suppressResistMult(vet: number): number {
  return 1 + vet * VET_SUPPRESS_RESIST
}

/** Morale regenerates this much faster per rank. */
export function rallyMult(vet: number): number {
  return 1 + vet * VET_RALLY_BONUS
}

/** Human-readable rank abbreviation. */
export function rankLabel(vet: number): string {
  return RANKS[vet] ?? RANKS[0]
}
