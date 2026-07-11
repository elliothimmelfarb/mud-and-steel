/**
 * The battlefield: a deformable heightfield.
 *
 * Every shell that lands carves a real crater — the heightfield changes, the
 * mesh changes, cover changes, pathfinding costs change, and when it rains the
 * holes fill with water that can bog a tank. The field you finish a run on is
 * a genuinely different place from the one you started on.
 */
import type { TerrainLike, Vec2 } from '../core/types'
import { TRENCH, WEATHER, WORLD } from '../core/config'
import { ValueNoise2D, forkRand, type Rand } from '../core/rng'

export interface DirtyRegion { minCol: number; minRow: number; maxCol: number; maxRow: number }

export class Terrain implements TerrainLike {
  readonly width = WORLD.width
  readonly depth = WORLD.depth
  readonly cell = WORLD.cell
  /** Vertex grid is (cols+1) x (rows+1). */
  readonly cols = Math.round(WORLD.width / WORLD.cell)
  readonly rows = Math.round(WORLD.depth / WORLD.cell)

  /** Current surface height per vertex. */
  readonly heights: Float32Array
  /** Height right after generation + trench carving — craters measure against this. */
  readonly base: Float32Array
  /** 0..1 shell-churn (scorch + mud) per vertex; drives shading and mud physics. */
  readonly churn: Float32Array
  /** 0..1 trench mask per vertex (1 = inside a trench). */
  readonly trench: Float32Array
  /** 0..1 standing-water coverage per vertex (recomputed as wetness changes). */
  readonly water: Float32Array

  /** Trench centerlines for props/slots/sections. */
  readonly frontLine: Vec2[] = []
  readonly supportLine: Vec2[] = []
  readonly commLines: Vec2[][] = []
  /** Flattened emplacement pads (behind the lines). */
  readonly pads: Vec2[] = []

  /** Mesh subscribes here to re-upload dirty vertices. */
  onDirty: ((r: DirtyRegion) => void) | null = null

  private wetness = 0
  /** Wetness value at the last water-map refresh (dead-band anchor). */
  private wetnessApplied = -1
  private craterOps: Array<{ x: number; z: number; r: number; d: number }> = []

  constructor(seed: number) {
    const vcount = (this.cols + 1) * (this.rows + 1)
    this.heights = new Float32Array(vcount)
    this.base = new Float32Array(vcount)
    this.churn = new Float32Array(vcount)
    this.trench = new Float32Array(vcount)
    this.water = new Float32Array(vcount)
    this.generate(seed)
  }

  // -- coordinate helpers ---------------------------------------------------

  vi(col: number, row: number): number { return row * (this.cols + 1) + col }
  worldX(col: number): number { return -this.width / 2 + col * this.cell }
  worldZ(row: number): number { return -this.depth / 2 + row * this.cell }
  colAt(x: number): number { return (x + this.width / 2) / this.cell }
  rowAt(z: number): number { return (z + this.depth / 2) / this.cell }

  private sample(arr: Float32Array, x: number, z: number): number {
    let fc = this.colAt(x), fr = this.rowAt(z)
    fc = Math.max(0, Math.min(this.cols - 0.001, fc))
    fr = Math.max(0, Math.min(this.rows - 0.001, fr))
    const c0 = fc | 0, r0 = fr | 0
    const tx = fc - c0, tz = fr - r0
    const a = arr[this.vi(c0, r0)], b = arr[this.vi(c0 + 1, r0)]
    const c = arr[this.vi(c0, r0 + 1)], d = arr[this.vi(c0 + 1, r0 + 1)]
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
  }

  // -- public queries (TerrainLike) ------------------------------------------

  heightAt(x: number, z: number): number { return this.sample(this.heights, x, z) }

  craterDepthAt(x: number, z: number): number {
    const d = this.sample(this.base, x, z) - this.sample(this.heights, x, z)
    return d > 0 ? d : 0
  }

  trenchAt(x: number, z: number): number { return this.sample(this.trench, x, z) }
  churnAt(x: number, z: number): number { return this.sample(this.churn, x, z) }

  mudAt(x: number, z: number): number {
    // Churned ground holds water; trenches are duckboarded (drier going).
    const t = this.sample(this.trench, x, z)
    const m = this.sample(this.churn, x, z) * (0.35 + this.wetness * 0.65) + this.wetness * 0.3
    return Math.min(1, m) * (1 - t * 0.6)
  }

  floodedAt(x: number, z: number): boolean {
    return this.craterDepthAt(x, z) > WEATHER.floodDepth && this.wetness > 0.35
  }

  /** |gradient| in m/m; used for movement cost & tank slope limits. */
  slopeAt(x: number, z: number): number {
    const e = this.cell
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z)
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e)
    return Math.hypot(dx, dz) / (2 * e)
  }

  // -- deformation ------------------------------------------------------------

  /**
   * Carve a crater: gaussian bowl + raised rim, churn the soil, notify the mesh.
   * Returns false when the blast lands off-field.
   */
  crater(x: number, z: number, radius: number, depthM: number): boolean {
    const minCol = Math.max(0, Math.floor(this.colAt(x - radius * 1.6)))
    const maxCol = Math.min(this.cols, Math.ceil(this.colAt(x + radius * 1.6)))
    const minRow = Math.max(0, Math.floor(this.rowAt(z - radius * 1.6)))
    const maxRow = Math.min(this.rows, Math.ceil(this.rowAt(z + radius * 1.6)))
    if (minCol >= maxCol || minRow >= maxRow) return false

    for (let r = minRow; r <= maxRow; r++) {
      const wz = this.worldZ(r)
      for (let c = minCol; c <= maxCol; c++) {
        const wx = this.worldX(c)
        const d = Math.hypot(wx - x, wz - z) / radius
        if (d > 1.6) continue
        const i = this.vi(c, r)
        // Bowl inside r, rim between 1.0r and 1.5r.
        const bowl = Math.exp(-d * d * 2.2) * depthM
        const rim = d > 0.85 && d < 1.55 ? Math.sin((d - 0.85) / 0.7 * Math.PI) * depthM * 0.22 : 0
        let h = this.heights[i] - bowl + rim
        // Don't dig bottomless pits where shells land twice.
        const floor = this.base[i] - Math.max(2.6, depthM * 2.2)
        if (h < floor) h = floor
        this.heights[i] = h
        const ch = this.churn[i] + Math.max(0, 1.2 - d) * 0.55
        this.churn[i] = ch > 1 ? 1 : ch
        // Blasts shred the trench revetment locally.
        if (d < 0.9 && this.trench[i] > 0) this.trench[i] *= 0.55
      }
    }
    this.craterOps.push({ x, z, r: radius, d: depthM })
    this.refreshWater(minCol, minRow, maxCol, maxRow)
    this.onDirty?.({ minCol, minRow, maxCol, maxRow })
    return true
  }

  /** Serialized deformation history (for save games). */
  getCraterOps(): ReadonlyArray<{ x: number; z: number; r: number; d: number }> { return this.craterOps }
  replayCraterOps(ops: ReadonlyArray<{ x: number; z: number; r: number; d: number }>): void {
    for (const o of ops) this.crater(o.x, o.z, o.r, o.d)
  }

  // -- water ------------------------------------------------------------------

  setWetness(w: number): void {
    this.wetness = w
    // Dead-band against the last APPLIED value so slow drifts still accumulate
    // and eventually trigger a refresh (no ratchet).
    if (Math.abs(w - this.wetnessApplied) < 0.02) return
    this.wetnessApplied = w
    this.refreshWater(0, 0, this.cols, this.rows)
    this.onDirty?.({ minCol: 0, minRow: 0, maxCol: this.cols, maxRow: this.rows })
  }

  getWetness(): number { return this.wetness }

  private refreshWater(minCol: number, minRow: number, maxCol: number, maxRow: number): void {
    const threshold = WEATHER.floodDepth
    const wet = this.wetness
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const i = this.vi(c, r)
        const depth = this.base[i] - this.heights[i]
        let w = 0
        if (wet > 0.3 && depth > threshold * 0.6) {
          w = Math.min(1, (depth - threshold * 0.6) / threshold) * Math.min(1, (wet - 0.3) / 0.4)
        }
        // Trench floors get miserable and wet too, but drain better.
        if (this.trench[i] > 0.6 && wet > 0.55) {
          w = Math.max(w, (wet - 0.55) * 0.9)
        }
        this.water[i] = w
      }
    }
  }

  // -- generation ---------------------------------------------------------------

  private generate(seed: number): void {
    const noise = new ValueNoise2D(seed ^ 0x7e44a1)
    const rand = forkRand(seed, 'terrain')

    // 1) Rolling ground, defenders on a gentle rise to the south.
    for (let r = 0; r <= this.rows; r++) {
      const z = this.worldZ(r)
      for (let c = 0; c <= this.cols; c++) {
        const x = this.worldX(c)
        const n = noise.fbm(x * 0.012, z * 0.012, 4) - 0.5
        const ridges = noise.fbm(x * 0.004 + 7, z * 0.004 + 3, 2) - 0.5
        const rise = (z + this.depth / 2) / this.depth // 0 north → 1 south
        let h = n * 4.2 + ridges * 3.5 + rise * 2.2
        // Flatten the far north spawn apron a touch so waves read clearly.
        if (z < WORLD.enemySpawnZ + 24) h *= 0.6
        this.heights[this.vi(c, r)] = h
      }
    }

    // 2) A shallow sunken lane / old streambed crossing no-man's land (cover feature).
    const laneZ = -40 + (rand() - 0.5) * 50
    for (let r = 0; r <= this.rows; r++) {
      const z = this.worldZ(r)
      for (let c = 0; c <= this.cols; c++) {
        const x = this.worldX(c)
        const meander = Math.sin(x * 0.02 + seed % 7) * 14
        const d = Math.abs(z - (laneZ + meander))
        if (d < 7) {
          const i = this.vi(c, r)
          this.heights[i] -= (1 - d / 7) * 0.9
          this.churn[i] = Math.max(this.churn[i], (1 - d / 7) * 0.25)
        }
      }
    }

    // 3) Trench lines.
    this.buildTrenchPolylines(rand)
    this.carveTrench(this.frontLine, true)
    this.carveTrench(this.supportLine, true)
    for (const line of this.commLines) this.carveTrench(line, false)

    // 4) Emplacement pads: flat discs behind the lines.
    const padSpots: Vec2[] = []
    for (let i = -3; i <= 3; i++) {
      if (i !== 0) padSpots.push({ x: i * 30 + (rand() - 0.5) * 6, z: WORLD.frontTrenchZ + 16 + rand() * 8 })
    }
    for (let i = -2; i <= 2; i++) {
      padSpots.push({ x: i * 32 + (rand() - 0.5) * 8, z: WORLD.supportTrenchZ + 14 + rand() * 10 })
    }
    padSpots.push({ x: -46, z: WORLD.supportTrenchZ + 34 }, { x: 46, z: WORLD.supportTrenchZ + 34 })
    for (const p of padSpots) {
      this.flattenPad(p.x, p.z, 3.4)
      this.pads.push(p)
    }

    // 5) Pre-war shell holes: the sector has already seen fighting.
    const preCraters = 14
    for (let i = 0; i < preCraters; i++) {
      const x = (rand() - 0.5) * (this.width - 40)
      const z = -170 + rand() * 220
      this.crater(x, z, 2 + rand() * 2.5, 0.5 + rand() * 0.7)
    }
    this.craterOps.length = 0 // pre-war holes are part of the base map, not history

    // Baseline snapshot AFTER all construction.
    this.base.set(this.heights)
  }

  private buildTrenchPolylines(rand: Rand): void {
    // Front line: classic zigzag with fire bays and traverses.
    const span = TRENCH.frontSpanX
    let flip = 1
    for (let x = -span; x <= span + 0.01; x += TRENCH.sectionLen) {
      this.frontLine.push({ x, z: WORLD.frontTrenchZ + flip * 3 + (rand() - 0.5) * 1.5 })
      flip *= -1
    }
    // Support line: shallower zigzag.
    flip = 1
    for (let x = -TRENCH.supportSpanX; x <= TRENCH.supportSpanX + 0.01; x += TRENCH.sectionLen) {
      this.supportLine.push({ x, z: WORLD.supportTrenchZ + flip * 2 })
      flip *= -1
    }
    // Communication trenches: front → support with a dogleg (never straight — enfilade).
    for (const cx of TRENCH.commTrenchXs) {
      const jitter = (rand() - 0.5) * 8
      this.commLines.push([
        { x: cx, z: WORLD.frontTrenchZ + 2 },
        { x: cx + 6 + jitter, z: (WORLD.frontTrenchZ + WORLD.supportTrenchZ) / 2 },
        { x: cx, z: WORLD.supportTrenchZ - 2 },
      ])
    }
  }

  private carveTrench(line: Vec2[], parapet: boolean): void {
    const halfW = TRENCH.width / 2
    for (let s = 0; s < line.length - 1; s++) {
      const a = line[s], b = line[s + 1]
      const minCol = Math.max(0, Math.floor(this.colAt(Math.min(a.x, b.x) - 5)))
      const maxCol = Math.min(this.cols, Math.ceil(this.colAt(Math.max(a.x, b.x) + 5)))
      const minRow = Math.max(0, Math.floor(this.rowAt(Math.min(a.z, b.z) - 5)))
      const maxRow = Math.min(this.rows, Math.ceil(this.rowAt(Math.max(a.z, b.z) + 5)))
      const abx = b.x - a.x, abz = b.z - a.z
      const abLen2 = abx * abx + abz * abz
      for (let r = minRow; r <= maxRow; r++) {
        const wz = this.worldZ(r)
        for (let c = minCol; c <= maxCol; c++) {
          const wx = this.worldX(c)
          // Distance to segment + signed side (north = enemy side gets the parapet).
          let t = abLen2 > 0 ? ((wx - a.x) * abx + (wz - a.z) * abz) / abLen2 : 0
          t = Math.max(0, Math.min(1, t))
          const px = a.x + abx * t, pz = a.z + abz * t
          const d = Math.hypot(wx - px, wz - pz)
          const i = this.vi(c, r)
          if (d < halfW + 0.6) {
            // Smooth-walled cut to full depth.
            const k = d < halfW - 0.5 ? 1 : 1 - (d - (halfW - 0.5)) / 1.1
            const cut = TRENCH.depth * Math.max(0, Math.min(1, k))
            const target = this.heights[i] - cut
            if (target < this.heights[i]) this.heights[i] = target
            this.trench[i] = Math.max(this.trench[i], Math.max(0, Math.min(1, k)))
          } else if (parapet && wz < pz && d < halfW + 2.2) {
            // Sandbag parapet lip on the enemy side.
            const k = 1 - (d - (halfW + 0.6)) / 1.6
            this.heights[i] += TRENCH.parapetH * Math.max(0, k)
          } else if (parapet && wz > pz && d < halfW + 1.6) {
            // Lower parados behind.
            const k = 1 - (d - (halfW + 0.6)) / 1.0
            this.heights[i] += TRENCH.parapetH * 0.5 * Math.max(0, k)
          }
        }
      }
    }
  }

  private flattenPad(x: number, z: number, radius: number): void {
    const h0 = this.heightAt(x, z)
    const minCol = Math.max(0, Math.floor(this.colAt(x - radius - 1)))
    const maxCol = Math.min(this.cols, Math.ceil(this.colAt(x + radius + 1)))
    const minRow = Math.max(0, Math.floor(this.rowAt(z - radius - 1)))
    const maxRow = Math.min(this.rows, Math.ceil(this.rowAt(z + radius + 1)))
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const d = Math.hypot(this.worldX(c) - x, this.worldZ(r) - z)
        if (d > radius + 1) continue
        const i = this.vi(c, r)
        const k = d < radius ? 1 : 1 - (d - radius)
        this.heights[i] = this.heights[i] * (1 - k) + h0 * k
      }
    }
  }
}
