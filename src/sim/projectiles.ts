/**
 * Everything that flies in an arc: mortar bombs, field-gun shells, grenades,
 * gas drums, parachute flares, and the shells of off-map barrages. True
 * ballistic integration; the whistle you hear is timed to the impact you get.
 */
import type { Projectile, ProjectileKind, Soldier, Team, Unit, Vec3 } from '../core/types'
import { WORLD } from '../core/config'
import { fx, modsOf, snd, type Ctx } from './sim'
import { explode } from './combat'
import { G, terrainNormal } from './ballistics'
import type { Target } from './soldiers'
import { createGasCloud } from './gas'

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
  const g = lob(ctx, 'grenade', thrower.team, thrower.pos.x, thrower.pos.z, y, ax, az, T, aoe, damage, unitId)
  // Mills-bomb fuse keeps burning after the bounce: the grenade lands, then
  // skips and rolls (downhill, into trenches and shell holes) before it goes.
  g.timer = T + 0.9 + ctx.rand() * 0.8
  snd(ctx.s, { name: 'whistle_attack', x: thrower.pos.x, y, z: thrower.pos.z, gain: 0.15, rate: 1.6 })
}

export function spawnMortarBomb(ctx: Ctx, u: Unit, target: Target, damage: number, aoe: number, unitId: number): void {
  const tp = target.ref.pos
  const scatter = (4 + ctx.rand() * 6) * modsOf(ctx, u.side).indirectScatter
  const ang = ctx.rand() * Math.PI * 2
  const tx = tp.x + Math.cos(ang) * scatter
  const tz = tp.z + Math.sin(ang) * scatter
  const d = Math.hypot(tx - u.pos.x, tz - u.pos.z)
  const T = 2.4 + d * 0.012
  const y = ctx.terrain.heightAt(u.pos.x, u.pos.z) + 0.8
  lob(ctx, 'mortarbomb', u.side, u.pos.x, u.pos.z, y, tx, tz, T, aoe, damage, unitId)
  snd(ctx.s, { name: 'mortar_launch', x: u.pos.x, y, z: u.pos.z })
  snd(ctx.s, { name: 'shell_whistle', x: tx, y: 30, z: tz, dur: T * 0.85, gain: 0.5 })
  fx(ctx.s, { t: 'smokepuff', x: u.pos.x, y: y + 0.6, z: u.pos.z, size: 1.2 })
}

export function spawnShell(ctx: Ctx, u: Unit, target: Target, damage: number, aoe: number, unitId: number): void {
  const tp = target.ref.pos
  const lead = target.kind === 'vehicle' ? 1.5 : 0.5
  const scatter = 2.5 * modsOf(ctx, u.side).indirectScatter
  const tx = tp.x + (ctx.rand() - 0.5) * scatter
  // Lead the target along its axis of advance — which is +z for the men
  // coming at the British gun and -z for those coming at the German one.
  const tz = tp.z + (ctx.rand() - 0.5) * scatter + lead * (u.side === 'brit' ? 1 : -1)
  const d = Math.hypot(tx - u.pos.x, tz - u.pos.z)
  const T = Math.max(0.5, d / 160) // flat, fast
  const y = ctx.terrain.heightAt(u.pos.x, u.pos.z) + 1.1
  lob(ctx, 'shell', u.side, u.pos.x, u.pos.z, y, tx, tz, T, aoe, damage, unitId)
}

/**
 * Lob a mortar bomb to an EXPLICIT ground point — used when the player mans the
 * Stokes himself and drops it wherever his sight is laid, rather than onto an
 * AI-chosen target. Same arc, whistle and re-digging burst as the crewed gun.
 */
export function spawnMortarBombAt(
  ctx: Ctx, fromX: number, fromZ: number, fromY: number,
  tx: number, tz: number, damage: number, aoe: number, unitId: number, team: Team = 'brit',
): void {
  const d = Math.hypot(tx - fromX, tz - fromZ)
  const T = 2.4 + d * 0.012
  lob(ctx, 'mortarbomb', team, fromX, fromZ, fromY, tx, tz, T, aoe, damage, unitId)
  snd(ctx.s, { name: 'mortar_launch', x: fromX, y: fromY, z: fromZ })
  snd(ctx.s, { name: 'shell_whistle', x: tx, y: 30, z: tz, dur: T * 0.85, gain: 0.5 })
  fx(ctx.s, { t: 'smokepuff', x: fromX, y: fromY + 0.6, z: fromZ, size: 1.2 })
}

/**
 * A flat, fast field-gun shell fired straight down the player's line of sight.
 * Gravity still bites over the flight, but at 260 m/s the drop is a hand's
 * width at a hundred metres — you aim at what you mean to hit. The existing
 * projectile integrator resolves the armour/ground strike and the burst.
 */
export function spawnDirectShell(
  ctx: Ctx, fromX: number, fromY: number, fromZ: number,
  dirX: number, dirY: number, dirZ: number, speed: number,
  damage: number, aoe: number, unitId: number, team: Team = 'brit',
): void {
  push(ctx, {
    kind: 'shell', team,
    pos: { x: fromX, y: fromY, z: fromZ },
    vel: { x: dirX * speed, y: dirY * speed, z: dirZ * speed },
    radius: aoe, damage, timer: 0, sourceUnitId: unitId,
  })
}

export function spawnTankShell(ctx: Ctx, team: Team, fromX: number, fromZ: number, tx: number, tz: number, damage: number): void {
  const d = Math.hypot(tx - fromX, tz - fromZ)
  const T = Math.max(0.4, d / 140)
  const y = ctx.terrain.heightAt(fromX, fromZ) + 1.8
  lob(ctx, 'tankshell', team, fromX, fromZ, y, tx + (ctx.rand() - 0.5) * 4, tz + (ctx.rand() - 0.5) * 4, T, 5, damage, -1)
  snd(ctx.s, { name: 'fieldgun', x: fromX, y, z: fromZ, gain: 0.8, rate: 1.15 })
}

export function spawnGasShell(
  ctx: Ctx, fromX: number, fromZ: number, tx: number, tz: number, team: Team = 'brit',
): void {
  const d = Math.hypot(tx - fromX, tz - fromZ)
  const T = 2.6 + d * 0.012
  const y = ctx.terrain.heightAt(fromX, fromZ) + 0.5
  lob(ctx, 'gasshell', team, fromX, fromZ, y, tx, tz, T, 0, 0, -1)
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

export function spawnFlare(ctx: Ctx, x: number, z: number, team: Team = 'brit'): void {
  const y = ctx.terrain.heightAt(x, z)
  push(ctx, {
    kind: 'flare', team,
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

const _n: Vec3 = { x: 0, y: 1, z: 0 }

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
    } else if (p.kind === 'grenade') {
      // Rigid-body grenade: fly, bounce off the ground plane, roll downhill,
      // detonate on the fuse — wherever it has ended up by then.
      p.vel.y -= G * dt
      p.pos.x += p.vel.x * dt
      p.pos.y += p.vel.y * dt
      p.pos.z += p.vel.z * dt
      p.timer -= dt
      const ground = ctx.terrain.heightAt(p.pos.x, p.pos.z)
      if (p.pos.y <= ground) {
        p.pos.y = ground + 0.03
        terrainNormal(ctx.terrain, p.pos.x, p.pos.z, _n)
        const vDotN = p.vel.x * _n.x + p.vel.y * _n.y + p.vel.z * _n.z
        if (vDotN < -1.2) {
          // Bounce: reflect the normal component, scrub the tangential one.
          const rest = 0.34, fric = 0.62
          p.vel.x = (p.vel.x - 2 * vDotN * _n.x) * fric
          p.vel.y = (p.vel.y - 2 * vDotN * _n.y) * rest
          p.vel.z = (p.vel.z - 2 * vDotN * _n.z) * fric
          fx(s, { t: 'dirt', x: p.pos.x, y: p.pos.y, z: p.pos.z, amount: 0.15 })
        } else {
          // Resting contact: roll downhill, bleed speed to the mud.
          const damp = Math.max(0, 1 - 3.2 * dt)
          p.vel.x = p.vel.x * damp + _n.x * G * dt * 1.6
          p.vel.z = p.vel.z * damp + _n.z * G * dt * 1.6
          p.vel.y = 0
          if (Math.hypot(p.vel.x, p.vel.z) < 0.25) { p.vel.x = 0; p.vel.z = 0 }
        }
      }
      if (p.timer <= 0) {
        impact(ctx, p)
        alive = false
      }
    } else {
      p.vel.y -= G * dt
      p.pos.x += p.vel.x * dt
      p.pos.y += p.vel.y * dt
      p.pos.z += p.vel.z * dt
      const ground = ctx.terrain.heightAt(p.pos.x, p.pos.z)
      // Direct hits: flat-trajectory shells strike armour they pass through.
      if ((p.kind === 'shell' || p.kind === 'tankshell') && p.pos.y < ground + 4) {
        for (const v of s.vehicles) {
          if (v.dead || v.team === p.team) continue
          const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z
          if (dx * dx + dz * dz < 2.6 * 2.6 &&
              p.pos.y < ctx.terrain.heightAt(v.pos.x, v.pos.z) + 2.9) {
            impact(ctx, p)
            alive = false
            break
          }
        }
      }
      if (alive && p.pos.y <= ground) {
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
