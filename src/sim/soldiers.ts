/**
 * Player-side unit behavior: targeting doctrine per weapon, Vickers heat and
 * venting, Lewis pan drums, medics/sappers/officers doing their jobs, morale
 * breaks and rallies, bayonet charges, and the static defences (searchlights,
 * flare posts).
 */
import type { Enemy, Soldier, TargetPriority, Unit, Vehicle } from '../core/types'
import { COMBAT, MARCH_SPEED, NCO_AURA_LEVEL, NCO_AURA_RANGE, UNIT_DEFS, VET_ROF_BONUS, WORLD } from '../core/config'
import { dist2, fx, snd, type Ctx } from './sim'
import {
  combatStance, coverFor, damageSoldier, fireSmallArms, soldierUpkeep, litAt,
} from './combat'
import { hasDeed, recordDeed } from './veterancy'
import { spawnGrenade, spawnMortarBomb, spawnShell, spawnGasShell, spawnFlare } from './projectiles'
import { losClear, standSurface } from './ballistics'
import { sectionAt } from './trench'

interface AuraSources {
  officers: Array<{ x: number; z: number }>
  medics: Array<{ x: number; z: number }>
  /** NCOs (Cpl.+) steady nearby men with a lesser calm than an officer's. */
  ncos: Array<{ x: number; z: number }>
}

/** Cheap early-exit test: is any living enemy within `r` of a point? */
function anyEnemyWithin(ctx: Ctx, x: number, z: number, r: number): boolean {
  const r2 = r * r
  for (const e of ctx.s.enemies) if (e.hp > 0 && dist2(e.pos.x, e.pos.z, x, z) < r2) return true
  return false
}

export function updateUnits(ctx: Ctx, dt: number): void {
  const { s } = ctx

  // Aura sources first.
  const aura: AuraSources = { officers: [], medics: [], ncos: [] }
  for (const u of s.units) {
    if (u.disbanded || u.fallenBack) continue
    if (u.kind === 'officer' && u.crew[0]?.hp > 0) aura.officers.push({ x: u.pos.x, z: u.pos.z })
    if (u.kind === 'medic' && u.crew[0]?.hp > 0) aura.medics.push({ x: u.pos.x, z: u.pos.z })
    // A seasoned NCO who is not himself an officer projects a smaller aura.
    if (u.kind !== 'officer' && u.vet >= NCO_AURA_LEVEL && u.crew.some((c) => c.hp > 0)) {
      aura.ncos.push({ x: u.pos.x, z: u.pos.z })
    }
  }

  for (const u of s.units) {
    if (u.disbanded) continue
    updateUnit(ctx, u, dt, aura)
    // Unit dies with its crew.
    if (u.crew.every((c) => c.hp <= 0)) {
      u.disbanded = true
      ctx.events.emit('unitLost', { unitId: u.id, kind: u.kind })
    }
  }

  updateDefences(ctx, dt)
}

function near(list: Array<{ x: number; z: number }>, x: number, z: number, r: number): boolean {
  for (const p of list) if (dist2(p.x, p.z, x, z) < r * r) return true
  return false
}

function updateUnit(ctx: Ctx, u: Unit, dt: number, aura: AuraSources): void {
  const { s } = ctx
  const def = UNIT_DEFS[u.kind]
  const takingCover = s.orders.coverT > 0
  const charging = s.orders.bayonetT > 0 && isChargeKind(u.kind)

  // -- crew upkeep ----------------------------------------------------------
  let moraleSum = 0, alive = 0
  for (const c of u.crew) {
    if (c.hp <= 0) continue
    alive++
    // An NCO's calm counts as an officer's for suppression & rally, at shorter reach.
    const officerNear = near(aura.officers, c.pos.x, c.pos.z, 16) ||
      near(aura.ncos, c.pos.x, c.pos.z, NCO_AURA_RANGE)
    const medicNear = near(aura.medics, c.pos.x, c.pos.z, 12)
    soldierUpkeep(ctx, c, dt, officerNear, medicNear, u.vet)
    c.masked = s.masksOn
    moraleSum += c.morale
    if (c.id === ctx.possessedSoldierId) continue // the player poses himself
    const inTrench = ctx.terrain.trenchAt(c.pos.x, c.pos.z) > 0.45
    combatStance(c, inTrench, takingCover)
    c.animPhase += dt * 7
  }
  if (alive === 0) return
  // The sole survivor of a weapon team who fights on is cited for holding alone.
  if (alive === 1 && u.crew.length >= 2 && s.phase === 'assault' && !u.fallenBack) {
    recordDeed(ctx, u, 'lastman')
  }
  const avgMorale = moraleSum / alive

  // -- Big Push: the column is still marching up from the rear ---------------
  // No posting, no firing, no morale-break-to-the-rear — they walk, they hit
  // the dirt under fire, and they can absolutely be killed on the way up.
  if (u.march) {
    marchTick(ctx, u, dt)
    return
  }

  // -- morale: break & rally --------------------------------------------------
  if (!u.fallenBack && avgMorale < COMBAT.moraleBreak && !charging) {
    u.fallenBack = true
    ctx.events.emit('toast', { text: `${def.name} crew falling back!`, kind: 'warn' })
  }
  if (u.fallenBack && avgMorale > 0.62) u.fallenBack = false

  // The unit's post is its home — the crew forms up on it and returns to it.
  const homeX = u.pos.x
  const homeZ = u.pos.z

  // -- movement: charge / fallback / hold ------------------------------------
  if (charging && !u.fallenBack) {
    chargeMove(ctx, u, dt)
  } else if (u.fallenBack) {
    // Scramble toward the support line.
    for (const c of u.crew) {
      if (c.hp <= 0 || c.id === ctx.possessedSoldierId) continue
      const tz = WORLD.supportTrenchZ + 6
      const dx = homeX - c.pos.x, dz = tz - c.pos.z
      const d = Math.hypot(dx, dz)
      if (d > 1) {
        const sp = 2.2 * dt
        c.pos.x += (dx / d) * sp
        c.pos.z += (dz / d) * sp
        c.facing = Math.atan2(dx, -dz) + Math.PI
      }
    }
    return // no fighting while broken
  } else {
    // Drift crew back to formation around the slot.
    formUp(ctx, u, homeX, homeZ, dt)
  }

  // The player has this unit's weapon in hand — it does not fire, heat, heal
  // or repair on its own. His crew stay put and load; every trigger-pull,
  // bandage and spanner-turn is now the player's. Crew upkeep already ran.
  if (u.id === ctx.possessedUnitId) return

  // -- weapon heat ------------------------------------------------------------
  if (u.kind === 'vickers') {
    if (u.venting || u.heat >= 1) {
      // Venting: latched — no fire until the jacket drains back down.
      u.venting = true
      u.heat -= dt / COMBAT.vickersVentTime
      if (u.heat <= 0.35) { u.heat = 0.35; u.venting = false }
      if (ctx.rand() < dt * 2) fx(s, { t: 'steam', x: u.pos.x, y: ctx.terrain.heightAt(u.pos.x, u.pos.z) + 1.1, z: u.pos.z })
      return
    }
    u.heat = Math.max(0, u.heat - COMBAT.vickersCoolRate * dt)
  }

  // -- role behaviors -----------------------------------------------------------
  // Never auto-fire the man the player is embodying — his trigger, his rifle.
  const shooter = u.crew.find((c) => c.hp > 0 && c.id !== ctx.possessedSoldierId)
  if (!shooter) return
  if (shooter.cooldown > 0) shooter.cooldown -= dt
  if (takingCover) return // heads down

  switch (u.kind) {
    case 'medic': return medicTick(ctx, u, dt)
    case 'engineer': return engineerTick(ctx, u, dt)
    case 'gasproj': return gasProjectorTick(ctx, u, shooter)
    default: break
  }

  if (shooter.suppression > COMBAT.suppressPin) return // pinned
  if (shooter.cooldown > 0) return

  // -- pick a target ----------------------------------------------------------
  const rapid = s.orders.rapidT > 0
  const range = def.range + (u.kind === 'sniper' ? ctx.mods.sniperRange : 0)
  // Direct-fire weapons only shoot men they can actually see; mortars and
  // field guns lob over the dead ground.
  const directFire = u.kind === 'rifleman' || u.kind === 'lewis' || u.kind === 'vickers' ||
    u.kind === 'sniper' || u.kind === 'officer'
  const target = pickTarget(ctx, u, range, def.minRange, u.targeting, directFire)
  if (!target) return

  const rofMult = (1 + u.vet * VET_ROF_BONUS) * (rapid ? 2 : 1)
  shooter.cooldown = 1 / (def.rof * rofMult)
  if (rapid) shooter.morale = Math.max(0.05, shooter.morale - 0.004) // the mad minute costs nerves
  // Firing on while all but pinned is coolness under fire.
  if (shooter.suppression > 0.6) recordDeed(ctx, u, 'held')

  // Face the enemy.
  const tp = target.kind === 'soldier' ? target.ref.pos : { x: target.ref.pos.x, z: target.ref.pos.z }
  shooter.facing = Math.atan2(tp.x - shooter.pos.x, -(tp.z - shooter.pos.z))

  switch (u.kind) {
    case 'rifleman': {
      fireSmallArms(ctx, {
        shooter, team: 'brit', target, damage: def.damage * ctx.mods.rifleDmg,
        accuracy: def.accuracy, range, suppress: def.suppress, category: 'rifle',
        shooterUnitId: u.id, tracer: false, sound: 'rifle', vetLevel: u.vet,
      })
      break
    }
    case 'lewis': {
      u.ammo--
      fireSmallArms(ctx, {
        shooter, team: 'brit', target, damage: def.damage * ctx.mods.rifleDmg,
        accuracy: def.accuracy, range, suppress: def.suppress, category: 'rifle',
        shooterUnitId: u.id, tracer: true, sound: 'mg', vetLevel: u.vet,
      })
      if (u.ammo <= 0) {
        u.ammo = 6
        shooter.cooldown = 2.1 / (rapid ? 1.6 : 1)
        snd(s, { name: 'reload', x: u.pos.x, y: 1, z: u.pos.z, gain: 0.5 })
      }
      break
    }
    case 'vickers': {
      u.heat += COMBAT.vickersHeatPerShot * ctx.mods.heatRate * (rapid ? 1.5 : 1)
      if (u.heat >= 1) {
        u.heat = 1
        snd(s, { name: 'steam_vent', x: u.pos.x, y: 1, z: u.pos.z })
      }
      fireSmallArms(ctx, {
        shooter, team: 'brit', target, damage: def.damage,
        accuracy: def.accuracy, range, suppress: def.suppress, category: 'mg',
        shooterUnitId: u.id, tracer: true, sound: 'mg', vetLevel: u.vet,
      })
      break
    }
    case 'sniper': {
      let dmg = def.damage
      if (ctx.rand() < ctx.mods.sniperCrit) dmg *= 3
      fireSmallArms(ctx, {
        shooter, team: 'brit', target, damage: dmg,
        accuracy: def.accuracy, range, suppress: def.suppress, category: 'sniper',
        shooterUnitId: u.id, tracer: false, sound: 'sniper', vetLevel: u.vet,
      })
      break
    }
    case 'grenadier': {
      if (target.kind !== 'soldier') { shooter.cooldown = 0.3; return }
      spawnGrenade(ctx, shooter, target.ref.pos.x, target.ref.pos.z,
        def.damage * ctx.mods.grenDmg, def.aoe + ctx.mods.grenAoe, u.id)
      break
    }
    case 'mortar': {
      spawnMortarBomb(ctx, u, target, def.damage, def.aoe, u.id)
      s.stats.shellsFired++
      break
    }
    case 'fieldgun': {
      spawnShell(ctx, u, target, def.damage, def.aoe, u.id)
      s.stats.shellsFired++
      fx(s, { t: 'muzzle', x: u.pos.x, y: ctx.terrain.heightAt(u.pos.x, u.pos.z) + 1.1, z: u.pos.z, dirX: Math.sin(shooter.facing), dirZ: -Math.cos(shooter.facing), big: true })
      snd(s, { name: 'fieldgun', x: u.pos.x, y: 1, z: u.pos.z })
      break
    }
    case 'flamer': {
      flameCone(ctx, shooter, 'brit', def.range, def.damage, u.id)
      break
    }
    case 'officer': {
      fireSmallArms(ctx, {
        shooter, team: 'brit', target, damage: def.damage,
        accuracy: def.accuracy, range: def.range, suppress: 0, category: 'rifle',
        shooterUnitId: u.id, tracer: false, sound: 'pistol', vetLevel: u.vet,
      })
      break
    }
    default: break
  }
}

function isChargeKind(kind: Unit['kind']): boolean {
  return kind === 'rifleman' || kind === 'grenadier' || kind === 'officer'
}

/**
 * Big Push: file the crew along the march path. Each man walks the shared
 * waypoint list at his own cursor; the staggered spawn keeps the column shape.
 * Suppression pins a man prone where he stands (a shelled column scatters by
 * stopping and dropping); he resumes when the fire slackens. The unit forms
 * up (march = null) once every living man has walked off the end of the path.
 */
function marchTick(ctx: Ctx, u: Unit, dt: number): void {
  const m = u.march
  if (!m) return
  let stillMarching = false
  for (let i = 0; i < u.crew.length; i++) {
    const c = u.crew[i]
    if (c.hp <= 0 || c.id === ctx.possessedSoldierId) continue
    if (m.idx[i] >= m.path.length) continue
    stillMarching = true
    // Under fire: hit the dirt; the render's prone stance IS the scatter read.
    if (c.suppression > 0.45) {
      c.stance = 'prone'
      continue
    }
    const wp = m.path[m.idx[i]]
    const dx = wp.x - c.pos.x, dz = wp.z - c.pos.z
    const d = Math.hypot(dx, dz)
    if (d < 0.9) {
      m.idx[i]++
      continue
    }
    const mud = 1 - ctx.terrain.mudAt(c.pos.x, c.pos.z) * 0.45
    const sp = Math.min(d, MARCH_SPEED * mud * dt)
    c.pos.x += (dx / d) * sp
    c.pos.z += (dz / d) * sp
    c.facing = Math.atan2(dx, -dz)
  }
  if (!stillMarching) {
    u.march = null
    ctx.events.emit('toast', { text: `${UNIT_DEFS[u.kind].name} formed up at the post.`, kind: 'good' })
  }
}

function formUp(ctx: Ctx, u: Unit, homeX: number, homeZ: number, dt: number): void {
  for (let i = 0; i < u.crew.length; i++) {
    const c = u.crew[i]
    if (c.hp <= 0 || c.id === ctx.possessedSoldierId) continue
    const ox = (i % 2) * 1.1 - 0.55 * (u.crew.length > 1 ? 1 : 0)
    const oz = Math.floor(i / 2) * 1.0
    const tx = homeX + ox, tz = homeZ + oz
    const dx = tx - c.pos.x, dz = tz - c.pos.z
    const d = Math.hypot(dx, dz)
    if (d > 0.25) {
      const sp = Math.min(d, 1.9 * dt)
      c.pos.x += (dx / d) * sp
      c.pos.z += (dz / d) * sp
    }
  }
}

function chargeMove(ctx: Ctx, u: Unit, dt: number): void {
  // Over the top: run at the nearest enemy within 40m north, melee on contact.
  for (const c of u.crew) {
    if (c.hp <= 0 || c.id === ctx.possessedSoldierId) continue
    let best: Enemy | null = null
    let bestD = 42 * 42
    for (const e of ctx.s.enemies) {
      if (e.hp <= 0 || e.behavior === 'rout') continue
      const d = dist2(e.pos.x, e.pos.z, c.pos.x, c.pos.z)
      if (d < bestD) { bestD = d; best = e }
    }
    if (!best) continue
    const d = Math.sqrt(bestD)
    c.facing = Math.atan2(best.pos.x - c.pos.x, -(best.pos.z - c.pos.z))
    c.stance = 'stand'
    if (d > 1.1) {
      const mud = 1 - ctx.terrain.mudAt(c.pos.x, c.pos.z) * 0.45
      const sp = 2.6 * mud * dt
      c.pos.x += Math.sin(c.facing) * sp
      c.pos.z += -Math.cos(c.facing) * sp
      c.animPhase += dt * 11
    } else {
      damageSoldier(ctx, best, COMBAT.meleeDps * dt * 1.6, 'rifle', 'brit', u.id)
      if (ctx.rand() < dt * 1.5) snd(ctx.s, { name: 'melee', x: c.pos.x, y: 1, z: c.pos.z, gain: 0.6 })
    }
  }
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export type Target = { kind: 'soldier'; ref: Enemy } | { kind: 'vehicle'; ref: Vehicle }

export function pickTarget(
  ctx: Ctx, u: Unit, range: number, minRange: number, prio: TargetPriority, needLos = false,
): Target | null {
  const { s } = ctx
  const px = u.pos.x, pz = u.pos.z
  const r2 = range * range, min2 = minRange * minRange

  // Armour hunters check vehicles first.
  if (prio === 'armour') {
    let bestV: Vehicle | null = null, bestD = r2
    for (const v of s.vehicles) {
      if (v.dead || v.team === 'brit') continue
      const d = dist2(v.pos.x, v.pos.z, px, pz)
      if (d >= min2 && d < bestD) { bestD = d; bestV = v }
    }
    if (bestV) return { kind: 'vehicle', ref: bestV }
  }

  // Keep a shortlist of the best-scoring candidates, then take the first one
  // the shooter can actually see over the dead ground.
  const TOP = 5
  const top: Array<{ e: Enemy; score: number }> = []
  for (const e of s.enemies) {
    if (e.hp <= 0 || e.behavior === 'rout') continue
    const d2v = dist2(e.pos.x, e.pos.z, px, pz)
    if (d2v < min2 || d2v > r2) continue
    let score = -Math.sqrt(d2v)
    switch (prio) {
      case 'strongest': score = e.maxHp - Math.sqrt(d2v) * 0.3; break
      case 'officers':
        if (e.kind === 'eofficer') score += 500
        else if (e.kind === 'emg' || e.kind === 'esniper') score += 250
        break
      case 'armour': break
      case 'nearest': break
    }
    // Prefer visible men at night.
    if (ctx.weather.state.night && !litAt(ctx, e.pos.x, e.pos.z)) score -= 200
    let i = top.length
    while (i > 0 && top[i - 1].score < score) i--
    if (i < TOP) {
      top.splice(i, 0, { e, score })
      if (top.length > TOP) top.pop()
    }
  }
  if (!needLos && top.length > 0) return { kind: 'soldier', ref: top[0].e }
  if (top.length > 0) {
    const eyeY = standSurface(ctx, px, pz) + 1.38
    for (const cand of top) {
      const e = cand.e
      const aimY = standSurface(ctx, e.pos.x, e.pos.z) + 0.9
      if (losClear(ctx, px, eyeY, pz, e.pos.x, aimY, e.pos.z)) {
        return { kind: 'soldier', ref: e }
      }
    }
  }

  // Fall back to vehicles for anyone whose rounds can matter.
  if (u.kind === 'vickers' || u.kind === 'lewis' || u.kind === 'mortar' || u.kind === 'fieldgun') {
    let bestV: Vehicle | null = null, bestD = r2
    for (const v of s.vehicles) {
      if (v.dead || v.team === 'brit') continue
      const d = dist2(v.pos.x, v.pos.z, px, pz)
      if (d >= min2 && d < bestD) { bestD = d; bestV = v }
    }
    if (bestV) return { kind: 'vehicle', ref: bestV }
  }
  return null
}

// ---------------------------------------------------------------------------
// Special roles
// ---------------------------------------------------------------------------

function medicTick(ctx: Ctx, u: Unit, dt: number): void {
  const medic = u.crew[0]
  if (!medic || medic.hp <= 0) return
  let worst: Soldier | null = null
  let worstFrac = 0.99
  for (const other of ctx.s.units) {
    if (other.disbanded) continue
    for (const c of other.crew) {
      if (c.hp <= 0) continue
      if (dist2(c.pos.x, c.pos.z, medic.pos.x, medic.pos.z) > 12 * 12) continue
      const frac = c.hp / c.maxHp
      if (frac < worstFrac) { worstFrac = frac; worst = c }
    }
  }
  if (worst) {
    worst.hp = Math.min(worst.maxHp, worst.hp + 6 * ctx.mods.healRate * dt)
    // Working on a badly hurt man with the enemy close is a stretcher-bearer's citation.
    if (!hasDeed(u, 'rescue') && worstFrac < 0.35 && anyEnemyWithin(ctx, medic.pos.x, medic.pos.z, 35)) {
      recordDeed(ctx, u, 'rescue')
    }
  }
}

function engineerTick(ctx: Ctx, u: Unit, dt: number): void {
  const sap = u.crew[0]
  if (!sap || sap.hp <= 0) return
  // Priority: broken parapet nearby, then torn wire.
  const sec = sectionAt(ctx.s.sections, sap.pos.x, sap.pos.z)
  if (sec && !sec.captured && sec.parapetHp < sec.parapetMax) {
    sec.parapetHp = Math.min(sec.parapetMax, sec.parapetHp + 8 * ctx.mods.repairRate * dt)
    if (ctx.rand() < dt * 0.4) snd(ctx.s, { name: 'build', x: sap.pos.x, y: 1, z: sap.pos.z, gain: 0.4 })
    sapperCitation(ctx, u, sap)
    return
  }
  for (const d of ctx.s.defences) {
    if (d.kind !== 'wire' || d.hp >= d.maxHp || d.hp <= 0) continue
    if (dist2(d.pos.x, d.pos.z, sap.pos.x, sap.pos.z) > 14 * 14) continue
    d.hp = Math.min(d.maxHp, d.hp + 6 * ctx.mods.repairRate * dt)
    d.wear = Math.max(0, d.wear - 0.1 * dt)
    if (ctx.rand() < dt * 0.4) snd(ctx.s, { name: 'wire_snip', x: sap.pos.x, y: 1, z: sap.pos.z, gain: 0.35 })
    sapperCitation(ctx, u, sap)
    return
  }
}

/** Mending the line with the enemy close earns the sapper his mention. */
function sapperCitation(ctx: Ctx, u: Unit, sap: Soldier): void {
  if (!hasDeed(u, 'repair') && anyEnemyWithin(ctx, sap.pos.x, sap.pos.z, 35)) {
    recordDeed(ctx, u, 'repair')
  }
}

function gasProjectorTick(ctx: Ctx, u: Unit, shooter: Soldier): void {
  if (shooter.cooldown > 0) return
  const def = UNIT_DEFS.gasproj
  // Never fire when the wind will bring it home.
  if (ctx.weather.windInfo().blowsTowardPlayer) return
  // Find the densest knot of enemies in range.
  let bestX = 0, bestZ = 0, bestCount = 3 // require a worthwhile target
  for (const e of ctx.s.enemies) {
    if (e.hp <= 0) continue
    const d2v = dist2(e.pos.x, e.pos.z, u.pos.x, u.pos.z)
    if (d2v < def.minRange * def.minRange || d2v > def.range * def.range) continue
    let count = 0
    for (const o of ctx.s.enemies) {
      if (o.hp > 0 && dist2(o.pos.x, o.pos.z, e.pos.x, e.pos.z) < 14 * 14) count++
    }
    if (count > bestCount) { bestCount = count; bestX = e.pos.x; bestZ = e.pos.z }
  }
  if (bestCount <= 3) return
  shooter.cooldown = 1 / def.rof
  for (let i = 0; i < 6; i++) {
    spawnGasShell(ctx, u.pos.x, u.pos.z, bestX + (ctx.rand() - 0.5) * 16, bestZ + (ctx.rand() - 0.5) * 16)
  }
  ctx.s.stats.gasClouds++
  snd(ctx.s, { name: 'gas_pop', x: u.pos.x, y: 1, z: u.pos.z })
  ctx.events.emit('toast', { text: 'Gas discharge — watch the wind', kind: 'info' })
}

/** Flamethrower cone: instant area damage + panic. Both sides use this. */
export function flameCone(ctx: Ctx, shooter: Soldier, team: 'brit' | 'german', range: number, damage: number, unitId: number): void {
  const dirX = Math.sin(shooter.facing), dirZ = -Math.cos(shooter.facing)
  const y = standSurface(ctx, shooter.pos.x, shooter.pos.z) + 1.2
  fx(ctx.s, { t: 'flame', x: shooter.pos.x, y, z: shooter.pos.z, dirX, dirZ, length: range })
  snd(ctx.s, { name: 'gas_pop', x: shooter.pos.x, y, z: shooter.pos.z, gain: 0.3, rate: 0.6 })
  const victims: Soldier[] = []
  if (team === 'brit') {
    for (const e of ctx.s.enemies) if (e.hp > 0) victims.push(e)
  } else {
    for (const u of ctx.s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) if (c.hp > 0) victims.push(c)
    }
  }
  for (const v of victims) {
    const dx = v.pos.x - shooter.pos.x, dz = v.pos.z - shooter.pos.z
    const d = Math.hypot(dx, dz)
    if (d > range || d < 0.5) continue
    const dot = (dx / d) * dirX + (dz / d) * dirZ
    if (dot < 0.75) continue // ~40° cone
    damageSoldier(ctx, v, damage * (1 - d / (range * 1.3)), 'flame', team, unitId)
    v.morale = Math.max(0, v.morale - 0.2)       // fire is terror
    v.suppression = Math.min(1, v.suppression + 0.4)
  }
}

// ---------------------------------------------------------------------------
// Static defences
// ---------------------------------------------------------------------------

function updateDefences(ctx: Ctx, dt: number): void {
  const { s } = ctx
  const night = ctx.weather.state.night
  for (const d of s.defences) {
    if (d.hp <= 0) continue
    if (d.kind === 'searchlight') {
      d.active = night
      if (!night) continue
      // Track the nearest advancing enemy; sweep idly otherwise.
      let best: Enemy | null = null
      let bestD = 165 * 165
      for (const e of s.enemies) {
        if (e.hp <= 0) continue
        const dd = dist2(e.pos.x, e.pos.z, d.pos.x, d.pos.z)
        if (dd < bestD) { bestD = dd; best = e }
      }
      const want = best
        ? Math.atan2(best.pos.x - d.pos.x, -(best.pos.z - d.pos.z))
        : Math.sin(s.time * 0.15 + d.id) * 0.9
      let diff = want - d.angle
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      d.angle += Math.max(-0.8 * dt, Math.min(0.8 * dt, diff))
    } else if (d.kind === 'flarepost') {
      if (!night || d.maxHp <= 0) continue
      if (d.angle > 0) { d.angle -= dt; continue } // angle doubles as cooldown
      let heard = false
      for (const e of s.enemies) {
        if (e.hp > 0 && dist2(e.pos.x, e.pos.z, d.pos.x, d.pos.z) < 120 * 120) { heard = true; break }
      }
      if (heard && d.hp > 1) {
        d.hp -= 2 // hp doubles as remaining rockets (starts at 40 = 20 flares)
        d.angle = 15
        spawnFlare(ctx, d.pos.x + (ctx.rand() - 0.5) * 20, d.pos.z - 45 - ctx.rand() * 30)
      }
    }
  }
}
