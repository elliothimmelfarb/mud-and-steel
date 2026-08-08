/**
 * The AI commander — the German chair in every shipping configuration, but
 * side-agnostic by construction.
 *
 * It is nothing but a COMMAND SOURCE: it reads the same fog-free state a human
 * would, holds the same purse, and emits tick-stamped envelopes through the
 * exact queue a remote player uses. Because it is a pure function
 * of (state, persona, seeded rand), both lockstep clients run it identically —
 * which is also how it takes over for a disconnected human.
 *
 * It plays the game the human next to it is playing: it buys from the SAME
 * roster, posts men on its own fire step, digs its own wire, buys its own
 * doctrine and sends its own sections over the top. Anything it can do, the
 * player on that side can do, and vice versa — which is the point. If a
 * command here would be refused for a human, it is refused for the AI too,
 * because it goes through the same `applyCmd`.
 *
 * Personas (spec §3): Methodical fortifies and probes; Stosstrupp hoards for
 * big pushes behind a creeping barrage; Opportunist hits whichever section is
 * thinnest.
 */
import type { BuildableId, Team, TrenchSection, UnitKindId } from '../core/types'
import { BIGPUSH } from '../core/config'
import type { Rand } from '../core/rng'
import { dist2, reqOf, type Ctx } from './sim'
import { costOf, orderReady, upgradeAvailable, type Cmd, type OrderId } from './commands'
import { isAssaultKind } from './assault'

export type AiPersona = 'methodical' | 'stosstrupp' | 'opportunist'

interface PersonaTuning {
  /** Keep this many living men per held front section before spending elsewhere. */
  garrisonPerSection: number
  /** Purse threshold before launching a deliberate attack. */
  assaultBudget: number
  /** What it posts on the line, in the order it wants them. */
  garrisonKinds: readonly UnitKindId[]
  /** Support weapons it emplaces behind the line once the garrison is up. */
  supportKinds: readonly UnitKindId[]
  /** Doctrine it saves for, in order. */
  upgradePlan: readonly string[]
  /** Walk a creeping barrage in front of the attack? */
  creeping: boolean
  /** Seconds between decision passes. */
  cadence: number
  /** Minimum men on a frontage before it is worth sending them over. */
  minAssaultMen: number
}

const TUNING: Record<AiPersona, PersonaTuning> = {
  methodical: {
    garrisonPerSection: 4, assaultBudget: 300,
    garrisonKinds: ['rifleman', 'rifleman', 'lewis', 'officer', 'vickers'],
    supportKinds: ['mortar', 'medic', 'engineer', 'fieldgun'],
    upgradePlan: ['spades', 'smle', 'dugouts', 'concrete', 'maskph'],
    creeping: false, cadence: 3, minAssaultMen: 8,
  },
  stosstrupp: {
    garrisonPerSection: 2, assaultBudget: 460,
    garrisonKinds: ['rifleman', 'grenadier', 'lewis', 'officer'],
    supportKinds: ['flamer', 'engineer', 'mortar', 'medic'],
    upgradePlan: ['mills', 'creepingdoctrine', 'rum', 'smle'],
    creeping: true, cadence: 4, minAssaultMen: 10,
  },
  opportunist: {
    garrisonPerSection: 3, assaultBudget: 220,
    garrisonKinds: ['rifleman', 'rifleman', 'grenadier', 'lewis'],
    supportKinds: ['sniper', 'mortar', 'medic', 'engineer'],
    upgradePlan: ['quartermaster', 'scopes', 'smle', 'rum'],
    creeping: false, cadence: 2, minAssaultMen: 6,
  },
}

export class AiCommander {
  private nextThink = 0
  private lastAssaultAt = -999
  private lastWireAt = -999

  /**
   * `side` is which chair this commander sits in. It is German in every
   * shipping configuration today, but nothing below assumes it: the sides are
   * symmetric, so the same brain plays either one.
   */
  constructor(readonly persona: AiPersona, private rand: Rand, readonly side: Team = 'german') {}

  /** One decision pass. Returns the commands to enqueue for `this.side`. */
  think(ctx: Ctx): Cmd[] {
    const s = ctx.s
    const cmds: Cmd[] = []
    if (s.outcome !== 'ongoing' || s.mode !== 'bigpush') return cmds
    const t = TUNING[this.persona]
    if (s.time < this.nextThink) return cmds
    this.nextThink = s.time + t.cadence

    // The purse is spent optimistically across this pass: every command is
    // re-validated at the tick boundary anyway, but tracking the balance here
    // stops it queueing five things it can only afford one of.
    let purse = reqOf(s, this.side)
    const afford = (id: BuildableId): boolean => purse >= costOf(ctx, id, this.side)
    const buy = (id: BuildableId, x: number, z: number, angle?: number): void => {
      purse -= costOf(ctx, id, this.side)
      cmds.push({ t: 'buy', kind: id, x, z, angle })
    }

    // -- census ---------------------------------------------------------------
    const ownFront = s.sections.filter((c) => c.home === this.side && c.line === 'front')
    const held = ownFront.filter((c) => c.owner === this.side)
    if (held.length === 0) return cmds

    // -- 1) hold the line: keep every held section manned ----------------------
    // The thinnest stretch gets the next man. A section with nobody on it is
    // a section that changes hands for free.
    let thinnest: TrenchSection | null = null
    let thinnestMen = Infinity
    for (const sec of held) {
      const men = this.menNear(ctx, sec, 14)
      if (men < thinnestMen) { thinnestMen = men; thinnest = sec }
    }
    if (thinnest && thinnestMen < t.garrisonPerSection) {
      const kind = t.garrisonKinds[Math.floor(this.rand() * t.garrisonKinds.length)]
      if (afford(kind)) {
        const spot = this.alongSection(thinnest)
        buy(kind, spot.x, spot.z)
      }
    }

    // -- 2) counterattack lost ground sharpish --------------------------------
    // Ground of his own in enemy hands is retaken before anything else is
    // contemplated: it is cheaper to hold than to buy back.
    const lost = ownFront.filter((c) => c.owner !== this.side)
    if (lost.length > 0 && s.time - this.lastAssaultAt > 25) {
      const target = lost[Math.floor(this.rand() * lost.length)]
      const from = this.musterNear(ctx, target, t.minAssaultMen * 0.6)
      if (from.length > 0) {
        this.lastAssaultAt = s.time
        cmds.push({ t: 'assault', sections: from, targetSection: target.id })
        return cmds
      }
    }

    // -- 3) works: wire the approaches, then emplace the heavy weapons ---------
    // Forward is toward the other trench; rearward is toward his own billets.
    const fwd = this.side === 'brit' ? -1 : 1
    if (purse > 140 && s.time - this.lastWireAt > 20 && afford('wire')) {
      this.lastWireAt = s.time
      const sec = held[Math.floor(this.rand() * held.length)]
      const z = sec.mid.z + (9 + this.rand() * 5) * fwd
      buy('wire', sec.mid.x + (this.rand() - 0.5) * 26, z, (this.rand() - 0.5) * 0.3)
    }
    if (purse > t.assaultBudget * 0.7) {
      for (const kind of t.supportKinds) {
        if (!afford(kind)) continue
        if (this.countKind(ctx, kind) >= 2) continue
        const sec = held[Math.floor(this.rand() * held.length)]
        // Gun pads sit behind his own line.
        buy(kind, sec.mid.x + (this.rand() - 0.5) * 30, sec.mid.z - (22 + this.rand() * 14) * fwd)
        break
      }
    }

    // -- 4) doctrine ----------------------------------------------------------
    for (const id of t.upgradePlan) {
      if (upgradeAvailable(s, id, this.side) !== 'buyable') continue
      // Never let the stores eat the war chest he is saving for the push.
      const spare = purse - t.assaultBudget * 0.5
      if (spare <= 0) break
      cmds.push({ t: 'upgrade', id })
      break
    }

    // -- 5) the push: save up, then send them over ----------------------------
    if (purse >= t.assaultBudget && s.time - this.lastAssaultAt > 40) {
      const enemyFront = s.sections.filter((c) => c.line === 'front' && c.owner !== this.side && c.home !== this.side)
      if (enemyFront.length === 0) return cmds
      const target = this.pickObjective(ctx, enemyFront)
      const from = this.musterNear(ctx, target, t.minAssaultMen)
      if (from.length > 0) {
        this.lastAssaultAt = s.time
        // The guns first, then the whistle — the curtain walks at a man's pace
        // and the men lean on it, exactly as they do for the other commander.
        if (t.creeping && orderReady(s, 'barrage', this.side)) {
          cmds.push({ t: 'order', id: 'barrage', x: target.mid.x, z: target.mid.z })
        }
        if (orderReady(s, 'rapidfire' as OrderId, this.side)) {
          cmds.push({ t: 'order', id: 'rapidfire' })
        }
        cmds.push({ t: 'assault', sections: from, targetSection: target.id })
      }
    }

    // -- 6) heads down under a barrage ----------------------------------------
    if (s.barrages.some((b) => b.t > -3) || s.creepings.some((c) => c.side !== this.side)) {
      if (orderReady(s, 'takecover' as OrderId, this.side)) cmds.push({ t: 'order', id: 'takecover' })
    }

    return cmds
  }

  // -------------------------------------------------------------------------
  // Reading the ground
  // -------------------------------------------------------------------------

  /** Living men of this commander's within `r` of a section's midpoint. */
  private menNear(ctx: Ctx, sec: TrenchSection, r: number): number {
    let n = 0
    const r2 = r * r
    for (const u of ctx.s.units) {
      if (u.disbanded || u.side !== this.side) continue
      for (const c of u.crew) {
        if (c.hp > 0 && dist2(c.pos.x, c.pos.z, sec.mid.x, sec.mid.z) < r2) n++
      }
    }
    return n
  }

  /**
   * The held sections closest to `target` that between them can put at least
   * `wantMen` rifles over the parapet. Empty when the attack would be a
   * gesture — an assault of three men achieves nothing but three casualties.
   */
  private musterNear(ctx: Ctx, target: TrenchSection, wantMen: number): number[] {
    const s = ctx.s
    const held = s.sections
      .filter((c) => c.owner === this.side && c.line === 'front')
      .sort((a, b) => dist2(a.mid.x, a.mid.z, target.mid.x, target.mid.z) -
        dist2(b.mid.x, b.mid.z, target.mid.x, target.mid.z))
    const picked: number[] = []
    let men = 0
    for (const sec of held) {
      if (picked.length >= 6) break
      const n = this.assaultMenNear(ctx, sec)
      if (n === 0) continue
      picked.push(sec.id)
      men += n
      if (men >= wantMen) return picked
    }
    return men >= Math.ceil(wantMen * 0.6) ? picked : []
  }

  /** Men on a section who could actually go over: infantry, formed up, free. */
  private assaultMenNear(ctx: Ctx, sec: TrenchSection): number {
    let n = 0
    for (const u of ctx.s.units) {
      if (u.disbanded || u.side !== this.side) continue
      if (u.march || u.assaultGroupId !== null || !isAssaultKind(u.kind)) continue
      if (dist2(u.pos.x, u.pos.z, sec.mid.x, sec.mid.z) > (BIGPUSH.laneHalfWidth + 12) ** 2) continue
      for (const c of u.crew) if (c.hp > 0) n++
    }
    return n
  }

  /** Which enemy stretch this persona wants. */
  private pickObjective(ctx: Ctx, candidates: TrenchSection[]): TrenchSection {
    let target = candidates[0]
    if (this.persona === 'opportunist') {
      // The thinnest stretch: fewest living defenders near it.
      let bestN = Infinity
      for (const sec of candidates) {
        let n = 0
        for (const u of ctx.s.units) {
          if (u.disbanded || u.side === this.side || u.fallenBack) continue
          for (const c of u.crew) {
            if (c.hp > 0 && dist2(c.pos.x, c.pos.z, sec.mid.x, sec.mid.z) < 16 * 16) n++
          }
        }
        if (n < bestN) { bestN = n; target = sec }
      }
    } else if (this.persona === 'methodical') {
      // The section nearest his farthest-forward hold — bite and hold.
      let bestD = Infinity
      for (const sec of candidates) {
        for (const g of ctx.s.sections) {
          if (g.owner !== this.side || g.line !== 'front') continue
          const d = dist2(sec.mid.x, sec.mid.z, g.mid.x, g.mid.z)
          if (d < bestD) { bestD = d; target = sec }
        }
      }
    } else {
      // Stosstrupp: centre mass, everything behind it.
      let bestAbs = Infinity
      for (const sec of candidates) {
        if (Math.abs(sec.mid.x) < bestAbs) { bestAbs = Math.abs(sec.mid.x); target = sec }
      }
    }
    return target
  }

  /**
   * A point somewhere along a section's trace. Posting every man at the exact
   * midpoint fails the placement spacing rule after the second one, so the
   * commander spreads them down the bay the way a human dragging the cursor
   * along it would.
   */
  private alongSection(sec: TrenchSection): { x: number; z: number } {
    const f = 0.15 + this.rand() * 0.7
    return {
      x: sec.a.x + (sec.b.x - sec.a.x) * f,
      z: sec.a.z + (sec.b.z - sec.a.z) * f,
    }
  }

  /** How many positions of this kind he already holds. */
  private countKind(ctx: Ctx, kind: UnitKindId): number {
    let n = 0
    for (const u of ctx.s.units) {
      if (!u.disbanded && u.side === this.side && u.kind === kind) n++
    }
    return n
  }
}
