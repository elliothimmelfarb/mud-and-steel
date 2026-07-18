/**
 * Artillery beyond the horizon: enemy preparatory barrages (with warning —
 * listen for the whistles), gas shoots, and your own creeping barrage that
 * walks a curtain of shellfire north across no-man's land.
 *
 * All barrage state lives on SimState (s.barrages / s.creeping) — never at
 * module level — so saves, twin sims and lockstep replays all see it.
 */
import { WORLD } from '../core/config'
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

  // Creeping barrage (player-owned).
  const creeping = s.creeping
  if (creeping) {
    creeping.t -= dt
    if (creeping.t <= 0) {
      creeping.t = 1.7
      creeping.volleys++
      for (let i = 0; i < 3; i++) {
        const sx = (ctx.rand() - 0.5) * 210
        spawnBarrageShell(ctx, 'brit', sx, creeping.z + gauss(ctx.rand, 0, 4), 65, false)
      }
      creeping.z -= 4.6
      if (creeping.z < -150) s.creeping = null
    }
  }
}

export function startCreepingBarrage(ctx: Ctx): void {
  ctx.s.creeping = { z: 52, t: 0.2, volleys: 0 }
  ctx.events.emit('toast', { text: 'Creeping barrage — walking north. Mind your wire.', kind: 'info' })
  snd(ctx.s, { name: 'whistle_attack', x: 0, y: 2, z: 100, gain: 0.8 })
}

export function barrageIncoming(ctx: Ctx): boolean {
  return ctx.s.barrages.some((b) => b.t < 0) // warning phase
}

export function anyBarrageActive(ctx: Ctx): boolean {
  return ctx.s.barrages.length > 0 || ctx.s.creeping !== null
}
