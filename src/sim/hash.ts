/**
 * Deterministic 32-bit state hash for lockstep verification and the twin-sim
 * probe. Hashes exact float BITS (no quantisation) — determinism here means
 * bit-identical, not approximately equal. Two sims that ever disagree on this
 * hash have diverged, full stop.
 *
 * Deliberately excluded: fx/sound queues (presentation), casualties/epitaph
 * records (flavour text composed game-side), corpses (render-only), and the
 * FPS feedback plumbing on Ctx.
 */
import type { SimState } from './sim'

class Hasher {
  private h = 0x811c9dc5 >>> 0
  private buf = new ArrayBuffer(8)
  private dv = new DataView(this.buf)

  byte(b: number): void {
    this.h = (this.h ^ (b & 0xff)) >>> 0
    this.h = Math.imul(this.h, 0x01000193) >>> 0
  }

  u32(v: number): void {
    const x = v >>> 0
    this.byte(x); this.byte(x >>> 8); this.byte(x >>> 16); this.byte(x >>> 24)
  }

  f64(v: number): void {
    this.dv.setFloat64(0, v, true)
    this.u32(this.dv.getUint32(0, true))
    this.u32(this.dv.getUint32(4, true))
  }

  bool(v: boolean): void { this.byte(v ? 1 : 0) }

  str(sv: string): void {
    this.u32(sv.length)
    for (let i = 0; i < sv.length; i++) this.byte(sv.charCodeAt(i))
  }

  get value(): number { return this.h >>> 0 }
}

const PHASE_IDX = { build: 0, assault: 1, debrief: 2 } as const
const OUTCOME_IDX = { ongoing: 0, victory: 1, defeat: 2, draw: 3 } as const
const STANCE_IDX = { stand: 0, crouch: 1, prone: 2, dead: 3 } as const
const BEHAVIOR_IDX = {
  advance: 0, rush: 1, takecover: 2, setup: 3, firing: 4, cutting: 5, melee: 6, rout: 7, mopup: 8,
} as const
const TARGETING_IDX = { nearest: 0, strongest: 1, officers: 2, armour: 3 } as const

export function hashSim(s: SimState): number {
  const h = new Hasher()

  // Scalar run state.
  h.byte(s.mode === 'bigpush' ? 1 : 0)
  h.u32(s.tick)
  h.f64(s.time)
  h.u32(s.wave)
  h.byte(PHASE_IDX[s.phase]); h.byte(OUTCOME_IDX[s.outcome])
  h.bool(s.endless)
  h.f64(s.buildTimer)
  h.f64(s.req)
  h.f64(s.breach)
  h.bool(s.masksOn)
  h.f64(s.earlyCallBonus)
  h.f64(s.advance.brit); h.f64(s.advance.german)
  h.f64(s.strength.brit); h.f64(s.strength.german)
  h.f64(s.holdT.brit); h.f64(s.holdT.german)
  h.f64(s.germanReq)
  h.f64(s.timeLimit)
  h.u32(s.nextId)
  h.f64(s.gasAlarmCooldown)
  h.f64(s.wetnessTimer)
  h.f64(s.lastFlowRebuild)
  h.u32(s.planCursor); h.u32(s.planBarrageCursor)
  h.f64(s.waveStartTime)

  // Orders.
  const o = s.orders
  h.f64(o.coverT); h.f64(o.rapidT); h.f64(o.bayonetT)
  h.f64(o.cooldowns.takecover); h.f64(o.cooldowns.rapidfire); h.f64(o.cooldowns.bayonets)
  h.f64(o.cooldowns.flare); h.f64(o.cooldowns.barrage); h.f64(o.cooldowns.marktank)

  // Upgrades (sorted — Set iteration is insertion-ordered, which may differ
  // between a live run and a replay that bought in another order… it can't
  // actually differ under lockstep, but sorted costs nothing and is safe).
  const ups = [...s.upgrades].sort()
  for (const id of ups) h.str(id)

  // Units & crews.
  h.u32(s.units.length)
  for (const u of s.units) {
    h.u32(u.id); h.str(u.kind)
    h.f64(u.pos.x); h.f64(u.pos.z)
    h.f64(u.heat); h.bool(u.venting); h.f64(u.ammo)
    h.f64(u.xp); h.byte(u.vet); h.u32(u.deeds); h.u32(u.wavesServed)
    h.byte(TARGETING_IDX[u.targeting])
    h.bool(u.fallenBack); h.bool(u.disbanded)
    if (u.march) {
      h.bool(true)
      h.u32(u.march.path.length)
      for (const p of u.march.path) { h.f64(p.x); h.f64(p.z) }
      for (const wi of u.march.idx) h.u32(wi)
    } else h.bool(false)
    for (const c of u.crew) {
      h.u32(c.id)
      h.f64(c.pos.x); h.f64(c.pos.z); h.f64(c.facing)
      h.f64(c.hp); h.byte(STANCE_IDX[c.stance])
      h.f64(c.suppression); h.f64(c.morale)
      h.bool(c.masked); h.f64(c.gasExposure)
      h.f64(c.cooldown); h.f64(c.animPhase)
      h.u32(c.kills)
    }
  }

  // Enemies.
  h.u32(s.enemies.length)
  for (const e of s.enemies) {
    h.u32(e.id); h.str(e.kind)
    h.f64(e.pos.x); h.f64(e.pos.z); h.f64(e.facing)
    h.f64(e.hp); h.byte(STANCE_IDX[e.stance])
    h.f64(e.suppression); h.f64(e.morale)
    h.bool(e.masked); h.f64(e.gasExposure)
    h.f64(e.cooldown); h.f64(e.animPhase)
    h.byte(BEHAVIOR_IDX[e.behavior]); h.f64(e.behaviorT)
    h.u32(e.squadId); h.byte(e.element)
    h.f64(e.speedMul); h.bool(e.mounted)
    if (e.coverTarget) { h.bool(true); h.f64(e.coverTarget.x); h.f64(e.coverTarget.z) } else h.bool(false)
  }

  // Squads.
  h.u32(s.squads.length)
  for (const q of s.squads) {
    h.u32(q.id); h.u32(q.targetSectionId)
    h.bool(q.bounding); h.bool(q.routed)
    h.u32(q.leaderId >>> 0); h.byte(q.moveElement); h.f64(q.boundT)
    for (const m of q.members) h.u32(m)
  }

  // Vehicles.
  h.u32(s.vehicles.length)
  for (const v of s.vehicles) {
    h.u32(v.id); h.str(v.kind)
    h.f64(v.pos.x); h.f64(v.pos.z); h.f64(v.facing)
    h.f64(v.hp); h.bool(v.bogged); h.f64(v.boggedT)
    h.f64(v.cooldownMain); h.f64(v.cooldownMG)
    h.bool(v.dead); h.f64(v.burnT)
  }

  // Ordnance in flight.
  h.u32(s.projectiles.length)
  for (const p of s.projectiles) {
    h.u32(p.id); h.f64(p.pos.x); h.f64(p.pos.y); h.f64(p.pos.z)
  }
  h.u32(s.bullets.length)
  for (const b of s.bullets) {
    h.f64(b.pos.x); h.f64(b.pos.y); h.f64(b.pos.z)
  }

  // Gas.
  h.u32(s.clouds.length)
  for (const cl of s.clouds) {
    h.u32(cl.id); h.f64(cl.age)
    for (const bl of cl.blobs) { h.f64(bl.x); h.f64(bl.z); h.f64(bl.r); h.f64(bl.c) }
  }

  // Defences.
  h.u32(s.defences.length)
  for (const d of s.defences) {
    h.u32(d.id); h.str(d.kind); h.byte(d.side === 'brit' ? 0 : 1)
    h.f64(d.pos.x); h.f64(d.pos.z)
    h.f64(d.hp); h.f64(d.wear); h.bool(d.active); h.f64(d.angle)
  }

  // Trench sections.
  for (const sec of s.sections) {
    h.u32(sec.id)
    h.f64(sec.parapetHp); h.f64(sec.parapetMax)
    h.bool(sec.captured); h.f64(sec.captureT)
    h.byte(sec.owner === 'brit' ? 0 : 1); h.byte(sec.home === 'brit' ? 0 : 1)
    h.byte(sec.facing === 1 ? 0 : 1)
  }

  // Barrages.
  h.u32(s.barrages.length)
  for (const b of s.barrages) {
    h.f64(b.x); h.f64(b.z); h.u32(b.shellsLeft); h.bool(b.gas); h.f64(b.t)
  }
  if (s.creeping) { h.bool(true); h.f64(s.creeping.z); h.f64(s.creeping.t); h.u32(s.creeping.volleys) } else h.bool(false)

  // Stats & director memory (sorted keys — object insertion order is
  // deterministic under lockstep, but sorting is free insurance).
  h.u32(s.stats.kills); h.u32(s.stats.losses); h.u32(s.stats.shellsFired)
  h.u32(s.stats.gasClouds); h.u32(s.stats.sectionsLost); h.f64(s.stats.reqEarned)
  const cats = Object.keys(s.director.dmgByCategory).sort()
  for (const k of cats) { h.str(k); h.f64(s.director.dmgByCategory[k]) }
  h.f64(s.director.wireDensity)

  return h.value
}
