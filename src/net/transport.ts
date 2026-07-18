/**
 * The transport seam. Lockstep only ever sees this interface — underneath it
 * is a WebRTC DataChannel in production, a jittery in-process loopback in the
 * lab, or a BroadcastChannel between two local tabs. Messages are JSON blobs;
 * ordering must be preserved (all three implementations are ordered).
 */
export interface Transport {
  send(msg: unknown): void
  onMessage: ((msg: unknown) => void) | null
  onClose: (() => void) | null
  close(): void
}

/**
 * In-process loopback pair with optional artificial latency/jitter — the
 * lab's twin-client harness. Jitter is DETERMINISTIC (caller-seeded) and
 * never reorders (per-endpoint FIFO release), matching DataChannel semantics.
 */
export function loopbackPair(opts?: { latencyTicks?: number; jitterTicks?: number; rand?: () => number }): [LoopbackTransport, LoopbackTransport] {
  const a = new LoopbackTransport(opts)
  const b = new LoopbackTransport(opts)
  a.peer = b
  b.peer = a
  return [a, b]
}

export class LoopbackTransport implements Transport {
  peer: LoopbackTransport | null = null
  onMessage: ((msg: unknown) => void) | null = null
  onClose: (() => void) | null = null
  private queue: Array<{ at: number; msg: unknown }> = []
  private clock = 0
  private latency: number
  private jitter: number
  private rand: () => number
  closed = false

  constructor(opts?: { latencyTicks?: number; jitterTicks?: number; rand?: () => number }) {
    this.latency = opts?.latencyTicks ?? 0
    this.jitter = opts?.jitterTicks ?? 0
    this.rand = opts?.rand ?? (() => 0.5)
  }

  send(msg: unknown): void {
    if (this.closed || !this.peer || this.peer.closed) return
    const delay = this.latency + Math.floor(this.rand() * (this.jitter + 1))
    // FIFO: never deliver before an earlier message (no reordering).
    const prev = this.peer.queue.length > 0 ? this.peer.queue[this.peer.queue.length - 1].at : this.peer.clock
    this.peer.queue.push({ at: Math.max(this.peer.clock + delay, prev), msg: JSON.parse(JSON.stringify(msg)) })
  }

  /** The lab pumps this once per sim tick; due messages deliver in order. */
  pump(): void {
    this.clock++
    while (this.queue.length > 0 && this.queue[0].at <= this.clock) {
      const { msg } = this.queue.shift()!
      this.onMessage?.(msg)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const p = this.peer
    this.peer = null
    if (p && !p.closed) {
      p.peer = null
      p.onClose?.()
    }
  }
}

/**
 * Messages can land between "channel open" and "session constructed" (the
 * hello handshake happens before LockstepSession exists). Both live
 * transports buffer until a handler is attached, then flush in order —
 * no message is ever dropped on the floor by a wiring race.
 */
abstract class BufferedTransport implements Transport {
  private handler: ((msg: unknown) => void) | null = null
  private backlog: unknown[] = []
  onClose: (() => void) | null = null

  get onMessage(): ((msg: unknown) => void) | null {
    return this.handler
  }

  set onMessage(fn: ((msg: unknown) => void) | null) {
    this.handler = fn
    if (fn) {
      const pending = this.backlog
      this.backlog = []
      for (const msg of pending) fn(msg)
    }
  }

  protected deliver(msg: unknown): void {
    if (this.handler) this.handler(msg)
    else this.backlog.push(msg)
  }

  abstract send(msg: unknown): void
  abstract close(): void
}

/** Two local tabs, zero servers — for a quick human-vs-human smoke on one machine. */
export class BroadcastTransport extends BufferedTransport {
  private ch: BroadcastChannel

  constructor(room: string, private me: string) {
    super()
    this.ch = new BroadcastChannel(`mudsteel-${room}`)
    this.ch.onmessage = (e) => {
      const d = e.data as { from: string; msg: unknown }
      if (d.from !== this.me) this.deliver(d.msg)
    }
  }

  send(msg: unknown): void {
    this.ch.postMessage({ from: this.me, msg })
  }

  close(): void {
    this.ch.close()
    this.onClose = null
  }
}

/**
 * Production: a WebRTC DataChannel, ordered + reliable, negotiated through
 * the Vercel signaling mailbox (see net/signaling.ts). STUN only in v1.
 */
export class RtcTransport extends BufferedTransport {
  private dc: RTCDataChannel | null = null
  readonly pc: RTCPeerConnection

  constructor() {
    super()
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
    })
  }

  attach(dc: RTCDataChannel): void {
    this.dc = dc
    dc.onmessage = (e) => this.deliver(JSON.parse(e.data as string))
    dc.onclose = () => this.onClose?.()
  }

  get open(): boolean { return this.dc?.readyState === 'open' }

  send(msg: unknown): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg))
  }

  close(): void {
    this.dc?.close()
    this.pc.close()
  }
}
