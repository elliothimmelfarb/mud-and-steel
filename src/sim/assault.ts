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
import type { AssaultGroup, Soldier, Team, TrenchSection, Unit } from '../core/types'
import { ASSAULT, BIGPUSH, COMBAT, CREEP, TRENCH, UNIT_DEFS, WIRE_SEGMENT_LEN } from '../core/config'
import { dist2, fx, snd, type Ctx } from './sim'
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
    // Census: living men still under this group's orders, and their nerve.
    let men = 0
    let moraleSum = 0
    for (const uid of g.unitIds) {
      const u = s.units.find((x) => x.id === uid)
      if (!u || u.disbanded || u.assaultGroupId !== g.id) continue
      for (const c of u.crew) {
        if (c.hp <= 0) continue
        men++
        moraleSum += c.morale
      }
    }
    if (men === 0) continue // group wiped or fully released — drop it

    // Cohesion. A push that has lost most of its men, or its nerve, does not
    // hang in no-man's-land forever waiting for an order that isn't coming —
    // it breaks and runs for its own parapet. Visible, diagnosable failure
    // beats an invisible permanent stall.
    if (g.state === 'advancing') {
      const lost = 1 - men / Math.max(1, g.startMen)
      if (lost >= ASSAULT.breakLossFraction || moraleSum / men < ASSAULT.breakMorale) {
        g.state = 'broken'
        ctx.events.emit('assaultBroke', { groupId: g.id, side: g.side, men })
        if (g.side === 'brit') {
          ctx.events.emit('toast', { text: 'The attack has broken — they are coming back!', kind: 'warn' })
        }
      }
    }

    // Lite bounding-overwatch: the group's units alternate move/fire elements.
    g.boundT -= dt
    if (g.boundT <= 0) {
      g.moveElement = g.moveElement === 0 ? 1 : 0
      g.boundT = ASSAULT.boundSeconds * (0.8 + ctx.rand() * 0.5)
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

/** Say why an order came to nothing — silence is the worst possible answer. */
function refuse(ctx: Ctx, side: Team, text: string): void {
  if (side === 'brit') ctx.events.emit('toast', { text, kind: 'warn' })
}

export function issueAssault(ctx: Ctx, side: Team, sectionIds: number[], targetSectionId: number): void {
  const s = ctx.s
  if (side !== 'brit') return // german assaults arrive with the M4 commander
  const target = sectionById(s, targetSectionId)
  if (!target) return
  if (target.owner === side) {
    refuse(ctx, side, 'That stretch is already ours — pick an enemy-held section.')
    return
  }
  const picked: Unit[] = []
  // A unit belongs to the order if its post sits ON one of the named stretches.
  // The reach MUST match the click hit-test (sectionAt) or a bay the player can
  // select is a bay that musters nobody, silently. Nearest-mid was also wrong:
  // a man at the far end of a bay can be closer to his neighbour's midpoint
  // than his own and get dropped from an order he plainly belongs to.
  const reach2 = (TRENCH.sectionLen * 0.75) ** 2
  let blocked = 0
  for (const u of s.units) {
    if (u.disbanded || u.assaultGroupId !== null) continue
    let onOrder = false
    for (const id of sectionIds) {
      const sec = sectionById(s, id)
      if (sec && dist2(u.pos.x, u.pos.z, sec.mid.x, sec.mid.z) < reach2) { onOrder = true; break }
    }
    if (!onOrder) continue
    // Emplaced crews stay on their pads and the column still walking up cannot
    // be turned around — both are worth saying out loud.
    if (!isAssaultKind(u.kind) || u.march) { blocked++; continue }
    picked.push(u)
  }
  if (picked.length === 0) {
    refuse(ctx, side, blocked > 0
      ? 'No one on that frontage can go over — emplaced crews hold their pads.'
      : 'No men on the selected sections. Post infantry there first.')
    return
  }
  let men = 0
  for (const u of picked) for (const c of u.crew) if (c.hp > 0) men++
  const g: AssaultGroup = {
    id: s.nextId++, side, unitIds: picked.map((u) => u.id),
    targetSectionId, state: 'advancing', moveElement: 0, boundT: ASSAULT.boundSeconds,
    startMen: men,
  }
  picked.forEach((u, i) => {
    u.assaultGroupId = g.id
    u.assaultElement = (i % 2) as 0 | 1
  })
  s.assaults.push(g)
  snd(s, { name: 'whistle_attack', x: picked[0].pos.x, y: 2, z: picked[0].pos.z, gain: 0.9 })
  ctx.events.emit('assaultBegan', { groupId: g.id, side, men, targetSectionId })
  ctx.events.emit('orderIssued', { id: 'assault', side })
}

export function issueRecall(ctx: Ctx, side: Team, groupId: number): void {
  for (const g of ctx.s.assaults) {
    if (g.id === groupId && g.side === side && g.state === 'advancing') {
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
  if (sec.facing === ownerSign) {
    refuse(ctx, side, 'That fire step already faces their way.')
    return
  }
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

  // Recalled by the whistle, or broken and running — either way, home.
  if (g.state !== 'advancing') {
    homeward(ctx, u, dt, g.state === 'broken')
    return
  }

  const captured = target.owner === g.side

  for (let ci = 0; ci < u.crew.length; ci++) {
    const c = u.crew[ci]
    if (c.hp <= 0 || c.id === ctx.s.possessedSoldierId) continue

    // Spread the crew along the objective, not onto one point.
    const along = ((u.id * 7 + ci * 3) % 11 - 5) / 5 // -1..1, deterministic per man
    const tx = target.mid.x + (target.b.x - target.a.x) / 2 * 0.6 * along
    const tz = target.mid.z + (target.b.z - target.a.z) / 2 * 0.6 * along
    const d = Math.hypot(tx - c.pos.x, tz - c.pos.z)

    // Wire is resolved FIRST and unconditionally: a man lying pinned in the
    // belt with a pair of cutters is exactly the man who should be cutting.
    const wireSlow = wireBite(ctx, u, c, g, dt)

    // Melee: an enemy at arm's reach in or near the objective trench.
    if (g.side === 'brit' && d < 26) {
      let foe: import('../core/types').Enemy | null = null
      let foeD = 10 * 10
      for (const e of s.enemies) {
        if (e.hp <= 0 || e.behavior === 'rout') continue
        const dd = dist2(e.pos.x, e.pos.z, c.pos.x, c.pos.z)
        if (dd < foeD) { foeD = dd; foe = e }
      }
      if (foe) {
        const fd = Math.sqrt(foeD)
        c.facing = Math.atan2(foe.pos.x - c.pos.x, -(foe.pos.z - c.pos.z))
        c.stance = 'stand'
        if (fd > 2) {
          step(ctx, c, foe.pos.x, foe.pos.z, ASSAULT.crouchSpeed * wireSlow, dt, false)
        } else {
          damageSoldier(ctx, foe, COMBAT.meleeDps * dt * 1.4, 'melee', 'brit', u.id)
          if (ctx.rand() < dt * 1.2) snd(s, { name: 'melee', x: c.pos.x, y: 1, z: c.pos.z, gain: 0.55 })
        }
        continue
      }
    }

    if (captured) {
      // Objective taken: occupy it (the capture logic reads presence).
      if (d > ASSAULT.occupyRadius) {
        c.stance = 'crouch'
        step(ctx, c, tx, tz, ASSAULT.crouchSpeed * wireSlow, dt, false)
      } else {
        // Hold, facing the enemy's way, and shoot what comes.
        c.facing = g.side === 'brit' ? Math.PI : 0
        c.stance = c.suppression > COMBAT.suppressCrouch ? 'prone' : 'crouch'
        assaultShoot(ctx, u, ci)
      }
      continue
    }

    const pinned = c.suppression > COMBAT.suppressPin
    const shaken = c.suppression > COMBAT.suppressCrouch
    // Lean on the barrage, never lead it. A fresh section rushes at 3.6 m/s
    // and the curtain walks at 1.35, so without this the men overtake their
    // own shells inside half a minute and the support that was meant to open
    // the way kills them instead. Holding station behind it is the order real
    // assaulting infantry were given, and it makes the barrage an escort the
    // player can rely on rather than a coin flip.
    const curtain = g.side === 'brit' ? s.creeping : null
    const leadingBarrage = curtain !== null && c.pos.z - curtain.z < CREEP.safeLag
    if (curtain) {
      // The guns are with them. A barrage walking ahead is the one thing that
      // steadies men crossing the open, and mechanically it has to be: without
      // this, the shoot's own splash chipped enough morale off the section to
      // break the push it was sent to carry, so calling for artillery was a
      // coin flip. The shells still kill — that cost stays — but they no
      // longer rout the men they are covering.
      if (c.morale < CREEP.moraleFloor) c.morale = CREEP.moraleFloor
    }

    if (pinned) {
      // Down but not done. He crawls on, working the ground — shell holes are
      // the road across no-man's-land — and answers the fire lying down.
      // This branch is the whole fix: there is no state that stops him.
      //
      // It is deliberately checked BEFORE the bound. A man already flat on his
      // face under a machine gun is not "covering" anybody; halting him for
      // his element's turn just halves the advance of a group that is already
      // crawling. Fire and movement is what the men who CAN still act do.
      c.stance = 'prone'
      step(ctx, c, tx, tz, ASSAULT.crawlSpeed * wireSlow, dt, true)
      assaultShoot(ctx, u, ci)
      continue
    }

    // Fire and movement is for the last stretch, where the static element's
    // rifles can actually reach the parapet they are meant to be keeping down.
    // Bounding out at nominal max range only halts men for no covering fire.
    if (d < ASSAULT.boundContactRange && u.assaultElement !== g.moveElement) {
      // This element goes to GROUND and fires so the other can rush. Prone,
      // not crouched: standing half-upright in the open is how a bound gets
      // its own men killed.
      c.stance = 'prone'
      assaultShoot(ctx, u, ci)
      continue
    }

    if (d <= ASSAULT.occupyRadius || leadingBarrage) {
      c.stance = 'crouch'
      assaultShoot(ctx, u, ci)
      continue
    }

    if (shaken) {
      c.stance = 'crouch'
      step(ctx, c, tx, tz, ASSAULT.crouchSpeed * wireSlow, dt, true)
      assaultShoot(ctx, u, ci)
      continue
    }

    // Up and running — the moving bound crosses fast and does not stop to fire.
    c.stance = 'stand'
    step(ctx, c, tx, tz, ASSAULT.rushSpeed * wireSlow, dt, false)
  }
}

/**
 * One step toward (tx,tz). `useCover` weaves the man crater to crater: five
 * headings inside a 110° fan are probed a few metres out and the deepest
 * ground wins, with a bias back to straight so he still makes progress. It is
 * stateless and therefore deterministic — no stored cover target to go stale
 * when the shelling digs a better hole two seconds later.
 */
function step(
  ctx: Ctx, c: Soldier, tx: number, tz: number, speed: number, dt: number, useCover: boolean,
): void {
  const dx = tx - c.pos.x, dz = tz - c.pos.z
  const d = Math.hypot(dx, dz)
  if (d < 1e-4) return
  let bx = dx / d, bz = dz / d
  if (useCover) {
    let bestScore = -1
    let bestX = bx, bestZ = bz
    for (let k = -2; k <= 2; k++) {
      const a = k * 0.48 // ±55°
      const ca = Math.cos(a), sa = Math.sin(a)
      const hx = bx * ca - bz * sa, hz = bx * sa + bz * ca
      const px = c.pos.x + hx * ASSAULT.coverProbe, pz = c.pos.z + hz * ASSAULT.coverProbe
      if (ctx.terrain.floodedAt(px, pz)) continue
      const score = ctx.terrain.craterDepthAt(px, pz) - Math.abs(k) * 0.07
      if (score > bestScore) { bestScore = score; bestX = hx; bestZ = hz }
    }
    bx = bestX; bz = bestZ
  }
  const mud = 1 - ctx.terrain.mudAt(c.pos.x, c.pos.z) * 0.45
  const sp = Math.min(d, speed * mud * dt)
  c.pos.x += bx * sp
  c.pos.z += bz * sp
  c.facing = Math.atan2(bx, -bz)
}

/**
 * Wire in the man's cell. Theirs holds him, cuts him, and gets cut back —
 * whatever his stance. His own belt costs him tempo only: the boards go down
 * and the sally ports are open before the whistle, and a battalion knows
 * where its own lanes are. Returns the speed multiplier.
 */
function wireBite(ctx: Ctx, u: Unit, c: Soldier, g: AssaultGroup, dt: number): number {
  const s = ctx.s
  const r2 = (WIRE_SEGMENT_LEN / 2) ** 2
  let slow = 1
  for (const w of s.defences) {
    if (w.kind !== 'wire' || w.hp <= 0) continue
    if (dist2(w.pos.x, w.pos.z, c.pos.x, c.pos.z) >= r2) continue
    if (w.side === g.side) { if (slow > ASSAULT.ownWireSlow) slow = ASSAULT.ownWireSlow; continue }
    slow = ASSAULT.wireSlow
    damageSoldier(ctx, c, ASSAULT.wireBleedDps * dt, 'wire', g.side === 'brit' ? 'german' : 'brit', -1)
    c.morale = Math.max(0, c.morale - 0.015 * dt)
    w.hp -= (u.kind === 'engineer' ? ASSAULT.cutDpsEngineer : ASSAULT.cutDps) * dt
    if (w.hp <= 0) {
      w.hp = 0
      ctx.flowDirty = true
      fx(s, { t: 'wiresnap', x: w.pos.x, y: ctx.terrain.heightAt(w.pos.x, w.pos.z) + 0.4, z: w.pos.z })
      snd(s, { name: 'wire_snip', x: w.pos.x, y: 0.5, z: w.pos.z, gain: 0.5 })
    }
    break
  }
  return slow
}

/** Recalled or broken: back over the parapet. Released once the last man is in. */
function homeward(ctx: Ctx, u: Unit, dt: number, broken: boolean): void {
  let allHome = true
  for (const c of u.crew) {
    if (c.hp <= 0 || c.id === ctx.s.possessedSoldierId) continue
    const d = Math.hypot(u.pos.x - c.pos.x, u.pos.z - c.pos.z)
    if (d > 2.2) {
      allHome = false
      c.stance = 'stand'
      // Broken men run flat out and do not weave; a recall is an orderly
      // withdrawal that still uses the ground.
      step(ctx, c, u.pos.x, u.pos.z, broken ? ASSAULT.homeSpeed : ASSAULT.crouchSpeed, dt, !broken)
    }
  }
  if (allHome) u.assaultGroupId = null
}

/** One aimed shot from crew member ci at the nearest hostile, unit-weapon stats. */
function assaultShoot(ctx: Ctx, u: Unit, ci: number): void {
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
