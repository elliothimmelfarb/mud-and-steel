/**
 * Artillery beyond the horizon: enemy preparatory barrages (with warning —
 * listen for the whistles), gas shoots, and your own creeping barrage that
 * walks a curtain of shellfire north across no-man's land.
 *
 * All barrage state lives on SimState (s.barrages / s.creeping) — never at
 * module level — so saves, twin sims and lockstep replays all see it.
 */
import type { Team } from '../core/types'
import { CREEP, WORLD } from '../core/config'
import { gauss } from '../core/rng'
import { snd, type Ctx } from './sim'
import { spawnBarrageShell } from './projectiles'

export function updateBarrages(ctx: Ctx, dt: number, elapsed: number): void {
  const { s } = ctx
  const plan = s.plan
  const active = s.barrages

  // Kick off scheduled enemy barrages.
  if (plan) {
    while (s.planBarrageCursor < plan.barrages.length && plan.barrages[s.planBarrageCursor].at <= elapsed) {
      const b = plan.barrages[s.planBarrageCursor++]
      active.push({ x: b.x, z: b.z, shellsLeft: b.shells, gas: b.gas, t: -6.5, interval: 0.75 })
      ctx.events.emit('barrageWarning', { x: b.x, z: b.z, seconds: 6.5 })
      // The far-off guns speak first.
      snd(s, { name: 'explosion_far', x: b.x, y: 30, z: WORLD.enemySpawnZ - 100, gain: 0.8 })
    }
  }

  for (let i = active.length - 1; i >= 0; i--) {
    const b = active[i]
    b.t += dt
    if (b.t < 0) continue
    if (b.t >= b.interval) {
      b.t = b.t % b.interval > 0.2 ? 0 : b.t - b.interval
      b.shellsLeft--
      const sx = b.x + gauss(ctx.rand, 0, 12)
      const sz = b.z + gauss(ctx.rand, 0, 9)
      spawnBarrageShell(ctx, 'german', sx, sz, b.gas ? 15 : 70, b.gas)
      if (b.shellsLeft <= 0) active.splice(i, 1)
    }
  }

  // Creeping barrages — one per commander, each walking toward the other.
  for (let i = s.creepings.length - 1; i >= 0; i--) {
    const creeping = s.creepings[i]
    const sign = creeping.side === 'brit' ? 1 : -1
    creeping.t -= dt
    if (creeping.t > 0) continue
    creeping.t = CREEP.interval
    creeping.volleys++
    for (let k = 0; k < CREEP.shellsPerVolley; k++) {
      const sx = creeping.x + gauss(ctx.rand, 0, CREEP.frontage / 2)
      spawnBarrageShell(ctx, creeping.side, sx, creeping.z + gauss(ctx.rand, 0, 4), 65, false)
    }
    // "North" is whichever way is away from the firer's own parapet.
    creeping.z -= CREEP.stepMetres * sign
    if (creeping.z * sign < CREEP.endZ) s.creepings.splice(i, 1)
  }
}

/**
 * The curtain. It starts just beyond your own wire and walks north at a man's
 * pace, so an assault ordered behind it arrives at the enemy parapet as the
 * last shells lift — that timing IS the mechanic. It is aimed at a FRONTAGE:
 * a hundred and thirty shells smeared across the whole map suppressed nobody.
 * It is also blind — it cuts your wire and theirs, and it will kill your own
 * men if they get ahead of it.
 */
export function startCreepingBarrage(ctx: Ctx, centreX: number, side: Team = 'brit'): void {
  const s = ctx.s
  // One curtain per commander; a second call while yours is walking is refused
  // (the cooldown normally prevents it, but a replayed command must not stack).
  if (s.creepings.some((c) => c.side === side)) return
  const sign = side === 'brit' ? 1 : -1
  const x = Math.max(-WORLD.width / 2 + 20, Math.min(WORLD.width / 2 - 20, centreX))
  s.creepings.push({ side, x, z: CREEP.startZ * sign, t: 0.2, volleys: 0 })
  ctx.events.emit('toast', {
    text: 'Creeping barrage — walking out at a man\'s pace. Follow it in.', kind: 'info', side,
  })
  snd(s, { name: 'whistle_attack', x, y: 2, z: 100 * sign, gain: 0.8 })
}

/** Where a side's curtain stands right now, for the follow-the-barrage read. */
export function creepingLineZ(ctx: Ctx, side: Team = 'brit'): number | null {
  const c = ctx.s.creepings.find((b) => b.side === side)
  return c ? c.z : null
}

export function barrageIncoming(ctx: Ctx): boolean {
  return ctx.s.barrages.some((b) => b.t < 0) // warning phase
}

export function anyBarrageActive(ctx: Ctx): boolean {
  return ctx.s.barrages.length > 0 || ctx.s.creepings.length > 0
}
