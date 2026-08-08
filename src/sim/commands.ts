/**
 * The command spine. Every act of command — buying a unit, issuing an order,
 * selling, upgrading — is a serialisable, tick-stamped `Cmd` consumed by the
 * sim ONLY at tick boundaries (see runner.ts). The local player, the AI
 * commander and a remote lockstep peer are all just sources of these.
 *
 * Everything here must stay deterministic: same state + same command → same
 * result, with randomness drawn only from `ctx.rand`. Application re-validates
 * every command (a scheduled command can arrive after the state that justified
 * it has changed) and drops invalid ones silently and identically on all
 * clients.
 */
import type { BuildableId, DefenceKindId, EnemyKindId, Soldier, Stance, Team, TargetPriority, Unit, UnitKindId, Vec3 } from '../core/types'
import {
  DEFENCE_DEFS, ECONOMY, ENEMY_DEFS, ORDER_DEFS, PLACEMENT, TRENCH, UNIT_DEFS, UPGRADE_DEFS,
  UPGRADE_TIER_WAVE, WIRE_SEGMENT_LEN, WORLD,
} from '../core/config'
import { forkRand } from '../core/rng'
import { makeGermanSoldierName, makeSoldierName } from '../core/flavor'
import {
  addReq, dist2, modsOf, opposing, ordersOf, reqOf, upgradesOf, type Ctx, type SimState,
} from './sim'
// Layering note: the weapon profiles (and the sim half of a discharge) live
// with the viewmodels in game/weapons.ts. Importing them here pulls no cycle —
// weapons.ts only imports sim leaf modules — and keeps the ballistic numbers
// in ONE table instead of a mirrored sim copy that could drift.
import { WEAPON_PROFILES, dischargeWeaponSim } from '../game/weapons'
import { projectToFireStep, sectionAt } from './trench'
import { spawnFlare } from './projectiles'
import { spawnVehicle } from './vehicles'
import { startCreepingBarrage } from './barrage'
import { issueAssault, issueConsolidate, issueCovering, issueRecall } from './assault'
import { makeSquad } from './enemies'

export type OrderId = keyof typeof ORDER_DEFS

/**
 * Command protocol v1 (spec §4) plus the classic-mode actions. The Big Push
 * order commands (assault/covering/recall/consolidate) are typed now so the
 * protocol is stable, and become live in M3.
 */
export type Cmd =
  | { t: 'buy'; kind: BuildableId; x: number; z: number; angle?: number }
  | { t: 'sell'; unitId: number }
  | { t: 'order'; id: OrderId; x?: number; z?: number }
  | { t: 'upgrade'; id: string }
  | { t: 'targeting'; unitId: number; p: TargetPriority }
  | { t: 'callwave' }
  | { t: 'beginwave' }
  | { t: 'continueendless' }
  | { t: 'assault'; sections: number[]; targetSection: number }
  | { t: 'covering'; sections: number[]; targetSection: number }
  | { t: 'recall'; groupId: number }
  | { t: 'consolidate'; section: number }
  /** First-person embodiment: the sim stands down this man/weapon — the
   *  player is on the trigger. Commanded so lockstep peers and replays
   *  agree on it (issue #41 item 2). */
  | { t: 'possess'; unitId: number; soldierId: number }
  | { t: 'release' }
  /** Embodiment rides the spine end-to-end (#41 item 1). The render-side
   *  predictor reports its pose at most once per tick; every trigger pull and
   *  every quantum of tool work is a command. Feel (flash, report, recoil)
   *  stays render-side and instant — only what the hash can see lands here. */
  | { t: 'fpspose'; x: number; z: number; stance: Stance; facing: number; heat?: number; venting?: boolean }
  | {
      t: 'fpsfire'; camPos: Vec3; dir: Vec3; yaw: number; pitch: number; ads: number; moving: boolean
      ground: { x: number; z: number; y: number; dist: number } | null; muzzle: Vec3
    }
  /** `amount` is SECONDS of work, not effect — rates and mods stay sim-side,
   *  so a client can only ever claim time at the bandage/parapet/wire. */
  | { t: 'fpstool'; tool: 'heal' | 'parapet' | 'wire'; targetId: number; amount: number }
  // German-side commands (the AI commander today; a human via lockstep in M5).
  | { t: 'spawnsquad'; kinds: EnemyKindId[]; x: number; role: 'garrison' | 'assault'; targetSection: number }
  | { t: 'gbarrage'; x: number; z: number; shells: number; gas: boolean }

export interface Envelope {
  tick: number
  side: Team
  /**
   * Producer-local counter. INVARIANT (#41 item 5): at most ONE live
   * producer per side at any moment — a human session, or the takeover AI
   * after a disconnect, never both. seq values can repeat across producer
   * eras (a rejoined session restarts at 0), which is safe because equal
   * (tick, side, seq) keys keep stable insertion order in the drain sort,
   * and the resync dedup only ever compares within one era's live tail.
   * Any future third producer (spectator relays, side handoff) must add a
   * producer id to this key.
   */
  seq: number
  cmds: Cmd[]
  /**
   * Emitted by the deterministic in-sim AI commander. NOT recorded in the
   * replay log — every client (and every replay) re-derives these from the
   * seed, so logging them would apply them twice.
   */
  ai?: boolean
}

/** What a command needs from its host besides the sim context. */
export interface CmdHost {
  ctx: Ctx
  /** Advance the wave lifecycle (continueendless re-arms the next wave). */
  prepareNextWave(): void
}

// ---------------------------------------------------------------------------
// Validation helpers — shared by the sim (authoritative, at apply time) and
// the UI (advisory, for the placement ghost / button states).
// ---------------------------------------------------------------------------

export function costOf(ctx: Ctx, id: BuildableId, side: Team = 'brit'): number {
  const base = (UNIT_DEFS as Record<string, { cost: number }>)[id]?.cost ?? DEFENCE_DEFS[id as DefenceKindId].cost
  return Math.round(base * modsOf(ctx, side).costMult)
}

export function isUnitKind(id: BuildableId): id is UnitKindId {
  return id in UNIT_DEFS
}

/** Distance from (x,z) to the nearest live unit's post (Infinity when none). */
export function unitClearance(s: SimState, x: number, z: number): number {
  let best = Infinity
  for (const u of s.units) {
    if (u.disbanded) continue
    const d = (u.pos.x - x) ** 2 + (u.pos.z - z) ** 2
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

/**
 * Open ground behind YOUR front line, off the trenches, clear of other units.
 * `side` flips the depth band through z = 0: the German commander's back area
 * is the north half of the map, and his gun pads sit in it.
 */
export function padSpotValid(ctx: Ctx, x: number, z: number, side: Team = 'brit'): boolean {
  if (Math.abs(x) > WORLD.width / 2 - 6) return false
  const sign = side === 'brit' ? 1 : -1
  const behind = z * sign
  if (behind < WORLD.frontTrenchZ + PLACEMENT.padMarginZ || behind > WORLD.depth / 2 - 10) return false
  if (unitClearance(ctx.s, x, z) < PLACEMENT.padSpacing) return false
  // The whole pad must be open ground — the dig skips trench cells, so a
  // gun straddling a corridor would hang over the void.
  if (ctx.terrain.trenchAt(x, z) > PLACEMENT.padMaxTrench) return false
  const r = PLACEMENT.padRadius * 0.8
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2
    if (ctx.terrain.trenchAt(x + Math.cos(a) * r, z + Math.sin(a) * r) > PLACEMENT.padMaxTrench) return false
  }
  return true
}

export function fieldBuildAllowed(s: SimState): boolean {
  return s.phase !== 'assault'
}

/**
 * Resolve a requested placement to a snapped position, or null when invalid.
 * This is the single validity rule for both the ghost and the applied command,
 * for BOTH commanders: every z test is taken in the placing side's own frame
 * (`z * sign`), so the German rules are the British rules seen from the north.
 */
export function resolvePlacement(
  ctx: Ctx, id: BuildableId, x: number, z: number, side: Team = 'brit',
): { x: number; z: number } | null {
  const s = ctx.s
  const placement = isUnitKind(id) ? UNIT_DEFS[id].placement : DEFENCE_DEFS[id as DefenceKindId].placement
  const sign = side === 'brit' ? 1 : -1

  if (id === 'sandbags') {
    const sec = sectionAt(s.sections, x, z)
    if (!sec || sec.owner !== side || sec.home !== side) return null
    const gx = sec.mid.x, gz = sec.mid.z
    if (s.defences.some((d) => d.kind === 'sandbags' && Math.hypot(d.pos.x - gx, d.pos.z - gz) < 3)) return null
    return { x: gx, z: gz }
  }
  if (placement === 'trench') {
    const post = projectToFireStep(s.sections, x, z, PLACEMENT.trenchSnapDist, side)
    if (!post) return null
    if (unitClearance(s, post.x, post.z) < PLACEMENT.trenchSpacing) return null
    return { x: post.x, z: post.z }
  }
  if (placement === 'pad') {
    return padSpotValid(ctx, x, z, side) ? { x, z } : null
  }
  // Field placement: forward of your own front line, not in a trench, and not
  // while the assault is running.
  const forward = z * sign
  const zMin = id === 'flarepost' ? 20 : -60
  const zMax = WORLD.frontTrenchZ - 5
  const ok = fieldBuildAllowed(s) &&
    forward > zMin && forward < zMax &&
    Math.abs(x) < WORLD.width / 2 - 6 &&
    ctx.terrain.trenchAt(x, z) < 0.25
  return ok ? { x, z } : null
}

export function orderReady(s: SimState, id: OrderId, side: Team = 'brit'): boolean {
  const def = ORDER_DEFS[id]
  if (def.needsUpgrade && !upgradesOf(s, side).has(def.needsUpgrade)) return false
  if (id === 'masks') return true
  const orders = ordersOf(s, side)
  const cd = orders.cooldowns[id as keyof typeof orders.cooldowns]
  return cd <= 0 && reqOf(s, side) >= def.cost
}

export function upgradeAvailable(
  s: SimState, id: string, side: Team = 'brit',
): 'owned' | 'locked' | 'unaffordable' | 'buyable' {
  const def = UPGRADE_DEFS.find((u) => u.id === id)
  if (!def) return 'locked'
  const owned = upgradesOf(s, side)
  if (owned.has(id)) return 'owned'
  // Big Push has no wave counter to unlock against — it is one continuous
  // battle at wave 1 forever, which quietly locked the whole tier-2/3 shelf
  // out of the mode, the creeping barrage among it. There, requisition is the
  // gate: you buy doctrine with the same drip that buys men.
  if (s.mode !== 'bigpush' && s.wave < UPGRADE_TIER_WAVE[def.tier]) return 'locked'
  if (def.requires && !owned.has(def.requires)) return 'locked'
  if (reqOf(s, side) < def.cost) return 'unaffordable'
  return 'buyable'
}

// ---------------------------------------------------------------------------
// Spawning (command-driven; all randomness from ctx.rand)
// ---------------------------------------------------------------------------

export { MARCH_SPEED } from '../core/config'

/**
 * Build a reinforcement column's route: own rear edge → the nearest
 * communication trench (entered at its rear mouth, walked toward the front)
 * → leave at the point nearest the post → the post itself. Deterministic
 * pure function of terrain + post. `side` picks which trench system.
 */
export function buildMarchPath(ctx: Ctx, side: Team, post: { x: number; z: number }): { x: number; z: number }[] {
  const rearZ = side === 'brit' ? WORLD.depth / 2 - 6 : -(WORLD.depth / 2 - 6)
  const comms = side === 'brit' ? ctx.terrain.commLines : ctx.terrain.germanCommLines

  // Nearest comm trench by mouth x (they run parallel; x distance decides).
  let bestLine: { x: number; z: number }[] | null = null
  let bestDx = Infinity
  for (const line of comms) {
    const dx = Math.abs(line[0].x - post.x)
    if (dx < bestDx) { bestDx = dx; bestLine = line }
  }

  const path: { x: number; z: number }[] = []
  if (bestLine && bestLine.length > 0) {
    // Order the polyline rear-first (largest |z| toward own rear edge first).
    const rearFirst = Math.abs(bestLine[0].z - rearZ) <= Math.abs(bestLine[bestLine.length - 1].z - rearZ)
      ? bestLine
      : [...bestLine].reverse()
    // March down the boyau only while it still brings us closer to the post.
    let cut = rearFirst.length
    let bestD = Infinity
    for (let i = 0; i < rearFirst.length; i++) {
      const d = (rearFirst[i].x - post.x) ** 2 + (rearFirst[i].z - post.z) ** 2
      if (d < bestD) { bestD = d; cut = i + 1 }
    }
    path.push({ x: rearFirst[0].x, z: rearZ })
    for (let i = 0; i < cut; i++) path.push({ x: rearFirst[i].x, z: rearFirst[i].z })
  } else {
    path.push({ x: post.x, z: rearZ })
  }
  path.push({ x: post.x, z: post.z })
  return path
}

/** Length of a march route (m) — the purchase ghost's ETA is len / MARCH_SPEED. */
export function marchPathLength(path: { x: number; z: number }[]): number {
  let len = 0
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z)
  return len
}

export function createUnit(
  ctx: Ctx, kind: UnitKindId, x: number, z: number, announce: boolean,
  opts?: { marchIn?: boolean; side?: Team },
): Unit {
  const s = ctx.s
  const def = UNIT_DEFS[kind]
  const side = opts?.side ?? 'brit'
  const u: Unit = {
    id: s.nextId++, kind, side, pos: { x, z },
    crew: [], heat: 0, venting: false, ammo: kind === 'lewis' ? 6 : -1,
    xp: 0, vet: 0, deeds: 0, wavesServed: 0,
    targeting: def.targeting, fallenBack: false, disbanded: false,
    march: null,
    assaultGroupId: null, assaultElement: 0, coverSectionId: null, coverT: 0,
  }
  const hpMult = def.placement === 'pad' ? modsOf(ctx, side).emplacementHp : 1

  // Big Push: men ARRIVE, they do not appear. The crew spawns in single file
  // at their OWN rear edge and walks their own communication trench up.
  const march = opts?.marchIn ? buildMarchPath(ctx, side, { x, z }) : null
  // Facing on arrival: down the boyau while marching, otherwise over the
  // parapet — which is -z for the British and +z for the Germans.
  const restFacing = side === 'brit' ? 0 : Math.PI
  const marchFacing = side === 'brit' ? Math.PI : 0

  for (let i = 0; i < def.crew; i++) {
    const spawn = march
      ? { x: march[0].x + (ctx.rand() - 0.5) * 0.6, z: march[0].z + (side === 'brit' ? i * 1.7 : -i * 1.7) }
      : { x: x + (i % 2) * 1.1 - 0.5, z: z + Math.floor(i / 2) }
    u.crew.push({
      id: s.nextId++, team: side,
      pos: spawn,
      facing: march ? marchFacing : restFacing, hp: def.hp * hpMult, maxHp: def.hp * hpMult,
      stance: 'stand', suppression: 0, morale: 1, masked: s.masksOn, gasExposure: 0,
      animPhase: ctx.rand() * 10, cooldown: ctx.rand(),
      name: side === 'brit' ? makeSoldierName(ctx.rand) : makeGermanSoldierName(ctx.rand), kills: 0,
    })
  }
  if (march) u.march = { path: march, idx: u.crew.map(() => 0) }
  s.units.push(u)
  if (announce) ctx.events.emit('unitPlaced', { unitId: u.id, side })
  return u
}

export function createDefence(ctx: Ctx, kind: DefenceKindId, x: number, z: number, angle: number, side: Team = 'brit'): void {
  const s = ctx.s
  const def = DEFENCE_DEFS[kind]
  const hp = kind === 'flarepost' ? 40 : def.hp
  s.defences.push({
    id: s.nextId++, kind, side, pos: { x, z }, hp: Math.max(1, hp), maxHp: Math.max(1, hp),
    wear: 0, active: false, angle: kind === 'wire' ? angle : 0,
  })
  if (kind === 'sandbags') {
    const sec = sectionAt(s.sections, x, z)
    if (sec) {
      const mult = modsOf(ctx, side).parapetMult
      sec.parapetMax += 80 * mult
      sec.parapetHp += 80 * mult
    }
  }
}

/**
 * The sector has been fought over for two years — no front line ever stood
 * behind bare grass. Two staggered rows of WORN wire (reduced hp, high wear)
 * front the fire trench, with sally-port gaps on the communication-trench
 * axes plus a couple of random blast gaps.
 */
export function placeStartingWire(s: SimState): void {
  const rand = forkRand(s.seed, 'wire0')
  const gaps: number[] = [...TRENCH.commTrenchXs]
  const nExtra = 2 + (rand() < 0.5 ? 1 : 0)
  for (let i = 0; i < nExtra; i++) gaps.push((rand() - 0.5) * 2 * (TRENCH.frontSpanX - 20))
  for (const row of [0, 1]) {
    const z0 = WORLD.frontTrenchZ - 10.5 - row * 3.5
    for (let x = -TRENCH.frontSpanX + 4; x <= TRENCH.frontSpanX - 4; x += WIRE_SEGMENT_LEN) {
      const wx = x + (row ? WIRE_SEGMENT_LEN / 2 : 0)
      if (gaps.some((g) => Math.abs(wx - g) < 4.5)) continue
      const hp = Math.round(DEFENCE_DEFS.wire.hp * (0.35 + rand() * 0.2))
      s.defences.push({
        id: s.nextId++, kind: 'wire', side: 'brit',
        pos: { x: wx, z: z0 + (rand() - 0.5) * 1.6 },
        hp, maxHp: hp, wear: 0.35 + rand() * 0.35, active: false,
        angle: (rand() - 0.5) * 0.15,
      })
    }
  }
  // Big Push: the German belt is REAL sim wire (side 'german') — it snags the
  // British assault the way ours snags theirs. Classic keeps it scenery-only.
  if (s.mode === 'bigpush') {
    for (const row of [0, 1]) {
      const z0 = -(WORLD.frontTrenchZ - 10.5 - row * 3.5)
      for (let x = -TRENCH.frontSpanX + 4; x <= TRENCH.frontSpanX - 4; x += WIRE_SEGMENT_LEN) {
        const wx = x + (row ? WIRE_SEGMENT_LEN / 2 : 0)
        if (gaps.some((g) => Math.abs(wx - g) < 4.5)) continue
        const hp = Math.round(DEFENCE_DEFS.wire.hp * (0.35 + rand() * 0.2))
        s.defences.push({
          id: s.nextId++, kind: 'wire', side: 'german',
          pos: { x: wx, z: z0 + (rand() - 0.5) * 1.6 },
          hp, maxHp: hp, wear: 0.35 + rand() * 0.35, active: false,
          angle: (rand() - 0.5) * 0.15,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Application — sim mutations only; presentation reacts via the event bus.
// ---------------------------------------------------------------------------

/** Largest ground one fpspose command may cover (see the case for why). */
const FPS_POSE_MAX_STEP = 3.0

/** The embodied man and his weapon, or null when the fps* command is stale
 *  (released, disbanded, or the man died before the tick boundary). */
function possessedPair(s: SimState): { unit: Unit; soldier: Soldier } | null {
  if (s.possessedSoldierId < 0) return null
  const unit = s.units.find((x) => x.id === s.possessedUnitId && !x.disbanded)
  const soldier = unit?.crew.find((x) => x.id === s.possessedSoldierId && x.hp > 0)
  return unit && soldier ? { unit, soldier } : null
}

export function applyEnvelope(host: CmdHost, env: Envelope): void {
  for (const cmd of env.cmds) applyCmd(host, env.side, cmd)
}

export function applyCmd(host: CmdHost, side: Team, cmd: Cmd): void {
  const ctx = host.ctx
  const s = ctx.s
  // release must survive the outcome gate: the game-over modal forces the
  // FPS exit, and eating its release would leave a zombie possession into
  // an endless continue (unit never fires, soldier never posed).
  if (s.outcome !== 'ongoing' && cmd.t !== 'continueendless' && cmd.t !== 'release') return

  // The command surface is the SAME for both commanders: buy, sell, order,
  // upgrade, re-target, go over the top. What separates them is whose purse
  // pays and whose men move, and every case below reads `side` for that.
  //
  // What stays British is the classic wave-defence lifecycle only — there is
  // one wave clock and it belongs to the defender. In the Big Push nobody
  // sends these; they are dropped identically on every client.
  const waveLifecycle = cmd.t === 'callwave' || cmd.t === 'beginwave' || cmd.t === 'continueendless'
  if (waveLifecycle && side !== 'brit') return
  // Classic mode has exactly one commander. A German envelope there could
  // only come from a confused AI or a hostile peer — drop the lot.
  if (s.mode !== 'bigpush' && side !== 'brit' && cmd.t !== 'spawnsquad' && cmd.t !== 'gbarrage') return

  switch (cmd.t) {
    case 'buy': {
      const cost = costOf(ctx, cmd.kind, side)
      if (reqOf(s, side) < cost) return
      const spot = resolvePlacement(ctx, cmd.kind, cmd.x, cmd.z, side)
      if (!spot) return
      if (isUnitKind(cmd.kind)) {
        // An emplacement crew digs in: level a pad under the gun first so it
        // sits true (recorded in the ops history — saves replay the dig).
        if (UNIT_DEFS[cmd.kind].placement === 'pad') {
          ctx.terrain.digPad(spot.x, spot.z, PLACEMENT.padRadius)
        }
        createUnit(ctx, cmd.kind, spot.x, spot.z, true, { marchIn: s.mode === 'bigpush', side })
      } else {
        createDefence(ctx, cmd.kind as DefenceKindId, spot.x, spot.z, cmd.angle ?? 0, side)
      }
      addReq(ctx, side, -cost)
      ctx.flowDirty = true
      break
    }

    case 'sell': {
      const u = s.units.find((x) => x.id === cmd.unitId && !x.disbanded)
      // You may only strike your OWN position off the strength.
      if (!u || u.side !== side) return
      u.disbanded = true
      addReq(ctx, side, Math.round(costOf(ctx, u.kind, side) * ECONOMY.sellRefund))
      break
    }

    case 'targeting': {
      const u = s.units.find((x) => x.id === cmd.unitId)
      if (u && u.side === side) u.targeting = cmd.p
      break
    }

    case 'order': {
      if (!orderReady(s, cmd.id, side)) return
      const def = ORDER_DEFS[cmd.id]
      const orders = ordersOf(s, side)
      addReq(ctx, side, -def.cost)
      switch (cmd.id) {
        case 'takecover':
          orders.coverT = def.duration
          orders.cooldowns.takecover = def.cooldown
          break
        case 'rapidfire':
          orders.rapidT = def.duration
          orders.cooldowns.rapidfire = def.cooldown
          break
        case 'bayonets':
          orders.bayonetT = def.duration
          orders.cooldowns.bayonets = def.cooldown
          break
        case 'masks':
          // Respirators are a per-side order; classic mode keeps the single
          // British flag it always had.
          if (side === 'brit') s.masksOn = !s.masksOn
          else s.germanMasksOn = !s.germanMasksOn
          break
        case 'flare': {
          orders.cooldowns.flare = def.cooldown
          const x = cmd.x ?? 0
          // Star shells burst over no-man's-land in front of the firer.
          const sign = side === 'brit' ? 1 : -1
          const z = sign * Math.min(60, Math.max(-40, ((cmd.z ?? 0) * sign) - 60))
          spawnFlare(ctx, x, z)
          break
        }
        case 'barrage':
          orders.cooldowns.barrage = def.cooldown
          startCreepingBarrage(ctx, cmd.x ?? 0, side)
          break
        case 'marktank':
          orders.cooldowns.marktank = def.cooldown
          spawnVehicle(ctx, side === 'brit' ? 'friendlytank' : 'etank',
            (ctx.rand() - 0.5) * 60, (side === 'brit' ? 1 : -1) * (WORLD.supportTrenchZ + 25))
          break
      }
      ctx.events.emit('orderIssued', { id: cmd.id, side })
      break
    }

    case 'upgrade': {
      if (upgradeAvailable(s, cmd.id, side) !== 'buyable') return
      const def = UPGRADE_DEFS.find((u) => u.id === cmd.id)
      if (!def) return
      addReq(ctx, side, -def.cost)
      const owned = upgradesOf(s, side)
      const mods = modsOf(ctx, side)
      owned.add(cmd.id)
      const oldParapet = mods.parapetMult
      mods.recompute(owned)
      // Deeper revetting thickens YOUR parapets — the sections you hold.
      if (mods.parapetMult !== oldParapet) {
        const scale = mods.parapetMult / oldParapet
        for (const sec of s.sections) {
          if (s.mode === 'bigpush' && sec.owner !== side) continue
          sec.parapetMax *= scale
          sec.parapetHp *= scale
        }
      }
      ctx.events.emit('upgradeBought', { id: cmd.id, side })
      break
    }

    case 'callwave': {
      if (s.phase !== 'build') return
      s.earlyCallBonus += s.buildTimer * ECONOMY.earlyCallBonusPerSecond
      s.buildTimer = 0
      break
    }

    case 'beginwave': {
      if (s.phase !== 'debrief' || !s.plan) return
      s.phase = 'build'
      s.buildTimer = ECONOMY.buildPhaseSeconds
      break
    }

    case 'continueendless': {
      if (s.outcome !== 'victory') return
      s.outcome = 'ongoing'
      s.endless = true
      host.prepareNextWave()
      break
    }

    case 'assault':
      if (s.mode === 'bigpush') issueAssault(ctx, side, cmd.sections, cmd.targetSection)
      break
    case 'covering':
      if (s.mode === 'bigpush') issueCovering(ctx, side, cmd.sections, cmd.targetSection)
      break
    case 'recall':
      if (s.mode === 'bigpush') issueRecall(ctx, side, cmd.groupId)
      break
    case 'consolidate':
      if (s.mode === 'bigpush') issueConsolidate(ctx, side, cmd.section)
      break

    case 'possess': {
      const u = s.units.find((x) => x.id === cmd.unitId && !x.disbanded)
      const c = u?.crew.find((x) => x.id === cmd.soldierId && x.hp > 0)
      // You take your own men's rifles, never the other fellow's.
      if (!u || !c || u.side !== side) return
      s.possessedUnitId = u.id
      s.possessedSoldierId = c.id
      break
    }
    case 'release':
      s.possessedSoldierId = -1
      s.possessedUnitId = -1
      break

    case 'fpspose': {
      const p = possessedPair(s)
      if (!p || cmd.stance === 'dead') return // death is the sim's to declare
      const { unit: u, soldier: c } = p
      // Sanity bound, not physics — the predictor already obeys stance speeds
      // and mud. This only stops a corrupt/forged command teleporting the man:
      // one commanded step may cover at most FPS_POSE_MAX_STEP of ground.
      let dx = cmd.x - c.pos.x, dz = cmd.z - c.pos.z
      const d = Math.hypot(dx, dz)
      if (d > FPS_POSE_MAX_STEP) { dx *= FPS_POSE_MAX_STEP / d; dz *= FPS_POSE_MAX_STEP / d }
      c.pos.x = Math.min(WORLD.width / 2 - 2, Math.max(-WORLD.width / 2 + 2, c.pos.x + dx))
      c.pos.z = Math.min(WORLD.depth / 2 - 2, Math.max(-WORLD.depth / 2 + 2, c.pos.z + dz))
      c.stance = cmd.stance
      c.facing = cmd.facing
      // Heat weapons: the player nurses the jacket render-side; his model is
      // authoritative and lands here (dischargeWeaponSim never touches heat).
      if (cmd.heat !== undefined) u.heat = Math.min(1, Math.max(0, cmd.heat))
      if (cmd.venting !== undefined) u.venting = cmd.venting
      break
    }

    case 'fpsfire': {
      const p = possessedPair(s)
      if (!p) return
      dischargeWeaponSim(WEAPON_PROFILES[p.unit.kind] ?? WEAPON_PROFILES.rifleman, ctx, p.unit, p.soldier, {
        camPos: cmd.camPos, dir: cmd.dir, yaw: cmd.yaw, pitch: cmd.pitch,
        ads: cmd.ads, moving: cmd.moving, ground: cmd.ground, muzzle: cmd.muzzle,
      })
      break
    }

    case 'fpstool': {
      const p = possessedPair(s)
      if (!p) return
      const c = p.soldier
      const profile = WEAPON_PROFILES[p.unit.kind] ?? WEAPON_PROFILES.rifleman
      // Clamp the claimed work to a few ticks' worth; the soldier's sim pos can
      // trail the predictor by a step, so reach gets a little slack on top.
      const secs = Math.min(0.4, Math.max(0, cmd.amount))
      if (secs <= 0) return
      const mods = modsOf(ctx, p.unit.side)
      const reach2 = (profile.maxRange + 3) ** 2
      if (cmd.tool === 'heal') {
        for (const u of s.units) {
          if (u.disbanded || u.side !== p.unit.side) continue // your own wounded
          const w = u.crew.find((x) => x.id === cmd.targetId)
          if (!w) continue
          // A medic cannot dress his own wounds (parity with the old rule).
          if (w.id === c.id) return
          if (w.hp <= 0 || dist2(w.pos.x, w.pos.z, c.pos.x, c.pos.z) > reach2) return
          w.hp = Math.min(w.maxHp, w.hp + 14 * mods.healRate * secs)
          return
        }
      } else if (cmd.tool === 'parapet') {
        // Same rule as the by-hand loop: the sapper shores the section he
        // stands in, no other — and only one his side holds.
        const sec = sectionAt(s.sections, c.pos.x, c.pos.z)
        if (!sec || sec.id !== cmd.targetId || sec.owner !== p.unit.side) return
        sec.parapetHp = Math.min(sec.parapetMax, sec.parapetHp + 18 * mods.repairRate * secs)
      } else {
        const w = s.defences.find((x) => x.id === cmd.targetId)
        if (!w || w.kind !== 'wire' || w.hp <= 0 || w.side !== p.unit.side) return
        if (dist2(w.pos.x, w.pos.z, c.pos.x, c.pos.z) > reach2) return
        w.hp = Math.min(w.maxHp, w.hp + 14 * mods.repairRate * secs)
        w.wear = Math.max(0, w.wear - 0.2 * secs)
      }
      break
    }

    case 'spawnsquad': {
      // The German commander's buy: a squad marches in from their rear.
      if (s.mode !== 'bigpush' || side !== 'german') return
      let cost = 0
      for (const k of cmd.kinds) cost += ENEMY_DEFS[k].cost
      if (s.germanReq < cost) return
      const target = s.sections.find((c) => c.id === cmd.targetSection)
      if (!target) return
      if (cmd.role === 'garrison' && target.home !== 'german') return
      if (cmd.role === 'assault' && target.owner !== 'brit') return
      s.germanReq -= cost
      makeSquad(ctx, cmd.kinds, cmd.x, cmd.targetSection, {
        spawnZ: -(WORLD.depth / 2 - 12),
        role: cmd.role,
      })
      ctx.flowDirty = true
      break
    }

    case 'gbarrage': {
      // German off-map guns: a registered shoot, paid from their purse.
      if (s.mode !== 'bigpush' || side !== 'german') return
      const cost = Math.round(cmd.shells * 3)
      if (s.germanReq < cost) return
      s.germanReq -= cost
      s.barrages.push({ x: cmd.x, z: cmd.z, shellsLeft: cmd.shells, gas: cmd.gas, t: -6.5, interval: 0.75 })
      ctx.events.emit('barrageWarning', { x: cmd.x, z: cmd.z, seconds: 6.5 })
      break
    }
  }
}
