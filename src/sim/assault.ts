/**
 * Over the top — the Big Push assault machinery for PLAYER units.
 *
 * This is the enemy's attacking brain (enemies.ts) grafted onto unit crews,
 * recon option (b): no pool unification, just the same soldiering — advance
 * on a chosen enemy section, hit the dirt under fire, chew through wire,
 * bound by elements, melee in the trench, occupy, and (with time and hands)
 * consolidate the captured fire step to face the other way.
 *
 * All deterministic: randomness only via ctx.rand, applied from commands at
 * tick boundaries. Everything here is hashed sim state.
 */
import type { AssaultGroup, Team, TrenchSection, Unit } from '../core/types'
import { BIGPUSH, COMBAT, MARCH_SPEED, TRENCH, UNIT_DEFS, WIRE_SEGMENT_LEN } from '../core/config'
import { dist2, snd, type Ctx } from './sim'
import { damageSoldier, fireSmallArms } from './combat'
import { sectionById } from './trench'

/** Kinds that can go over the top (crewed emplacements stay on their pads). */
export function isAssaultKind(kind: Unit['kind']): boolean {
  return kind === 'rifleman' || kind === 'lewis' || kind === 'grenadier' ||
    kind === 'officer' || kind === 'flamer' || kind === 'medic' || kind === 'engineer' || kind === 'sniper'
}



// ---------------------------------------------------------------------------
// Group lifecycle (runs once per tick from updateUnits, before per-unit ticks)
// ---------------------------------------------------------------------------

export function updateAssaultGroups(ctx: Ctx, dt: number): void {
  const s = ctx.s
  let w = 0
  for (const g of s.assaults) {
    // Census.
    let anyAlive = false
    for (const uid of g.unitIds) {
      const u = s.units.find((x) => x.id === uid)
      if (u && !u.disbanded && u.assaultGroupId === g.id) { anyAlive = true; break }
    }
    if (!anyAlive) continue // group wiped or fully released — drop it

    // Lite bounding-overwatch: the group's units alternate move/fire elements.
    g.boundT -= dt
    if (g.boundT <= 0) {
      g.moveElement = g.moveElement === 0 ? 1 : 0
      g.boundT = 4 * (0.8 + ctx.rand() * 0.5)
    }
    s.assaults[w++] = g
  }
  s.assaults.length = w

  // Consolidation: ordered sections get their fire step reversed by hands on
  // the spot — engineers work at double time. Real bench geometry is carved
  // when the work completes (terrain-height-is-cover, always).
  for (const sec of s.sections) {
    if (!sec.consolidating) continue
    const ownerSign: 1 | -1 = sec.owner === 'brit' ? 1 : -1
    if (sec.facing === ownerSign) { sec.consolidating = false; sec.consolidateT = 0; continue }
    let hands = 0
    let engineer = false
    if (sec.owner === 'brit') {
      for (const u of s.units) {
        if (u.disbanded || u.march) continue
        for (const c of u.crew) {
          if (c.hp > 0 && dist2(c.pos.x, c.pos.z, sec.mid.x, sec.mid.z) < 9 * 9) {
            hands++
            if (u.kind === 'engineer') engineer = true
          }
        }
      }
    } else {
      for (const e of s.enemies) {
        if (e.hp > 0 && e.behavior !== 'rout' && dist2(e.pos.x, e.pos.z, sec.mid.x, sec.mid.z) < 9 * 9) {
          hands++
          if (e.kind === 'epioneer') engineer = true
        }
      }
    }
    if (hands === 0) continue
    sec.consolidateT += (dt / BIGPUSH.consolidateSeconds) * (engineer ? 2 : 1)
    if (sec.consolidateT >= 1) {
      sec.consolidateT = 0
      sec.consolidating = false
      sec.facing = ownerSign
      sec.parapetHp = Math.max(sec.parapetHp, sec.parapetMax * 0.6)
      carveReversedBench(ctx, sec)
      ctx.events.emit('toast', {
        text: sec.owner === 'brit' ? 'Section consolidated — the fire step faces THEIR way now.' : 'The enemy have consolidated a captured section.',
        kind: sec.owner === 'brit' ? 'good' : 'warn',
      })
    }
  }
}

/** Carve a real bench into the section's NEW enemy wall (facing just flipped). */
function carveReversedBench(ctx: Ctx, sec: TrenchSection): void {
  const abx = sec.b.x - sec.a.x, abz = sec.b.z - sec.a.z
  const len = Math.hypot(abx, abz) || 1
  // Enemy-facing normal for the new facing.
  let nx = -abz / len, nz = abx / len
  if (nz * sec.facing > 0) { nx = -nx; nz = -nz }
  const stepDrop = TRENCH.depth - TRENCH.fireStepLift
  const steps = Math.max(2, Math.round(len / 2.2))
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const px = sec.a.x + abx * t + nx * TRENCH.fireStepSlot
    const pz = sec.a.z + abz * t + nz * TRENCH.fireStepSlot
    // Grade sampled well behind the new parapet side; the bench top sits
    // fireStepLift above the trench floor = grade - stepDrop.
    const grade = ctx.terrain.heightAt(px + nx * 10, pz + nz * 10)
    ctx.terrain.raiseBench(px, pz, 1.15, grade - stepDrop)
  }
}

// ---------------------------------------------------------------------------
// Command application helpers (called from commands.ts applyCmd)
// ---------------------------------------------------------------------------

export function issueAssault(ctx: Ctx, side: Team, sectionIds: number[], targetSectionId: number): void {
  const s = ctx.s
  if (side !== 'brit') return // german assaults arrive with the M4 commander
  const target = sectionById(s, targetSectionId)
  if (!target || target.owner === side) return
  const picked: Unit[] = []
  for (const u of s.units) {
    if (u.disbanded || u.march || u.assaultGroupId !== null || !isAssaultKind(u.kind)) continue
    // A unit belongs to the order if its post sits on one of the named sections.
    let best = -1, bestD = 10 * 10
    for (const sec of s.sections) {
      const d = dist2(u.pos.x, u.pos.z, sec.mid.x, sec.mid.z)
      if (d < bestD) { bestD = d; best = sec.id }
    }
    if (best >= 0 && sectionIds.includes(best)) picked.push(u)
  }
  if (picked.length === 0) return
  const g: AssaultGroup = {
    id: s.nextId++, side, unitIds: picked.map((u) => u.id),
    targetSectionId, state: 'advancing', moveElement: 0, boundT: 4,
  }
  picked.forEach((u, i) => {
    u.assaultGroupId = g.id
    u.assaultElement = (i % 2) as 0 | 1
  })
  s.assaults.push(g)
  snd(s, { name: 'whistle_attack', x: picked[0].pos.x, y: 2, z: picked[0].pos.z, gain: 0.9 })
  ctx.events.emit('orderIssued', { id: 'assault', side })
}

export function issueRecall(ctx: Ctx, side: Team, groupId: number): void {
  for (const g of ctx.s.assaults) {
    if (g.id === groupId && g.side === side && g.state !== 'recalled') {
      g.state = 'recalled'
      ctx.events.emit('orderIssued', { id: 'recall', side })
    }
  }
}

export function issueCovering(ctx: Ctx, side: Team, sectionIds: number[], targetSectionId: number): void {
  const s = ctx.s
  if (side !== 'brit') return
  const target = sectionById(s, targetSectionId)
  if (!target) return
  for (const u of s.units) {
    if (u.disbanded || u.march || u.assaultGroupId !== null) continue
    let best = -1, bestD = 10 * 10
    for (const sec of s.sections) {
      const d = dist2(u.pos.x, u.pos.z, sec.mid.x, sec.mid.z)
      if (d < bestD) { bestD = d; best = sec.id }
    }
    if (best >= 0 && sectionIds.includes(best)) {
      u.coverSectionId = targetSectionId
      u.coverT = 30
    }
  }
  ctx.events.emit('orderIssued', { id: 'covering', side })
}

export function issueConsolidate(ctx: Ctx, side: Team, sectionId: number): void {
  const sec = sectionById(ctx.s, sectionId)
  if (!sec || sec.owner !== side) return
  const ownerSign: 1 | -1 = side === 'brit' ? 1 : -1
  if (sec.facing === ownerSign) return // already fights your way
  sec.consolidating = true
  ctx.events.emit('orderIssued', { id: 'consolidate', side })
}

// ---------------------------------------------------------------------------
// Per-unit assault tick (called from updateUnit when assaultGroupId != null)
// ---------------------------------------------------------------------------

export function assaultTick(ctx: Ctx, u: Unit, dt: number): void {
  const s = ctx.s
  const g = s.assaults.find((x) => x.id === u.assaultGroupId)
  if (!g) { u.assaultGroupId = null; return }
  const target = sectionById(s, g.targetSectionId)
  if (!target) { u.assaultGroupId = null; return }
  const def = UNIT_DEFS[u.kind]

  // Recalled: back to the home post; release when everyone's in.
  if (g.state === 'recalled') {
    let allHome = true
    for (const c of u.crew) {
      if (c.hp <= 0 || c.id === ctx.possessedSoldierId) continue
      const dx = u.pos.x - c.pos.x, dz = u.pos.z - c.pos.z
      const d = Math.hypot(dx, dz)
      if (d > 2.2) {
        allHome = false
        const mud = 1 - ctx.terrain.mudAt(c.pos.x, c.pos.z) * 0.45
        const sp = Math.min(d, 2.5 * mud * dt)
        c.pos.x += (dx / d) * sp
        c.pos.z += (dz / d) * sp
        c.facing = Math.atan2(dx, -dz)
      }
    }
    if (allHome) u.assaultGroupId = null
    return
  }

  const captured = target.owner === g.side
  const overwatch = !captured && u.assaultElement !== g.moveElement

  for (let ci = 0; ci < u.crew.length; ci++) {
    const c = u.crew[ci]
    if (c.hp <= 0 || c.id === ctx.possessedSoldierId) continue

    // Pinned men go to ground where they stand.
    if (c.suppression > COMBAT.suppressPin) { c.stance = 'prone'; continue }

    // Spread the crew along the objective, not onto one point.
    const along = ((u.id * 7 + ci * 3) % 11 - 5) / 5 // -1..1, deterministic per man
    const tx = target.mid.x + (target.b.x - target.a.x) / 2 * 0.6 * along
    const tz = target.mid.z + (target.b.z - target.a.z) / 2 * 0.6 * along
    const dx = tx - c.pos.x, dz = tz - c.pos.z
    const d = Math.hypot(dx, dz)

    // Enemy wire in the path: slow, bleed, and chew through it.
    let wireSlow = 1
    for (const w of s.defences) {
      if (w.kind !== 'wire' || w.hp <= 0 || w.side === g.side) continue
      if (dist2(w.pos.x, w.pos.z, c.pos.x, c.pos.z) < (WIRE_SEGMENT_LEN / 2) ** 2) {
        wireSlow = 0.32
        damageSoldier(ctx, c, 1.2 * dt, 'wire', g.side === 'brit' ? 'german' : 'brit', -1)
        c.morale = Math.max(0, c.morale - 0.015 * dt)
        // Cutting as they stand in it — engineers are fastest.
        w.hp -= (u.kind === 'engineer' ? 30 : 11) * dt
        if (w.hp <= 0) { w.hp = 0; ctx.flowDirty = true }
        break
      }
    }

    // Melee: an enemy at arm's reach in or near the objective trench.
    if (g.side === 'brit') {
      let foe: import('../core/types').Enemy | null = null
      let foeD = 10 * 10
      for (const e of s.enemies) {
        if (e.hp <= 0 || e.behavior === 'rout') continue
        const dd = dist2(e.pos.x, e.pos.z, c.pos.x, c.pos.z)
        if (dd < foeD) { foeD = dd; foe = e }
      }
      if (foe && d < 26) {
        const fd = Math.sqrt(foeD)
        c.facing = Math.atan2(foe.pos.x - c.pos.x, -(foe.pos.z - c.pos.z))
        if (fd > 2) {
          const mud = 1 - ctx.terrain.mudAt(c.pos.x, c.pos.z) * 0.45
          const sp = 2.6 * mud * wireSlow * dt
          c.pos.x += Math.sin(c.facing) * sp
          c.pos.z += -Math.cos(c.facing) * sp
          c.animPhase += dt * 4
        } else {
          damageSoldier(ctx, foe, COMBAT.meleeDps * dt * 1.4, 'melee', 'brit', u.id)
          if (ctx.rand() < dt * 1.2) snd(s, { name: 'melee', x: c.pos.x, y: 1, z: c.pos.z, gain: 0.55 })
        }
        continue
      }
    }

    if (captured) {
      // Objective taken: occupy it (the capture logic reads presence).
      if (d > 1.2) {
        const mud = 1 - ctx.terrain.mudAt(c.pos.x, c.pos.z) * 0.45
        const sp = Math.min(d, MARCH_SPEED * mud * wireSlow * dt)
        c.pos.x += (dx / d) * sp
        c.pos.z += (dz / d) * sp
        c.facing = Math.atan2(dx, -dz)
      } else {
        // Hold, facing the enemy's way, and shoot what comes.
        c.facing = g.side === 'brit' ? Math.PI : 0
        assaultShoot(ctx, u, ci, dt)
      }
      continue
    }

    if (overwatch) {
      // This element holds and fires so the other can rush.
      c.stance = c.suppression > COMBAT.suppressCrouch ? 'prone' : 'crouch'
      assaultShoot(ctx, u, ci, dt)
      continue
    }

    // The moving bound presses on.
    if (d > 1.2) {
      const suppressed = c.suppression > COMBAT.suppressCrouch ? 0.5 : 1
      const mud = 1 - ctx.terrain.mudAt(c.pos.x, c.pos.z) * 0.45
      const sp = Math.min(d, 2.6 * mud * wireSlow * suppressed * dt)
      c.pos.x += (dx / d) * sp
      c.pos.z += (dz / d) * sp
      c.facing = Math.atan2(dx, -dz)
      c.animPhase += dt * 4
    }
  }
}

/** One aimed shot from crew member ci at the nearest hostile, unit-weapon stats. */
function assaultShoot(ctx: Ctx, u: Unit, ci: number, dt: number): void {
  void dt
  const s = ctx.s
  const c = u.crew[ci]
  if (c.cooldown > 0) return
  const def = UNIT_DEFS[u.kind]
  if (def.damage <= 0) return
  let tgt: import('../core/types').Enemy | null = null
  let bestD = def.range * def.range
  for (const e of s.enemies) {
    if (e.hp <= 0 || e.behavior === 'rout') continue
    const dd = dist2(e.pos.x, e.pos.z, c.pos.x, c.pos.z)
    if (dd < bestD) { bestD = dd; tgt = e }
  }
  if (!tgt) return
  c.cooldown = 1 / Math.max(0.12, def.rof)
  c.facing = Math.atan2(tgt.pos.x - c.pos.x, -(tgt.pos.z - c.pos.z))
  fireSmallArms(ctx, {
    shooter: c, team: 'brit',
    target: { kind: 'soldier', ref: tgt },
    damage: def.damage, accuracy: def.accuracy * 0.8, range: def.range,
    suppress: def.suppress, category: 'rifle',
    shooterUnitId: u.id, tracer: u.kind === 'lewis', sound: u.kind === 'lewis' ? 'mg' : 'rifle',
  })
}
