/**
 * GET /api/rooms/:code?since=n → { msgs, next } — drain the signaling mailbox.
 *
 * Clients poll at ~1 Hz with the cursor they last saw; `next` is the cursor
 * for the following poll. Messages are opaque JSON blobs (SDP offers/answers,
 * trickled ICE candidates) tagged with the sender role.
 */
import { json, redisOr503 } from '../_redis'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405)
  const redis = redisOr503()
  if (redis instanceof Response) return redis

  const url = new URL(req.url)
  const code = (url.pathname.split('/').pop() ?? '').toUpperCase()
  if (!/^[A-Z]{4}$/.test(code)) return json({ error: 'bad room code' }, 400)
  const since = Math.max(0, Number(url.searchParams.get('since') ?? '0') || 0)

  const alive = await redis.exists(`room:${code}`)
  if (!alive) return json({ error: 'no such room' }, 404)

  const msgs = await redis.lrange<unknown>(`room:${code}:msgs`, since, -1)
  return json({ msgs, next: since + msgs.length })
}
