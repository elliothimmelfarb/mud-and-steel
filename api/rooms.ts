/**
 * POST /api/rooms → { code } — open a signaling room.
 *
 * The room is a Redis mailbox two peers use to swap WebRTC SDP/ICE blobs;
 * once the DataChannel opens they never talk to us again. 4-letter code,
 * 15-minute TTL (see api/_redis.ts).
 */
import { json, redisOr503, ROOM_TTL_S } from './_redis'

export const config = { runtime: 'edge' }

// No vowels: pronounceable-adjacent, and no accidental words on the scoreboard.
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

function makeCode(): string {
  let code = ''
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length]
  return code
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const redis = redisOr503()
  if (redis instanceof Response) return redis

  // A handful of attempts dodges the (tiny) chance of a live-code collision.
  for (let i = 0; i < 5; i++) {
    const code = makeCode()
    const created = await redis.set(`room:${code}`, '1', { nx: true, ex: ROOM_TTL_S })
    if (created !== null) {
      await redis.del(`room:${code}:msgs`)
      return json({ code })
    }
  }
  return json({ error: 'could not allocate a room code' }, 503)
}
