/**
 * Shared Upstash Redis handle for the signaling mailbox routes.
 *
 * The integration is installed via the Vercel marketplace (Upstash), which
 * injects UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Until Elliot
 * installs it, every route answers 503 with a human-readable reason instead
 * of crashing — the game shows "online play not configured yet".
 */
import { Redis } from '@upstash/redis'

export function redisOr503(): Redis | Response {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    return json({ error: 'signaling not configured (Upstash Redis env missing)' }, 503)
  }
  return new Redis({ url, token })
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Rooms live 15 minutes — long enough to lobby + reconnect, short enough to self-clean. */
export const ROOM_TTL_S = 900
