/**
 * Real small-arms ballistics. Every rifle, MG and pistol round is a simulated
 * body: it leaves an actual muzzle, drops under gravity, and is swept against
 * the terrain heightfield, soldier capsules and vehicle hulls each tick.
 * A parapet stops bullets because it is *there*, not because a dice roll
 * says so. Misses strike real dirt and suppress whoever heard the crack.
 */
import type { Bullet, ImpactSurface, Soldier, Team, Vec3 } from '../core/types'
import { ARMOUR_MULT, COMBAT, WORLD } from '../core/config'
import { dist2, fx, snd, type Ctx } from './sim'
import { damageSoldier, damageVehicle, stanceHeight, suppressArea } from './combat'
import type { Terrain } from '../world/terrain'

/** One gravity for every system that flies. */
export const G = 9.81

// ---------------------------------------------------------------------------
// Shared geometry helpers
// ---------------------------------------------------------------------------

/**
 * The surface a soldier stands on: terrain height plus the trench fire-step.
 * The step is tall enough that a STANDING man's muzzle clears the parapet
 * (that is what fire-steps were for) while a CROUCHING man ducks fully
 * behind it — with physical bullets, that difference IS the cover model.
 * Render-side standY must use this same function.
 */
export function standSurface(ctx: Ctx, x: number, z: number): number {
  return ctx.terrain.heightAt(x, z) + ctx.terrain.trenchAt(x, z) * 1.55
}

/** Muzzle origin for a firing soldier (cheek height on the fire step). */
export function muzzlePos(ctx: Ctx, s: Soldier): Vec3 {
  return {
    x: s.pos.x,
    y: standSurface(ctx, s.pos.x, s.pos.z) + stanceHeight(s.stance) * 0.92,
    z: s.pos.z,
  }
}

/**
 * Cheap line-of-sight test against the heightfield: can a round leaving
 * (x0,y0,z0) reach (x1,y1,z1) without meeting dirt? Rugged ground creates
 * real dead ground — shooters use this to stop wasting rounds on men they
 * cannot see.
 */
export function losClear(
  ctx: Ctx, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): boolean {
  const steps = 12
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const y = y0 + (y1 - y0) * t
    if (y <= ctx.terrain.heightAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t) - 0.05) return false
  }
  return true
}

/** Outward terrain normal from central differences on the heightfield. */
export function terrainNormal(terrain: Terrain, x: number, z: number, out: Vec3): Vec3 {
  const e = 0.6
  const hx = terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z)
  const hz = terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e)
  const nx = -hx, ny = 2 * e, nz = -hz
  const len = Math.hypot(nx, ny, nz) || 1
  out.x = nx / len; out.y = ny / len; out.z = nz / len
  return out
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

export interface BulletSpec {
  team: Team
  from: Vec3
  /** Unit aim direction (before spread is applied). */
  dir: Vec3
  speed: number
  damage: number
  /** Angular spread sigma in radians (Gaussian). */
  spread: number
  category: string
  shooterUnitId: number
  shooterId: number
  tracer: boolean
}

/**
 * Box–Muller gaussian from the sim's seeded RNG. Deliberately no spare-value
 * caching: module state would leak across runs and break seeded replays.
 */
function gauss(rand: () => number): number {
  let u = 0
  while (u <= 1e-9) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

export function fireBullet(ctx: Ctx, spec: BulletSpec): Bullet {
  // Orthonormal basis around the aim direction for angular dispersion.
  let dx = spec.dir.x, dy = spec.dir.y, dz = spec.dir.z
  const dl = Math.hypot(dx, dy, dz) || 1
  dx /= dl; dy /= dl; dz /= dl
  // Right vector (dir × up); degenerate looking straight up/down is fine here.
  let rx = -dz, ry = 0, rz = dx
  const rl = Math.hypot(rx, ry, rz) || 1
  rx /= rl; rz /= rl
  // Up vector (right × dir).
  const ux = ry * dz - rz * dy, uy = rz * dx - rx * dz, uz = rx * dy - ry * dx
  const a = gauss(ctx.rand) * spec.spread
  const b = gauss(ctx.rand) * spec.spread
  dx += rx * a + ux * b
  dy += ry * a + uy * b
  dz += rz * a + uz * b
  const nl = Math.hypot(dx, dy, dz) || 1

  const bullet: Bullet = {
    id: ctx.s.nextId++,
    team: spec.team,
    pos: { x: spec.from.x, y: spec.from.y, z: spec.from.z },
    prev: { x: spec.from.x, y: spec.from.y, z: spec.from.z },
    vel: {
      x: (dx / nl) * spec.speed,
      y: (dy / nl) * spec.speed,
      z: (dz / nl) * spec.speed,
    },
    damage: spec.damage,
    category: spec.category,
    shooterUnitId: spec.shooterUnitId,
    shooterId: spec.shooterId,
    tracer: spec.tracer,
    life: COMBAT.bulletMaxLife,
  }
  ctx.s.bullets.push(bullet)
  return bullet
}

// ---------------------------------------------------------------------------
// Integration & collision
// ---------------------------------------------------------------------------

const VEHICLE_RADIUS = 2.6
const VEHICLE_HEIGHT = 2.9

/**
 * Horizontal hit radius by stance. A prone man is a low target but a LONG
 * one — treating him as a slightly fatter, much shorter cylinder keeps
 * physical fire effective without simulating limbs.
 */
function hitRadius(st: Soldier['stance']): number {
  switch (st) {
    case 'prone': return 0.55
    case 'crouch': return 0.42
    default: return 0.34
  }
}

/** Scratch normal for terrain impacts — reused, never escapes a tick. */
const _impactN: Vec3 = { x: 0, y: 1, z: 0 }

/**
 * What the ground is made of where a round struck it, so the strike throws the
 * right stuff up: a sandbagged parapet spits tan dust and can ricochet, churned
 * mud gives a wet dark splat, dry ground a dusty clod-burst.
 */
function classifyGround(ctx: Ctx, x: number, z: number): ImpactSurface {
  if (ctx.terrain.trenchAt(x, z) > 0.5) return 'sandbag'
  if (ctx.terrain.mudAt(x, z) > 0.5) return 'mud'
  return 'dirt'
}

export function updateBullets(ctx: Ctx, dt: number): void {
  const { s } = ctx
  let w = 0
  for (let i = 0; i < s.bullets.length; i++) {
    const b = s.bullets[i]
    b.prev.x = b.pos.x; b.prev.y = b.pos.y; b.prev.z = b.pos.z
    b.vel.y -= G * dt
    b.pos.x += b.vel.x * dt
    b.pos.y += b.vel.y * dt
    b.pos.z += b.vel.z * dt
    b.life -= dt

    if (
      b.life <= 0 ||
      Math.abs(b.pos.x) > WORLD.width * 0.75 ||
      Math.abs(b.pos.z) > WORLD.depth * 0.75
    ) continue // discard

    if (sweep(ctx, b)) continue // hit something — discard
    s.bullets[w++] = b
  }
  s.bullets.length = w
}

/** Swept collision for one tick of flight. Returns true if the round stopped. */
function sweep(ctx: Ctx, b: Bullet): boolean {
  const ax = b.prev.x, ay = b.prev.y, az = b.prev.z
  const bx = b.pos.x, by = b.pos.y, bz = b.pos.z
  const sx = bx - ax, sy = by - ay, sz = bz - az
  const segLen2 = sx * sx + sz * sz

  // --- men (enemy team only; the shooter's own side keeps fire discipline) --
  let hitT = Infinity
  let hitSol: Soldier | null = null
  const testSoldier = (c: Soldier): void => {
    if (c.hp <= 0 || c.id === b.shooterId) return
    // Exact 2D segment↔cylinder intersection, then y-overlap across the whole
    // crossing interval — plunging fire into a trench must still connect.
    const r = hitRadius(c.stance)
    const fx0 = ax - c.pos.x, fz0 = az - c.pos.z
    let t1: number, t2: number
    if (segLen2 < 1e-6) {
      if (fx0 * fx0 + fz0 * fz0 > r * r) return
      t1 = 0; t2 = 1
    } else {
      const bq = 2 * (fx0 * sx + fz0 * sz)
      const cq = fx0 * fx0 + fz0 * fz0 - r * r
      const disc = bq * bq - 4 * segLen2 * cq
      if (disc < 0) return
      const sq = Math.sqrt(disc)
      t1 = (-bq - sq) / (2 * segLen2)
      t2 = (-bq + sq) / (2 * segLen2)
      if (t2 < 0 || t1 > 1) return
      if (t1 < 0) t1 = 0
      if (t2 > 1) t2 = 1
    }
    const base = standSurface(ctx, c.pos.x, c.pos.z)
    const h = stanceHeight(c.stance)
    const yA = ay + sy * t1, yB = ay + sy * t2
    const yLo = yA < yB ? yA : yB, yHi = yA < yB ? yB : yA
    if (yHi < base - 0.1 || yLo > base + h + 0.12) return
    if (t1 < hitT) { hitT = t1; hitSol = c }
  }
  if (b.team === 'brit') {
    for (const e of ctx.s.enemies) testSoldier(e)
  } else {
    for (const u of ctx.s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) testSoldier(c)
    }
  }

  // --- vehicles (both sides' rounds can strike armour) -----------------------
  let hitVehT = Infinity
  let hitVeh: import('../core/types').Vehicle | null = null
  for (const v of ctx.s.vehicles) {
    if (v.dead || v.team === b.team) continue
    let t = 0
    if (segLen2 > 1e-6) {
      t = ((v.pos.x - ax) * sx + (v.pos.z - az) * sz) / segLen2
      t = t < 0 ? 0 : t > 1 ? 1 : t
    }
    const px = ax + sx * t, pz = az + sz * t
    if (dist2(px, pz, v.pos.x, v.pos.z) > VEHICLE_RADIUS * VEHICLE_RADIUS) continue
    const py = ay + sy * t
    const base = ctx.terrain.heightAt(v.pos.x, v.pos.z)
    if (py < base || py > base + VEHICLE_HEIGHT) continue
    if (t < hitVehT) { hitVehT = t; hitVeh = v }
  }

  // --- terrain ---------------------------------------------------------------
  // Sample along the segment. The heightfield is a 1m grid and the parapet
  // crest is a single-vertex ridge — a 0.5m step cannot tunnel through it.
  let groundT = Infinity
  const segLen = Math.sqrt(segLen2 + sy * sy)
  const steps = Math.max(2, Math.ceil(segLen / 0.5))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const px = ax + sx * t, py = ay + sy * t, pz = az + sz * t
    if (py <= ctx.terrain.heightAt(px, pz)) { groundT = t; break }
  }

  const first = Math.min(hitT, hitVehT, groundT)
  if (first === Infinity) return false

  if (first === hitT && hitSol) {
    const c = hitSol as Soldier
    const dmg = b.damage * (0.8 + ctx.rand() * 0.4)
    const ix = ax + sx * hitT, iy = ay + sy * hitT, iz = az + sz * hitT
    // Spray thrown back toward the shooter (along −velocity).
    fx(ctx.s, { t: 'impact', x: ix, y: iy, z: iz, nx: -b.vel.x, ny: -b.vel.y, nz: -b.vel.z, surface: 'flesh', spark: false })
    damageSoldier(ctx, c, dmg, b.category, b.team, b.shooterUnitId)
    // The crack of a near hit keeps neighbours honest.
    suppressArea(ctx, c.pos.x, c.pos.z, 2.5, 0.06, b.team)
    return true
  }
  if (first === hitVehT && hitVeh) {
    const v = hitVeh
    const dmg = b.damage * (0.8 + ctx.rand() * 0.4) * ARMOUR_MULT[Math.min(2, v.armour)]
    const px = ax + sx * hitVehT, py = ay + sy * hitVehT, pz = az + sz * hitVehT
    // Outward hull normal (horizontal), so sparks fly off the plate.
    let nX = px - v.pos.x, nZ = pz - v.pos.z
    const nl = Math.hypot(nX, nZ) || 1
    nX /= nl; nZ /= nl
    if (dmg <= 0.5) {
      // Small-arms bounce off armour — always a spark and a whine.
      snd(ctx.s, { name: 'ricochet', x: px, y: py, z: pz, gain: 0.5 })
      fx(ctx.s, { t: 'impact', x: px, y: py, z: pz, nx: nX, ny: 0.25, nz: nZ, surface: 'steel', spark: true })
    } else {
      damageVehicle(ctx, v, dmg, b.category, b.team, b.shooterUnitId)
      const spark = ctx.rand() < COMBAT.ricochetChance
      fx(ctx.s, { t: 'impact', x: px, y: py, z: pz, nx: nX, ny: 0.25, nz: nZ, surface: 'steel', spark })
      if (spark) snd(ctx.s, { name: 'ricochet', x: px, y: py, z: pz, gain: 0.4 })
    }
    return true
  }
  // Ground strike: the right stuff kicks up for what got hit; heads go down.
  const gx = ax + sx * groundT, gy0 = ay + sy * groundT, gz = az + sz * groundT
  const gy = ctx.terrain.heightAt(gx, gz)
  const surface = classifyGround(ctx, gx, gz)
  const n = terrainNormal(ctx.terrain, gx, gz, _impactN)
  const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z) || 1
  const incidence = Math.abs((b.vel.x * n.x + b.vel.y * n.y + b.vel.z * n.z) / speed)
  // A shallow round off a hard parapet can whine away as a ricochet.
  const spark = surface === 'sandbag' && incidence < 0.45 && ctx.rand() < COMBAT.ricochetChance
  fx(ctx.s, { t: 'impact', x: gx, y: Math.max(gy, gy0) + 0.03, z: gz, nx: n.x, ny: n.y, nz: n.z, surface, spark })
  if (spark) snd(ctx.s, { name: 'ricochet', x: gx, y: gy, z: gz, gain: 0.35 })
  suppressArea(ctx, gx, gz, 2.0, 0.05, b.team)
  return true
}
