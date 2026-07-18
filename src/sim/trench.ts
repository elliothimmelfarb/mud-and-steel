/**
 * The trench network as a game system: sections with parapet integrity,
 * fighting-post projection, capture/recapture, and sapper repairs.
 */
import type { TrenchSection, Vec2 } from '../core/types'
import { COMBAT, TRENCH } from '../core/config'
import type { Terrain } from '../world/terrain'
import { dist2, type Ctx } from './sim'

export function buildSections(terrain: Terrain, parapetMult: number): TrenchSection[] {
  const sections: TrenchSection[] = []
  let sectionId = 0

  const addLine = (line: Vec2[], kind: 'front' | 'support') => {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1]
      // Fighting sections live on the fire BAYS only — the long x-running
      // forward segments of the crenellated trace. Traverse jogs and the short
      // links behind the islands are corridors, not firing positions (and only
      // the bays carry a carved bench for the slots to stand on).
      if (Math.abs(b.x - a.x) < 8 || Math.abs(b.x - a.x) <= 2 * Math.abs(b.z - a.z)) continue
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      sections.push({
        id: sectionId++, line: kind, a, b, mid,
        parapetHp: TRENCH.parapetHp * parapetMult,
        parapetMax: TRENCH.parapetHp * parapetMult,
        captured: false, captureT: 0,
      })
    }
  }
  addLine(terrain.frontLine, 'front')
  addLine(terrain.supportLine, 'support')
  return sections
}

/**
 * Project a cursor point onto the nearest fighting post: any point along an
 * uncaptured front/support section, pushed onto the fire step carved into the
 * enemy wall — the man plants his feet on that real bench instead of floating
 * over the deep floor. Placement is continuous along the line, not a handful
 * of pre-dug slots. Returns null when the cursor is farther than `maxDist`
 * from every candidate.
 */
export function projectToFireStep(
  sections: TrenchSection[], x: number, z: number, maxDist: number,
): { x: number; z: number; sectionId: number } | null {
  let best: { x: number; z: number; sectionId: number } | null = null
  let bestD = maxDist * maxDist
  for (const sec of sections) {
    if (sec.captured) continue
    const abx = sec.b.x - sec.a.x, abz = sec.b.z - sec.a.z
    const len2 = abx * abx + abz * abz
    if (len2 <= 0) continue
    const segLen = Math.sqrt(len2)
    // Stay a metre clear of the traverse corners so a man never straddles two bays.
    const margin = Math.min(0.45, 1.0 / segLen)
    let t = ((x - sec.a.x) * abx + (z - sec.a.z) * abz) / len2
    t = Math.max(margin, Math.min(1 - margin, t))
    // Enemy-facing normal (toward global -z) pushes the post onto the bench.
    let nx = -abz / segLen, nz = abx / segLen
    if (nz > 0) { nx = -nx; nz = -nz }
    const px = sec.a.x + abx * t + nx * TRENCH.fireStepSlot
    const pz = sec.a.z + abz * t + nz * TRENCH.fireStepSlot
    const d = dist2(x, z, px, pz)
    if (d < bestD) { bestD = d; best = { x: px, z: pz, sectionId: sec.id } }
  }
  return best
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
