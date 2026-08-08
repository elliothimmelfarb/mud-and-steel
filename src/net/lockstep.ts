/**
 * Deterministic lockstep over a Transport. Both peers run the FULL sim; only
 * command envelopes, tick beacons and state hashes cross the wire.
 *
 * - Local commands are stamped tick+INPUT_DELAY and sent; the peer's arrive
 *   the same way. Same envelopes + same seed = the same battle (M0 contract).
 * - A peer may not run more than WINDOW ticks ahead of the other: `gate()`
 *   tells the driver whether it may step this frame.
 * - Every HASH_EVERY ticks each side records + sends its state hash; any
 *   mismatch fires onDesync. Recovery IS the rejoin path: rebuild from the
 *   creator's (seed + envelope log) — proven hash-exact by the replay probe.
 * - If the peer vanishes, the host adopts the German side with the AI
 *   commander (adopted-AI envelopes ARE logged — unlike the from-start SP AI
 *   they cannot be re-derived from the seed).
 */
import type { MatchLength, Team } from '../core/types'
import { SimRunner } from '../sim/runner'
import { hashSim } from '../sim/hash'
import type { Cmd, Envelope } from '../sim/commands'
import type { Transport } from './transport'

export const INPUT_DELAY = 6
export const HASH_EVERY = 30

export type NetMsg =
  /** Joiner's pre-battle beacon; the host answers with hello, echoing the
   *  nonce so exactly ONE joiner pairs (BroadcastChannel rooms are open). */
  | { t: 'hi'; nonce: string }
  /** tick > 0 means the battle is already running: the joiner is a REJOINER
   *  and must requestLog() to fast-forward before stepping. */
  | { t: 'hello'; seedStr: string; matchLen: MatchLength; hostSide: Team; nonce: string; tick: number }
  | { t: 'env'; env: Envelope }
  /** Sent after every stepped tick. SEALS the sender's inputs: because the
   *  channel is ordered and submits stamp tick+INPUT_DELAY, once you hold
   *  frame T you provably hold every peer envelope for ticks ≤ T+INPUT_DELAY. */
  | { t: 'frame'; tick: number }
  | { t: 'hash'; tick: number; hash: number }
  | { t: 'reqlog' }
  | { t: 'log'; envs: Envelope[]; tick: number }
  | { t: 'bye' }

export interface LockstepEvents {
  onStatus?: (line: string) => void
  onDesync?: (tick: number) => void
  onPeerLost?: () => void
  onResynced?: () => void
}

export class LockstepSession {
  readonly runner: SimRunner
  readonly side: Team
  readonly isCreator: boolean
  /** Highest sealed peer frame. We may step tick X only if X <= peerFrame + INPUT_DELAY. */
  peerFrame = 0
  peerGone = false
  /** True while rebuilding from the creator's log (drive loop must not step). */
  resyncing = false
  desyncedAt: number | null = null
  private seq = 0
  /** Envelopes that arrive while we're rebuilding — re-enqueued after. */
  private resyncBuffer: Envelope[] = []
  private hashes = new Map<number, number>()
  private peerHashes = new Map<number, number>()
  private ev: LockstepEvents

  constructor(
    readonly seedStr: string,
    readonly matchLen: MatchLength,
    side: Team,
    isCreator: boolean,
    readonly transport: Transport,
    ev: LockstepEvents = {},
    makeRunner?: () => SimRunner,
  ) {
    this.side = side
    this.isCreator = isCreator
    this.ev = ev
    this.runner = makeRunner
      ? makeRunner()
      : new SimRunner({ seedStr, difficulty: 'front', mode: 'bigpush', matchLen, aiPersona: null })
    transport.onMessage = (m) => this.onMsg(m as NetMsg)
    transport.onClose = () => this.onPeerLost()
  }

  /** Local player action → scheduled for BOTH sims at tick+delay. */
  submit(cmds: Cmd[]): void {
    if (cmds.length === 0) return
    // While rebuilding, a locally-enqueued envelope would be wiped by
    // adoptState but still applied by the peer — a guaranteed re-desync.
    // The rebuild takes a moment; commands during it are simply refused.
    if (this.resyncing || this.desyncedAt !== null) {
      this.ev.onStatus?.('order lost in the confusion (resynchronising)')
      return
    }
    const env: Envelope = {
      tick: this.runner.ctx.s.tick + INPUT_DELAY,
      side: this.side,
      seq: this.seq++,
      cmds,
    }
    this.runner.enqueue(env)
    this.transport.send({ t: 'env', env } satisfies NetMsg)
  }

  /**
   * May the driver step the sim this frame? True lockstep: the NEXT tick must
   * be covered by the peer's sealed inputs. Deadlock-free — whichever side is
   * behind can always step, and its frames free the other.
   */
  gate(): boolean {
    if (this.resyncing || this.desyncedAt !== null) return false
    if (this.peerGone) return true // AI holds the other side now
    return this.runner.ctx.s.tick + 1 <= this.peerFrame + INPUT_DELAY
  }

  private lastFrameSent = -1

  /** Call AFTER each runner.step(). Seals this tick; hashes on cadence. */
  afterStep(): void {
    const tick = this.runner.ctx.s.tick
    // Post-outcome steps no longer advance the tick — don't spam the wire.
    if (tick === this.lastFrameSent) return
    this.lastFrameSent = tick
    this.transport.send({ t: 'frame', tick } satisfies NetMsg)
    if (tick % HASH_EVERY === 0) {
      const h = hashSim(this.runner.ctx.s)
      this.hashes.set(tick, h)
      if (this.hashes.size > 40) this.hashes.delete(tick - HASH_EVERY * 40)
      this.transport.send({ t: 'hash', tick, hash: h } satisfies NetMsg)
      const peer = this.peerHashes.get(tick)
      if (peer !== undefined) this.checkHash(tick, h, peer)
    }
  }

  private checkHash(tick: number, mine: number, theirs: number): void {
    if (mine === theirs) return
    if (this.desyncedAt !== null) return
    this.desyncedAt = tick
    this.ev.onStatus?.(`DESYNC at tick ${tick}: ${mine.toString(16)} vs ${theirs.toString(16)}`)
    this.ev.onDesync?.(tick)
    // The creator's battle is the battle. The other side rebuilds from its log.
    // Buffer from THIS moment: anything arriving before the rebuild lands is
    // either already in the log (tick <= snapshot) or must survive it.
    if (!this.isCreator) {
      this.resyncing = true
      this.transport.send({ t: 'reqlog' } satisfies NetMsg)
    }
  }

  private onMsg(m: NetMsg): void {
    switch (m.t) {
      case 'env':
        if (this.resyncing) this.resyncBuffer.push(m.env)
        else this.runner.enqueue(m.env)
        break
      case 'frame':
        if (m.tick > this.peerFrame) this.peerFrame = m.tick
        break
      case 'hash': {
        this.peerHashes.set(m.tick, m.hash)
        if (this.peerHashes.size > 40) this.peerHashes.delete(m.tick - HASH_EVERY * 40)
        const mine = this.hashes.get(m.tick)
        if (mine !== undefined) this.checkHash(m.tick, mine, m.hash)
        break
      }
      case 'reqlog': {
        const tick = this.runner.ctx.s.tick
        // Applied log + in-flight pending: envelopes stamped past this tick
        // are not in the log yet, but the rebuilding peer may have lost its
        // copy (dead transport, or wiped by its own adoptState). The reply is
        // EVERYTHING this side knows about the battle.
        const envs = [...this.runner.log, ...this.runner.pendingEnvelopes]
        this.transport.send({ t: 'log', envs, tick } satisfies NetMsg)
        // FREEZE here until the rebuilt peer's frames flow again — anything we
        // stepped past the snapshot would be missing from their replay.
        this.peerFrame = Math.min(this.peerFrame, tick - INPUT_DELAY)
        this.transport.send({ t: 'frame', tick } satisfies NetMsg)
        // Creator considers its own state authoritative; clear the flag.
        this.desyncedAt = null
        break
      }
      case 'log':
        this.rebuildFromLog(m.envs, m.tick)
        break
      case 'bye':
        this.onPeerLost()
        break
    }
  }

  /**
   * The one recovery path: fresh runner, replay the creator's envelope log to
   * the given tick. Used for desync resync AND for rejoin fast-forward —
   * bit-exact by the replay probe's contract.
   */
  rebuildFromLog(envs: Envelope[], tick: number): void {
    this.resyncing = true
    this.ev.onStatus?.(`rebuilding from log: ${envs.length} envelopes to tick ${tick}`)
    const fresh = new SimRunner({
      seedStr: this.seedStr, difficulty: 'front', mode: 'bigpush',
      matchLen: this.matchLen, aiPersona: null, headless: true,
    })
    fresh.begin()
    for (const env of envs) fresh.enqueue(JSON.parse(JSON.stringify(env)) as Envelope)
    for (let i = 0; i < tick; i++) fresh.step()
    // Swap the fresh state into OUR runner (context object identity must
    // survive — the render layer holds references to runner.ctx).
    this.runner.adoptState(fresh)
    this.desyncedAt = null
    this.resyncing = false
    // Envelopes stamped at or before the snapshot are already IN the log
    // (re-enqueueing would double-apply); later ones are the live tail — but
    // the reply's pending section may carry the same envelopes, so dedup on
    // (tick, side, seq) before re-enqueueing what we buffered ourselves.
    const seen = new Set<string>()
    for (const env of envs) {
      if (env.tick > tick) seen.add(`${env.tick}|${env.side}|${env.seq}`)
    }
    for (const env of this.resyncBuffer) {
      if (env.tick > tick && !seen.has(`${env.tick}|${env.side}|${env.seq}`)) this.runner.enqueue(env)
    }
    this.resyncBuffer.length = 0
    this.hashes.clear()
    this.peerHashes.clear()
    // The log sender froze at the snapshot tick; our frames free them. Treat
    // their snapshot tick as their latest sealed frame.
    this.peerFrame = Math.max(this.peerFrame, tick)
    this.transport.send({ t: 'frame', tick: this.runner.ctx.s.tick } satisfies NetMsg)
    this.ev.onResynced?.()
  }

  private onPeerLost(): void {
    if (this.peerGone) return
    this.peerGone = true
    // A desync/resync in flight with a dead peer can never complete — clear
    // it or gate() blocks forever with nobody left to free it.
    this.desyncedAt = null
    this.resyncing = false
    this.resyncBuffer.length = 0
    // The remaining human's machine adopts the ABSENT side with the AI. Now
    // that both sides play the same game, the commander can hold either chair
    // — the match goes on either way instead of ending in a walkover.
    const absent: Team = this.side === 'brit' ? 'german' : 'brit'
    this.runner.adoptAi('methodical', absent)
    this.ev.onStatus?.('peer lost — the AI takes their side')
    this.ev.onPeerLost?.()
  }

  /**
   * Rejoin plumbing: bind a NEW transport into a live session (the old peer
   * died; signaling produced a fresh channel). Un-adopts any takeover AI —
   * the returning human owns their side again.
   */
  attachTransport(t: Transport): void {
    ;(this as { transport: Transport }).transport = t
    t.onMessage = (m) => this.onMsg(m as NetMsg)
    t.onClose = () => this.onPeerLost()
    this.peerGone = false
    // Frozen until the rejoiner's frames arrive; announce where we stand.
    this.peerFrame = this.runner.ctx.s.tick - INPUT_DELAY
    this.transport.send({ t: 'frame', tick: this.runner.ctx.s.tick } satisfies NetMsg)
    this.hashes.clear()
    this.peerHashes.clear()
    this.runner.releaseAi()
    this.ev.onStatus?.('peer rejoined')
  }

  /** A rejoining client's first act: ask the survivor for the battle so far. */
  requestLog(): void {
    this.resyncing = true // buffer every envelope until the rebuild lands
    this.transport.send({ t: 'reqlog' } satisfies NetMsg)
  }

  close(): void {
    this.transport.send({ t: 'bye' } satisfies NetMsg)
    this.transport.close()
  }
}
