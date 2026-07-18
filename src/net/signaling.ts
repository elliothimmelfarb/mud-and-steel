/**
 * Signaling client + match handshake. Two phases:
 *
 * 1. RENDEZVOUS — swap SDP/ICE through the Vercel mailbox (/api/rooms) at
 *    1 Hz until the WebRTC DataChannel opens. After that the server is out
 *    of the picture; the match is pure P2P.
 * 2. HELLO — the host tells the joiner the battle terms (seed, match length)
 *    over the freshly opened transport. Both sides then construct their
 *    LockstepSession from identical terms.
 *
 * The same hello phase runs over a BroadcastTransport for the local
 * two-tab path — one code path from here on down.
 */
import type { MatchLength, Team } from '../core/types'
import { RtcTransport, type Transport } from './transport'
import type { NetMsg } from './lockstep'

export type NetRole = 'host' | 'join'

/** Everything the game needs to start an MP run. */
export interface MatchTerms {
  transport: Transport
  seedStr: string
  matchLen: MatchLength
  side: Team
  isCreator: boolean
  /** Host's tick at hello. > 0 = mid-battle: the joiner must fast-forward. */
  hostTick: number
}

const POLL_MS = 1000
const CONNECT_TIMEOUT_MS = 90_000

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `signaling ${res.status}`)
  return body
}

export function createRoom(): Promise<{ code: string }> {
  return api<{ code: string }>('/api/rooms', { method: 'POST' })
}

function sendSignal(code: string, from: NetRole, payload: unknown): Promise<unknown> {
  return api(`/api/rooms/${code}/signal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, payload }),
  })
}

interface SignalPayload {
  t: 'offer' | 'answer' | 'ice'
  sdp?: string
  cand?: RTCIceCandidateInit | null
}

/**
 * Negotiate a DataChannel through the room mailbox. Resolves when the
 * channel is OPEN. The host creates the channel + offer; the joiner answers.
 */
export function connectRtc(code: string, role: NetRole, onStatus?: (s: string) => void, opts?: { fromEnd?: boolean }): Promise<RtcTransport> {
  return new Promise<RtcTransport>((resolve, reject) => {
    const t = new RtcTransport()
    const pc = t.pc
    let cursor = 0
    // Rejoin reuses the room mailbox: skip everything already in it (the
    // dead negotiation's offers/answers/ICE) and process only what arrives
    // after we reopened. The first poll just moves the cursor to the end.
    let skipFirst = opts?.fromEnd === true
    let settled = false
    let pollTimer = 0

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      window.clearInterval(pollTimer)
      window.clearInterval(repostTimer)
      window.clearTimeout(deadline)
      if (err) { t.close(); reject(err) } else resolve(t)
    }
    const deadline = window.setTimeout(
      () => finish(new Error('connection timed out — check the code and both networks')),
      CONNECT_TIMEOUT_MS,
    )

    pc.onicecandidate = (e) => {
      void sendSignal(code, role, { t: 'ice', cand: e.candidate?.toJSON() ?? null } satisfies SignalPayload)
        .catch(() => {}) // candidate loss is survivable; the poll keeps going
    }
    pc.onconnectionstatechange = () => {
      onStatus?.(`connection: ${pc.connectionState}`)
      if (pc.connectionState === 'failed') finish(new Error('WebRTC connection failed (STUN could not punch through)'))
    }

    const armChannel = (dc: RTCDataChannel) => {
      t.attach(dc)
      dc.onopen = () => { onStatus?.('channel open'); finish() }
    }
    let repostTimer = 0
    if (role === 'host') {
      armChannel(pc.createDataChannel('game', { ordered: true }))
      void pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => sendSignal(code, role, { t: 'offer', sdp: pc.localDescription!.sdp } satisfies SignalPayload))
        .catch((e: Error) => finish(e))
      // Re-post until answered: a late joiner (rejoin path) reads the
      // mailbox from the end and would miss a one-shot offer. Once ICE
      // gathering finishes, localDescription.sdp carries the candidates
      // inline, so the repost alone is enough to connect.
      repostTimer = window.setInterval(() => {
        if (settled || pc.signalingState !== 'have-local-offer' || !pc.localDescription) return
        void sendSignal(code, role, { t: 'offer', sdp: pc.localDescription.sdp } satisfies SignalPayload).catch(() => {})
      }, 5000)
    } else {
      pc.ondatachannel = (e) => armChannel(e.channel)
    }

    // ICE candidates race the offer/answer POSTs into the mailbox (both are
    // independent fetches) — hold any that arrive early and flush them once
    // the remote description lands. addIceCandidate before that throws, and
    // the mailbox never re-delivers.
    const earlyIce: Array<RTCIceCandidateInit | null> = []
    let haveRemote = false
    const takeIce = async (cand: RTCIceCandidateInit | null) => {
      if (!haveRemote) { earlyIce.push(cand); return }
      await pc.addIceCandidate(cand ?? undefined).catch(() => {})
    }
    const remoteSet = async () => {
      haveRemote = true
      for (const cand of earlyIce.splice(0)) await pc.addIceCandidate(cand ?? undefined).catch(() => {})
    }

    // One message at a time; the cursor advances only past messages that were
    // actually processed, so an exception mid-batch re-delivers the rest next
    // poll instead of discarding them. `busy` stops overlapping polls from
    // double-processing the same batch on a slow link.
    let busy = false
    const poll = async () => {
      if (busy || settled) return
      busy = true
      try {
        const { msgs, next } = await api<{ msgs: Array<{ from: NetRole; payload: SignalPayload }>; next: number }>(
          `/api/rooms/${code}?since=${cursor}`,
        )
        if (skipFirst) { skipFirst = false; cursor = next; return }
        for (const m of msgs) {
          if (settled) return
          const p = m.payload
          if (m.from === role) { cursor++; continue }
          if (p.t === 'offer' && role === 'join' && pc.signalingState === 'stable' && !haveRemote) {
            onStatus?.('offer received — answering')
            await pc.setRemoteDescription({ type: 'offer', sdp: p.sdp })
            await remoteSet()
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await sendSignal(code, role, { t: 'answer', sdp: pc.localDescription!.sdp } satisfies SignalPayload)
          } else if (p.t === 'answer' && role === 'host' && pc.signalingState === 'have-local-offer') {
            onStatus?.('answer received')
            await pc.setRemoteDescription({ type: 'answer', sdp: p.sdp })
            await remoteSet()
          } else if (p.t === 'ice') {
            await takeIce(p.cand ?? null)
          }
          cursor++
        }
      } finally {
        busy = false
      }
    }
    const fatal = (msg: string) =>
      msg.includes('no such room') || msg.includes('not configured') || msg.includes('bad room')
    pollTimer = window.setInterval(() => {
      if (settled) return
      void poll().catch((e: Error) => {
        // A dead/unconfigured room is fatal; transient fetch hiccups are not.
        if (fatal(String(e.message))) finish(new Error(e.message))
      })
    }, POLL_MS)
    void poll().catch((e: Error) => { if (fatal(String(e.message))) finish(new Error(e.message)) })
  })
}

/**
 * HELLO over an open transport, hi/hello shaped so it also survives
 * BroadcastChannel (which buffers nothing between tabs): the joiner beacons
 * `hi` every half-second; the host answers the first one with the terms.
 * Runs BEFORE LockstepSession construction on both ends (the RTC and
 * Broadcast transports buffer anything that races the wiring).
 */
export function helloAsHost(t: Transport, seedStr: string, matchLen: MatchLength, timeoutMs = 120_000, tickOf: () => number = () => 0, side: Team = 'brit'): Promise<MatchTerms> {
  return new Promise<MatchTerms>((resolve, reject) => {
    const deadline = window.setTimeout(() => {
      t.onMessage = null
      reject(new Error('no opponent arrived'))
    }, timeoutMs)
    t.onMessage = (raw) => {
      const m = raw as NetMsg
      if (m.t !== 'hi') return
      // Echo the joiner's nonce: exactly one joiner pairs; a third tab in the
      // same BroadcastChannel room keeps beaconing and times out instead of
      // silently corrupting a two-player battle. tick > 0 tells a rejoiner
      // the battle is already running and it must fast-forward.
      const tick = tickOf()
      t.send({ t: 'hello', seedStr, matchLen, hostSide: side, nonce: m.nonce, tick } satisfies NetMsg)
      window.clearTimeout(deadline)
      t.onMessage = null
      resolve({ transport: t, seedStr, matchLen, side, isCreator: true, hostTick: tick })
    }
  })
}

export function helloAsJoiner(t: Transport, timeoutMs = 120_000): Promise<MatchTerms> {
  return new Promise<MatchTerms>((resolve, reject) => {
    // Lobby plumbing, not sim: Math.random is fine here.
    const nonce = Math.random().toString(36).slice(2, 10)
    const beacon = window.setInterval(() => t.send({ t: 'hi', nonce } satisfies NetMsg), 500)
    const deadline = window.setTimeout(() => {
      window.clearInterval(beacon)
      t.onMessage = null
      reject(new Error('no hello from host'))
    }, timeoutMs)
    t.onMessage = (raw) => {
      const m = raw as NetMsg
      if (m.t !== 'hello' || m.nonce !== nonce) return // someone else's hello
      window.clearInterval(beacon)
      window.clearTimeout(deadline)
      t.onMessage = null
      resolve({
        transport: t,
        seedStr: m.seedStr,
        matchLen: m.matchLen,
        side: m.hostSide === 'brit' ? 'german' : 'brit',
        isCreator: false,
        hostTick: m.tick ?? 0,
      })
    }
    t.send({ t: 'hi', nonce } satisfies NetMsg)
  })
}
