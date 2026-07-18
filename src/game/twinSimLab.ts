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

  think(s: SimState): Cmd[] {
    const cmds: Cmd[] = []
    if (s.outcome !== 'ongoing') return cmds

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

  const mk = () => new SimRunner({ seedStr: seed, difficulty, mode: opts.mode ?? 'classic', headless: true, startReq })
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

  while (a.ctx.s.tick < MAX_TICKS) {
    const s = a.ctx.s
    if (s.outcome !== 'ongoing' || s.wave > waves) break
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
