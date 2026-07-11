/**
 * Everything that flies in an arc: mortar bombs, field-gun shells, grenades,
 * gas drums, parachute flares, and the shells of off-map barrages. True
 * ballistic integration; the whistle you hear is timed to the impact you get.
 */
import type { Projectile, ProjectileKind, Soldier, Team, Unit } from '../core/types'
import { WORLD } from '../core/config'
import { fx, snd, type Ctx } from './sim'
import { explode } from './combat'
import type { Target } from './soldiers'
import { createGasCloud } from './gas'

const G = 9.81

function push(ctx: Ctx, p: Omit<Projectile, 'id'>): Projectile {
  const proj = { ...p, id: ctx.s.nextId++ }
  ctx.s.projectiles.push(proj)
  return proj
}

/** Solve a lobbed trajectory that lands at (tx,tz) after T seconds. */
function lob(ctx: Ctx, kind: ProjectileKind, team: Team, fromX: number, fromZ: number, fromY: number,
  tx: number, tz: number, T: number, radius: number, damage: number, unitId: number): Projectile {
  const ty = ctx.terrain.heightAt(tx, tz)
  return push(ctx, {
    kind, team,
    pos: { x: fromX, y: fromY, z: fromZ },
    vel: {
      x: (tx - fromX) / T,
      y: (ty - fromY) / T + 0.5 * G * T,
      z: (tz - fromZ) / T,
    },
    radius, damage, timer: 0, sourceUnitId: unitId,
  })
}

// ---------------------------------------------------------------------------
// Spawners
// ---------------------------------------------------------------------------

export function spawnGrenade(ctx: Ctx, thrower: Soldier, tx: number, tz: number, damage: number, aoe: number, unitId: number): void {
  const scatter = 1.5 + ctx.rand() * 2
  const ang = ctx.rand() * Math.PI * 2
  const ax = tx + Math.cos(ang) * scatter * ctx.rand()
  const az = tz + Math.sin(ang) * scatter * ctx.rand()
  const d = Math.hypot(ax - thrower.pos.x, az - thrower.pos.z)
  const T = 0.9 + d * 0.045
  const y = ctx.terrain.heightAt(thrower.pos.x, thrower.pos.z) + 1.6
  lob(ctx, 'grenade', thrower.team, thrower.pos.x, thrower.pos.z, y, ax, az, T, aoe, damage, unitId)
  snd(ctx.s, { name: 'whistle_attack', x: thrower.pos.x, y, z: thrower.pos.z, gain: 0.15, rate: 1.6 })
}

export function spawnMortarBomb(ctx: Ctx, u: Unit, target: Target, damage: number, aoe: number, unitId: number): void {
  const tp = target.ref.pos
  const scatter = (4 + ctx.rand() * 6) * ctx.mods.indirectScatter
  const ang = ctx.rand() * Math.PI * 2
  const tx = tp.x + Math.cos(ang) * scatter
  const tz = tp.z + Math.sin(ang) * scatter
  const d = Math.hypot(tx - u.pos.x, tz - u.pos.z)
  const T = 2.4 + d * 0.012
  const y = ctx.terrain.heightAt(u.pos.x, u.pos.z) + 0.8
  lob(ctx, 'mortarbomb', 'brit', u.pos.x, u.pos.z, y, tx, tz, T, aoe, damage, unitId)
  snd(ctx.s, { name: 'mortar_launch', x: u.pos.x, y, z: u.pos.z })
  snd(ctx.s, { name: 'shell_whistle', x: tx, y: 30, z: tz, dur: T * 0.85, gain: 0.5 })
  fx(ctx.s, { t: 'smokepuff', x: u.pos.x, y: y + 0.6, z: u.pos.z, size: 1.2 })
}

export function spawnShell(ctx: Ctx, u: Unit, target: Target, damage: number, aoe: number, unitId: number): void {
  const tp = target.ref.pos
  const lead = target.kind === 'vehicle' ? 1.5 : 0.5
  const scatter = 2.5 * ctx.mods.indirectScatter
  const tx = tp.x + (ctx.rand() - 0.5) * scatter
  const tz = tp.z + (ctx.rand() - 0.5) * scatter - lead
  const d = Math.hypot(tx - u.pos.x, tz - u.pos.z)
  const T = Math.max(0.5, d / 160) // flat, fast
  const y = ctx.terrain.heightAt(u.pos.x, u.pos.z) + 1.1
  lob(ctx, 'shell', 'brit', u.pos.x, u.pos.z, y, tx, tz, T, aoe, damage, unitId)
}

export function spawnTankShell(ctx: Ctx, team: Team, fromX: number, fromZ: number, tx: number, tz: number, damage: number): void {
  const d = Math.hypot(tx - fromX, tz - fromZ)
  const T = Math.max(0.4, d / 140)
  const y = ctx.terrain.heightAt(fromX, fromZ) + 1.8
  lob(ctx, 'tankshell', team, fromX, fromZ, y, tx + (ctx.rand() - 0.5) * 4, tz + (ctx.rand() - 0.5) * 4, T, 5, damage, -1)
  snd(ctx.s, { name: 'fieldgun', x: fromX, y, z: fromZ, gain: 0.8, rate: 1.15 })
}

export function spawnGasShell(ctx: Ctx, fromX: number, fromZ: number, tx: number, tz: number): void {
  const d = Math.hypot(tx - fromX, tz - fromZ)
  const T = 2.6 + d * 0.012
  const y = ctx.terrain.heightAt(fromX, fromZ) + 0.5
  lob(ctx, 'gasshell', 'brit', fromX, fromZ, y, tx, tz, T, 0, 0, -1)
  snd(ctx.s, { name: 'mortar_launch', x: fromX, y, z: fromZ, rate: 0.8, gain: 0.7 })
}

/** Barrage shell: arrives from the sky. team decides whose guns are talking. */
export function spawnBarrageShell(ctx: Ctx, team: Team, tx: number, tz: number, damage: number, gas: boolean): void {
  const T = 1.6 + ctx.rand() * 0.5
  const ty = ctx.terrain.heightAt(tx, tz)
  // Start high, offset upwind of the fall line so the arc reads.
  push(ctx, {
    kind: gas ? 'gasshell' : 'shell',
    team,
    pos: { x: tx + (ctx.rand() - 0.5) * 8, y: ty + 110, z: tz + (team === 'german' ? -25 : 25) },
    vel: { x: 0, y: (-110 + 0.5 * G * T * T) / T, z: (team === 'german' ? 25 : -25) / T },
    radius: gas ? 0 : 3.4,
    damage,
    timer: 0,
    sourceUnitId: -1,
  })
  snd(ctx.s, { name: 'shell_whistle', x: tx, y: ty + 40, z: tz, dur: T, gain: 0.9 })
}

export function spawnFlare(ctx: Ctx, x: number, z: number): void {
  const y = ctx.terrain.heightAt(x, z)
  push(ctx, {
    kind: 'flare', team: 'brit',
    pos: { x, y: y + 1, z },
    vel: { x: (ctx.rand() - 0.5) * 3, y: 42, z: (ctx.rand() - 0.5) * 3 },
    radius: 0, damage: 0,
    timer: 14, // burn seconds
    sourceUnitId: -1,
  })
  snd(ctx.s, { name: 'flare_pop', x, y: y + 2, z })
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

export function updateProjectiles(ctx: Ctx, dt: number): void {
  const { s } = ctx
  const wind = ctx.weather.state
  let w = 0
  for (let i = 0; i < s.projectiles.length; i++) {
    const p = s.projectiles[i]
    let alive = true

    if (p.kind === 'flare') {
      // Rocket up, then hang on the parachute and drift.
      p.vel.y -= G * dt * (p.vel.y > 0 ? 1 : 0.12)
      if (p.vel.y < -1.4) p.vel.y = -1.4
      p.pos.x += (p.vel.x + wind.windX * 0.5) * dt
      p.pos.z += (p.vel.z + wind.windZ * 0.5) * dt
      p.pos.y += p.vel.y * dt
      p.timer -= dt
      if (ctx.rand() < dt * 2) fx(s, { t: 'smokepuff', x: p.pos.x, y: p.pos.y + 0.5, z: p.pos.z, size: 0.7 })
      if (p.timer <= 0 || p.pos.y <= ctx.terrain.heightAt(p.pos.x, p.pos.z)) alive = false
    } else {
      p.vel.y -= G * dt
      p.pos.x += p.vel.x * dt
      p.pos.y += p.vel.y * dt
      p.pos.z += p.vel.z * dt
      const ground = ctx.terrain.heightAt(p.pos.x, p.pos.z)
      if (p.pos.y <= ground) {
        impact(ctx, p)
        alive = false
      } else if (Math.abs(p.pos.x) > WORLD.width || Math.abs(p.pos.z) > WORLD.depth) {
        alive = false
      }
    }
    if (alive) s.projectiles[w++] = p
  }
  s.projectiles.length = w
}

function impact(ctx: Ctx, p: Projectile): void {
  switch (p.kind) {
    case 'grenade':
      explode(ctx, p.pos.x, p.pos.z, p.radius, p.damage, {
        team: p.team, category: p.team === 'brit' ? 'rifle' : 'enemy', shooterUnitId: p.sourceUnitId,
      })
      break
    case 'mortarbomb':
      explode(ctx, p.pos.x, p.pos.z, p.radius, p.damage, {
        team: p.team, category: 'artillery', shooterUnitId: p.sourceUnitId,
        craterRadius: 2.1, craterDepth: 0.7,
      })
      break
    case 'shell':
      explode(ctx, p.pos.x, p.pos.z, p.radius, p.damage, {
        team: p.team, category: p.team === 'brit' ? 'artillery' : 'enemyart', shooterUnitId: p.sourceUnitId,
        craterRadius: 3.1, craterDepth: 1.1, big: true,
      })
      break
    case 'tankshell':
      explode(ctx, p.pos.x, p.pos.z, p.radius, p.damage, {
        team: p.team, category: p.team === 'brit' ? 'artillery' : 'enemyart',
        craterRadius: 1.6, craterDepth: 0.5,
      })
      break
    case 'gasshell': {
      snd(ctx.s, { name: 'gas_pop', x: p.pos.x, y: p.pos.y, z: p.pos.z })
      fx(ctx.s, { t: 'dirt', x: p.pos.x, y: p.pos.y + 0.3, z: p.pos.z, amount: 0.8 })
      createGasCloud(ctx, p.pos.x, p.pos.z, p.team)
      break
    }
    case 'flare':
      break
  }
}
