/**
 * The battlefield: a deformable heightfield.
 *
 * Every shell that lands carves a real crater — the heightfield changes, the
 * mesh changes, cover changes, pathfinding costs change, and when it rains the
 * holes fill with water that can bog a tank. The field you finish a run on is
 * a genuinely different place from the one you started on.
 *
 * The grid runs at an INTERNAL 1 m cell (WORLD.cell / 2) so trenches, parapets
 * and shell holes read crisply; everything public is world-space or describes
 * this internal grid (cols/rows/vi/worldX/worldZ/colAt/rowAt all agree).
 */
import type { TerrainLike, Vec2 } from '../core/types'
import { TRENCH, WEATHER, WORLD } from '../core/config'
import { ValueNoise2D, forkRand, type Rand } from '../core/rng'

export interface DirtyRegion { minCol: number; minRow: number; maxCol: number; maxRow: number }

/** Radius (in cells) of the concavity/AO neighbourhood — dirty regions grow by this. */
const AO_REACH = 5

export class Terrain implements TerrainLike {
  readonly width = WORLD.width
  readonly depth = WORLD.depth
  /** Internal grid cell (1 m) — finer than the 2 m WORLD.cell the flow fields use. */
  readonly cell = WORLD.cell / 2
  /** Vertex grid is (cols+1) x (rows+1). */
  readonly cols = Math.round(WORLD.width / (WORLD.cell / 2))
  readonly rows = Math.round(WORLD.depth / (WORLD.cell / 2))

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
  /**
   * Signed concavity per vertex: +1 = deep pit/trench bottom (occluded),
   * -1 = crest/rim/parapet (catches light, exposed subsoil). Recomputed for
   * dirty regions when shells land.
   */
  readonly ao: Float32Array

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
  /** Fine-detail noise lattice, kept for carve-time surface variation. */
  private detailNoise!: ValueNoise2D

  constructor(seed: number) {
    const vcount = (this.cols + 1) * (this.rows + 1)
    this.heights = new Float32Array(vcount)
    this.base = new Float32Array(vcount)
    this.churn = new Float32Array(vcount)
    this.trench = new Float32Array(vcount)
    this.water = new Float32Array(vcount)
    this.ao = new Float32Array(vcount)
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
    // Sample at a fixed 2 m arm so the finer internal grid doesn't make micro
    // roughness read as walls to the pathfinder.
    const e = 2
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

    const dn = this.detailNoise
    for (let r = minRow; r <= maxRow; r++) {
      const wz = this.worldZ(r)
      for (let c = minCol; c <= maxCol; c++) {
        const wx = this.worldX(c)
        const d = Math.hypot(wx - x, wz - z) / radius
        if (d > 1.6) continue
        const i = this.vi(c, r)
        // Ragged edge: modulate distance a touch with fine noise so lips and
        // bowls stop reading as perfect circles at 1 m resolution.
        const rag = dn ? (dn.at(wx * 0.55 + 11.3, wz * 0.55 + 71.9) - 0.5) * 0.22 : 0
        const dd = Math.max(0, d + rag * Math.min(1, d))
        // Bowl inside r, rim between 1.0r and 1.5r.
        const bowl = Math.exp(-dd * dd * 2.2) * depthM
        const rim = dd > 0.85 && dd < 1.55 ? Math.sin((dd - 0.85) / 0.7 * Math.PI) * depthM * 0.22 : 0
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
    // Concavity shading changes a ring beyond the blast itself; water reads AO,
    // so recompute AO first.
    const aMinC = Math.max(0, minCol - AO_REACH), aMaxC = Math.min(this.cols, maxCol + AO_REACH)
    const aMinR = Math.max(0, minRow - AO_REACH), aMaxR = Math.min(this.rows, maxRow + AO_REACH)
    this.computeAO(aMinC, aMinR, aMaxC, aMaxR)
    this.refreshWater(aMinC, aMinR, aMaxC, aMaxR)
    this.onDirty?.({ minCol: aMinC, minRow: aMinR, maxCol: aMaxC, maxRow: aMaxR })
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
        // Pre-war shell holes and hollows puddle at high wetness too. This is
        // render-only (the water array feeds the shader; the sim gates flooding
        // on craterDepthAt), so old holes shine without changing gameplay.
        if (wet > 0.45 && this.trench[i] < 0.3 && this.ao[i] > 0.5) {
          const pw = Math.min(1, (this.ao[i] - 0.5) * 2.4) * Math.min(1, (wet - 0.45) / 0.35) * 0.85
          if (pw > w) w = pw
        }
        // Trench floors get miserable and wet too, but drain better.
        if (this.trench[i] > 0.6 && wet > 0.55) {
          w = Math.max(w, (wet - 0.55) * 0.9)
        }
        this.water[i] = w
      }
    }
  }

  // -- concavity / ambient occlusion -------------------------------------------

  /**
   * Signed concavity from ring means at ~2 m and ~5 m: positive in pits and
   * trench bottoms (darkens), negative on rims and parapets (exposed subsoil).
   */
  private computeAO(minCol: number, minRow: number, maxCol: number, maxRow: number): void {
    const H = this.heights
    const cs = this.cols, rs = this.rows
    for (let r = minRow; r <= maxRow; r++) {
      const rU2 = Math.max(0, r - 2), rD2 = Math.min(rs, r + 2)
      const rU5 = Math.max(0, r - 5), rD5 = Math.min(rs, r + 5)
      const rU1 = Math.max(0, r - 1), rD1 = Math.min(rs, r + 1)
      const rU4 = Math.max(0, r - 4), rD4 = Math.min(rs, r + 4)
      for (let c = minCol; c <= maxCol; c++) {
        const cL2 = Math.max(0, c - 2), cR2 = Math.min(cs, c + 2)
        const cL5 = Math.max(0, c - 5), cR5 = Math.min(cs, c + 5)
        const cL1 = Math.max(0, c - 1), cR1 = Math.min(cs, c + 1)
        const cL4 = Math.max(0, c - 4), cR4 = Math.min(cs, c + 4)
        const h = H[this.vi(c, r)]
        // 2 m ring: 4 cardinals + 4 near-diagonals.
        const m1 = (H[this.vi(cL2, r)] + H[this.vi(cR2, r)] + H[this.vi(c, rU2)] + H[this.vi(c, rD2)]
          + H[this.vi(cL1, rU1)] + H[this.vi(cR1, rU1)] + H[this.vi(cL1, rD1)] + H[this.vi(cR1, rD1)]) * 0.125
        // 5 m ring.
        const m2 = (H[this.vi(cL5, r)] + H[this.vi(cR5, r)] + H[this.vi(c, rU5)] + H[this.vi(c, rD5)]
          + H[this.vi(cL4, rU4)] + H[this.vi(cR4, rU4)] + H[this.vi(cL4, rD4)] + H[this.vi(cR4, rD4)]) * 0.125
        const conc = (m1 - h) * 1.05 + (m2 - h) * 0.38
        // Soft-saturate to [-1, 1]; ~1 m of concavity ≈ 0.8.
        this.ao[this.vi(c, r)] = conc / (0.4 + Math.abs(conc)) * 1.12
      }
    }
  }

  // -- generation ---------------------------------------------------------------

  private generate(seed: number): void {
    const noise = new ValueNoise2D(seed ^ 0x7e44a1)
    const detail = new ValueNoise2D(seed ^ 0x3c9f21)
    this.detailNoise = detail
    const rand = forkRand(seed, 'terrain')
    const frontZ = WORLD.frontTrenchZ

    // Ridged fBm in [0,1] — sharp-crested broken ground.
    const ridged = (x: number, z: number, oct: number): number => {
      let amp = 0.55, freq = 1, sum = 0, norm = 0
      for (let o = 0; o < oct; o++) {
        const n = 1 - Math.abs(2 * noise.at(x * freq + 41.7, z * freq + 89.2) - 1)
        sum += amp * n * n
        norm += amp
        amp *= 0.5
        freq *= 2.13
      }
      return sum / norm
    }

    // 1) Landform: rolling ground + broad ridges + ridged breakup + hummocks
    //    + fine roughness, defenders on a gentle rise to the south. No-man's
    //    land carries a base churn belt, heaviest just short of the wire.
    for (let r = 0; r <= this.rows; r++) {
      const z = this.worldZ(r)
      const rise = (z + this.depth / 2) / this.depth // 0 north → 1 south
      // Smooth spawn-apron flattening (the old hard cutoff drew a crease).
      let apron = (z - (WORLD.enemySpawnZ + 8)) / 34
      apron = Math.max(0, Math.min(1, apron))
      apron = apron * apron * (3 - 2 * apron)
      const flatten = 0.55 + 0.45 * apron
      // Shell-churn belt weight across no-man's land.
      let beltW = 0
      if (z > WORLD.enemySpawnZ + 36 && z < frontZ + 4) {
        const t = 1 - Math.min(1, Math.abs(frontZ - 20 - z) / 95)
        beltW = t * t
      }
      for (let c = 0; c <= this.cols; c++) {
        const x = this.worldX(c)
        const i = this.vi(c, r)
        const roll = noise.fbm(x * 0.011, z * 0.011, 4) - 0.5
        const broad = noise.fbm(x * 0.004 + 7, z * 0.004 + 3, 2) - 0.5
        const rg = ridged(x * 0.03, z * 0.03, 3) - 0.42
        const hum = detail.at(x * 0.065 + 31, z * 0.065 + 17) - 0.5
        const mic = detail.fbm(x * 0.31 + 57, z * 0.31 + 23, 2) - 0.5
        this.heights[i] =
          (roll * 4.0 + broad * 3.4 + rg * 1.7 + hum * 0.55 + mic * 0.22) * flatten + rise * 2.2
        if (beltW > 0) {
          const m = detail.fbm(x * 0.05 + 91, z * 0.05 + 47, 3)
          const ch = beltW * Math.max(0, Math.min(1, m * 1.9 - 0.55)) * 0.8
          if (ch > this.churn[i]) this.churn[i] = ch
        }
      }
    }

    // 2) A shallow sunken lane / old streambed crossing no-man's land (cover
    //    feature), with a ragged noisy edge instead of a clean band.
    const laneZ = -40 + (rand() - 0.5) * 50
    {
      const rMin = Math.max(0, Math.floor(this.rowAt(laneZ - 26)))
      const rMax = Math.min(this.rows, Math.ceil(this.rowAt(laneZ + 26)))
      for (let r = rMin; r <= rMax; r++) {
        const z = this.worldZ(r)
        for (let c = 0; c <= this.cols; c++) {
          const x = this.worldX(c)
          const meander = Math.sin(x * 0.02 + seed % 7) * 14
          const w = 7 + (detail.at(x * 0.09 + 5, z * 0.09 + 9) - 0.5) * 3.2
          const d = Math.abs(z - (laneZ + meander))
          if (d < w) {
            const i = this.vi(c, r)
            const k = 0.5 + 0.5 * Math.cos(Math.PI * d / w)
            this.heights[i] -= k * 1.0
            this.churn[i] = Math.max(this.churn[i], k * 0.3)
          }
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

    // Interim baseline so the pocking pass below carves against real ground
    // (the floor clamp in crater() reads base; a zeroed base flattens bowls
    // that land in hollows).
    this.base.set(this.heights)

    // 5) Shell-pocked no-man's land: the sector has seen two years of fighting.
    //    Density biases toward the wire in front of the front trench.
    const pock = (n: number, rLo: number, rHi: number, dLo: number, dHi: number) => {
      for (let i = 0; i < n; i++) {
        const rad = rLo + rand() * (rHi - rLo)
        const t = Math.pow(rand(), 0.55) // biased toward 1 → toward the front line
        let z = WORLD.enemySpawnZ + 44 + t * (frontZ - 14 - (WORLD.enemySpawnZ + 44))
        z = Math.min(z, frontZ - 8 - rad * 1.6) // never chew the parapet
        const x = (rand() - 0.5) * (this.width - 30)
        this.crater(x, z, rad, dLo + rand() * (dHi - dLo))
      }
    }
    pock(58, 1.1, 2.3, 0.3, 0.6)  // field-gun and mortar scatter
    pock(30, 2.4, 4.0, 0.5, 1.0)  // medium howitzer
    pock(9, 4.4, 6.0, 0.9, 1.5)   // heavies
    // Overlapping clusters just short of the wire — the lunar belt.
    for (let i = 0; i < 12; i++) {
      const cx = (rand() - 0.5) * (this.width - 60)
      const cz = frontZ - 18 - rand() * 26
      const m = 2 + ((rand() * 3) | 0)
      for (let j = 0; j < m; j++) {
        const rad = 1.2 + rand() * 1.8
        const z = Math.min(cz + (rand() - 0.5) * 9, frontZ - 8 - rad * 1.6)
        this.crater(cx + (rand() - 0.5) * 9, z, rad, 0.35 + rand() * 0.55)
      }
    }
    // A few overs behind the front line (clear of the communication trenches).
    for (let i = 0; i < 7; i++) {
      const rad = 1.1 + rand() * 0.9
      let x = (rand() - 0.5) * (this.width - 40)
      for (const cx of TRENCH.commTrenchXs) if (Math.abs(x - cx) < 10) x += x > cx ? 10 : -10
      this.crater(x, frontZ + 7 + rand() * 4, rad, 0.3 + rand() * 0.35)
    }
    this.craterOps.length = 0 // pre-war holes are part of the base map, not history

    // Final baseline AFTER all construction: pre-war holes are scenery, not
    // gameplay craters (no crater cover / flooding change vs. a fresh field) —
    // same semantics as before, just carved against sane floors above.
    this.base.set(this.heights)

    // 6) Concavity/AO + initial water over the whole field.
    this.computeAO(0, 0, this.cols, this.rows)
    this.refreshWater(0, 0, this.cols, this.rows)
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
    const dn = this.detailNoise
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
            // Smooth-walled cut to full depth; floor gets a little trodden
            // unevenness so duckboards don't sit on glass.
            const k = d < halfW - 0.5 ? 1 : 1 - (d - (halfW - 0.5)) / 1.1
            const kk = Math.max(0, Math.min(1, k))
            const rut = (dn.at(wx * 0.7 + 3.1, wz * 0.7 + 8.7) - 0.5) * 0.12 * kk
            const cut = TRENCH.depth * kk - rut
            const target = this.heights[i] - cut
            if (target < this.heights[i]) this.heights[i] = target
            this.trench[i] = Math.max(this.trench[i], kk)
          } else if (parapet && wz < pz && d < halfW + 2.2) {
            // Sandbag parapet lip on the enemy side — slightly lumpy, like
            // stacked bags rather than an extruded curb.
            const k = 1 - (d - (halfW + 0.6)) / 1.6
            const lump = 0.8 + 0.4 * dn.at(wx * 0.9 + 13.7, wz * 0.9 + 29.3)
            this.heights[i] += TRENCH.parapetH * Math.max(0, k) * lump
          } else if (parapet && wz > pz && d < halfW + 1.6) {
            // Lower parados behind.
            const k = 1 - (d - (halfW + 0.6)) / 1.0
            const lump = 0.85 + 0.3 * dn.at(wx * 0.9 + 51.1, wz * 0.9 + 67.9)
            this.heights[i] += TRENCH.parapetH * 0.5 * Math.max(0, k) * lump
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
