/**
 * ?bigpush — The Big Push lab. M0 deliverable: the twin-sim determinism probe.
 *
 * Runs TWO headless SimRunners in one process on the same seed, drives them
 * with an identical scripted command stream (a deterministic bot commander
 * reading sim A), and compares 32-bit state hashes every 30 ticks. Any
 * mismatch = a determinism bug = a Big Push release blocker.
 *
 * Also proves the replay path: a third runner is fed sim A's recorded
 * envelope log wholesale and must land on the identical final hash.
 *
 * Console API (for probes / CI): await window.__twinsim.run({ waves: 20 })
 */
import type { Difficulty } from '../core/types'
import { PLACEMENT, UPGRADE_DEFS, WORLD } from '../core/config'
import { SimRunner } from '../sim/runner'
import { hashSim } from '../sim/hash'
import { orderReady, upgradeAvailable, type Cmd, type Envelope } from '../sim/commands'
import type { SimState } from '../sim/sim'

export interface TwinProbeOpts {
  seed?: string
  waves?: number
  difficulty?: Difficulty
  mode?: 'classic' | 'bigpush'
  /** Big Push runs are time-bound (sim seconds) rather than wave-bound. */
  simSeconds?: number
  /** Big Push: german AI persona; null disables the AI (isolated probes). */
  aiPersona?: 'methodical' | 'stosstrupp' | 'opportunist' | null
  startReq?: number
  onProgress?: (line: string) => void
}

export interface TwinProbeResult {
  ok: boolean
  twinOk: boolean
  replayOk: boolean
  /** True when the run hit the tick cap without finishing — a wave stalled. */
  stalled: boolean
  ticks: number
  wavesReached: number
  outcome: string
  divergedAtTick: number | null
  checks: number
  finalHash: number
  wallMs: number
}

/**
 * A deterministic scripted commander. Reads ONE sim's state and emits the
 * classic-mode command surface (begin/buy/upgrade/orders/callwave). All
 * decisions are pure functions of sim state + internal counters — no
 * Math.random, no Date, so twin sims fed its output stay in lockstep.
 */
class ProbeCommander {
  private beganWave = 0
  private boughtWave = 0
  private slot = 0

  private bpNextShop = 1
  private bpLastAssault = 0
  private bpAssaultStarted = new Map<number, number>()

  think(s: SimState): Cmd[] {
    const cmds: Cmd[] = []
    if (s.outcome !== 'ongoing') return cmds

    // Big Push: continuous war. Keep the line bought, send a fresh assault
    // whenever a party has formed, recall anything out too long. Cyclical and
    // purely state-derived, so it doubles as the balance-lab British side.
    if (s.mode === 'bigpush') {
      if (s.tick % 60 !== 0) return cmds
      // Shopping: keep ~10 posts manned.
      const live = s.units.filter((u) => !u.disbanded && u.crew.some((c) => c.hp > 0))
      if (s.time >= this.bpNextShop && live.length < 10 && s.req >= 70) {
        this.bpNextShop = s.time + 20
        const xs = [-16, -8, 0, 8, 16, 24, -32, 32]
        const have = live.length
        for (let i = 0; i < Math.min(4, 10 - have); i++) {
          cmds.push({ t: 'buy', kind: i === 3 ? 'engineer' : 'rifleman', x: xs[(have + i) % xs.length], z: WORLD.frontTrenchZ })
        }
        return cmds
      }
      // Recall parties out longer than 3 minutes.
      for (const g of s.assaults) {
        if (g.side !== 'brit' || g.state !== 'advancing') continue
        const started = this.bpAssaultStarted.get(g.id) ?? s.time
        if (!this.bpAssaultStarted.has(g.id)) this.bpAssaultStarted.set(g.id, s.time)
        if (s.time - started > 180) cmds.push({ t: 'recall', groupId: g.id })
      }
      if (cmds.length > 0) return cmds
      // Assault when a party is formed and nothing is already out.
      const anyOut = s.assaults.some((g) => g.side === 'brit')
      const formed = live.filter((u) => !u.march && u.assaultGroupId === null)
      if (!anyOut && formed.length >= 6 && s.time - this.bpLastAssault > 90 && s.time > 120) {
        const mine = new Set<number>()
        for (const u of formed) {
          let best = -1, bestD = 100
          for (const sec of s.sections) {
            if (sec.home !== 'brit' || sec.line !== 'front') continue
            const d = Math.hypot(sec.mid.x - u.pos.x, sec.mid.z - u.pos.z)
            if (d < bestD) { bestD = d; best = sec.id }
          }
          if (best >= 0) mine.add(best)
        }
        let target = -1, bestAbs = Infinity
        for (const sec of s.sections) {
          if (sec.home !== 'german' || sec.line !== 'front' || sec.owner !== 'german') continue
          if (Math.abs(sec.mid.x) < bestAbs) { bestAbs = Math.abs(sec.mid.x); target = sec.id }
        }
        if (mine.size > 0 && target >= 0) {
          this.bpLastAssault = s.time
          // Leave a third of the sections home as a garrison.
          const list = [...mine].sort((a, b) => a - b)
          cmds.push({ t: 'assault', sections: list.slice(0, Math.max(1, Math.ceil(list.length * 0.7))), targetSection: target })
        }
        return cmds
      }
      // Consolidate anything we hold that still faces the wrong way.
      for (const sec of s.sections) {
        if (sec.home === 'german' && sec.owner === 'brit' && sec.facing !== 1 && !sec.consolidating) {
          cmds.push({ t: 'consolidate', section: sec.id })
        }
      }
      return cmds
    }

    if (s.phase === 'debrief' && s.plan && this.beganWave < s.wave) {
      this.beganWave = s.wave
      cmds.push({ t: 'beginwave' })
      return cmds
    }

    if (s.phase === 'build' && this.boughtWave < s.wave) {
      this.boughtWave = s.wave
      cmds.push(...this.shop(s))
      cmds.push({ t: 'callwave' })
      return cmds
    }

    if (s.phase === 'assault') {
      if (orderReady(s, 'rapidfire')) cmds.push({ t: 'order', id: 'rapidfire' })
      if (s.clouds.length > 0 && !s.masksOn) cmds.push({ t: 'order', id: 'masks' })
      else if (s.clouds.length === 0 && s.masksOn && s.wave > this.beganWave - 1) cmds.push({ t: 'order', id: 'masks' })
      if (orderReady(s, 'takecover') && s.barrages.some((b) => b.t < 0)) cmds.push({ t: 'order', id: 'takecover' })
    }
    return cmds
  }

  /** One wave's shopping list. The sim validates each command in order. */
  private shop(s: SimState): Cmd[] {
    const cmds: Cmd[] = []
    // One affordable upgrade per wave keeps the tree exercised.
    for (const up of UPGRADE_DEFS) {
      if (upgradeAvailable(s, up.id) === 'buyable') { cmds.push({ t: 'upgrade', id: up.id }); break }
    }
    // Line infantry across the front, a Lewis every third slot.
    const xs = [-90, -72, -54, -36, -18, 0, 18, 36, 54, 72, 90]
    const n = s.wave === 1 ? 8 : 5
    for (let i = 0; i < n; i++) {
      const x = xs[this.slot++ % xs.length]
      cmds.push({ t: 'buy', kind: this.slot % 3 === 0 ? 'lewis' : 'rifleman', x, z: WORLD.frontTrenchZ })
    }
    // Emplacements on the pads behind the line.
    if (s.wave % 2 === 0) {
      cmds.push({ t: 'buy', kind: 'vickers', x: s.wave % 4 === 0 ? 42 : -42, z: WORLD.frontTrenchZ + PLACEMENT.padMarginZ + 8 })
    }
    if (s.wave % 3 === 0) {
      cmds.push({ t: 'buy', kind: 'mortar', x: s.wave % 6 === 0 ? 20 : -20, z: WORLD.frontTrenchZ + PLACEMENT.padMarginZ + 16 })
    }
    // Fresh wire out front; sandbags on the middle bays.
    for (let i = 0; i < 4; i++) {
      const wx = ((this.slot * 5 + i * 11) % 22 - 11) * 8
      cmds.push({ t: 'buy', kind: 'wire', x: wx, z: WORLD.frontTrenchZ - 15, angle: 0 })
    }
    cmds.push({ t: 'buy', kind: 'sandbags', x: (s.wave % 5 - 2) * 30, z: WORLD.frontTrenchZ })
    return cmds
  }
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * Yield to the event loop WITHOUT setTimeout: hidden/occluded pages get their
 * timers clamped to once a minute ("intensive throttling"), which turned a
 * 3-minute probe into an hour. MessageChannel posts are exempt.
 */
const nextTick = (): Promise<void> => new Promise((resolve) => {
  const ch = new MessageChannel()
  ch.port1.onmessage = () => resolve()
  ch.port2.postMessage(null)
})

export async function runTwinProbe(opts: TwinProbeOpts = {}): Promise<TwinProbeResult> {
  const seed = opts.seed ?? 'bigpush-m0'
  const waves = opts.waves ?? 20
  const difficulty = opts.difficulty ?? 'front'
  const startReq = opts.startReq ?? 900
  const say = opts.onProgress ?? (() => {})
  const t0 = performance.now()

  const mk = () => new SimRunner({ seedStr: seed, difficulty, mode: opts.mode ?? 'classic', aiPersona: opts.aiPersona, headless: true, startReq })
  const a = mk()
  const b = mk()
  ;(window as unknown as { __twinsimLast: object }).__twinsimLast = { a, b }
  a.begin(); b.begin()

  const bot = new ProbeCommander()
  let seq = 0
  let checks = 0
  let diverged: number | null = null
  let lastWaveSeen = 0
  const MAX_TICKS = 30 * 60 * 120 // 2 sim-hours hard stop

  const bpSeconds = opts.simSeconds ?? 480
  while (a.ctx.s.tick < MAX_TICKS) {
    const s = a.ctx.s
    if (s.outcome !== 'ongoing') break
    if (s.mode === 'bigpush' ? s.time >= bpSeconds : s.wave > waves) break
    if (s.wave !== lastWaveSeen) {
      lastWaveSeen = s.wave
      say(`wave ${s.wave} — tick ${s.tick}, req £${s.req}, hash ${(hashSim(s) >>> 0).toString(16)}`)
      await nextTick() // let the page breathe
    }

    const cmds = bot.think(s)
    if (cmds.length > 0) {
      const env: Envelope = { tick: s.tick, side: 'brit', seq: seq++, cmds }
      a.enqueue(clone(env))
      b.enqueue(clone(env))
    }

    a.step()
    b.step()

    if (a.ctx.s.tick % 30 === 0) {
      checks++
      const ha = hashSim(a.ctx.s)
      const hb = hashSim(b.ctx.s)
      if (ha !== hb) {
        diverged = a.ctx.s.tick
        say(`✗ DIVERGENCE at tick ${diverged}: A=${ha.toString(16)} B=${hb.toString(16)}`)
        break
      }
    }
  }

  const ticks = a.ctx.s.tick
  const finalHash = hashSim(a.ctx.s)
  const twinOk = diverged === null

  // Replay check: a fresh runner fed the recorded log must land on the same hash.
  say(`replaying ${a.log.length} envelopes over ${ticks} ticks into a fresh sim… (live outcome: ${a.ctx.s.outcome}, wave ${a.ctx.s.wave})`)
  await nextTick()
  const c = mk()
  c.begin()
  for (const env of a.log) c.enqueue(clone(env))
  for (let i = 0; i < ticks; i++) {
    c.step()
    if (i % 4000 === 3999) {
      const cs = c.ctx.s
      say(`  replay ${i + 1}/${ticks} — wave ${cs.wave} ${cs.phase} ${cs.outcome}, ${cs.enemies.length} enemies, ${cs.units.length} units, ${cs.bullets.length} bullets, ${cs.projectiles.length} proj`)
      await nextTick()
    }
  }
  const replayOk = hashSim(c.ctx.s) === finalHash
  if (!replayOk) say(`✗ REPLAY MISMATCH: live=${finalHash.toString(16)} replay=${hashSim(c.ctx.s).toString(16)}`)

  const stalled = ticks >= MAX_TICKS
  if (stalled) say(`✗ STALL — hit the ${MAX_TICKS}-tick cap on wave ${a.ctx.s.wave} (${a.ctx.s.enemies.filter((e) => e.hp > 0).length} enemies left)`)

  return {
    ok: twinOk && replayOk && !stalled,
    twinOk, replayOk, stalled,
    ticks,
    wavesReached: a.ctx.s.wave,
    outcome: a.ctx.s.outcome,
    divergedAtTick: diverged,
    checks,
    finalHash,
    wallMs: Math.round(performance.now() - t0),
  }
}

// ---------------------------------------------------------------------------
// M3 gate probes
// ---------------------------------------------------------------------------

/**
 * Scripted assault probe (spec §5 M3 gate): buy a storming party, send it
 * over the top at a garrisoned line, and assert every stage of the drill —
 * the advance crosses no-man's-land, wire gets cut, melee kills land, the
 * section flips, consolidation reverses the bench, recall brings them home.
 */
export async function runAssaultProbe(opts: { seed?: string; onProgress?: (l: string) => void } = {}): Promise<Record<string, unknown>> {
  const say = opts.onProgress ?? (() => {})
  const r = new SimRunner({ seedStr: opts.seed ?? 'm3-assault', difficulty: 'front', mode: 'bigpush', aiPersona: null, headless: true, startReq: 900 })
  r.begin()
  const s = r.ctx.s

  // Garrison the objective line so there is a fight: spawn german defenders
  // at their front sections (director-style, via the real squad spawner).
  const { makeSquad } = await import('../sim/enemies')
  const gerFront = s.sections.filter((c) => c.home === 'german' && c.line === 'front' && Math.abs(c.mid.x) < 40)
  for (const sec of gerFront.slice(0, 3)) {
    const sq = makeSquad(r.ctx, ['einf', 'einf', 'einf'], sec.mid.x, sec.id)
    // Walk them onto their parapet line (they spawn at the north edge).
    for (const id of sq.members) {
      const e = s.enemies.find((x) => x.id === id)
      if (e) { e.pos.x = sec.mid.x + (r.ctx.rand() - 0.5) * 6; e.pos.z = sec.mid.z; e.behavior = 'takecover' }
    }
  }
  const defenders0 = s.enemies.filter((e) => e.hp > 0).length
  const wire0 = s.defences.filter((d) => d.kind === 'wire' && d.side === 'german' && d.hp > 0).length

  const bot = new ProbeCommander()
  let seq = 0
  const out: Record<string, unknown> = {}
  let captureTick = 0
  let consolidatedTick = 0
  let minZ = 999
  let targetSec = -1

  const MAX = 30 * 60 * 22 // 22 sim-minutes cap
  for (let i = 0; i < MAX; i++) {
    const cmds = bot.think(s)
    if (cmds.length > 0) r.enqueue({ tick: s.tick, side: 'brit', seq: seq++, cmds })
    r.step()
    if (s.tick % 1800 === 0) { say(`t=${Math.round(s.time)}s adv=${s.advance.brit.toFixed(0)} enemies=${s.enemies.filter(e => e.hp > 0).length} assaults=${s.assaults.length}`); await nextTick() }
    if (s.advance.brit < minZ) minZ = s.advance.brit
    if (targetSec < 0 && s.assaults.length > 0) targetSec = s.assaults[0].targetSectionId
    if (!captureTick && targetSec >= 0) {
      const t = s.sections.find((c) => c.id === targetSec)
      if (t && t.owner === 'brit') {
        captureTick = s.tick
        // Order consolidation the moment it falls.
        r.enqueue({ tick: s.tick, side: 'brit', seq: seq++, cmds: [{ t: 'consolidate', section: targetSec }] })
      }
    }
    if (captureTick && !consolidatedTick) {
      const t = s.sections.find((c) => c.id === targetSec)
      if (t && t.facing === 1) consolidatedTick = s.tick
    }
    // After consolidation the bot's own recall (t>420) or ours here wraps up.
    if (consolidatedTick && s.assaults.length === 0) break
    if (s.outcome !== 'ongoing') break
  }

  const t = s.sections.find((c) => c.id === targetSec)
  out.assaultLaunched = targetSec >= 0
  out.crossedNml = minZ < 0
  out.wireCut = s.defences.filter((d) => d.kind === 'wire' && d.side === 'german' && d.hp > 0).length < wire0
  out.meleeKills = defenders0 - s.enemies.filter((e) => e.hp > 0).length
  out.captured = captureTick > 0
  out.consolidated = consolidatedTick > 0
  out.benchReversedFacing = t ? t.facing : null
  out.allRecalledHome = s.assaults.length === 0 && s.units.every((u) => u.assaultGroupId === null)
  out.simSeconds = Math.round(s.time)
  out.ok = Boolean(out.assaultLaunched && out.crossedNml && out.wireCut && (out.meleeKills as number) > 0 && out.captured && out.consolidated && out.allRecalledHome)
  return out
}

/** Verdict probe: every timed length must end, with the right verdict. */
export async function runVerdictProbe(opts: { onProgress?: (l: string) => void } = {}): Promise<Record<string, unknown>> {
  const say = opts.onProgress ?? (() => {})
  const results: Record<string, unknown> = {}
  for (const len of ['raid', 'battle', 'grand'] as const) {
    const r = new SimRunner({ seedStr: 'verdict-' + len, difficulty: 'front', mode: 'bigpush', matchLen: len, aiPersona: null, headless: true })
    r.begin()
    const s = r.ctx.s
    // Tip the scales so the verdict is determinate: bleed german strength.
    s.strength.german = 40
    const cap = 30 * (s.timeLimit + 120)
    let i = 0
    for (; i < cap && s.outcome === 'ongoing'; i++) r.step()
    // Whistle time = stand-to + limit.
    const expected = 60 + s.timeLimit
    results[len] = {
      outcome: s.outcome,
      endedAtSimSeconds: Math.round(s.time),
      expectedWhistle: expected,
      ok: s.outcome === 'victory' && Math.abs(s.time - expected) < 2,
    }
    say(`${len}: ${JSON.stringify(results[len])}`)
    await nextTick()
  }
  // Attrition: no clock — flip a majority of the german front to brit and the
  // hold timer must end it inside ~holdWinSeconds.
  {
    const r = new SimRunner({ seedStr: 'verdict-attrition', difficulty: 'front', mode: 'bigpush', matchLen: 'attrition', aiPersona: null, headless: true })
    r.begin()
    const s = r.ctx.s
    for (let i = 0; i < 30 * 61; i++) r.step() // through stand-to
    for (const sec of s.sections) {
      if (sec.home === 'german' && sec.line === 'front') { sec.owner = 'brit'; sec.captured = true }
    }
    let i = 0
    for (; i < 30 * 90 && s.outcome === 'ongoing'; i++) r.step()
    results.attrition = {
      outcome: s.outcome,
      heldSeconds: Math.round(i / 30),
      ok: s.outcome === 'victory' && i / 30 < 75,
    }
    say(`attrition: ${JSON.stringify(results.attrition)}`)
  }
  results.ok = (['raid', 'battle', 'grand', 'attrition'] as const).every((k) => (results[k] as { ok: boolean }).ok)
  return results
}

/**
 * The balance lab (M4 gate): N headless AI-vs-AI(bot) matches across lengths
 * and personas. Every timed match must terminate at (or before) its whistle;
 * a match still 'ongoing' past the whistle grace is a STALL and fails the lab.
 */
export async function runBalanceLab(n = 50, opts: { onProgress?: (l: string) => void } = {}): Promise<Record<string, unknown>> {
  const say = opts.onProgress ?? (() => {})
  const lengths = ['raid', 'battle', 'grand'] as const
  const personas = ['methodical', 'stosstrupp', 'opportunist'] as const
  const results: Array<Record<string, unknown>> = []
  let stalls = 0
  const outcomes: Record<string, number> = { victory: 0, defeat: 0, draw: 0 }
  const t0 = performance.now()

  for (let i = 0; i < n; i++) {
    // Weight raids heaviest to keep the lab quick; grands every 5th.
    const len = i % 5 === 4 ? 'grand' : lengths[i % 2]
    const persona = personas[i % 3]
    const r = new SimRunner({
      seedStr: `lab-${i}`, difficulty: 'front', mode: 'bigpush',
      matchLen: len, aiPersona: persona, headless: true,
    })
    r.begin()
    const s = r.ctx.s
    const bot = new ProbeCommander()
    let seq = 0
    const grace = 60 + s.timeLimit + 10
    const cap = Math.round(30 * grace)
    let ticks = 0
    for (; ticks < cap && s.outcome === 'ongoing'; ticks++) {
      const cmds = bot.think(s)
      if (cmds.length > 0) r.enqueue({ tick: s.tick, side: 'brit', seq: seq++, cmds })
      r.step()
      if (ticks % 12000 === 11999) await nextTick()
    }
    const stalled = s.outcome === 'ongoing'
    if (stalled) stalls++
    else outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1
    results.push({
      i, len, persona, outcome: s.outcome, simSeconds: Math.round(s.time),
      strength: { brit: Math.round(s.strength.brit), german: Math.round(s.strength.german) },
      stalled,
    })
    say(`match ${i + 1}/${n} [${len}/${persona}]: ${s.outcome} @ ${Math.round(s.time)}s (str ${Math.round(s.strength.brit)}:${Math.round(s.strength.german)})`)
    await nextTick()
  }
  const summary = {
    n, stalls, outcomes,
    ok: stalls === 0,
    wallMs: Math.round(performance.now() - t0),
    results,
  }
  say(`LAB ${summary.ok ? 'CLEAN' : 'FAILED'} — ${n} matches, ${stalls} stalls, ${JSON.stringify(outcomes)}, ${summary.wallMs} ms`)
  return summary
}

// ---------------------------------------------------------------------------
// Page harness
// ---------------------------------------------------------------------------

export function startTwinSimLab(app: HTMLElement): void {
  app.innerHTML = `
    <div style="font:14px/1.5 'SF Mono',Menlo,monospace;color:#d8cdb4;background:#181510;min-height:100vh;padding:2rem">
      <h1 style="font-size:1.2rem;letter-spacing:.2em;color:#c9b070">THE BIG PUSH — TWIN-SIM DETERMINISM PROBE</h1>
      <p style="color:#8a8064">Two headless sims, one seed, one command stream. Hashes compared every 30 ticks; then the full log is replayed into a third sim. <code>await __twinsim.run({waves: 20})</code></p>
      <pre id="twinlog" style="white-space:pre-wrap;margin-top:1rem"></pre>
    </div>`
  const log = document.getElementById('twinlog')!
  const say = (line: string) => {
    log.textContent += line + '\n'
    // eslint-disable-next-line no-console
    console.log('[twinsim]', line)
  }

  const api = {
    run: (o: TwinProbeOpts = {}) => runTwinProbe({ onProgress: say, ...o }),
    assault: (o: { seed?: string } = {}) => runAssaultProbe({ onProgress: say, ...o }),
    verdicts: () => runVerdictProbe({ onProgress: say }),
    balance: (n = 50) => runBalanceLab(n, { onProgress: say }),
  }
  ;(window as unknown as { __twinsim: typeof api }).__twinsim = api

  // Auto-run a quick 6-wave pass on load so opening the page IS a smoke test;
  // PR gates run the full 20 from the console.
  void api.run({ waves: 6 }).then((res) => {
    say(res.ok
      ? `✓ CLEAN — ${res.ticks} ticks, ${res.checks} hash checks, wave ${res.wavesReached}, replay ok, ${res.wallMs} ms`
      : `✗ FAILED — twin=${res.twinOk} replay=${res.replayOk} divergedAt=${res.divergedAtTick}`)
    say(JSON.stringify(res))
  })
}
