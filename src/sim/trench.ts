/**
 * The trench network as a game system: sections with parapet integrity,
 * placement slots, capture/recapture, and sapper repairs.
 */
import type { TrenchSection, TrenchSlot, Vec2 } from '../core/types'
import { COMBAT, TRENCH } from '../core/config'
import type { Terrain } from '../world/terrain'
import { dist2, type Ctx } from './sim'

export function buildSections(terrain: Terrain, parapetMult: number): { sections: TrenchSection[]; slots: TrenchSlot[] } {
  const sections: TrenchSection[] = []
  const slots: TrenchSlot[] = []
  let sectionId = 0
  let slotId = 0

  const addLine = (line: Vec2[], kind: 'front' | 'support') => {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1]
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      const sec: TrenchSection = {
        id: sectionId++, line: kind, a, b, mid,
        parapetHp: TRENCH.parapetHp * parapetMult,
        parapetMax: TRENCH.parapetHp * parapetMult,
        captured: false, captureT: 0,
      }
      sections.push(sec)
      // Two fighting slots per front section, one per support section.
      const fracs = kind === 'front' ? [0.32, 0.68] : [0.5]
      for (const f of fracs) {
        slots.push({
          id: slotId++, sectionId: sec.id, kind: 'trench',
          pos: { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f },
          unitId: null,
        })
      }
    }
  }
  addLine(terrain.frontLine, 'front')
  addLine(terrain.supportLine, 'support')

  for (const p of terrain.pads) {
    slots.push({ id: slotId++, sectionId: -1, kind: 'pad', pos: { x: p.x, z: p.z }, unitId: null })
  }
  return { sections, slots }
}

export function sectionAt(sections: TrenchSection[], x: number, z: number): TrenchSection | null {
  let best: TrenchSection | null = null
  let bestD = (TRENCH.sectionLen * 0.75) ** 2
  for (const sec of sections) {
    const d = dist2(x, z, sec.mid.x, sec.mid.z)
    if (d < bestD) { bestD = d; best = sec }
  }
  return best
}

/** Cover quality contributed by a section's parapet (0..1). */
export function parapetFactor(sec: TrenchSection | null): number {
  if (!sec || sec.captured) return 0.4
  return 0.55 + 0.45 * (sec.parapetHp / sec.parapetMax)
}

/** Shellfire chews the parapet down; sappers build it back. */
export function damageParapet(ctx: Ctx, x: number, z: number, amount: number): void {
  const sec = sectionAt(ctx.s.sections, x, z)
  if (!sec) return
  sec.parapetHp = Math.max(0, sec.parapetHp - amount)
}

export function updateCapture(ctx: Ctx, dt: number): void {
  const { s } = ctx
  for (const sec of s.sections) {
    // Defenders near the section?
    let defenders = 0
    for (const u of s.units) {
      if (u.disbanded || u.fallenBack) continue
      for (const c of u.crew) {
        if (c.hp > 0 && dist2(c.pos.x, c.pos.z, sec.mid.x, sec.mid.z) < 8 * 8) defenders++
      }
    }
    // Attackers in the trench itself?
    let attackers = 0
    for (const e of s.enemies) {
      if (e.hp <= 0 || e.behavior === 'rout') continue
      if (dist2(e.pos.x, e.pos.z, sec.mid.x, sec.mid.z) < 7 * 7) attackers++
    }

    if (!sec.captured) {
      if (attackers > 0 && defenders === 0) {
        sec.captureT += dt / COMBAT.captureSeconds
        if (sec.captureT >= 1) {
          sec.captured = true
          sec.captureT = 1
          s.stats.sectionsLost++
          ctx.events.emit('sectionLost', { sectionId: sec.id })
          ctx.flowDirty = true
        }
      } else {
        sec.captureT = Math.max(0, sec.captureT - dt / COMBAT.captureSeconds)
      }
    } else {
      // Retaking: any brit presence with no live attackers flips it back.
      if (defenders > 0 && attackers === 0) {
        sec.captureT -= dt / (COMBAT.captureSeconds * 0.7)
        if (sec.captureT <= 0) {
          sec.captured = false
          sec.captureT = 0
          ctx.events.emit('sectionRetaken', { sectionId: sec.id })
          ctx.flowDirty = true
        }
      }
    }
  }
}
