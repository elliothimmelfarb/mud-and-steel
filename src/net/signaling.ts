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
export function connectRtc(code: string, role: NetRole, onStatus?: (s: string) => void): Promise<RtcTransport> {
  return new Promise<RtcTransport>((resolve, reject) => {
    const t = new RtcTransport()
    const pc = t.pc
    let cursor = 0
    let settled = false
    let pollTimer = 0

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      window.clearInterval(pollTimer)
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
    if (role === 'host') {
      armChannel(pc.createDataChannel('game', { ordered: true }))
      void pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => sendSignal(code, role, { t: 'offer', sdp: pc.localDescription!.sdp } satisfies SignalPayload))
        .catch((e: Error) => finish(e))
    } else {
      pc.ondatachannel = (e) => armChannel(e.channel)
    }

    const poll = async () => {
      const { msgs, next } = await api<{ msgs: Array<{ from: NetRole; payload: SignalPayload }>; next: number }>(
        `/api/rooms/${code}?since=${cursor}`,
      )
      cursor = next
      for (const m of msgs) {
        if (m.from === role) continue
        const p = m.payload
        if (p.t === 'offer' && role === 'join') {
          onStatus?.('offer received — answering')
          await pc.setRemoteDescription({ type: 'offer', sdp: p.sdp })
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          await sendSignal(code, role, { t: 'answer', sdp: pc.localDescription!.sdp } satisfies SignalPayload)
        } else if (p.t === 'answer' && role === 'host') {
          onStatus?.('answer received')
          await pc.setRemoteDescription({ type: 'answer', sdp: p.sdp })
        } else if (p.t === 'ice') {
          await pc.addIceCandidate(p.cand ?? undefined).catch(() => {})
        }
      }
    }
    pollTimer = window.setInterval(() => {
      if (settled) return
      void poll().catch((e: Error) => {
        // A dead room is fatal; transient fetch hiccups are not.
        if (String(e.message).includes('no such room')) finish(new Error('room expired or never existed'))
      })
    }, POLL_MS)
    void poll().catch(() => {})
  })
}

/**
 * HELLO over an open transport, hi/hello shaped so it also survives
 * BroadcastChannel (which buffers nothing between tabs): the joiner beacons
 * `hi` every half-second; the host answers the first one with the terms.
 * Runs BEFORE LockstepSession construction on both ends (the RTC and
 * Broadcast transports buffer anything that races the wiring).
 */
export function helloAsHost(t: Transport, seedStr: string, matchLen: MatchLength, timeoutMs = 120_000): Promise<MatchTerms> {
  return new Promise<MatchTerms>((resolve, reject) => {
    const deadline = window.setTimeout(() => {
      t.onMessage = null
      reject(new Error('no opponent arrived'))
    }, timeoutMs)
    t.onMessage = (raw) => {
      if ((raw as { t?: string }).t !== 'hi') return
      t.send({ t: 'hello', seedStr, matchLen, hostSide: 'brit' } satisfies NetMsg)
      window.clearTimeout(deadline)
      t.onMessage = null
      resolve({ transport: t, seedStr, matchLen, side: 'brit', isCreator: true })
    }
  })
}

export function helloAsJoiner(t: Transport, timeoutMs = 120_000): Promise<MatchTerms> {
  return new Promise<MatchTerms>((resolve, reject) => {
    const beacon = window.setInterval(() => t.send({ t: 'hi' }), 500)
    const deadline = window.setTimeout(() => {
      window.clearInterval(beacon)
      t.onMessage = null
      reject(new Error('no hello from host'))
    }, timeoutMs)
    t.onMessage = (raw) => {
      const m = raw as NetMsg
      if (m.t !== 'hello') return // pre-battle noise — ignore
      window.clearInterval(beacon)
      window.clearTimeout(deadline)
      t.onMessage = null
      resolve({
        transport: t,
        seedStr: m.seedStr,
        matchLen: m.matchLen,
        side: m.hostSide === 'brit' ? 'german' : 'brit',
        isCreator: false,
      })
    }
    t.send({ t: 'hi' })
  })
}
