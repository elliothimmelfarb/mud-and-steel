/**
 * Seeded RNG + value noise. Everything random in the sim flows from a run seed
 * so a seed string reproduces the same battlefield, weather, and waves.
 */

export type Rand = () => number

/** mulberry32 — small, fast, good enough distribution for gameplay. */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a string hash → 32-bit uint, for turning seed strings into numbers. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Fork an independent stream (e.g. terrain vs waves) from a base seed. */
export function forkRand(baseSeed: number, streamName: string): Rand {
  return mulberry32((baseSeed ^ hashString(streamName)) >>> 0)
}

export function pick<T>(rand: Rand, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, (rand() * arr.length) | 0)]
}

export function range(rand: Rand, min: number, max: number): number {
  return min + rand() * (max - min)
}

export function irange(rand: Rand, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1))
}

/** Gaussian-ish via central limit; cheap and fine for scatter. */
export function gauss(rand: Rand, mean = 0, stdev = 1): number {
  const n = rand() + rand() + rand() + rand() - 2
  return mean + n * stdev * 0.7071
}

// ---------------------------------------------------------------------------
// 2D value noise + fBm (for terrain, wind meander, weather fronts)
// ---------------------------------------------------------------------------

export class ValueNoise2D {
  private perm: Uint8Array

  constructor(seed: number) {
    const rand = mulberry32(seed)
    const p = new Uint8Array(512)
    const base = new Uint8Array(256)
    for (let i = 0; i < 256; i++) base[i] = i
    // Fisher–Yates
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0
      const t = base[i]; base[i] = base[j]; base[j] = t
    }
    for (let i = 0; i < 512; i++) p[i] = base[i & 255]
    this.perm = p
  }

  private grad(ix: number, iz: number): number {
    return this.perm[(ix & 255) + this.perm[iz & 255]] / 255
  }

  /** Smooth value noise in [0,1]. */
  at(x: number, z: number): number {
    const ix = Math.floor(x), iz = Math.floor(z)
    const fx = x - ix, fz = z - iz
    const ux = fx * fx * (3 - 2 * fx)
    const uz = fz * fz * (3 - 2 * fz)
    const a = this.grad(ix, iz)
    const b = this.grad(ix + 1, iz)
    const c = this.grad(ix, iz + 1)
    const d = this.grad(ix + 1, iz + 1)
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
  }

  /** Fractal Brownian motion in [0,1]. */
  fbm(x: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 0.5, freq = 1, sum = 0, norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.at(x * freq, z * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }
}
