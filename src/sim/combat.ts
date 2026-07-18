/**
 * The combat model. Small-arms fire is fully physical: every round is a
 * simulated bullet that leaves a muzzle, drops under gravity, and stops on
 * whatever it actually strikes — parapet, mud, man or armour. Marksmanship
 * (accuracy, veterancy, suppression, night, fog, respirators) sets the
 * angular spread of the shot; the world decides the rest. Explosions damage
 * BOTH sides, deform the terrain, and knock down parapets — your own mortars
 * can bury your own charge.
 */
import type { Enemy, Soldier, Team, Unit, Vehicle } from '../core/types'
import { COMBAT, ENEMY_DEFS, MARKSMAN_KILLS, RANKS, SQUAD, UNIT_DEFS, VET_ACC_BONUS, XP_PER_KILL } from '../core/config'
import { dist2, fx, snd, type Ctx } from './sim'
import { damageParapet, parapetFactor, sectionAt } from './trench'
import { fireBullet, muzzlePos, standSurface, G } from './ballistics'
import { awardXp, leadCrew, rallyMult, recordDeed, suppressResistMult } from './veterancy'

// ---------------------------------------------------------------------------
// Geometry / perception helpers
// ---------------------------------------------------------------------------

export function stanceHeight(st: Soldier['stance']): number {
  switch (st) {
    case 'stand': return 1.5
    case 'crouch': return 1.0
    case 'prone': return 0.4
    case 'dead': return 0.2
  }
}

/** Is this point illuminated right now? (day, flare overhead, searchlight beam) */
export function litAt(ctx: Ctx, x: number, z: number): boolean {
  if (!ctx.weather.state.night) return true
  for (const p of ctx.s.projectiles) {
    if (p.kind === 'flare' && p.pos.y > 2 && dist2(p.pos.x, p.pos.z, x, z) < 85 * 85) return true
  }
  for (const d of ctx.s.defences) {
    if (d.kind !== 'searchlight' || !d.active || d.hp <= 0) continue
    // Beam: a 12°-wide wedge out to 170m at d.angle.
    const dx = x - d.pos.x, dz = z - d.pos.z
    const dist = Math.hypot(dx, dz)
    if (dist > 170 || dist < 4) continue
    const bearing = Math.atan2(dx, -dz)
    let diff = bearing - d.angle
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    if (Math.abs(diff) < 0.105) return true
  }
  return false
}

/** 0..~0.85 damage & hit-chance reduction from what the target is standing in. */
export function coverFor(ctx: Ctx, s: Soldier): number {
  let cover = 0
  const t = ctx.terrain
  if (t.trenchAt(s.pos.x, s.pos.z) > 0.45) {
    const sec = sectionAt(ctx.s.sections, s.pos.x, s.pos.z)
    cover = COMBAT.coverTrench * parapetFactor(sec)
  } else if (t.craterDepthAt(s.pos.x, s.pos.z) > 0.45 && s.stance !== 'stand') {
    cover = COMBAT.coverCrater
  }
  if (s.stance === 'prone') cover = Math.max(cover, COMBAT.coverProne)
  else if (s.stance === 'crouch') cover = Math.max(cover, COMBAT.coverProne * 0.5)
  return Math.min(0.85, cover)
}

// ---------------------------------------------------------------------------
// Small arms
// ---------------------------------------------------------------------------

export interface ShotSpec {
  shooter: Soldier
  team: Team
  target: { kind: 'soldier'; ref: Soldier } | { kind: 'vehicle'; ref: Vehicle }
  damage: number
  accuracy: number
  range: number
  suppress: number
  category: string
  shooterUnitId: number
  tracer: boolean
  sound: string | null
  vetLevel?: number
}

export function fireSmallArms(ctx: Ctx, spec: ShotSpec): void {
  const { s } = ctx
  const sh = spec.shooter
  const tgt = spec.target.ref
  const tx = spec.target.kind === 'soldier' ? tgt.pos.x : (tgt as Vehicle).pos.x
  const tz = spec.target.kind === 'soldier' ? tgt.pos.z : (tgt as Vehicle).pos.z
  const d = Math.max(0.5, Math.sqrt(dist2(sh.pos.x, sh.pos.z, tx, tz)))

  // -- marksmanship → angular spread ----------------------------------------
  // Everything that used to shave hit probability now widens the shot group.
  let q = spec.accuracy
  if (spec.vetLevel) q *= 1 + spec.vetLevel * VET_ACC_BONUS
  q *= 1 - Math.min(0.6, sh.suppression * 0.65)
  if (sh.masked) q *= ctx.mods.maskAccPenalty
  const w = ctx.weather.state
  if (w.night && !litAt(ctx, tx, tz)) q *= COMBAT.nightAccMult
  if (w.fog > 0.15) {
    const effRange = spec.range * (1 - 0.45 * w.fog)
    if (d > effRange) q *= 0.4
  }
  // Range strain beyond what pure dispersion gives (breathing, rangefinding).
  q *= Math.max(0.35, 1.05 - 0.4 * (d / Math.max(1, spec.range)))
  const spread = COMBAT.baseSpreadRad / Math.max(0.1, q)

  // -- muzzle, aim point, gravity holdover ------------------------------------
  const from = muzzlePos(ctx, sh)
  // Aim at what is actually visible: head-and-shoulders for a man behind a
  // parapet, centre of mass in the open.
  const inTrench = ctx.terrain.trenchAt(tx, tz) > 0.45
  const aimY = spec.target.kind === 'soldier'
    ? standSurface(ctx, tx, tz) + stanceHeight((tgt as Soldier).stance) * (inTrench ? 0.85 : 0.62)
    : ctx.terrain.heightAt(tx, tz) + 1.5
  const tof = d / COMBAT.bulletSpeed
  const holdover = 0.5 * G * tof * tof // trained shooters compensate for drop
  let dirX = tx - from.x, dirY = aimY + holdover - from.y, dirZ = tz - from.z
  const dl = Math.hypot(dirX, dirY, dirZ) || 1
  dirX /= dl; dirY /= dl; dirZ /= dl

  fireBullet(ctx, {
    team: spec.team,
    from: { x: from.x + dirX * 0.8, y: from.y + dirY * 0.8, z: from.z + dirZ * 0.8 },
    dir: { x: dirX, y: dirY, z: dirZ },
    speed: COMBAT.bulletSpeed,
    damage: spec.damage,
    spread,
    category: spec.category,
    shooterUnitId: spec.shooterUnitId,
    shooterId: sh.id,
    tracer: spec.tracer || ctx.rand() < COMBAT.tracerFraction,
  })

  // -- muzzle + report ------------------------------------------------------
  fx(s, { t: 'muzzle', x: from.x + dirX * 0.8, y: from.y, z: from.z + dirZ * 0.8, dirX, dirZ })
  if (spec.sound) snd(s, { name: spec.sound, x: from.x, y: from.y, z: from.z })

  // MG bursts suppress the whole beaten zone immediately.
  if (spec.suppress > 0.08) {
    suppressArea(ctx, tx, tz, 4.5, spec.suppress * 0.6, spec.team)
  }
}

// ---------------------------------------------------------------------------
// Damage & death
// ---------------------------------------------------------------------------

export function findSoldier(ctx: Ctx, id: number): Soldier | null {
  for (const e of ctx.s.enemies) if (e.id === id) return e
  for (const u of ctx.s.units) {
    for (const c of u.crew) if (c.id === id) return c
  }
  return null
}

export function damageSoldier(
  ctx: Ctx, target: Soldier, dmg: number, category: string, sourceTeam: Team, shooterUnitId: number,
): void {
  if (target.hp <= 0) return
  target.hp -= dmg
  target.morale = Math.max(0, target.morale - COMBAT.moraleHitPenalty)
  target.suppression = Math.min(1, target.suppression + 0.15)
  // Director learns what kills its men.
  if (target.team === 'german' && sourceTeam === 'brit') {
    const d = ctx.s.director.dmgByCategory
    d[category] = (d[category] ?? 0) + dmg
  }
  // FPS Lab invincibility: the possessed man takes the hit (morale/suppression
  // above still fire his hurt feedback) but is floored at a sliver so killSoldier
  // never runs — no 'dead' stance soft-lock, no stray corpse. FpsMode restores
  // him to full next frame. Scoped tightly to the possessed man; nil in real play.
  if (ctx.fpsInvincible && target.id === ctx.possessedSoldierId) {
    if (target.hp < 1) target.hp = 1
    return
  }
  if (target.hp <= 0) {
    killSoldier(ctx, target, sourceTeam, shooterUnitId)
  }
}

export function killSoldier(ctx: Ctx, target: Soldier, sourceTeam: Team, shooterUnitId: number): void {
  const { s } = ctx
  if (target.stance === 'dead') return // never record the same man twice
  target.hp = 0
  target.stance = 'dead'
  const y = ctx.terrain.heightAt(target.pos.x, target.pos.z)
  s.corpses.push({
    x: target.pos.x, z: target.pos.z, y, facing: target.facing,
    team: target.team, deadT: 0, seed: target.id * 0.618 % 1,
    mounted: false,
  })
  if (s.corpses.length > 200) s.corpses.shift()
  fx(s, { t: 'blood', x: target.pos.x, y: y + 0.6, z: target.pos.z })
  if (ctx.rand() < 0.5) snd(s, { name: 'death_cry', x: target.pos.x, y, z: target.pos.z, gain: 0.5 })

  // Morale shock ripples to nearby friends.
  for (const ally of alliesNear(ctx, target.team, target.pos.x, target.pos.z, 10)) {
    if (ally !== target) ally.morale = Math.max(0, ally.morale - COMBAT.moraleDeathPenalty)
  }

  // Cutting down the squad NCO is a real, felt counterplay: the whole section
  // wavers — an extra morale blow and a spike of hesitation across every man
  // in it, wherever he stands. The squad promotes a replacement next tick.
  if (target.team === 'german') {
    const e = target as Enemy
    const sq = s.squads.find((q) => q.leaderId === target.id && q.id === e.squadId)
    if (sq) {
      sq.leaderId = -1
      for (const m of s.enemies) {
        if (m === target || m.hp <= 0 || m.squadId !== e.squadId) continue
        m.morale = Math.max(0, m.morale - SQUAD.leaderMoraleShock)
        m.suppression = Math.min(1, m.suppression + SQUAD.leaderSuppressBump)
      }
    }
  }

  if (target.team === 'german') {
    // Only deaths the PLAYER caused pay out — Germans lost to their own
    // barrages and gas are not your kills.
    if (sourceTeam === 'brit') {
      const e = target as Enemy
      s.stats.kills++
      const bounty = Math.round(e.bounty * ctx.mods.bounty)
      s.req += bounty
      s.stats.reqEarned += bounty
      ctx.events.emit('reqChanged', { req: s.req })
      if (shooterUnitId >= 0) {
        const u = s.units.find((u) => u.id === shooterUnitId)
        if (u) creditKill(ctx, u)
      }
    }
  } else {
    s.stats.losses++
    // Name the man for the memorial. His unit gives him his rank, his deeds,
    // and the tally of waves he saw through — a long-serving man is honoured
    // apart from the green drafts.
    let rank = RANKS[0] as string
    let kind = 'rifleman'
    let deeds = 0
    let wavesServed = 0
    for (const u of s.units) {
      if (u.crew.includes(target)) {
        rank = RANKS[u.vet] ?? RANKS[0]
        kind = u.kind
        deeds = u.deeds
        wavesServed = u.wavesServed
        break
      }
    }
    ctx.events.emit('soldierDied', {
      name: `${target.name.first} ${target.name.last}`,
      rank, kind, wave: s.wave, deeds, wavesServed,
    })
  }
}

export function creditKill(ctx: Ctx, u: Unit): void {
  const lead = leadCrew(u)
  if (lead) lead.kills++
  awardXp(ctx, u, XP_PER_KILL)
  // A kill made with cold steel while over the top is a gallantry citation.
  if (ctx.s.orders.bayonetT > 0 &&
      (u.kind === 'rifleman' || u.kind === 'grenadier' || u.kind === 'officer')) {
    recordDeed(ctx, u, 'bayonet')
  }
  // A man who runs up a long tally is mentioned for his marksmanship.
  if (lead && lead.kills >= MARKSMAN_KILLS) recordDeed(ctx, u, 'marksman')
}

export function damageVehicle(
  ctx: Ctx, v: Vehicle, dmg: number, category: string, sourceTeam: Team, shooterUnitId: number,
): void {
  if (v.dead) return
  v.hp -= dmg
  if (v.team === 'german' && sourceTeam === 'brit') {
    const d = ctx.s.director.dmgByCategory
    d[category] = (d[category] ?? 0) + dmg
  }
  snd(ctx.s, { name: 'tank_hit', x: v.pos.x, y: 1.5, z: v.pos.z, gain: 0.7 })
  if (v.hp <= 0) {
    v.dead = true
    v.burnT = 45
    const y = ctx.terrain.heightAt(v.pos.x, v.pos.z)
    fx(ctx.s, { t: 'explosion', x: v.pos.x, y: y + 1.5, z: v.pos.z, radius: 5, big: true, dirt: false })
    snd(ctx.s, { name: 'explosion_big', x: v.pos.x, y, z: v.pos.z })
    if (v.team === 'german') {
      const def = v.kind === 'etank' ? 200 : 60
      const bounty = Math.round(def * ctx.mods.bounty)
      ctx.s.req += bounty
      ctx.s.stats.reqEarned += bounty
      ctx.s.stats.kills++
      ctx.events.emit('reqChanged', { req: ctx.s.req })
      if (shooterUnitId >= 0) {
        const u = ctx.s.units.find((u) => u.id === shooterUnitId)
        if (u) creditKill(ctx, u)
      }
    }
    ctx.flowDirty = true // wrecks become obstacles
  }
}

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

export interface ExplodeOpts {
  team: Team
  category: string
  shooterUnitId?: number
  craterRadius?: number     // 0/undefined = no terrain deformation
  craterDepth?: number
  big?: boolean
}

export function explode(ctx: Ctx, x: number, z: number, radius: number, damage: number, o: ExplodeOpts): void {
  const { s } = ctx
  const y = ctx.terrain.heightAt(x, z)
  const water = ctx.terrain.floodedAt(x, z)

  // Terrain scar first (changes cover for the damage step below — fair: the
  // blast and the hole are simultaneous, but this errs kindly).
  if (o.craterRadius && o.craterRadius > 0) {
    ctx.terrain.crater(x, z, o.craterRadius, o.craterDepth ?? 0.8)
    ctx.flowDirty = true
  }

  fx(s, { t: 'explosion', x, y: y + 0.3, z, radius, big: !!o.big, dirt: !water })
  if (water) fx(s, { t: 'dirt', x, y: y + 0.2, z, amount: 2 })
  snd(s, { name: o.big ? 'explosion_big' : 'explosion_small', x, y, z })

  // Soldiers — BOTH teams. War is not tidy.
  const r2 = radius * radius
  for (const u of s.units) {
    if (u.disbanded) continue
    for (const c of u.crew) {
      if (c.hp <= 0) continue
      const d2 = dist2(c.pos.x, c.pos.z, x, z)
      if (d2 > r2 * 2.6) continue
      let dmg = blastDamage(damage, Math.sqrt(d2), radius)
      if (dmg <= 0) continue
      dmg *= 1 - coverFor(ctx, c) * 0.75
      if (s.orders.coverT > 0) dmg *= 0.5 * ctx.mods.barrageCasualty
      damageSoldier(ctx, c, dmg, o.category, o.team, -1)
    }
  }
  for (const e of s.enemies) {
    if (e.hp <= 0) continue
    const d2 = dist2(e.pos.x, e.pos.z, x, z)
    if (d2 > r2 * 2.6) continue
    let dmg = blastDamage(damage, Math.sqrt(d2), radius)
    if (dmg <= 0) continue
    dmg *= 1 - coverFor(ctx, e) * 0.75
    damageSoldier(ctx, e, dmg, o.category, o.team, o.shooterUnitId ?? -1)
  }
  for (const v of s.vehicles) {
    if (v.dead) continue
    const d2 = dist2(v.pos.x, v.pos.z, x, z)
    if (d2 > (radius + 3) * (radius + 3)) continue
    const isAP = o.category === 'artillery' || o.category === 'enemyart' || o.category === 'mine'
    const mult = isAP ? 1 : 0.3
    damageVehicle(ctx, v, blastDamage(damage, Math.sqrt(d2), radius + 3) * mult, o.category, o.team, o.shooterUnitId ?? -1)
  }

  // Defences: wire gets shredded, traps and posts battered.
  for (const d of s.defences) {
    if (d.hp <= 0) continue
    const dd2 = dist2(d.pos.x, d.pos.z, x, z)
    if (dd2 > (radius + 2) * (radius + 2)) continue
    const dmg = blastDamage(damage, Math.sqrt(dd2), radius + 2)
    d.hp -= d.kind === 'wire' ? dmg * 1.6 : dmg
    if (d.kind === 'wire') d.wear = Math.min(1, d.wear + 0.4)
    if (d.hp <= 0 && d.kind === 'wire') {
      fx(s, { t: 'wiresnap', x: d.pos.x, y: ctx.terrain.heightAt(d.pos.x, d.pos.z) + 0.4, z: d.pos.z })
      ctx.flowDirty = true
    }
  }

  damageParapet(ctx, x, z, damage * 0.65)
  suppressArea(ctx, x, z, radius * 2.1, Math.min(0.55, damage / 90), null)
}

function blastDamage(damage: number, d: number, radius: number): number {
  if (d > radius * 1.6) return 0
  const t = Math.max(0, 1 - d / (radius * 1.6))
  return damage * t * t
}

// ---------------------------------------------------------------------------
// Suppression & morale utilities
// ---------------------------------------------------------------------------

/** Suppress the OPPOSING team near a point (team=null suppresses everyone). */
export function suppressArea(ctx: Ctx, x: number, z: number, radius: number, amount: number, team: Team | null): void {
  const r2 = radius * radius
  if (team !== 'german') {
    for (const e of ctx.s.enemies) {
      if (e.hp <= 0) continue
      const d2 = dist2(e.pos.x, e.pos.z, x, z)
      if (d2 < r2) e.suppression = Math.min(1, e.suppression + amount * (1 - d2 / r2))
    }
  }
  if (team !== 'brit') {
    for (const u of ctx.s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) {
        if (c.hp <= 0) continue
        const d2 = dist2(c.pos.x, c.pos.z, x, z)
        if (d2 < r2) c.suppression = Math.min(1, c.suppression + amount * (1 - d2 / r2))
      }
    }
  }
}

function* alliesNear(ctx: Ctx, team: Team, x: number, z: number, radius: number): Generator<Soldier> {
  const r2 = radius * radius
  if (team === 'german') {
    for (const e of ctx.s.enemies) {
      if (e.hp > 0 && dist2(e.pos.x, e.pos.z, x, z) < r2) yield e
    }
  } else {
    for (const u of ctx.s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) if (c.hp > 0 && dist2(c.pos.x, c.pos.z, x, z) < r2) yield c
    }
  }
}

/**
 * Shared per-soldier upkeep: suppression decay, morale regen, gas coughing.
 * `vet` is the man's rank level (0..3); steadier veterans shake off suppression
 * faster and rally sooner — modest perks, not immunity.
 */
export function soldierUpkeep(ctx: Ctx, sol: Soldier, dt: number, officerNear: boolean, medicNear: boolean, vet = 0): void {
  sol.suppression = Math.max(0, sol.suppression - COMBAT.suppressDecay * dt * (officerNear ? 1.6 : 1) * suppressResistMult(vet))
  let regen = COMBAT.moraleRegen * (officerNear ? 2.2 : 1) * (medicNear ? 1.5 : 1) * rallyMult(vet) * ctx.mods.rallyRate
  sol.morale = Math.min(1, sol.morale + regen * dt)
  const floor = sol.team === 'brit' ? ctx.mods.moraleFloor : 0
  if (sol.morale < floor) sol.morale = floor
  if (sol.gasExposure > 0) {
    sol.gasExposure = Math.max(0, sol.gasExposure - dt * 0.5)
    if (ctx.rand() < dt * 0.25) {
      snd(ctx.s, { name: 'cough', x: sol.pos.x, y: 1, z: sol.pos.z, gain: 0.35 })
    }
  }
}

/**
 * Weapon-appropriate stance given suppression & orders. Stance is now
 * load-bearing: bullets are physical, so a crouched man's muzzle is BELOW
 * the parapet. In a trench the parapet is the cover — men stay on the fire
 * step until they are pinned outright (or ordered down); in the open they
 * hug the ground as before.
 */
export function combatStance(sol: Soldier, inTrench: boolean, takingCover: boolean): void {
  if (sol.stance === 'dead') return
  if (takingCover) { sol.stance = 'crouch'; return }
  if (inTrench) {
    sol.stance = sol.suppression > COMBAT.suppressPin ? 'crouch' : 'stand'
    return
  }
  if (sol.suppression > COMBAT.suppressPin) sol.stance = 'prone'
  else if (sol.suppression > COMBAT.suppressCrouch) sol.stance = 'crouch'
  else sol.stance = 'stand'
}
