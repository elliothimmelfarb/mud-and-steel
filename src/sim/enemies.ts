/**
 * The attacking army. Squads advance by bounds along the flow field, go to
 * ground in shell holes when suppressed (your own barrages dig their cover),
 * cut wire, set up machine guns, gas out, break and rout when morale fails,
 * and fight into the trenches to capture sections.
 */
import type { Enemy, EnemyKindId, Soldier, Squad, Unit } from '../core/types'
import { COMBAT, ENEMY_DEFS, MINE_DAMAGE, MINE_RADIUS, WIRE_SEGMENT_LEN, WORLD } from '../core/config'
import { dist2, fx, snd, type Ctx } from './sim'
import { combatStance, damageSoldier, explode, fireSmallArms, soldierUpkeep } from './combat'
import { flameCone } from './soldiers'
import { spawnGrenade } from './projectiles'
import { sectionAt } from './trench'

const _dir = { x: 0, z: 0 }

export function spawnEnemy(ctx: Ctx, kind: EnemyKindId, x: number, z: number, squadId: number): Enemy {
  const def = ENEMY_DEFS[kind]
  const e: Enemy = {
    id: ctx.s.nextId++,
    team: 'german',
    kind,
    pos: { x, z },
    facing: Math.PI, // south, toward the player... facing 0=north; enemies face south = π
    hp: def.hp, maxHp: def.hp,
    stance: 'stand',
    suppression: 0,
    morale: 0.85 + ctx.rand() * 0.15,
    masked: ctx.s.wave >= 9, // gas discipline improves as the war grinds on
    gasExposure: 0,
    animPhase: ctx.rand() * 10,
    cooldown: ctx.rand() * 2,
    name: { first: '', last: '' },
    kills: 0,
    squadId,
    behavior: kind === 'estorm' || kind === 'ecav' ? 'rush' : 'advance',
    behaviorT: 0,
    coverTarget: null,
    speedMul: 0.92 + ctx.rand() * 0.16,
    bounty: def.bounty,
    mounted: kind === 'ecav',
  }
  ctx.s.enemies.push(e)
  return e
}

export function updateEnemies(ctx: Ctx, dt: number): void {
  const { s } = ctx

  // Officer auras.
  const officers: Array<{ x: number; z: number }> = []
  for (const e of s.enemies) {
    if (e.hp > 0 && e.kind === 'eofficer') officers.push({ x: e.pos.x, z: e.pos.z })
  }

  let w = 0
  for (let i = 0; i < s.enemies.length; i++) {
    const e = s.enemies[i]
    if (e.hp <= 0) continue // corpse already recorded by combat
    const officerNear = officers.some((o) => dist2(o.x, o.z, e.pos.x, e.pos.z) < 18 * 18)
    soldierUpkeep(ctx, e, dt, officerNear, false)

    // Rout check.
    if (e.behavior !== 'rout' && e.morale < COMBAT.moraleBreak) {
      e.behavior = 'rout'
      e.coverTarget = null
    }

    updateEnemy(ctx, e, dt, officerNear)

    // Routed men fade once they're clear of the fight; men over the breach line score.
    if (e.behavior === 'rout' && e.pos.z < 0) continue
    if (e.pos.z > WORLD.breachZ) {
      s.breach = Math.max(0, s.breach - COMBAT.breachPerEnemy)
      ctx.events.emit('toast', { text: 'They are through the line!', kind: 'danger' })
      continue
    }
    s.enemies[w++] = e
  }
  s.enemies.length = w
}

function updateEnemy(ctx: Ctx, e: Enemy, dt: number, officerNear: boolean): void {
  const { s } = ctx
  const def = ENEMY_DEFS[e.kind]
  if (e.cooldown > 0) e.cooldown -= dt
  // Decay below zero (bounded) — 'firing' MGs wait for behaviorT <= -6 to
  // pack up when targetless; clamping at 0 would strand them forever.
  if (e.behaviorT > -30) e.behaviorT -= dt

  const inTrench = ctx.terrain.trenchAt(e.pos.x, e.pos.z) > 0.45
  combatStance(e, inTrench, false)

  // Mines don't care which way a man is walking — advancing, mopping up,
  // or running for home through his own footsteps.
  const mine = nearestDefence(ctx, e.pos.x, e.pos.z, 'mine', 1.4)
  if (mine) {
    mine.hp = 0
    explode(ctx, mine.pos.x, mine.pos.z, MINE_RADIUS, MINE_DAMAGE, { team: 'brit', category: 'mine' })
  }

  switch (e.behavior) {
    case 'rout': {
      // North, away from this place.
      e.facing = Math.PI
      moveEnemy(ctx, e, 0, -1, def.speed * 1.25, dt)
      e.stance = 'stand'
      return
    }

    case 'takecover': {
      // In a hole. Pop up, shoot, drop. Leave when calm.
      e.stance = e.suppression > COMBAT.suppressCrouch ? 'prone' : 'crouch'
      tryShoot(ctx, e, def, dt)
      if (e.suppression < 0.22 && e.behaviorT <= 0) {
        e.behavior = e.kind === 'estorm' || e.kind === 'ecav' ? 'rush' : 'advance'
        e.coverTarget = null
      }
      return
    }

    case 'setup': {
      if (e.behaviorT <= 0) {
        e.behavior = 'firing'
        snd(s, { name: 'reload', x: e.pos.x, y: 1, z: e.pos.z, gain: 0.5 })
      }
      return
    }

    case 'firing': {
      // Emplaced MG: suppressive bursts until forced to move — or until the
      // targets are all dead/out of range, in which case pack up and advance.
      if (e.kind === 'emg') {
        e.stance = 'prone'
        const hadTarget = tryShoot(ctx, e, def, dt)
        if (hadTarget) e.behaviorT = 6
        else if (e.behaviorT <= -6) { e.behavior = 'advance'; e.behaviorT = 0 }
        if (e.suppression > 0.85) { e.behavior = 'advance'; e.behaviorT = 3 }
      } else {
        tryShoot(ctx, e, def, dt)
        if (e.behaviorT <= 0) e.behavior = 'advance'
      }
      return
    }

    case 'cutting': {
      // Wire party at work.
      if (e.behaviorT <= 0) {
        const wire = nearestDefence(ctx, e.pos.x, e.pos.z, 'wire', 3)
        if (wire) {
          wire.hp = 0
          fx(s, { t: 'wiresnap', x: wire.pos.x, y: ctx.terrain.heightAt(wire.pos.x, wire.pos.z) + 0.4, z: wire.pos.z })
          snd(s, { name: 'wire_snip', x: wire.pos.x, y: 0.5, z: wire.pos.z })
          ctx.flowDirty = true
        }
        e.behavior = 'advance'
      }
      return
    }

    case 'melee': {
      const victim = nearestBrit(ctx, e.pos.x, e.pos.z, 12)
      if (!victim) {
        // Trench cleared here — push along it (mop up) or on toward support.
        e.behavior = 'mopup'
        return
      }
      e.facing = Math.atan2(victim.pos.x - e.pos.x, -(victim.pos.z - e.pos.z))
      const d = Math.hypot(victim.pos.x - e.pos.x, victim.pos.z - e.pos.z)
      if (d > 2) {
        // Close the distance — a bayonet is no use at ten paces.
        moveEnemy(ctx, e, (victim.pos.x - e.pos.x) / d, (victim.pos.z - e.pos.z) / d, def.speed * 0.9, dt)
        return
      }
      damageSoldier(ctx, victim, COMBAT.meleeDps * dt, 'melee', 'german', -1)
      victim.suppression = Math.min(1, victim.suppression + dt)
      if (ctx.rand() < dt * 1.2) snd(s, { name: 'melee', x: e.pos.x, y: 1, z: e.pos.z, gain: 0.55 })
      return
    }

    case 'mopup': {
      const victim = nearestBrit(ctx, e.pos.x, e.pos.z, 12)
      if (victim) { e.behavior = 'melee'; return }
      // Continue south toward the support line via the flow field.
      advanceAlongFlow(ctx, e, def, dt, true)
      return
    }

    case 'rush':
    case 'advance': {
      // Wire: slows everyone, bleeds them; specialists stop to cut it.
      const wire = nearestDefence(ctx, e.pos.x, e.pos.z, 'wire', WIRE_SEGMENT_LEN / 2)
      let wireSlow = 1
      if (wire) {
        wireSlow = 0.32
        damageSoldier(ctx, e, 1.2 * dt, 'wire', 'brit', -1)
        e.morale = Math.max(0, e.morale - 0.02 * dt)
        if ((e.kind === 'estorm' || e.kind === 'epioneer') && e.cooldown <= 0) {
          e.behavior = 'cutting'
          e.behaviorT = e.kind === 'epioneer' ? 4 : 6.5
          e.cooldown = 2
          return
        }
      }

      // Suppressed men look for a hole.
      if (e.behavior === 'advance' && e.suppression > COMBAT.suppressCrouch && !e.coverTarget) {
        e.coverTarget = findShellHole(ctx, e)
      }
      if (e.coverTarget) {
        const d = Math.hypot(e.coverTarget.x - e.pos.x, e.coverTarget.z - e.pos.z)
        if (d < 1.2) {
          e.behavior = 'takecover'
          e.behaviorT = 2.5 + ctx.rand() * 3
          return
        }
        const dirX = (e.coverTarget.x - e.pos.x) / d
        const dirZ = (e.coverTarget.z - e.pos.z) / d
        e.facing = Math.atan2(dirX, -dirZ)
        moveEnemy(ctx, e, dirX, dirZ, def.speed * wireSlow, dt)
        return
      }

      // MG teams deploy at effective range.
      if (e.kind === 'emg') {
        const tgt = nearestBrit(ctx, e.pos.x, e.pos.z, def.range * 0.85)
        if (tgt && ctx.terrain.craterDepthAt(e.pos.x, e.pos.z) > 0.3) {
          e.behavior = 'setup'
          e.behaviorT = 5
          return
        }
      }
      // Snipers settle in at long range, but re-evaluate the position
      // periodically so they never idle a wave out with no targets left.
      if (e.kind === 'esniper') {
        const tgt = nearestBrit(ctx, e.pos.x, e.pos.z, def.range)
        if (tgt && e.pos.z > -60) {
          e.behavior = 'firing'
          e.behaviorT = 14
          e.stance = 'prone'
          return
        }
      }

      // Close enough to fight into the trench?
      const sec = sectionAt(s.sections, e.pos.x, e.pos.z)
      if (sec && !sec.captured && ctx.terrain.trenchAt(e.pos.x, e.pos.z) > 0.3) {
        e.behavior = 'melee'
        snd(s, { name: 'melee', x: e.pos.x, y: 1, z: e.pos.z })
        return
      }

      // Line infantry pause to shoot on the way in.
      if (e.behavior === 'advance' && e.cooldown <= 0) {
        const tgt = nearestBrit(ctx, e.pos.x, e.pos.z, def.range)
        if (tgt) {
          e.behavior = 'firing'
          e.behaviorT = 1.4
          return
        }
      }
      // Stormtroopers bomb the trench as they close.
      if (e.kind === 'estorm' && e.cooldown <= 0) {
        const tgt = nearestBrit(ctx, e.pos.x, e.pos.z, 26)
        if (tgt) {
          e.cooldown = 6
          spawnGrenade(ctx, e, tgt.pos.x, tgt.pos.z, ENEMY_DEFS.estorm.damage, 3.2, -1)
        }
      }
      // Flame pioneers burn the parapet.
      if (e.kind === 'eflamer' && e.cooldown <= 0) {
        const tgt = nearestBrit(ctx, e.pos.x, e.pos.z, ENEMY_DEFS.eflamer.range)
        if (tgt) {
          e.cooldown = 1
          e.facing = Math.atan2(tgt.pos.x - e.pos.x, -(tgt.pos.z - e.pos.z))
          flameCone(ctx, e, 'german', ENEMY_DEFS.eflamer.range, ENEMY_DEFS.eflamer.damage, -1)
          return
        }
      }
      // Cavalry lance on contact.
      if (e.kind === 'ecav') {
        const tgt = nearestBrit(ctx, e.pos.x, e.pos.z, 2.2)
        if (tgt) {
          damageSoldier(ctx, tgt, ENEMY_DEFS.ecav.damage * dt * 1.4, 'melee', 'german', -1)
        }
      }

      advanceAlongFlow(ctx, e, def, dt, false)
      return
    }
  }
}

function advanceAlongFlow(ctx: Ctx, e: Enemy, def: { speed: number }, dt: number, toSupport: boolean): void {
  ctx.flowInf.dirAt(e.pos.x, e.pos.z, _dir)
  let dx = _dir.x, dz = _dir.z
  if (dx === 0 && dz === 0) { dz = 1 } // flow gap: just head south
  // Slight squad-mate separation so formations don't collapse to a point.
  const sep = separation(ctx, e)
  dx += sep.x * 0.5; dz += sep.z * 0.5
  const len = Math.hypot(dx, dz) || 1
  dx /= len; dz /= len
  e.facing = Math.atan2(dx, -dz)
  const suppressed = e.suppression > COMBAT.suppressCrouch ? 0.45 : 1
  moveEnemy(ctx, e, dx, dz, def.speed * suppressed, dt)
}

const _sep = { x: 0, z: 0 }
function separation(ctx: Ctx, e: Enemy): { x: number; z: number } {
  _sep.x = 0; _sep.z = 0
  for (const o of ctx.s.enemies) {
    if (o === e || o.hp <= 0) continue
    const d2v = dist2(o.pos.x, o.pos.z, e.pos.x, e.pos.z)
    if (d2v < 2.4 * 2.4 && d2v > 0.0001) {
      const d = Math.sqrt(d2v)
      _sep.x += (e.pos.x - o.pos.x) / d * (1 - d / 2.4)
      _sep.z += (e.pos.z - o.pos.z) / d * (1 - d / 2.4)
    }
  }
  return _sep
}

function moveEnemy(ctx: Ctx, e: Enemy, dirX: number, dirZ: number, speed: number, dt: number): void {
  const mud = 1 - ctx.terrain.mudAt(e.pos.x, e.pos.z) * (1 - 0.55)
  const flooded = ctx.terrain.floodedAt(e.pos.x, e.pos.z) ? 0.55 : 1
  const gallop = e.mounted ? 1 : 1
  const sp = speed * e.speedMul * mud * flooded * gallop * dt
  e.pos.x = clamp(e.pos.x + dirX * sp, -WORLD.width / 2 + 2, WORLD.width / 2 - 2)
  e.pos.z += dirZ * sp
  e.animPhase += dt * (e.mounted ? 9 : 3.2 + speed * 2.2)
}

function tryShoot(ctx: Ctx, e: Enemy, def: { range: number; rof: number; damage: number; accuracy: number; suppress: number }, dt: number): boolean {
  void dt
  if (e.cooldown > 0 || e.suppression > COMBAT.suppressPin) return true // busy, not targetless
  const prefer = e.kind === 'esniper'
  const tgt = prefer
    ? highValueBrit(ctx, e.pos.x, e.pos.z, def.range)
    : nearestBrit(ctx, e.pos.x, e.pos.z, def.range)
  if (!tgt) return false
  e.cooldown = 1 / def.rof
  e.facing = Math.atan2(tgt.pos.x - e.pos.x, -(tgt.pos.z - e.pos.z))
  fireSmallArms(ctx, {
    shooter: e, team: 'german',
    target: { kind: 'soldier', ref: tgt },
    damage: def.damage, accuracy: def.accuracy, range: def.range,
    suppress: def.suppress, category: 'enemy',
    shooterUnitId: -1,
    tracer: e.kind === 'emg',
    sound: e.kind === 'emg' ? 'mg' : e.kind === 'esniper' ? 'sniper' : 'rifle_far',
  })
  return true
}

function nearestBrit(ctx: Ctx, x: number, z: number, range: number): Soldier | null {
  let best: Soldier | null = null
  let bestD = range * range
  for (const u of ctx.s.units) {
    if (u.disbanded || u.fallenBack) continue
    for (const c of u.crew) {
      if (c.hp <= 0) continue
      const d = dist2(c.pos.x, c.pos.z, x, z)
      if (d < bestD) { bestD = d; best = c }
    }
  }
  return best
}

function highValueBrit(ctx: Ctx, x: number, z: number, range: number): Soldier | null {
  let best: Soldier | null = null
  let bestScore = -Infinity
  const r2 = range * range
  for (const u of ctx.s.units) {
    if (u.disbanded || u.fallenBack) continue
    const value = u.kind === 'officer' ? 400 : u.kind === 'medic' ? 300
      : u.kind === 'vickers' || u.kind === 'fieldgun' ? 250 : u.kind === 'sniper' ? 200 : 0
    for (const c of u.crew) {
      if (c.hp <= 0) continue
      const d = dist2(c.pos.x, c.pos.z, x, z)
      if (d > r2) continue
      const score = value - Math.sqrt(d)
      if (score > bestScore) { bestScore = score; best = c }
    }
  }
  return best
}

function nearestDefence(ctx: Ctx, x: number, z: number, kind: 'wire' | 'mine', radius: number) {
  for (const d of ctx.s.defences) {
    if (d.kind !== kind || d.hp <= 0) continue
    if (dist2(d.pos.x, d.pos.z, x, z) < radius * radius) return d
  }
  return null
}

/** Find a nearby shell hole worth diving into (deep = safe). */
function findShellHole(ctx: Ctx, e: Enemy): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null
  let bestScore = 0.45 // minimum useful depth
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2
    const px = e.pos.x + Math.cos(ang) * 6
    const pz = e.pos.z + Math.sin(ang) * 6 + 2 // prefer holes that still make progress south
    const depth = ctx.terrain.craterDepthAt(px, pz)
    if (depth > bestScore && !ctx.terrain.floodedAt(px, pz)) {
      bestScore = depth
      best = { x: px, z: pz }
    }
  }
  return best
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------------
// Squads (director-facing helpers)
// ---------------------------------------------------------------------------

export function makeSquad(ctx: Ctx, kinds: EnemyKindId[], x: number, targetSectionId: number): Squad {
  const squad: Squad = {
    id: ctx.s.nextId++,
    members: [],
    targetSectionId,
    bounding: false,
    routed: false,
  }
  // Wedge formation off the spawn line.
  for (let i = 0; i < kinds.length; i++) {
    const row = Math.floor(i / 4)
    const col = (i % 4) - 1.5
    const ex = x + col * 3.2 + (ctx.rand() - 0.5) * 1.5
    const ez = WORLD.enemySpawnZ - row * 3 - ctx.rand() * 2
    squad.members.push(spawnEnemy(ctx, kinds[i], ex, ez, squad.id).id)
  }
  ctx.s.squads.push(squad)
  return squad
}
