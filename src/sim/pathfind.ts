/**
 * MUD & STEEL — flow-field pathfinder.
 *
 * A FlowField owns a cols x rows grid of terrain costs and, on compute(),
 * runs a multi-source Dijkstra flood-fill from a set of world-space target
 * points to produce:
 *   - `dist`      integrated cost-to-nearest-target per cell (internal)
 *   - `bestDirX/Z` per-cell best-descent direction toward that target (internal)
 * dirAt()/distAt() then bilinearly sample those precomputed fields so that
 * up to ~150 concurrent enemies can query a smooth steering direction every
 * sim tick for effectively zero cost, while compute() itself (which reruns
 * every few seconds as shellfire reshapes the ground) stays O(n log n) using
 * only typed-array storage — no allocation after construction.
 *
 * Coordinate convention: cell (col, row) COVERS world space
 *   [originX + col*cellSize, originX + (col+1)*cellSize) x
 *   [originZ + row*cellSize, originZ + (row+1)*cellSize)
 * and is SAMPLED at its center: (originX + (col+0.5)*cellSize, originZ + (row+0.5)*cellSize).
 * Bilinear queries (dirAt/distAt) interpolate between the four nearest cell
 * centers, clamping at the grid edge so off-grid or edge-hugging queries
 * degrade gracefully instead of returning garbage.
 *
 * Edge cost model: moving from cell u to a neighbor v costs
 *   (diagonal ? SQRT2 : 1) * (cost[u] + cost[v]) / 2
 * i.e. the step cost is the step length times the average of the two cells'
 * terrain costs. This is symmetric (order-independent) and naturally makes
 * a cell with cost = Infinity impassable from either side without any
 * special-casing: any edge touching it costs Infinity and is simply never
 * relaxed.
 */

export interface FlowFieldOpts {
  cols: number
  rows: number
  originX: number
  originZ: number
  cellSize: number
}

const SQRT2 = Math.SQRT2
const INV_SQRT2 = 1 / Math.SQRT2

export class FlowField {
  readonly cols: number
  readonly rows: number
  /**
   * cols*rows row-major (index = row*cols+col, col<->x, row<->z).
   * Write terrain costs here directly: 1 = open ground, higher = slower/
   * dangerous, Number.POSITIVE_INFINITY = impassable.
   */
  readonly cost: Float32Array

  private readonly originX: number
  private readonly originZ: number
  private readonly cellSize: number

  /** Integrated cost-to-nearest-target per cell. Infinity = unreached. */
  private readonly dist: Float32Array
  private readonly visited: Uint8Array
  /** Per-cell normalized best-descent direction (0,0) if none/unreached. */
  private readonly bestDirX: Float32Array
  private readonly bestDirZ: Float32Array

  // Binary min-heap over (cellIndex, priority), stored as parallel typed
  // arrays. Stale entries (a cell relaxed more than once) are left in place
  // and skipped lazily on pop rather than removed, which keeps push O(log n)
  // with no decrease-key bookkeeping. Capacity is sized once at construction
  // to the analytic worst case (see compute()) so no resize is ever needed.
  private readonly heapIdx: Int32Array
  private readonly heapPri: Float32Array
  private heapSize: number
  private poppedIdx: number
  private poppedPri: number

  // Scratch fields for the shared bilinear-lattice computation used by both
  // dirAt() and distAt(), reused across calls to avoid allocation.
  private lc0 = 0
  private lc1 = 0
  private lr0 = 0
  private lr1 = 0
  private ltx = 0
  private ltz = 0

  constructor(opts: FlowFieldOpts) {
    const cols = Math.max(1, Math.floor(opts.cols))
    const rows = Math.max(1, Math.floor(opts.rows))
    this.cols = cols
    this.rows = rows
    this.originX = opts.originX
    this.originZ = opts.originZ
    this.cellSize = opts.cellSize > 0 && Number.isFinite(opts.cellSize) ? opts.cellSize : 1

    const n = cols * rows
    this.cost = new Float32Array(n).fill(1)
    this.dist = new Float32Array(n).fill(Infinity)
    this.visited = new Uint8Array(n)
    this.bestDirX = new Float32Array(n)
    this.bestDirZ = new Float32Array(n)

    // Worst-case heap pushes: <= n seed pushes (one per distinct target
    // cell) + <= 8n relax pushes (each finalized node examines <= 8
    // neighbor edges, each causing at most one push). 9n with headroom.
    const heapCap = Math.max(64, n * 9 + 64)
    this.heapIdx = new Int32Array(heapCap)
    this.heapPri = new Float32Array(heapCap)
    this.heapSize = 0
    this.poppedIdx = 0
    this.poppedPri = 0
  }

  /**
   * Multi-source Dijkstra flowing TOWARD the given world-space targets.
   * 8-connected, diagonal step = SQRT2 * avg cell cost, cardinal = 1 * avg
   * cell cost. Targets outside the grid are clamped to the nearest valid
   * cell. Zero heap-allocation: all storage is pre-sized in the constructor.
   */
  compute(targets: ReadonlyArray<{ x: number; z: number }>): void {
    const cols = this.cols
    const rows = this.rows
    const cost = this.cost
    const dist = this.dist
    const visited = this.visited

    dist.fill(Infinity)
    visited.fill(0)
    this.heapSize = 0

    for (let t = 0; t < targets.length; t++) {
      const target = targets[t]
      const cell = this.clampedCellIndex(target.x, target.z)
      if (dist[cell] > 0) {
        dist[cell] = 0
        this.heapPush(cell, 0)
      }
    }

    // The neighbor pass below is manually unrolled into three row-bands
    // (north/same/south) and fully inlined (no per-neighbor function call —
    // measured to matter: extracting a relax() helper cost ~30% throughput
    // in this loop, which runs up to ~8n times per compute()). Each band's
    // row-base index is computed once instead of once per neighbor, and the
    // diagonal-vs-cardinal step multiplier is a literal, not a table read.
    while (this.heapSize > 0) {
      this.heapPop()
      const u = this.poppedIdx
      const du = this.poppedPri
      if (du > dist[u] || visited[u]) continue // stale heap entry
      visited[u] = 1

      const ucost = cost[u]
      // An impassable cell can only be finalized here if it was itself a
      // seeded (dist=0) target with cost=Infinity; no edge leaving it can
      // ever improve a neighbor (avg cost would be Infinity either way), so
      // skip straight to the next heap entry instead of re-deriving that
      // per neighbor below.
      if (!(ucost < Infinity)) continue
      const urow = (u / cols) | 0
      const ucol = u - urow * cols

      if (urow > 0) {
        const rowBase = (urow - 1) * cols
        if (ucol > 0) {
          const v = rowBase + ucol - 1
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + SQRT2 * (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
        {
          const v = rowBase + ucol
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
        if (ucol < cols - 1) {
          const v = rowBase + ucol + 1
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + SQRT2 * (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
      }
      {
        const rowBase = urow * cols
        if (ucol > 0) {
          const v = rowBase + ucol - 1
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
        if (ucol < cols - 1) {
          const v = rowBase + ucol + 1
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
      }
      if (urow < rows - 1) {
        const rowBase = (urow + 1) * cols
        if (ucol > 0) {
          const v = rowBase + ucol - 1
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + SQRT2 * (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
        {
          const v = rowBase + ucol
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
        if (ucol < cols - 1) {
          const v = rowBase + ucol + 1
          if (!visited[v]) {
            const vcost = cost[v]
            if (vcost < Infinity) {
              const nd = du + SQRT2 * (ucost + vcost) * 0.5
              if (nd < dist[v]) {
                dist[v] = nd
                this.heapPush(v, nd)
              }
            }
          }
        }
      }
    }

    this.computeBestDirections()
  }

  /**
   * Normalized descent direction at world pos, bilinearly smoothed across
   * the 4 surrounding cells' best-neighbor directions. Returns {x:0,z:0} if
   * unreachable/blocked. Writes into and returns the caller-provided out
   * object to avoid allocation.
   */
  dirAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    this.computeLattice(x, z)
    const cols = this.cols
    const i00 = this.lr0 * cols + this.lc0
    const i10 = this.lr0 * cols + this.lc1
    const i01 = this.lr1 * cols + this.lc0
    const i11 = this.lr1 * cols + this.lc1
    const tx = this.ltx
    const tz = this.ltz
    const w00 = (1 - tx) * (1 - tz)
    const w10 = tx * (1 - tz)
    const w01 = (1 - tx) * tz
    const w11 = tx * tz

    const bx = this.bestDirX
    const bz = this.bestDirZ
    const dx = w00 * bx[i00] + w10 * bx[i10] + w01 * bx[i01] + w11 * bx[i11]
    const dz = w00 * bz[i00] + w10 * bz[i10] + w01 * bz[i01] + w11 * bz[i11]

    const lenSq = dx * dx + dz * dz
    if (lenSq < 1e-12) {
      out.x = 0
      out.z = 0
      return out
    }
    const invLen = 1 / Math.sqrt(lenSq)
    out.x = dx * invLen
    out.z = dz * invLen
    return out
  }

  /** Integrated distance-to-target at world pos (bilinear), Infinity if unreached. */
  distAt(x: number, z: number): number {
    this.computeLattice(x, z)
    const cols = this.cols
    const i00 = this.lr0 * cols + this.lc0
    const i10 = this.lr0 * cols + this.lc1
    const i01 = this.lr1 * cols + this.lc0
    const i11 = this.lr1 * cols + this.lc1
    const tx = this.ltx
    const tz = this.ltz
    const w00 = (1 - tx) * (1 - tz)
    const w10 = tx * (1 - tz)
    const w01 = (1 - tx) * tz
    const w11 = tx * tz

    const d = this.dist
    // Guard 0 * Infinity -> NaN by skipping zero-weight corners entirely.
    let sum = 0
    sum += w00 > 0 ? w00 * d[i00] : 0
    sum += w10 > 0 ? w10 * d[i10] : 0
    sum += w01 > 0 ? w01 * d[i01] : 0
    sum += w11 > 0 ? w11 * d[i11] : 0
    return sum
  }

  /** -1 if out of bounds. */
  cellIndex(x: number, z: number): number {
    const col = Math.floor((x - this.originX) / this.cellSize)
    const row = Math.floor((z - this.originZ) / this.cellSize)
    if (!Number.isFinite(col) || !Number.isFinite(row)) return -1
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return -1
    return row * this.cols + col
  }

  // ---------------------------------------------------------------------
  // internal
  // ---------------------------------------------------------------------

  /** Like cellIndex but clamps into range instead of returning -1; used to seed targets. */
  private clampedCellIndex(x: number, z: number): number {
    let col = Math.floor((x - this.originX) / this.cellSize)
    let row = Math.floor((z - this.originZ) / this.cellSize)
    if (!Number.isFinite(col)) col = 0
    if (!Number.isFinite(row)) row = 0
    const maxCol = this.cols - 1
    const maxRow = this.rows - 1
    if (col < 0) col = 0
    else if (col > maxCol) col = maxCol
    if (row < 0) row = 0
    else if (row > maxRow) row = maxRow
    return row * this.cols + col
  }

  /** Computes clamped bilinear corner indices + fractional weights for (x,z) into scratch fields. */
  private computeLattice(x: number, z: number): void {
    const maxCol = this.cols - 1
    const maxRow = this.rows - 1
    let fcol = (x - this.originX) / this.cellSize - 0.5
    let frow = (z - this.originZ) / this.cellSize - 0.5
    if (!(fcol >= 0)) fcol = 0 // also catches NaN
    else if (fcol > maxCol) fcol = maxCol
    if (!(frow >= 0)) frow = 0
    else if (frow > maxRow) frow = maxRow

    let c0 = Math.floor(fcol)
    if (c0 < 0) c0 = 0
    else if (c0 > maxCol) c0 = maxCol
    let c1 = c0 + 1
    if (c1 > maxCol) c1 = maxCol
    const tx = c1 > c0 ? fcol - c0 : 0

    let r0 = Math.floor(frow)
    if (r0 < 0) r0 = 0
    else if (r0 > maxRow) r0 = maxRow
    let r1 = r0 + 1
    if (r1 > maxRow) r1 = maxRow
    const tz = r1 > r0 ? frow - r0 : 0

    this.lc0 = c0
    this.lc1 = c1
    this.lr0 = r0
    this.lr1 = r1
    this.ltx = tx
    this.ltz = tz
  }

  /** After Dijkstra: for each cell, direction toward its lowest-dist 8-neighbor. */
  private computeBestDirections(): void {
    const cols = this.cols
    const rows = this.rows
    const dist = this.dist
    const bestDirX = this.bestDirX
    const bestDirZ = this.bestDirZ

    for (let row = 0; row < rows; row++) {
      const rowBase = row * cols
      for (let col = 0; col < cols; col++) {
        const i = rowBase + col
        bestDirX[i] = 0
        bestDirZ[i] = 0
        const di = dist[i]
        if (!(di < Infinity)) continue // unreached or self impassable

        let bestD = di
        let bestDx = 0
        let bestDz = 0

        // Row-band unroll (matches compute()'s hot loop): avoids the
        // dx===0&&dz===0 self-skip branch and recomputes each row's base
        // index once instead of once per neighbor.
        if (row > 0) {
          const northBase = (row - 1) * cols
          if (col > 0) {
            const dv = dist[northBase + col - 1]
            if (dv < bestD) { bestD = dv; bestDx = -1; bestDz = -1 }
          }
          {
            const dv = dist[northBase + col]
            if (dv < bestD) { bestD = dv; bestDx = 0; bestDz = -1 }
          }
          if (col < cols - 1) {
            const dv = dist[northBase + col + 1]
            if (dv < bestD) { bestD = dv; bestDx = 1; bestDz = -1 }
          }
        }
        if (col > 0) {
          const dv = dist[rowBase + col - 1]
          if (dv < bestD) { bestD = dv; bestDx = -1; bestDz = 0 }
        }
        if (col < cols - 1) {
          const dv = dist[rowBase + col + 1]
          if (dv < bestD) { bestD = dv; bestDx = 1; bestDz = 0 }
        }
        if (row < rows - 1) {
          const southBase = (row + 1) * cols
          if (col > 0) {
            const dv = dist[southBase + col - 1]
            if (dv < bestD) { bestD = dv; bestDx = -1; bestDz = 1 }
          }
          {
            const dv = dist[southBase + col]
            if (dv < bestD) { bestD = dv; bestDx = 0; bestDz = 1 }
          }
          if (col < cols - 1) {
            const dv = dist[southBase + col + 1]
            if (dv < bestD) { bestD = dv; bestDx = 1; bestDz = 1 }
          }
        }

        if (bestDx !== 0 || bestDz !== 0) {
          const invLen = bestDx !== 0 && bestDz !== 0 ? INV_SQRT2 : 1
          bestDirX[i] = bestDx * invLen
          bestDirZ[i] = bestDz * invLen
        }
        // else: local minimum (e.g. the target cell itself) -> (0,0), agent has arrived.
      }
    }
  }

  private heapPush(cell: number, pri: number): void {
    // Capacity is analytically sufficient (see constructor); this guard is
    // purely defensive and should never trigger.
    if (this.heapSize >= this.heapIdx.length) return
    const heapIdx = this.heapIdx
    const heapPri = this.heapPri
    let i = this.heapSize++
    heapIdx[i] = cell
    heapPri[i] = pri
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heapPri[parent] <= heapPri[i]) break
      const ti = heapIdx[parent]
      heapIdx[parent] = heapIdx[i]
      heapIdx[i] = ti
      const tp = heapPri[parent]
      heapPri[parent] = heapPri[i]
      heapPri[i] = tp
      i = parent
    }
  }

  /** Pops the min entry into this.poppedIdx/poppedPri. Assumes heapSize > 0. */
  private heapPop(): void {
    const heapIdx = this.heapIdx
    const heapPri = this.heapPri
    this.poppedIdx = heapIdx[0]
    this.poppedPri = heapPri[0]
    this.heapSize--
    const size = this.heapSize
    if (size > 0) {
      heapIdx[0] = heapIdx[size]
      heapPri[0] = heapPri[size]
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = i * 2 + 2
        let smallest = i
        if (l < size && heapPri[l] < heapPri[smallest]) smallest = l
        if (r < size && heapPri[r] < heapPri[smallest]) smallest = r
        if (smallest === i) break
        const ti = heapIdx[smallest]
        heapIdx[smallest] = heapIdx[i]
        heapIdx[i] = ti
        const tp = heapPri[smallest]
        heapPri[smallest] = heapPri[i]
        heapPri[i] = tp
        i = smallest
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Exercises straight-line flow on a uniform grid, flow around an Infinity
 * wall, bilinear direction smoothness, distAt monotonicity toward target,
 * and the all-blocked / out-of-bounds-target / multi-target edge cases.
 * Returns a list of failed-assertion descriptions; empty = all passed.
 */
export function _selfTest(): string[] {
  const fails: string[] = []
  const check = (cond: boolean, msg: string): void => {
    if (!cond) fails.push(msg)
  }
  const run = (name: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      fails.push(`${name} threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  run('straight-line flow on uniform grid', () => {
    const ff = new FlowField({ cols: 12, rows: 12, originX: 0, originZ: 0, cellSize: 1 })
    ff.compute([{ x: 6, z: 6 }])
    const out = { x: 0, z: 0 }

    // Sample exactly on the target's row/col center (tz=0 / tx=0 respectively)
    // so the bilinear blend isn't split across a row/col that's nearer a
    // different part of the target cell — isolates pure east/south flow.
    ff.dirAt(1.5, 6.5, out)
    check(
      out.x > 0.9 && Math.abs(out.z) < 0.3,
      `west-of-target should flow east, got (${out.x.toFixed(3)}, ${out.z.toFixed(3)})`
    )

    ff.dirAt(6.5, 1.5, out)
    check(
      out.z > 0.9 && Math.abs(out.x) < 0.3,
      `north-of-target should flow south, got (${out.x.toFixed(3)}, ${out.z.toFixed(3)})`
    )

    ff.dirAt(1.5, 1.5, out)
    check(
      out.x > 0.5 && out.z > 0.5,
      `NW-of-target should flow SE, got (${out.x.toFixed(3)}, ${out.z.toFixed(3)})`
    )
  })

  run('flow around an Infinity wall', () => {
    const ff = new FlowField({ cols: 12, rows: 12, originX: 0, originZ: 0, cellSize: 1 })
    // Vertical wall at col 5, blocking rows 0..10; row 11 is the only gap.
    for (let row = 0; row <= 10; row++) ff.cost[row * ff.cols + 5] = Infinity
    ff.compute([{ x: 10.5, z: 1.5 }]) // target: col10,row1, east side

    const straightLineDist = 9 // |10.5 - 1.5|
    const d = ff.distAt(1.5, 1.5) // start: col1,row1, west side, same row as target
    check(Number.isFinite(d), `start point should remain reachable via the gap, got dist=${d}`)
    check(
      d > straightLineDist * 1.3,
      `distAt should reflect a detour around the wall (>${(straightLineDist * 1.3).toFixed(1)}), got ${d.toFixed(2)}`
    )

    const out = { x: 0, z: 0 }
    ff.dirAt(1.5, 1.5, out)
    check(
      out.z > 0.3,
      `dir at start should bend south toward the gap (z>0.3), got (${out.x.toFixed(3)}, ${out.z.toFixed(3)})`
    )
    check(
      !(out.x > 0.9 && Math.abs(out.z) < 0.3),
      `dir at start should NOT point straight through the wall, got (${out.x.toFixed(3)}, ${out.z.toFixed(3)})`
    )
  })

  run('bilinear dir smoothness across a cell boundary', () => {
    const ff = new FlowField({ cols: 12, rows: 12, originX: 0, originZ: 0, cellSize: 1 })
    ff.compute([{ x: 6, z: 6 }])
    const a = { x: 0, z: 0 }
    const b = { x: 0, z: 0 }
    // fcol = x - 0.5 crosses the integer boundary (col index changes) at x=4.5.
    ff.dirAt(4.48, 6, a)
    ff.dirAt(4.52, 6, b)
    const jump = Math.hypot(a.x - b.x, a.z - b.z)
    check(
      jump < 0.15,
      `dir should change smoothly across a cell boundary, got jump=${jump.toFixed(4)} (a=(${a.x.toFixed(3)},${a.z.toFixed(3)}) b=(${b.x.toFixed(3)},${b.z.toFixed(3)}))`
    )
  })

  run('distAt monotonicity toward target', () => {
    const ff = new FlowField({ cols: 12, rows: 12, originX: 0, originZ: 0, cellSize: 1 })
    ff.compute([{ x: 6, z: 6 }])
    let prev = Infinity
    let monotonic = true
    let detail = ''
    for (let x = 0.5; x <= 6.0; x += 0.5) {
      const d = ff.distAt(x, 6)
      if (d > prev + 1e-3) {
        monotonic = false
        detail = `dist increased from ${prev.toFixed(3)} to ${d.toFixed(3)} at x=${x}`
        break
      }
      prev = d
    }
    check(monotonic, `distAt should be non-increasing while approaching target: ${detail}`)
  })

  run('all-blocked grid', () => {
    const ff = new FlowField({ cols: 8, rows: 8, originX: 0, originZ: 0, cellSize: 1 })
    ff.cost.fill(Infinity)
    ff.compute([{ x: 4, z: 4 }])
    const out = { x: 1, z: 1 }
    ff.dirAt(1.5, 1.5, out)
    check(out.x === 0 && out.z === 0, `dir on all-blocked grid should be (0,0), got (${out.x}, ${out.z})`)
    const d = ff.distAt(1.5, 1.5)
    check(d === Infinity, `dist on all-blocked grid should be Infinity, got ${d}`)
  })

  run('target outside bounds clamps instead of throwing', () => {
    const ff = new FlowField({ cols: 10, rows: 10, originX: 0, originZ: 0, cellSize: 1 })
    ff.compute([{ x: 1000, z: -1000 }]) // far outside; should clamp to a grid corner
    const out = { x: 0, z: 0 }
    ff.dirAt(5, 5, out)
    const len = Math.hypot(out.x, out.z)
    check(
      len === 0 || Math.abs(len - 1) < 1e-4,
      `dir should be zero or unit length after clamped out-of-bounds target, got len=${len}`
    )
    const d = ff.distAt(5, 5)
    check(Number.isFinite(d), `dist should be finite after clamped out-of-bounds target, got ${d}`)
  })

  run('multiple targets each attract their own basin', () => {
    const ff = new FlowField({ cols: 20, rows: 6, originX: 0, originZ: 0, cellSize: 1 })
    ff.compute([
      { x: 1, z: 3 },
      { x: 18, z: 3 },
    ])
    const dNearA = ff.distAt(1.5, 3)
    const dNearB = ff.distAt(18.5, 3)
    check(dNearA < 2, `point near target A should have small dist, got ${dNearA.toFixed(2)}`)
    check(dNearB < 2, `point near target B should have small dist, got ${dNearB.toFixed(2)}`)

    const out = { x: 0, z: 0 }
    ff.dirAt(3, 3, out)
    check(out.x < 0, `point west of target A should flow further west (toward A), got dx=${out.x.toFixed(3)}`)
    ff.dirAt(16, 3, out)
    check(out.x > 0, `point east of target B should flow further east (toward B), got dx=${out.x.toFixed(3)}`)
  })

  return fails
}
