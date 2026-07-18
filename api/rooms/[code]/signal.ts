/**
 * POST /api/rooms/:code/signal {from, payload} — drop a message in the mailbox.
 *
 * `from` is the sender role ('host' | 'join'); the poller filters out its own
 * messages client-side. Body size is capped: SDP blobs are a few KB, anything
 * bigger is not signaling.
 */
import { json, redisOr503, ROOM_TTL_S } from '../../_redis'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const redis = redisOr503()
  if (redis instanceof Response) return redis

  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const code = (parts[parts.length - 2] ?? '').toUpperCase()
  if (!/^[A-Z]{4}$/.test(code)) return json({ error: 'bad room code' }, 400)

  const raw = await req.text()
  if (raw.length > 32_768) return json({ error: 'signal too large' }, 413)
  let body: { from?: string; payload?: unknown }
  try {
    body = JSON.parse(raw) as { from?: string; payload?: unknown }
  } catch {
    return json({ error: 'bad JSON' }, 400)
  }
  if (body.from !== 'host' && body.from !== 'join') return json({ error: 'bad sender' }, 400)

  const alive = await redis.exists(`room:${code}`)
  if (!alive) return json({ error: 'no such room' }, 404)

  const key = `room:${code}:msgs`
  await redis.rpush(key, JSON.stringify({ from: body.from, payload: body.payload }))
  await redis.expire(key, ROOM_TTL_S)
  return json({ ok: true })
}
