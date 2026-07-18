/**
 * The German AI commander — the first network peer we ship.
 *
 * It is nothing but a COMMAND SOURCE: it reads the same fog-free state a
 * human would, holds a purse (s.germanReq, drip-fed by the runner), and emits
 * tick-stamped envelopes through the exact queue a remote player will use in
 * M5. Because it is a pure function of (state, persona, seeded rand), both
 * lockstep clients run it identically — which is also how it takes over for
 * a disconnected human.
 *
 * Personas (spec §3): Methodical fortifies and probes; Stosstrupp hoards for
 * big pushes behind box barrages; Opportunist hits whichever section is
 * thinnest.
 */
import type { EnemyKindId } from '../core/types'
import type { Rand } from '../core/rng'
import { dist2, type Ctx } from './sim'
import type { Cmd } from './commands'

export type AiPersona = 'methodical' | 'stosstrupp' | 'opportunist'

interface PersonaTuning {
  /** Keep this many living defenders per german-held front section. */
  garrisonPerSection: number
  /** Purse threshold before launching an assault. */
  assaultBudget: number
  /** Assault party composition (drawn until budget is spent). */
  assaultKinds: EnemyKindId[]
  /** Precede the assault with a box barrage on the objective? */
  boxBarrage: boolean
  /** Seconds between decision passes. */
  cadence: number
}

const TUNING: Record<AiPersona, PersonaTuning> = {
  methodical: {
    garrisonPerSection: 2.2, assaultBudget: 260,
    assaultKinds: ['einf', 'einf', 'einf', 'einf', 'eofficer', 'emg'],
    boxBarrage: false, cadence: 3,
  },
  stosstrupp: {
    garrisonPerSection: 1.2, assaultBudget: 420,
    assaultKinds: ['estorm', 'estorm', 'estorm', 'estorm', 'eofficer', 'eflamer', 'epioneer'],
    boxBarrage: true, cadence: 4,
  },
  opportunist: {
    garrisonPerSection: 1.6, assaultBudget: 200,
    assaultKinds: ['einf', 'einf', 'estorm', 'estorm', 'eofficer'],
    boxBarrage: false, cadence: 2,
  },
}

export class AiCommander {
  private nextThink = 0
  private lastAssaultAt = -999

  constructor(readonly persona: AiPersona, private rand: Rand) {}

  /** One decision pass. Returns the commands to enqueue (side 'german'). */
  think(ctx: Ctx): Cmd[] {
    const s = ctx.s
    const cmds: Cmd[] = []
    if (s.outcome !== 'ongoing') return cmds
    const t = TUNING[this.persona]
    if (s.time < this.nextThink) return cmds
    this.nextThink = s.time + t.cadence

    // -- census ---------------------------------------------------------------
    const gerFront = s.sections.filter((c) => c.home === 'german' && c.line === 'front')
    const held = gerFront.filter((c) => c.owner === 'german')
    let garrison = 0
    for (const e of s.enemies) {
      if (e.hp > 0 && (e.behavior === 'garrison' || e.behavior === 'melee') && e.pos.z < 0) garrison++
    }

    // -- 1) hold the line: keep the front garrisoned ---------------------------
    const wantGarrison = Math.round(held.length * t.garrisonPerSection)
    if (garrison < wantGarrison && s.germanReq >= 40) {
      // Reinforce the emptiest held section.
      let best: typeof held[number] | null = null
      let bestCount = Infinity
      for (const sec of held) {
        let n = 0
        for (const e of s.enemies) {
          if (e.hp > 0 && dist2(e.pos.x, e.pos.z, sec.mid.x, sec.mid.z) < 12 * 12) n++
        }
        if (n < bestCount) { bestCount = n; best = sec }
      }
      if (best) {
        const kinds: EnemyKindId[] = this.persona === 'methodical' && this.rand() < 0.3
          ? ['einf', 'einf', 'emg']
          : ['einf', 'einf', 'einf']
        cmds.push({ t: 'spawnsquad', kinds, x: best.mid.x, role: 'garrison', targetSection: best.id })
      }
    }

    // -- 2) counterattack lost ground sharpish ---------------------------------
    const lost = gerFront.filter((c) => c.owner === 'brit')
    if (lost.length > 0 && s.germanReq >= 140 && s.time - this.lastAssaultAt > 25) {
      this.lastAssaultAt = s.time
      const target = lost[Math.floor(this.rand() * lost.length)]
      cmds.push({
        t: 'spawnsquad', kinds: ['estorm', 'estorm', 'einf', 'einf'],
        x: target.mid.x, role: 'assault', targetSection: target.id,
      })
      return cmds
    }

    // -- 3) the push: save up, then hit the chosen section ---------------------
    if (s.germanReq >= t.assaultBudget && s.time - this.lastAssaultAt > 40) {
      const britFront = s.sections.filter((c) => c.home === 'brit' && c.line === 'front' && c.owner === 'brit')
      if (britFront.length === 0) return cmds
      let target = britFront[0]
      if (this.persona === 'opportunist') {
        // The thinnest stretch: fewest living defenders near it.
        let bestN = Infinity
        for (const sec of britFront) {
          let n = 0
          for (const u of s.units) {
            if (u.disbanded || u.fallenBack) continue
            for (const c of u.crew) {
              if (c.hp > 0 && dist2(c.pos.x, c.pos.z, sec.mid.x, sec.mid.z) < 16 * 16) n++
            }
          }
          if (n < bestN) { bestN = n; target = sec }
        }
      } else if (this.persona === 'methodical') {
        // The section nearest our farthest forward hold — bite and hold.
        let bestD = Infinity
        for (const sec of britFront) {
          for (const g of gerFront) {
            if (g.owner !== 'german') continue
            const d = dist2(sec.mid.x, sec.mid.z, g.mid.x, g.mid.z)
            if (d < bestD) { bestD = d; target = sec }
          }
        }
      } else {
        // Stosstrupp: centre mass, biggest party, behind a box barrage.
        let bestAbs = Infinity
        for (const sec of britFront) {
          if (Math.abs(sec.mid.x) < bestAbs) { bestAbs = Math.abs(sec.mid.x); target = sec }
        }
      }
      this.lastAssaultAt = s.time
      if (t.boxBarrage) {
        cmds.push({ t: 'gbarrage', x: target.mid.x, z: target.mid.z, shells: 14, gas: false })
      }
      cmds.push({
        t: 'spawnsquad', kinds: [...t.assaultKinds],
        x: target.mid.x + (this.rand() - 0.5) * 20, role: 'assault', targetSection: target.id,
      })
      // Opportunist doubles down with a second, smaller party on a flank.
      if (this.persona === 'opportunist' && s.germanReq >= t.assaultBudget + 120) {
        cmds.push({
          t: 'spawnsquad', kinds: ['einf', 'einf', 'einf'],
          x: target.mid.x + (this.rand() < 0.5 ? -26 : 26), role: 'assault', targetSection: target.id,
        })
      }
    }

    return cmds
  }
}
