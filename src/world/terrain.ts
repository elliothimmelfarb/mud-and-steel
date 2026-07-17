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

/**
 * One raised earth bank thrown up beside a trench — the enemy-side parapet lip
 * or the lower parados behind. The two were copy-paste bar these constants; see
 * `carveTrench`'s `addBank` closure, which reproduces both branches exactly.
 */
interface BankSpec {
  setbackBase: number; setbackOx: number; setbackOz: number; setbackAmp: number
  kDiv: number
  l1Freq: number; l1Ox: number; l1Oz: number; l1Amp: number
  l2Freq: number; l2Ox: number; l2Oz: number; l2Amp: number
  lumpBase: number
  gapOx: number; gapOz: number; gapThresh: number; gapFloorBase: number; gapFloorSpan: number
  heightScale: number
  /** Floor on lump*gap so parapet dips never drop below the old uniform lip
   *  height (they'd become firing holes onto crouching men); null = parados. */
  floor: number | null
}

const PARAPET_BANK: BankSpec = {
  setbackBase: 0.65, setbackOx: 5.0, setbackOz: 90.0, setbackAmp: 0.9,
  kDiv: 1.6,
  l1Freq: 0.9, l1Ox: 13.7, l1Oz: 29.3, l1Amp: 0.34,
  l2Freq: 2.4, l2Ox: 2.1, l2Oz: 58.4, l2Amp: 0.2,
  lumpBase: 0.68,
  gapOx: 120.0, gapOz: 7.0, gapThresh: 0.3, gapFloorBase: 0.35, gapFloorSpan: 0.65,
  heightScale: 1, floor: 0.8,
}

const PARADOS_BANK: BankSpec = {
  setbackBase: 0.5, setbackOx: 51.1, setbackOz: 67.9, setbackAmp: 0.7,
  kDiv: 1.05,
  l1Freq: 0.95, l1Ox: 51.1, l1Oz: 67.9, l1Amp: 0.3,
  l2Freq: 2.3, l2Ox: 9.4, l2Oz: 21.2, l2Amp: 0.18,
  lumpBase: 0.72,
  gapOx: 61.0, gapOz: 88.0, gapThresh: 0.28, gapFloorBase: 0.4, gapFloorSpan: 0.6,
  heightScale: 0.5, floor: null,
}

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
  /** 0..1 shell-churn (scorch + mud) per vertex; drives mud PHYSICS (mudAt,
   *  movement cost, bogging). Kept deliberately tight around real blast bowls. */
  readonly churn: Float32Array
  /** Render-only churn: everything in `churn` PLUS cosmetic ejecta rays around
   *  fresh craters. The terrain mesh shades from this so shell holes read
   *  blasted, without widening each shell's gameplay slow-zone. */
  readonly churnVis: Float32Array
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
  /**
   * Fire-step bench cells (vi -> carved bench height). Recorded by the parapet
   * lines so the communication trenches — carved after them — can't dig the
   * bench back out at a junction and leave manning soldiers floating there.
   */
  private benchGuard = new Map<number, number>()
  /** Fine-detail noise lattice, kept for carve-time surface variation. */
  private detailNoise!: ValueNoise2D

  constructor(seed: number) {
    const vcount = (this.cols + 1) * (this.rows + 1)
    this.heights = new Float32Array(vcount)
    this.base = new Float32Array(vcount)
    this.churn = new Float32Array(vcount)
    this.churnVis = new Float32Array(vcount)
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
   *
   * Profile detail (all deterministic from x/z/radius/depth + the stored detail
   * noise, so replayCraterOps reproduces it byte-for-byte):
   *  - steep inner bowl + a narrow, tall rim crest that scales with depth,
   *  - a low-amplitude non-radial wobble so bowls aren't perfect dishes,
   *  - churn-only EJECTA rays out to ~2.2r (no height change → no gameplay
   *    depth/cover shift; fresh holes read blasted, not stamped),
   *  - clod lumps flung onto the rim of heavy shells (radius > 3).
   */
  crater(x: number, z: number, radius: number, depthM: number): boolean {
    // Box reaches the ejecta apron (2.2r); height work stays inside ~1.65r.
    const REACH = 2.2
    const minCol = Math.max(0, Math.floor(this.colAt(x - radius * REACH)))
    const maxCol = Math.min(this.cols, Math.ceil(this.colAt(x + radius * REACH)))
    const minRow = Math.max(0, Math.floor(this.rowAt(z - radius * REACH)))
    const maxRow = Math.min(this.rows, Math.ceil(this.rowAt(z + radius * REACH)))
    if (minCol >= maxCol || minRow >= maxRow) return false

    const dn = this.detailNoise
    const heavy = radius > 3
    // Deterministic per-crater clod phases (unique per hole, reproducible on
    // replay). Only heavy shells read them.
    const clodPhase = heavy && dn ? dn.at(x * 0.4 + 3.1, z * 0.4 + 7.7) * 6.2832 : 0
    const clodLobes = heavy && dn && dn.at(x * 0.31 + 51.3, z * 0.31 + 9.9) < 0.5 ? 2 : 3
    const rimAmp = 0.28 + Math.min(0.2, depthM * 0.07)

    for (let r = minRow; r <= maxRow; r++) {
      const wz = this.worldZ(r)
      for (let c = minCol; c <= maxCol; c++) {
        const wx = this.worldX(c)
        const d = Math.hypot(wx - x, wz - z) / radius
        if (d > REACH) continue
        const i = this.vi(c, r)

        // -- height: bowl + rim + clods, only where they actually live -------
        if (d <= 1.65) {
          // Ragged edge: modulate distance a touch with fine noise so lips and
          // bowls stop reading as perfect circles at 1 m resolution.
          const rag = dn ? (dn.at(wx * 0.55 + 11.3, wz * 0.55 + 71.9) - 0.5) * 0.22 : 0
          const dd = Math.max(0, d + rag * Math.min(1, d))
          // Secondary, lower-frequency non-radial wobble on the bowl wall.
          const wob = dn ? (dn.at(wx * 0.32 + 40.0, wz * 0.32 + 12.0) - 0.5) * 0.16 : 0
          const de = Math.max(0, dd + wob * Math.min(1, dd))
          // Steeper inner bowl (exp 3.0 vs 2.2) — walls read cut, not dished.
          const bowl = Math.exp(-de * de * 3.0) * depthM
          // Sharper rim crest: narrower band (0.9..1.4r), taller, depth-scaled.
          let rim = de > 0.9 && de < 1.4 ? Math.sin((de - 0.9) / 0.5 * Math.PI) * depthM * rimAmp : 0
          // Heavy shells fling 2-3 clod lumps onto the rim.
          if (heavy && de > 0.82 && de < 1.4) {
            const ang = Math.atan2(wz - z, wx - x)
            const lobe = Math.max(0, Math.sin(ang * clodLobes + clodPhase))
            rim += lobe * lobe * Math.sin((de - 0.82) / 0.58 * Math.PI) * depthM * 0.16
          }
          let h = this.heights[i] - bowl + rim
          // Don't dig bottomless pits where shells land twice.
          const floor = this.base[i] - Math.max(2.6, depthM * 2.2)
          if (h < floor) h = floor
          this.heights[i] = h
        }

        // -- churn: bowl scorch near centre is GAMEPLAY mud (churn + churnVis);
        // the ejecta rays in the apron are shading only (churnVis), so a
        // shell's slow-zone footprint stays the tight pre-rework bowl.
        const add = Math.max(0, 1.2 - d) * 0.55
        if (add > 0) {
          const ch = this.churn[i] + add
          this.churn[i] = ch > 1 ? 1 : ch
        }
        let addVis = add
        if (dn && d > 1.0 && d < 2.2) {
          const ang = Math.atan2(wz - z, wx - x)
          // Angular noise sampled on a ring → constant along a radius = a ray;
          // the crater-centre offset makes each hole's fan unique.
          const streak = dn.at(Math.cos(ang) * 3.0 + x * 0.15, Math.sin(ang) * 3.0 + z * 0.15)
          const rays = Math.max(0, (streak - 0.42) / 0.58)
          const fall = Math.max(0, (2.2 - d) / 1.2)
          const ej = rays * fall * 0.55
          if (ej > addVis) addVis = ej
        }
        if (addVis > 0) {
          const cv = this.churnVis[i] + addVis
          this.churnVis[i] = cv > 1 ? 1 : cv
        }

        // Blasts shred the trench revetment locally.
        if (d < 0.9 && this.trench[i] > 0) this.trench[i] *= 0.55
      }
    }
    this.craterOps.push({ x, z, r: radius, d: depthM })
    // AO + water depend only on HEIGHTS, which change within 1.65r — grow that
    // box (not the churn apron) by the concavity reach. The dirty region for
    // the mesh is the union: churn texels out to 2.2r + the AO ring.
    const hMinC = Math.max(0, Math.floor(this.colAt(x - radius * 1.65)) - AO_REACH)
    const hMaxC = Math.min(this.cols, Math.ceil(this.colAt(x + radius * 1.65)) + AO_REACH)
    const hMinR = Math.max(0, Math.floor(this.rowAt(z - radius * 1.65)) - AO_REACH)
    const hMaxR = Math.min(this.rows, Math.ceil(this.rowAt(z + radius * 1.65)) + AO_REACH)
    this.computeAO(hMinC, hMinR, hMaxC, hMaxR)
    this.refreshWater(hMinC, hMinR, hMaxC, hMaxR)
    this.onDirty?.({
      minCol: Math.min(minCol, hMinC), minRow: Math.min(minRow, hMinR),
      maxCol: Math.max(maxCol, hMaxC), maxRow: Math.max(maxRow, hMaxR),
    })
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
    const supportZ = WORLD.supportTrenchZ

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
    //    land carries a base churn belt, heaviest just short of the wire, now
    //    clumped into blast fields. The rear fields (south of the support line)
    //    carry faint plough furrows.
    // Furrow direction: axis-aligned rows rotated ~10° so they don't align to x.
    const furrowCos = 0.9848, furrowSin = 0.1736
    const furrowK = (2 * Math.PI) / 1.4 // ~1.4 m wavelength
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
      // Rear plough furrows fade in south of the support line.
      const furrowFade = z > supportZ - 6 ? Math.min(1, (z - (supportZ - 6)) / 14) : 0
      for (let c = 0; c <= this.cols; c++) {
        const x = this.worldX(c)
        const i = this.vi(c, r)
        const roll = noise.fbm(x * 0.011, z * 0.011, 4) - 0.5
        const broad = noise.fbm(x * 0.004 + 7, z * 0.004 + 3, 2) - 0.5
        const rg = ridged(x * 0.03, z * 0.03, 3) - 0.42
        const hum = detail.at(x * 0.065 + 31, z * 0.065 + 17) - 0.5
        const mic = detail.fbm(x * 0.31 + 57, z * 0.31 + 23, 2) - 0.5
        let h = (roll * 4.0 + broad * 3.4 + rg * 1.7 + hum * 0.55 + mic * 0.22) * flatten + rise * 2.2
        if (furrowFade > 0) {
          // ~0.05 m ripples, banded so the ploughing isn't perfectly uniform.
          const u = x * furrowCos + z * furrowSin
          const band = 0.62 + 0.38 * detail.at(x * 0.02 + 70, z * 0.02 + 30)
          h += Math.sin(u * furrowK) * 0.05 * furrowFade * band
        }
        this.heights[i] = h
        if (beltW > 0) {
          const m = detail.fbm(x * 0.05 + 91, z * 0.05 + 47, 3)
          // A second, lower-frequency mask clumps the churn into blast fields
          // with cleaner unblasted gaps between them.
          const clump = detail.at(x * 0.021 + 13, z * 0.021 + 61)
          const clumpMask = Math.max(0, Math.min(1, (clump - 0.4) / 0.35))
          const ch = beltW * Math.max(0, Math.min(1, m * 1.9 - 0.55)) * clumpMask * 0.95
          if (ch > this.churn[i]) this.churn[i] = ch
        }
      }
    }

    // 2) A shallow sunken lane / old streambed crossing no-man's land (cover
    //    feature), with a ragged, two-octave noisy edge and an uneven floor
    //    instead of a clean band.
    const laneZ = -40 + (rand() - 0.5) * 50
    {
      const rMin = Math.max(0, Math.floor(this.rowAt(laneZ - 30)))
      const rMax = Math.min(this.rows, Math.ceil(this.rowAt(laneZ + 30)))
      for (let r = rMin; r <= rMax; r++) {
        const z = this.worldZ(r)
        for (let c = 0; c <= this.cols; c++) {
          const x = this.worldX(c)
          const meander = Math.sin(x * 0.02 + seed % 7) * 14
          // Two-octave ragged bank width.
          const w = 7 + (detail.at(x * 0.09 + 5, z * 0.09 + 9) - 0.5) * 3.4
            + (detail.at(x * 0.28 + 22, z * 0.28 + 3) - 0.5) * 1.8
          const d = Math.abs(z - (laneZ + meander))
          if (d < w) {
            const i = this.vi(c, r)
            const k = 0.5 + 0.5 * Math.cos(Math.PI * d / w)
            // Uneven, churned streambed floor.
            const rag = (detail.at(x * 0.4 + 2, z * 0.4 + 8) - 0.5) * 0.25 * k
            this.heights[i] -= k * 1.0 + rag
            this.churn[i] = Math.max(this.churn[i], k * 0.3)
          }
        }
      }
    }

    // Everything written to `churn` so far (belt + lane) is gameplay mud that
    // should shade too; from here on crater() and spoilHeap() maintain both
    // arrays themselves (ejecta rays go to churnVis only).
    this.churnVis.set(this.churn)

    // 3) Trench lines. Every line is carved against ONE shared snapshot of the
    //    pre-trench surface. Per-line snapshots fixed a single zigzag's self-
    //    overlap but NOT junctions: the communication trenches are carved after
    //    the front/support lines, so their old per-line snapshot already held
    //    the lowered front floor and each junction cut a SECOND full depth below
    //    it — the crater-like pit Elliot saw. Sharing the pristine snapshot
    //    makes every line target the same absolute floor (grade - depth), so a
    //    junction is a clean min/union at one depth instead of additive digging.
    this.buildTrenchPolylines(rand)
    const preTrench = this.heights.slice()
    this.carveTrench(this.frontLine, true, preTrench)
    this.carveTrench(this.supportLine, true, preTrench)
    for (const line of this.commLines) this.carveTrench(line, false, preTrench)

    // 3b) Spoil heaps flanking each communication trench — dug-out earth thrown
    //     to the sides. Small mounds + churn, kept low so they never wall the
    //     corridor.
    for (const cx of TRENCH.commTrenchXs) {
      const nHeaps = 2 + (rand() < 0.5 ? 1 : 0)
      for (let hIdx = 0; hIdx < nHeaps; hIdx++) {
        const side = rand() < 0.5 ? -1 : 1
        const hz = frontZ + 8 + rand() * (supportZ - frontZ - 16)
        const hx = cx + side * (TRENCH.width / 2 + 1.6 + rand() * 1.4) + (rand() - 0.5) * 3
        this.spoilHeap(hx, hz, 0.3 + rand() * 0.15, 1.6 + rand() * 0.6)
      }
    }

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

  private carveTrench(line: Vec2[], parapet: boolean, pre: Float32Array): void {
    const halfW = TRENCH.width / 2
    const dn = this.detailNoise
    // Full-depth floor reaches this far out before the wall ramps up.
    const inner = halfW - 0.35
    // `pre` is a SHARED snapshot of the pre-trench surface (see generate()):
    // adjacent zigzag segments overlap near every joint, and cutting from the
    // live heights made those cuts cumulative — measured 5-6 m pits at traverses
    // AND at every junction where a communication trench met the front/support
    // floor. Carving all lines from one pristine snapshot makes overlaps agree
    // (target the same absolute floor) instead of adding.

    // Fire step: a raised bench carved into the ENEMY wall of the parapet
    // trenches. Its top sits `fireStepLift` above the floor (= grade - stepDrop),
    // exactly the height a manning soldier reads at. We clear the trench mask on
    // the bench so standSurface returns the real benchTop (no synthetic lift) and
    // the man's feet plant on ground. The deep floor + duckboards stay on the
    // parados side for the trench silhouette and for men moving under cover.
    const stepDrop = TRENCH.depth - TRENCH.fireStepLift  // benchTop = grade - stepDrop
    const stepInset = TRENCH.fireStepInset               // deep floor reaches this far past centre toward the parados
    // Slats of the deep floor: everything from the parados wall to `stepInset`
    // on the enemy side. Beyond that (toward the enemy wall) rises the bench.

    // Raise one earth bank (parapet lip / parados) at cell `i`. The parapet and
    // parados branches were copy-paste bar a dozen constants; drive both from a
    // BankSpec. The final += keeps each branch's exact multiply chain so the
    // result is bit-identical to the pre-refactor code (parapet floors lump*gap
    // and has heightScale 1; parados has no floor and heightScale 0.5).
    const addBank = (wx: number, wz: number, d: number, i: number, s: BankSpec): void => {
      const setback = s.setbackBase + (dn.at(wx * 0.20 + s.setbackOx, wz * 0.20 + s.setbackOz) - 0.5) * s.setbackAmp
      const k = 1 - (d - (halfW + setback)) / s.kDiv
      const kc = Math.max(0, Math.min(1.1, k))
      const l1 = dn.at(wx * s.l1Freq + s.l1Ox, wz * s.l1Freq + s.l1Oz)
      const l2 = dn.at(wx * s.l2Freq + s.l2Ox, wz * s.l2Freq + s.l2Oz)
      const lump = s.lumpBase + s.l1Amp * l1 + s.l2Amp * l2
      const gapN = dn.at(wx * 0.14 + s.gapOx, wz * 0.14 + s.gapOz)
      const gap = gapN < s.gapThresh ? s.gapFloorBase + (gapN / s.gapThresh) * s.gapFloorSpan : 1
      this.heights[i] += s.floor !== null
        ? TRENCH.parapetH * s.heightScale * kc * Math.max(s.floor, lump * gap)
        : TRENCH.parapetH * s.heightScale * kc * lump * gap
    }

    for (let s = 0; s < line.length - 1; s++) {
      const a = line[s], b = line[s + 1]
      const minCol = Math.max(0, Math.floor(this.colAt(Math.min(a.x, b.x) - 5)))
      const maxCol = Math.min(this.cols, Math.ceil(this.colAt(Math.max(a.x, b.x) + 5)))
      const minRow = Math.max(0, Math.floor(this.rowAt(Math.min(a.z, b.z) - 5)))
      const maxRow = Math.min(this.rows, Math.ceil(this.rowAt(Math.max(a.z, b.z) + 5)))
      const abx = b.x - a.x, abz = b.z - a.z
      const abLen2 = abx * abx + abz * abz
      // Unit perpendicular pointing toward the enemy (global -z), so we can
      // tell which side of the centreline a cell is on for the fire step.
      const segLen = Math.sqrt(abLen2) || 1
      let nx = -abz / segLen, nz = abx / segLen
      if (nz > 0) { nx = -nx; nz = -nz }
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
            // Steeper, cut wall: full depth to `inner`, then a short 0.7 m
            // ramp raised to a convex power so the wall stays deep and the lip
            // stays crisp (revetted, not eroded).
            const kraw = d < inner ? 1 : 1 - (d - inner) / 0.7
            const kk = Math.pow(Math.max(0, Math.min(1, kraw)), 0.72)
            // Floor gets a little trodden unevenness so duckboards don't sit on
            // glass (kept on the fire-step too).
            const rut = (dn.at(wx * 0.7 + 3.1, wz * 0.7 + 8.7) - 0.5) * 0.12 * kk
            const cut = TRENCH.depth * kk - rut
            let target = pre[i] - cut
            // A communication trench meeting a parapet line stops at the fire
            // step: it must not dig the bench back out, nor re-mask it (the
            // cleared mask is what plants a manning soldier's feet on it).
            const guard = parapet ? undefined : this.benchGuard.get(i)
            if (guard !== undefined && target < guard) target = guard
            if (target < this.heights[i]) this.heights[i] = target
            if (guard === undefined) this.trench[i] = Math.max(this.trench[i], kk)
            // Physical fire step on the enemy wall of the parapet trenches.
            // `signed` > 0 means the cell is on the enemy side of the centreline;
            // past `stepInset` the deep floor gives way to a bench rising to
            // `benchTop` (= grade - stepDrop = floor + fireStepLift). We lerp the
            // rise and FADE the trench mask to 0 over a 0.6 m riser so
            // standSurface reads real geometry there (feet planted, no float)
            // while transitioning smoothly to the synthetic-lift deep floor.
            if (parapet) {
              const signed = (wx - px) * nx + (wz - pz) * nz
              let bench = (signed - stepInset) / 0.6 + 0.5
              bench = bench <= 0 ? 0 : bench >= 1 ? 1 : bench * bench * (3 - 2 * bench)
              if (bench > 0) {
                const benchTop = pre[i] - stepDrop + rut * 0.5
                if (benchTop > this.heights[i]) {
                  this.heights[i] += (benchTop - this.heights[i]) * bench
                }
                this.trench[i] *= 1 - bench
                if (bench > 0.5) this.benchGuard.set(i, this.heights[i])
              }
            }
          } else if (parapet && wz < pz && d < halfW + 2.4) {
            // Sandbag parapet lip on the enemy side (the ACTUAL small-arms
            // cover): two octaves of bag lumpiness, a wandering setback, and
            // the odd noise-thresholded gap reading as blast damage.
            addBank(wx, wz, d, i, PARAPET_BANK)
          } else if (parapet && wz > pz && d < halfW + 1.9) {
            // Lower parados behind, same treatment at half height.
            addBank(wx, wz, d, i, PARADOS_BANK)
          }
        }
      }
    }
  }

  /**
   * Iterate every grid cell in the bounding box of the disc of `reach` metres
   * around (cx,cz), calling cb(col,row,worldX,worldZ,vertexIndex). The precise
   * in-disc test stays in the callback so each caller reproduces its original
   * radial math byte-for-byte. (crater/carveTrench keep their own scans: crater
   * needs the box bounds for its return value + AO ring + dirty union, and
   * carveTrench measures distance to a segment, not a point.)
   */
  private forEachCellInDisc(
    cx: number, cz: number, reach: number,
    cb: (c: number, r: number, wx: number, wz: number, i: number) => void,
  ): void {
    const minCol = Math.max(0, Math.floor(this.colAt(cx - reach)))
    const maxCol = Math.min(this.cols, Math.ceil(this.colAt(cx + reach)))
    const minRow = Math.max(0, Math.floor(this.rowAt(cz - reach)))
    const maxRow = Math.min(this.rows, Math.ceil(this.rowAt(cz + reach)))
    for (let r = minRow; r <= maxRow; r++) {
      const wz = this.worldZ(r)
      for (let c = minCol; c <= maxCol; c++) {
        cb(c, r, this.worldX(c), wz, this.vi(c, r))
      }
    }
  }

  /** A small dug-out spoil mound + local churn (deterministic surface lumps). */
  private spoilHeap(x: number, z: number, height: number, radius: number): void {
    const dn = this.detailNoise
    this.forEachCellInDisc(x, z, radius * 1.5, (_c, _r, wx, wz, i) => {
      const dn2 = ((wx - x) * (wx - x) + (wz - z) * (wz - z)) / (radius * radius)
      if (dn2 > 2.25) return
      // Never spill into a carved corridor: comm-trench doglegs wander up to
      // ~10 m off their nominal axis, and a heap stamped on the floor walls
      // the corridor and floats the duckboards.
      if (this.trench[i] > 0.02) return
      const g = Math.exp(-dn2 * 1.8)
      const lump = 0.8 + 0.3 * dn.at(wx * 0.8 + 17.0, wz * 0.8 + 44.0)
      this.heights[i] += height * g * lump
      const ch = g * 0.35
      if (ch > this.churn[i]) this.churn[i] = ch
      if (ch > this.churnVis[i]) this.churnVis[i] = ch
    })
  }

  private flattenPad(x: number, z: number, radius: number): void {
    const h0 = this.heightAt(x, z)
    this.forEachCellInDisc(x, z, radius + 1, (_c, _r, wx, wz, i) => {
      const d = Math.hypot(wx - x, wz - z)
      if (d > radius + 1) return
      const k = d < radius ? 1 : 1 - (d - radius)
      this.heights[i] = this.heights[i] * (1 - k) + h0 * k
    })
  }
}
