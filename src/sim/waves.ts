/**
 * The adaptive wave director. It has a budget, a war to run, and a memory:
 * it watches HOW you kill its men and buys counters — pioneers for your wire,
 * snipers for your machine guns, dispersed storm parties for your artillery.
 * No two runs, and no two waves, play the same.
 */
import type { Difficulty, EnemyKindId, WavePlan, WaveSpawn } from '../core/types'
import { DIRECTOR, ENEMY_DEFS, VEHICLE_DEFS, WORLD } from '../core/config'
import type { Rand } from '../core/rng'
import { makeSquad, spawnEnemy } from './enemies'
import { spawnVehicle } from './vehicles'
import type { Ctx } from './sim'

type TemplateId = 'probe' | 'mass' | 'storm' | 'barrage_assault' | 'cavalry_raid' | 'armour_push' | 'gas_attack' | 'combined'

interface Template {
  id: TemplateId
  fromWave: number
  weight: number
  night: number          // probability bump for a night attack
  weather: 'clear' | 'rain' | 'fog'
  barrageMult: number
  gas: boolean
}

const TEMPLATES: Template[] = [
  { id: 'probe', fromWave: 1, weight: 2, night: 0, weather: 'clear', barrageMult: 0, gas: false },
  { id: 'mass', fromWave: 2, weight: 3, night: 0, weather: 'clear', barrageMult: 0.6, gas: false },
  { id: 'cavalry_raid', fromWave: 2, weight: 1.4, night: 0, weather: 'fog', barrageMult: 0, gas: false },
  { id: 'barrage_assault', fromWave: 4, weight: 2.4, night: 0, weather: 'rain', barrageMult: 1.6, gas: false },
  { id: 'storm', fromWave: 5, weight: 2.2, night: 0.65, weather: 'fog', barrageMult: 0.7, gas: false },
  { id: 'gas_attack', fromWave: 8, weight: 1.8, night: 0.2, weather: 'clear', barrageMult: 1, gas: true },
  { id: 'armour_push', fromWave: 11, weight: 2.2, night: 0, weather: 'clear', barrageMult: 0.8, gas: false },
  { id: 'combined', fromWave: 13, weight: 3, night: 0.25, weather: 'rain', barrageMult: 1.4, gas: true },
]

export function planWave(ctx: Ctx, wave: number, difficulty: Difficulty, rand: Rand): WavePlan {
  const budget = DIRECTOR.budgetBase[difficulty] * (1 + DIRECTOR.budgetGrowth * (wave - 1))

  // -- what has been killing us? --------------------------------------------
  const ledger = ctx.s.director.dmgByCategory
  let topCat = ''
  let topVal = 0
  for (const [cat, val] of Object.entries(ledger)) {
    if (val > topVal && DIRECTOR.counters[cat]) { topVal = val; topCat = cat }
  }
  const counter = topCat ? DIRECTOR.counters[topCat] : null

  // -- pick a template ---------------------------------------------------------
  const avail = TEMPLATES.filter((t) => wave >= t.fromWave)
  let total = 0
  for (const t of avail) total += t.weight
  let roll = rand() * total
  let tpl = avail[0]
  for (const t of avail) { roll -= t.weight; if (roll <= 0) { tpl = t; break } }

  const night = DIRECTOR.nightWaves.includes(wave) || rand() < tpl.night * (wave >= 6 ? 1 : 0)

  // -- composition ---------------------------------------------------------------
  const spawns: WaveSpawn[] = []
  let remaining = budget
  const lanes = pickLanes(rand, wave)
  let pulse = 0
  const spend = (kind: EnemyKindId | 'ecar' | 'etank', count: number, at: number, x: number) => {
    const cost = kind === 'ecar' || kind === 'etank' ? VEHICLE_DEFS[kind].cost : ENEMY_DEFS[kind as EnemyKindId].cost
    if (remaining < cost * count) count = Math.max(0, Math.floor(remaining / cost))
    if (count === 0) return
    remaining -= cost * count
    spawns.push({ kind, count, at, x })
  }

  // Template signature purchases first.
  const lane = () => lanes[Math.floor(rand() * lanes.length)]
  switch (tpl.id) {
    case 'probe': break
    case 'mass': break
    case 'cavalry_raid':
      spend('ecav', 4 + Math.floor(rand() * 4), 6, lane())
      spend('ecav', 3 + Math.floor(rand() * 3), 30, lane())
      break
    case 'storm':
      spend('estorm', 5 + Math.floor(wave / 3), 4, lane())
      spend('estorm', 4 + Math.floor(wave / 4), 26, lane())
      break
    case 'barrage_assault':
      spend('emg', 1, 20, lane())
      break
    case 'gas_attack':
      spend('estorm', 4, 40, lane())
      break
    case 'armour_push':
      spend('ecar', 1 + (rand() < 0.4 ? 1 : 0), 10, lane())
      if (wave >= VEHICLE_DEFS.etank.fromWave) spend('etank', 1, 25, lane())
      break
    case 'combined':
      if (wave >= VEHICLE_DEFS.etank.fromWave) spend('etank', 1 + (rand() < 0.3 ? 1 : 0), 30, lane())
      spend('emg', 2, 12, lane())
      spend('estorm', 6, 45, lane())
      break
  }

  // The director's counter-purchases.
  if (counter) {
    for (const [kind, mult] of Object.entries(counter.spawns) as Array<[EnemyKindId, number]>) {
      if (wave < ENEMY_DEFS[kind].fromWave) continue
      const n = Math.round(mult * (1 + wave * 0.18))
      spend(kind, n, 10 + rand() * 40, lane())
    }
  }

  // Support weapons that scale with the war.
  if (wave >= ENEMY_DEFS.emg.fromWave && rand() < 0.7) spend('emg', 1 + Math.floor(wave / 7), 15 + rand() * 30, lane())
  if (wave >= ENEMY_DEFS.esniper.fromWave && rand() < 0.6) spend('esniper', 1 + Math.floor(wave / 9), 8, lane())
  if (wave >= ENEMY_DEFS.eflamer.fromWave && rand() < 0.5) spend('eflamer', 2, 35 + rand() * 20, lane())
  if (wave >= ENEMY_DEFS.epioneer.fromWave && ctx.s.director.wireDensity > 4) spend('epioneer', 3, 6, lane())

  // Spend the rest on line infantry in pulses, an officer with each big pulse.
  pulse = 0
  while (remaining >= ENEMY_DEFS.einf.cost * 4) {
    const at = 3 + pulse * (16 + rand() * 8)
    const x = lanes[pulse % lanes.length]
    const n = Math.min(6 + Math.floor(rand() * 4) + Math.floor(wave / 5), Math.floor(remaining / ENEMY_DEFS.einf.cost))
    spend('einf', n, at, x)
    if (remaining >= ENEMY_DEFS.eofficer.cost && rand() < 0.75) spend('eofficer', 1, at + 1, x)
    pulse++
    if (pulse > 12) break
  }

  spawns.sort((a, b) => a.at - b.at)

  // -- barrages ---------------------------------------------------------------
  const barrages: WavePlan['barrages'] = []
  if (wave >= DIRECTOR.barrageFromWave && tpl.barrageMult > 0) {
    const count = Math.round((1 + rand() * 2) * tpl.barrageMult)
    for (let i = 0; i < count; i++) {
      barrages.push({
        at: 5 + rand() * 60,
        x: (rand() - 0.5) * 180,
        z: WORLD.frontTrenchZ + (rand() - 0.5) * 30,
        shells: Math.round((6 + wave * 0.7 + rand() * 6) * ctx.mods.counterBattery),
        gas: tpl.gas && wave >= DIRECTOR.gasFromWave && rand() < 0.6,
      })
    }
    if (tpl.gas && wave >= DIRECTOR.gasFromWave) {
      barrages.push({
        at: 15 + rand() * 20,
        x: (rand() - 0.5) * 120,
        z: WORLD.frontTrenchZ - 20,
        shells: 6,
        gas: true,
      })
    }
  }

  return {
    number: wave,
    name: tpl.id, // template id; the game layer turns it into a flavor name
    spawns,
    barrages,
    night,
    weatherBias: tpl.weather,
    intent: counter ? counter.intent : defaultIntent(tpl.id),
    // The concrete adaptation telegraph — only set when the director actually
    // bought a counter to how the player has been killing its men.
    adaptation: counter ? counter.telegraph : null,
  }
}

function pickLanes(rand: Rand, wave: number): number[] {
  const all = [-95, -50, 0, 50, 95]
  const n = Math.min(2 + Math.floor(wave / 4) + (rand() < 0.4 ? 1 : 0), all.length)
  // Shuffle, take n.
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = all[i]; all[i] = all[j]; all[j] = t
  }
  return all.slice(0, n)
}

// Lower-case, mid-sentence fragments — intelFlavor embeds them inside a
// sentence ("Corps expects <intent>…"), same convention as DIRECTOR counters.
function defaultIntent(id: TemplateId): string {
  switch (id) {
    case 'probe': return 'a probing attack to test your line'
    case 'mass': return 'an attack in mass formation'
    case 'storm': return 'infiltration by assault detachments'
    case 'barrage_assault': return 'an assault behind a heavy preparatory barrage'
    case 'cavalry_raid': return 'a cavalry raid against your flanks'
    case 'armour_push': return 'an armoured thrust at your centre'
    case 'gas_attack': return 'a gas discharge ahead of the infantry'
    case 'combined': return 'a combined-arms assault in depth'
  }
}

// ---------------------------------------------------------------------------
// Runtime spawning
// ---------------------------------------------------------------------------

/** Returns true while the wave still has men or machines in it. */
export function updateWaveSpawns(ctx: Ctx, elapsed: number): boolean {
  const { s } = ctx
  const plan = s.plan
  if (!plan) return false

  while (s.planCursor < plan.spawns.length && plan.spawns[s.planCursor].at <= elapsed) {
    const sp = plan.spawns[s.planCursor++]
    if (sp.kind === 'ecar' || sp.kind === 'etank') {
      for (let i = 0; i < sp.count; i++) {
        spawnVehicle(ctx, sp.kind, sp.x + (ctx.rand() - 0.5) * 20, WORLD.enemySpawnZ - i * 12)
      }
    } else {
      const kind = sp.kind as EnemyKindId
      // Section targeting: prefer weak spots (low parapet, captured neighbours).
      let remaining = sp.count
      while (remaining > 0) {
        const chunk = Math.min(remaining, kind === 'emg' || kind === 'esniper' ? 2 : 8)
        remaining -= chunk
        const target = pickTargetSection(ctx)
        makeSquad(ctx, new Array(chunk).fill(kind), sp.x + (ctx.rand() - 0.5) * 12, target)
      }
    }
    ctx.flowDirty = true
  }

  const spawnsDone = s.planCursor >= plan.spawns.length
  // Routed men no longer count as fight — the wave is beaten when only backs remain.
  const hostiles = s.enemies.some((e) => e.behavior !== 'rout') ||
    s.vehicles.some((v) => v.team === 'german' && !v.dead)
  return !(spawnsDone && !hostiles && elapsed > 8)
}

function pickTargetSection(ctx: Ctx): number {
  const fronts = ctx.s.sections.filter((sec) => sec.line === 'front')
  let best = fronts[0]?.id ?? 0
  let bestScore = -Infinity
  for (const sec of fronts) {
    let score = ctx.rand() * 40
    score -= sec.parapetHp / sec.parapetMax * 20
    if (sec.captured) score += 50 // reinforce success
    for (const u of ctx.s.units) {
      if (!u.disbanded && Math.abs(u.pos.x - sec.mid.x) < 12) score -= 8
    }
    if (score > bestScore) { bestScore = score; best = sec.id }
  }
  return best
}

/** Count wire so the director can decide whether pioneers are worth it. */
export function noteWireDensity(ctx: Ctx): void {
  let n = 0
  for (const d of ctx.s.defences) if (d.kind === 'wire' && d.hp > 0) n++
  ctx.s.director.wireDensity = n
}

/** Spawn used by the Fix Bayonets counter-charge check (unused elsewhere). */
export const _internals = { spawnEnemy }
