/**
 * Armour: enemy Panzerwagen armoured cars and A7V assault tanks, plus your
 * call-in Mark IV. Vehicles crush wire flat, shrug off rifle fire, stand off
 * at the trench line, and — because this is Flanders — bog down in flooded
 * shell holes.
 */
import type { Soldier, Vehicle, VehicleKindId } from '../core/types'
import { MINE_DAMAGE, MINE_RADIUS, VEHICLE_DEFS, WORLD } from '../core/config'
import { dist2, fx, snd, type Ctx } from './sim'
import { damageVehicle, explode, fireSmallArms } from './combat'
import { spawnTankShell } from './projectiles'

const _dir = { x: 0, z: 0 }

/** Phantom gunners so vehicle MGs can reuse the small-arms pipeline. */
const gunners = new Map<number, Soldier>()

export function spawnVehicle(ctx: Ctx, kind: VehicleKindId, x: number, z: number): Vehicle {
  const def = VEHICLE_DEFS[kind]
  const team = kind === 'friendlytank' ? 'brit' : 'german'
  const v: Vehicle = {
    id: ctx.s.nextId++,
    kind, team,
    pos: { x, z },
    facing: team === 'german' ? Math.PI : 0,
    hp: def.hp, maxHp: def.hp,
    armour: def.armour,
    speed: def.speed,
    bogged: false, boggedT: 0,
    cooldownMain: 2 + ctx.rand() * 3,
    cooldownMG: 1 + ctx.rand() * 2,
    dead: false, burnT: 0,
  }
  ctx.s.vehicles.push(v)
  gunners.set(v.id, {
    id: -v.id, team, pos: v.pos, facing: v.facing, hp: 1, maxHp: 1,
    stance: 'stand', suppression: 0, morale: 1, masked: true, gasExposure: 0,
    animPhase: 0, cooldown: 0, name: { first: '', last: '' }, kills: 0,
  })
  if (kind === 'etank') ctx.events.emit('tankSighted', {})
  return v
}

export function updateVehicles(ctx: Ctx, dt: number): void {
  const { s } = ctx
  let w = 0
  for (let i = 0; i < s.vehicles.length; i++) {
    const v = s.vehicles[i]
    if (v.dead) {
      v.burnT -= dt
      if (v.burnT > -300) { s.vehicles[w++] = v } // wrecks persist as scenery
      else gunners.delete(v.id)
      continue
    }
    updateVehicle(ctx, v, dt)
    s.vehicles[w++] = v
  }
  s.vehicles.length = w
}

function updateVehicle(ctx: Ctx, v: Vehicle, dt: number): void {
  const { s } = ctx
  const def = VEHICLE_DEFS[v.kind]
  v.cooldownMain -= dt
  v.cooldownMG -= dt

  if (v.bogged) {
    v.boggedT -= dt
    if (ctx.rand() < dt * 0.5) {
      fx(s, { t: 'dirt', x: v.pos.x, y: ctx.terrain.heightAt(v.pos.x, v.pos.z) + 0.3, z: v.pos.z, amount: 0.6 })
    }
    if (v.boggedT <= 0) v.bogged = false
  } else {
    moveVehicle(ctx, v, def.speed, dt)
  }

  // Crush wire under the tracks (yours or theirs — steel doesn't ask),
  // and detonate any mine unlucky enough to be under them.
  for (const d of s.defences) {
    if (d.hp <= 0) continue
    if (d.kind === 'wire' && dist2(d.pos.x, d.pos.z, v.pos.x, v.pos.z) < 3 * 3) {
      d.hp = 0
      fx(s, { t: 'wiresnap', x: d.pos.x, y: ctx.terrain.heightAt(d.pos.x, d.pos.z) + 0.3, z: d.pos.z })
      ctx.flowDirty = true
    } else if (d.kind === 'mine' && v.team === 'german' && dist2(d.pos.x, d.pos.z, v.pos.x, v.pos.z) < 2.6 * 2.6) {
      d.hp = 0
      explode(ctx, d.pos.x, d.pos.z, MINE_RADIUS, MINE_DAMAGE, { team: 'brit', category: 'mine' })
      // A mine under the tracks cripples even a tank for a while.
      v.bogged = true
      v.boggedT = 9 + ctx.rand() * 6
      damageVehicle(ctx, v, 160, 'mine', 'brit', -1)
    }
  }

  // Weapons.
  const gunner = gunners.get(v.id)
  if (!gunner) return
  gunner.pos = v.pos
  gunner.facing = v.facing

  if (def.mainDamage > 0 && v.cooldownMain <= 0) {
    const tgt = pickVehicleTarget(ctx, v, def.mainRange)
    if (tgt) {
      v.cooldownMain = 1 / def.mainRof
      spawnTankShell(ctx, v.team, v.pos.x, v.pos.z, tgt.pos.x, tgt.pos.z, def.mainDamage)
    }
  }
  if (def.mgDamage > 0 && v.cooldownMG <= 0) {
    const tgt = pickVehicleTarget(ctx, v, def.mgRange)
    if (tgt) {
      v.cooldownMG = 1 / def.mgRof
      gunner.facing = Math.atan2(tgt.pos.x - v.pos.x, -(tgt.pos.z - v.pos.z))
      fireSmallArms(ctx, {
        shooter: gunner, team: v.team,
        target: { kind: 'soldier', ref: tgt },
        damage: def.mgDamage, accuracy: 0.3, range: def.mgRange, suppress: 0.12,
        category: v.team === 'brit' ? 'mg' : 'enemy',
        shooterUnitId: -1, tracer: true, sound: 'mg',
      })
    }
  }
}

function moveVehicle(ctx: Ctx, v: Vehicle, speed: number, dt: number): void {
  let dx = 0, dz = 0
  if (v.team === 'german') {
    // Stand off just short of the wire line and pound the trenches.
    if (v.pos.z > WORLD.frontTrenchZ - 26) {
      turnToward(v, Math.PI, dt); return
    }
    ctx.flowVeh.dirAt(v.pos.x, v.pos.z, _dir)
    dx = _dir.x; dz = _dir.z
    if (dx === 0 && dz === 0) dz = 1
    // Near the map edge, pull hard back toward the field of battle.
    const margin = WORLD.width / 2 - 24
    if (v.pos.x < -margin) dx = Math.max(dx, 0.8)
    else if (v.pos.x > margin) dx = Math.min(dx, -0.8)
  } else {
    // Mark IV: through the line and out into no-man's land, then hold.
    if (v.pos.z < -55) { turnToward(v, Math.PI, dt); return }
    dz = -1
    // Gentle weave toward the thickest cluster of enemies.
    let bestX = v.pos.x, best = 0
    for (const e of ctx.s.enemies) {
      if (e.hp <= 0) continue
      let n = 0
      for (const o of ctx.s.enemies) {
        if (o.hp > 0 && Math.abs(o.pos.x - e.pos.x) < 15) n++
      }
      if (n > best) { best = n; bestX = e.pos.x }
    }
    dx = Math.max(-0.4, Math.min(0.4, (bestX - v.pos.x) * 0.02))
  }

  const want = Math.atan2(dx, -dz)
  turnToward(v, want, dt)
  // Only advance roughly along the hull axis (tracked vehicles pivot slowly).
  let diff = want - v.facing
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  if (Math.abs(diff) > 0.7) return

  const mud = 1 - ctx.terrain.mudAt(v.pos.x, v.pos.z) * 0.5
  const trench = ctx.terrain.trenchAt(v.pos.x, v.pos.z) > 0.4 ? 0.45 : 1
  const sp = speed * mud * trench * dt
  const nx = v.pos.x + Math.sin(v.facing) * sp
  const nz = v.pos.z - Math.cos(v.facing) * sp

  // Tank traps are a wall.
  for (const d of ctx.s.defences) {
    if (d.kind !== 'tanktrap' || d.hp <= 0) continue
    if (dist2(d.pos.x, d.pos.z, nx, nz) < 3.2 * 3.2) return
  }
  // Deep flooded craters can swallow a tank.
  if (ctx.terrain.floodedAt(nx, nz) && ctx.terrain.craterDepthAt(nx, nz) > 0.8 && !v.bogged) {
    if (ctx.rand() < 0.35) {
      v.bogged = true
      v.boggedT = 7 + ctx.rand() * 7
      snd(ctx.s, { name: 'splash', x: nx, y: 0, z: nz, gain: 0.9 })
      ctx.events.emit('toast', { text: `${VEHICLE_DEFS[v.kind].name} bogged in the mud!`, kind: v.team === 'brit' ? 'warn' : 'good' })
    }
  }
  // Never off the edge of the world.
  v.pos.x = Math.max(-WORLD.width / 2 + 6, Math.min(WORLD.width / 2 - 6, nx))
  v.pos.z = Math.max(-WORLD.depth / 2 + 6, Math.min(WORLD.depth / 2 - 6, nz))
}

function turnToward(v: Vehicle, want: number, dt: number): void {
  let diff = want - v.facing
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  const rate = 0.5 * dt
  v.facing += Math.max(-rate, Math.min(rate, diff))
}

function pickVehicleTarget(ctx: Ctx, v: Vehicle, range: number): Soldier | null {
  let best: Soldier | null = null
  let bestD = range * range
  if (v.team === 'german') {
    for (const u of ctx.s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) {
        if (c.hp <= 0) continue
        const d = dist2(c.pos.x, c.pos.z, v.pos.x, v.pos.z)
        if (d < bestD) { bestD = d; best = c }
      }
    }
  } else {
    for (const e of ctx.s.enemies) {
      if (e.hp <= 0 || e.behavior === 'rout') continue
      const d = dist2(e.pos.x, e.pos.z, v.pos.x, v.pos.z)
      if (d < bestD) { bestD = d; best = e }
    }
  }
  return best
}
