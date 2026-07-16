/**
 * Vehicles & beasts — tanks, the armoured car, aircraft, cavalry horses.
 *
 * Every builder returns a THREE.Group of FRESH geometry (never module-cached —
 * scenery.ts disposeGroup frees it per entity) over the shared module material
 * set. Named meshes are engine API and MUST keep their names / rough pivots:
 *   'barrel' (recoil/aim), 'turret', 'prop' (spins), 'wheel0'..'wheel3' (spin),
 *   horse 'legFL'/'legFR'/'legBL'/'legBR' (leg-root groups pivoting at the hip,
 *   rotated ±x by the gallop code) and 'head' (nods).
 *
 * Detailing strategy (see brief): silhouette first (extruded profiles, angled
 * plates, tapers), then FREE baked per-vertex colour (ground-darken + mud + rust
 * + tonal breakup via `assemble`), then greebles (rivet rows, bolts, tools) that
 * merge into one vertex-coloured mesh so they cost nothing at draw time.
 *
 * Sim/world convention: x west→east, z north→south, y up. Built groups face -Z.
 */

import * as THREE from 'three'
import { PALETTE, bakeAndMerge, fm, localRand, mat, wrapVC, xf, type ColoredPart } from './shared'

// ---------------------------------------------------------------------------
// Local detailing helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Cheap deterministic hash of a position → [0,1). Feeds per-vertex weathering. */
function vhash(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}

/** Build one coloured part: fresh geometry with scale→rotate→translate applied. */
function part(
  geo: THREE.BufferGeometry,
  hex: number,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): ColoredPart {
  return { geo: xf(geo, x, y, z, rx, ry, rz, sx, sy, sz), hex }
}

/** A row of tiny merged rivets from a→b (world coords). */
function rivetRow(
  out: ColoredPart[],
  a: [number, number, number],
  b: [number, number, number],
  n: number,
  r: number,
  hex: number,
): void {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1)
    out.push(part(
      new THREE.SphereGeometry(r, 4, 3),
      hex,
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      0, 0, 0, 1, 0.55, 1,
    ))
  }
}

/** A clump of caked-mud blobs around a point — reads clearly near tracks/hooves. */
function mudClumps(
  out: ColoredPart[],
  cx: number, cy: number, cz: number,
  sx: number, sy: number, sz: number,
  count: number, seed: number,
): void {
  const rnd = localRand(seed)
  for (let i = 0; i < count; i++) {
    const r = 0.08 + rnd() * 0.15
    out.push(part(
      new THREE.SphereGeometry(r, 5, 4),
      0x38301f,
      cx + (rnd() * 2 - 1) * sx,
      cy + rnd() * sy,
      cz + (rnd() * 2 - 1) * sz,
      0, 0, 0, 1, 0.55, 1,
    ))
  }
}

interface WeatherOpts {
  darken?: number   // ground-darken strength for bakeAndMerge
  mudTop?: number   // below this world-y, tint toward mud
  mudBot?: number
  rust?: number     // 0..~0.5 flecks of rust on upper metal
  tone?: number     // tonal breakup amplitude (default 0.12)
}

/** Per-vertex weathering pass over an already vertex-coloured (baked) geometry. */
function weather(geo: THREE.BufferGeometry, opts: WeatherOpts): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const color = geo.getAttribute('color') as THREE.BufferAttribute | undefined
  if (!color) return geo
  const mud = new THREE.Color(PALETTE.mud)
  const rust = new THREE.Color(PALETTE.rust)
  const mudTop = opts.mudTop ?? -1e9
  const mudBot = opts.mudBot ?? mudTop - 1
  const rustAmt = opts.rust ?? 0
  const toneAmt = opts.tone ?? 0.12
  const span = Math.max(1e-3, mudTop - mudBot)
  const n = pos.count
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    let r = color.getX(i), g = color.getY(i), b = color.getZ(i)
    // tonal breakup so big plates never read flat
    const tone = 1 - toneAmt * 0.5 + toneAmt * vhash(x, y, z)
    r *= tone; g *= tone; b *= tone
    // caked mud rising off the ground, speckled at its upper edge
    if (y < mudTop) {
      const f = clamp01((mudTop - y) / span)
      const speck = vhash(x * 7.3 + 1.1, y * 3.7, z * 7.3 - 2.2)
      const m = f * (0.25 + 0.6 * speck * speck)
      r += (mud.r - r) * m; g += (mud.g - g) * m; b += (mud.b - b) * m
    }
    // occasional rust fleck on exposed metal
    if (rustAmt > 0) {
      const rf = vhash(x * 5.1 - 3.3, y * 5.1, z * 5.1 + 2.7)
      if (rf > 0.8) {
        const m = rustAmt * (rf - 0.8) / 0.2
        r += (rust.r - r) * m; g += (rust.g - g) * m; b += (rust.b - b) * m
      }
    }
    color.setXYZ(i, clamp01(r), clamp01(g), clamp01(b))
  }
  color.needsUpdate = true
  return geo
}

/** Bake per-part colour, merge, weather, and recompute normals → one VC mesh.
 *  mergeGeometries requires a consistent index state across inputs; ExtrudeGeometry
 *  is non-indexed while the primitives are indexed, so drop indices uniformly. */
function assemble(parts: ColoredPart[], opts: WeatherOpts = {}): THREE.Mesh {
  const norm = parts.map((p): ColoredPart => ({
    geo: p.geo.getIndex() ? p.geo.toNonIndexed() : p.geo,
    hex: p.hex,
  }))
  const geo = bakeAndMerge(norm, opts.darken ?? 0.34)
  weather(geo, opts)
  geo.computeVertexNormals()
  return wrapVC(geo)
}

/**
 * Extrude a closed 2-D profile (points are [alongLength, height]) into a slab of
 * `depth` running along world Z, centred on X. Front of the group is -Z, so give
 * front features a negative first coordinate. Used for the A7V boat hull and the
 * Mk IV rhomboid track frames and the aircraft wings/airfoils.
 */
function extrudePts(profile: Array<[number, number]>, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  shape.moveTo(profile[0][0], profile[0][1])
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1])
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 })
  geo.translate(0, 0, -depth / 2)
  geo.rotateY(-Math.PI / 2)
  return geo
}

// ===========================================================================
// A7V — 7.34 m faceted armoured box: angled prow/stern, hull overhanging the
// tracks, front 57 mm gun, MG embrasures, raised cupola, roof exhausts, rivets.
// ===========================================================================

export function buildTankA7V(): THREE.Group {
  const g = new THREE.Group()
  const p: ColoredPart[] = []
  const body = PALETTE.feldgrau
  const dark = PALETTE.steelDark
  const rivet = 0x2b2f33
  const track = 0x2a2d30

  // --- superstructure: extruded boat-hull side profile (pointed prow & stern),
  //     overhanging the tracks front, rear and sides.
  const hullProfile: Array<[number, number]> = [
    [-3.62, 1.42],  // prow tip (juts forward at mid height)
    [-2.55, 2.52],  // front top
    [2.55, 2.52],   // rear top
    [3.62, 1.42],   // stern tip
    [2.55, 0.55],   // rear bottom
    [-2.55, 0.55],  // front bottom
  ]
  p.push({ geo: extrudePts(hullProfile, 3.06), hex: body })

  // inset flat roof plate + a thin coaming lip
  p.push(part(new THREE.BoxGeometry(2.7, 0.14, 5.0), body, 0, 2.52, 0))
  p.push(part(new THREE.BoxGeometry(2.86, 0.08, 5.2, 3, 1, 4), dark, 0, 2.42, 0))

  // belly plate between the tracks (nearly ground-scraping, as the real A7V)
  p.push(part(new THREE.BoxGeometry(1.9, 0.7, 5.8), dark, 0, 0.4, 0))

  // --- track runs each side + road-wheel bumps peeking below the skirt
  for (const side of [-1, 1]) {
    const tx = side * 1.16
    p.push(part(new THREE.BoxGeometry(0.62, 0.92, 5.9), track, tx, 0.46, 0))
    // ribbed track links along the visible lower run (front & bottom)
    for (let i = 0; i < 22; i++) {
      const z = -2.85 + (i / 21) * 5.7
      p.push(part(new THREE.BoxGeometry(0.66, 0.14, 0.16), 0x35393c, tx, 0.06, z))
    }
    // road wheels
    for (let i = 0; i < 6; i++) {
      const z = -2.4 + i * 0.96
      const w = new THREE.CylinderGeometry(0.26, 0.26, 0.5, 8)
      p.push(part(w, 0x24272a, tx, 0.28, z, 0, 0, Math.PI / 2))
    }
    // return-roller / suspension bolt hints
    rivetRow(p, [tx, 0.86, -2.6], [tx, 0.86, 2.6], 9, 0.05, rivet)
  }

  // --- front 57 mm gun in a boxed mantlet (mantlet merged, barrel named)
  p.push(part(new THREE.BoxGeometry(0.9, 0.86, 0.5), dark, 0, 1.5, -2.72))
  p.push(part(new THREE.BoxGeometry(0.66, 0.6, 0.3), 0x30343a, 0, 1.5, -2.98))
  const barrelGeo = new THREE.CylinderGeometry(0.1, 0.13, 1.75, 10)
  barrelGeo.rotateX(Math.PI / 2)
  const barrel = fm(barrelGeo, mat.steel)
  barrel.position.set(0, 1.5, -3.55)
  barrel.name = 'barrel'
  g.add(barrel)

  // --- MG embrasures: 2 per side + 2 in the stern, each a boxed port + stub
  const mgPorts: Array<[number, number, number, number]> = [
    [-1.55, 1.62, -0.6, -Math.PI / 2], [-1.55, 1.62, 1.4, -Math.PI / 2],
    [1.55, 1.62, -0.6, Math.PI / 2], [1.55, 1.62, 1.4, Math.PI / 2],
    [-0.7, 1.62, 3.1, 0], [0.7, 1.62, 3.1, 0],
  ]
  for (const [mx, my, mz, ry] of mgPorts) {
    p.push(part(new THREE.BoxGeometry(0.42, 0.42, 0.34), 0x2d3136, mx, my, mz, 0, ry, 0))
    const stub = new THREE.CylinderGeometry(0.05, 0.06, 0.5, 6)
    stub.rotateX(Math.PI / 2)
    // point the stub outward along the port's facing (side ports ±x, stern +z)
    if (ry === 0) p.push(part(stub, 0x1f2226, mx, my, mz + 0.34))
    else p.push(part(stub, 0x1f2226, mx + Math.sin(ry) * 0.34, my, mz, 0, ry, 0))
  }

  // --- raised commander cupola with vision slits + two roof hatches
  p.push(part(new THREE.BoxGeometry(1.05, 0.42, 1.35), body, 0, 2.74, -0.15))
  p.push(part(new THREE.CylinderGeometry(0.42, 0.46, 0.3, 10), dark, 0, 3.0, -0.15))
  p.push(part(new THREE.CylinderGeometry(0.44, 0.44, 0.06, 10), 0x2c3035, 0, 3.16, -0.15))
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    p.push(part(new THREE.BoxGeometry(0.14, 0.06, 0.04), 0x141618,
      Math.sin(a) * 0.4, 2.98, -0.15 + Math.cos(a) * 0.4, 0, -a, 0))
  }
  for (const hz of [-1.9, 1.7]) {
    p.push(part(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 10), dark, 0, 2.6, hz))
    p.push(part(new THREE.TorusGeometry(0.18, 0.03, 4, 8), 0x1d2023, 0, 2.66, hz, Math.PI / 2, 0, 0))
  }

  // --- roof exhaust piping + boxed silencer along the rear
  for (const ex of [-0.7, 0.7]) {
    const pipe = new THREE.CylinderGeometry(0.08, 0.08, 3.0, 6)
    pipe.rotateX(Math.PI / 2)
    // Oxidised dark brown, not raw PALETTE.rust — 3 m of saturated orange pipe
    // dominated the whole roof read.
    p.push(part(pipe, 0x53381f, ex, 2.66, 0.6))
  }
  p.push(part(new THREE.BoxGeometry(1.5, 0.24, 0.6), 0x3a2f22, 0, 2.7, 2.0))

  // --- rivet seams along every major plate edge
  for (const side of [-1, 1]) {
    rivetRow(p, [side * 1.53, 2.45, -2.4], [side * 1.53, 2.45, 2.4], 16, 0.055, rivet) // roof edge
    rivetRow(p, [side * 1.55, 0.7, -2.4], [side * 1.55, 0.7, 2.4], 14, 0.055, rivet)   // sill
    rivetRow(p, [side * 1.53, 1.5, -2.5], [side * 0.9, 2.45, -3.0], 6, 0.055, rivet)   // prow
    rivetRow(p, [side * 1.53, 1.5, 2.5], [side * 0.9, 2.45, 3.0], 6, 0.055, rivet)     // stern
  }
  rivetRow(p, [-1.3, 2.55, -2.45], [1.3, 2.55, -2.45], 9, 0.055, rivet)
  rivetRow(p, [-1.3, 2.55, 2.45], [1.3, 2.55, 2.45], 9, 0.055, rivet)

  // --- caked mud along the lower third, heaviest at the tracks
  mudClumps(p, 0, 0.1, 0, 1.4, 0.5, 2.7, 22, 0xa7)

  g.add(assemble(p, { mudTop: 1.15, mudBot: 0, rust: 0.18, tone: 0.14, darken: 0.36 }))
  return g
}

// ===========================================================================
// Mk IV — true rhomboid: extruded lozenge track frames with a link ridge strip
// around the perimeter, hull slab between, side sponsons with a 6-pdr each, a
// front cab, unditching beam on roof rails, exhaust silencer, rivets, mud.
// ===========================================================================

export function buildTankMkIV(): THREE.Group {
  const g = new THREE.Group()
  const p: ColoredPart[] = []
  const body = PALETTE.khaki
  const frameHex = 0x2c2f31
  const linkHex = 0x3a3e40
  const rivet = 0x232628

  // Rhomboid track outline (side view, front = -z): tall front horn, tapering
  // rear, flat belly near the ground.
  const loz: Array<[number, number]> = [
    [-4.15, 1.15],  // front horn
    [-3.5, 2.28],   // upper front
    [-1.2, 2.55],   // top (highest)
    [2.2, 2.12],    // top rear
    [3.85, 1.2],    // rear point
    [2.9, 0.12],    // lower rear (track run sits on the ground)
    [-2.9, 0.12],   // belly
    [-3.75, 0.5],   // lower front (track curves up over the horn)
  ]
  // centroid, for pushing link blocks outward onto the rim
  let cz = 0, cy = 0
  for (const [z, y] of loz) { cz += z; cy += y }
  cz /= loz.length; cy /= loz.length
  const frameDepth = 0.5

  for (const side of [-1, 1]) {
    const sx = side * 1.36
    const sideGeo = extrudePts(loz, frameDepth)
    p.push({ geo: xf(sideGeo, sx - side * frameDepth / 2, 0, 0), hex: frameHex })

    // track-link ridge strip: small angled blocks stepped around the perimeter,
    // nudged outward along the outward normal so they sit on the running rim.
    for (let e = 0; e < loz.length; e++) {
      const a = loz[e]
      const b = loz[(e + 1) % loz.length]
      const dz = b[0] - a[0], dy = b[1] - a[1]
      const len = Math.hypot(dz, dy)
      const tz = dz / len, ty = dy / len
      const rot = Math.atan2(-ty, tz)
      const steps = Math.max(1, Math.round(len / 0.34))
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps
        const pz = a[0] + dz * t, py = a[1] + dy * t
        // outward normal from centroid
        let nz = pz - cz, ny = py - cy
        const nl = Math.hypot(nz, ny) || 1
        nz /= nl; ny /= nl
        p.push(part(
          new THREE.BoxGeometry(0.58, 0.15, 0.3),
          linkHex,
          sx + nz * 0.02, py + ny * 0.04, pz + nz * 0.04,
          rot, 0, 0,
        ))
      }
    }
    // rivet seam just inboard of the rim: inset each end toward the lozenge
    // centroid in the z/y plane (not a flat y-drop, which sank the belly rows
    // below ground) so every row stays on the frame face and above y=0.
    const inset = (pt: [number, number]): [number, number] => {
      const nz = pt[0] - cz, ny = pt[1] - cy
      const nl = Math.hypot(nz, ny) || 1
      return [pt[0] - (nz / nl) * 0.2, pt[1] - (ny / nl) * 0.2]
    }
    for (let e = 0; e < loz.length; e++) {
      const ai = inset(loz[e]), bi = inset(loz[(e + 1) % loz.length])
      rivetRow(p, [sx - side * 0.18, ai[1], ai[0]],
        [sx - side * 0.18, bi[1], bi[0]], 4, 0.05, rivet)
    }
  }

  // --- hull slab between the track frames
  p.push(part(new THREE.BoxGeometry(2.2, 1.95, 6.4, 2, 2, 5), body, 0, 1.28, 0))
  // riveted top corners of the hull
  rivetRow(p, [-1.05, 2.24, -3.0], [-1.05, 2.24, 3.0], 16, 0.05, rivet)
  rivetRow(p, [1.05, 2.24, -3.0], [1.05, 2.24, 3.0], 16, 0.05, rivet)

  // --- front commander cab with vision slits
  p.push(part(new THREE.BoxGeometry(1.5, 0.66, 0.95), body, 0, 2.2, -2.75))
  p.push(part(new THREE.BoxGeometry(1.4, 0.12, 0.05), 0x111315, 0, 2.32, -3.23))
  p.push(part(new THREE.BoxGeometry(0.16, 0.12, 0.05), 0x111315, -0.45, 2.05, -3.23))
  p.push(part(new THREE.BoxGeometry(0.16, 0.12, 0.05), 0x111315, 0.45, 2.05, -3.23))

  // --- side sponsons, each a 6-pdr (barrel named) + a Lewis stub
  for (const side of [-1, 1]) {
    const sx = side * 1.78
    p.push(part(new THREE.BoxGeometry(0.72, 1.02, 1.7), 0x3b3e33, sx, 1.32, 0.25))
    p.push(part(new THREE.BoxGeometry(0.5, 0.5, 0.4), 0x2c2f26, sx + side * 0.2, 1.32, -0.55)) // mantlet
    // 6-pdr, forward & slightly outboard
    const bg = new THREE.CylinderGeometry(0.07, 0.09, 1.5, 10)
    bg.rotateX(Math.PI / 2)
    const b = fm(bg, mat.steel)
    b.position.set(sx + side * 0.35, 1.32, -1.15)
    b.rotation.y = side * 0.32
    b.name = 'barrel'
    g.add(b)
    // Lewis stub (fat cooling shroud) on the sponson top
    const lg = new THREE.CylinderGeometry(0.07, 0.07, 0.55, 8)
    lg.rotateX(Math.PI / 2)
    p.push(part(lg, 0x24262a, sx, 1.72, -0.55))
    // sponson rivets
    rivetRow(p, [sx + side * 0.36, 1.82, -0.55], [sx + side * 0.36, 1.82, 1.05], 5, 0.05, rivet)
    rivetRow(p, [sx + side * 0.36, 0.82, -0.55], [sx + side * 0.36, 0.82, 1.05], 5, 0.05, rivet)
  }

  // --- unditching beam on top rails
  for (const rx of [-0.75, 0.75]) {
    p.push(part(new THREE.BoxGeometry(0.1, 0.12, 5.2), 0x2f3234, rx, 2.34, 0))
  }
  p.push(part(new THREE.BoxGeometry(3.4, 0.32, 0.34), 0x5b4530, 0, 2.52, 0.1)) // stowed timber
  rivetRow(p, [-1.6, 2.52, 0.1], [1.6, 2.52, 0.1], 8, 0.05, 0x3a2c1c)          // beam brackets

  // --- roof exhaust silencer + pipe
  const sil = new THREE.CylinderGeometry(0.15, 0.15, 1.5, 8)
  sil.rotateZ(Math.PI / 2)
  p.push(part(sil, 0x37302a, 0, 2.5, 1.7))
  const upipe = new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6)
  p.push(part(upipe, PALETTE.rust, 0.6, 2.6, 2.1))

  // --- mud along the lower run
  mudClumps(p, 0, 0.1, 0, 1.8, 0.5, 3.2, 26, 0x1d)

  g.add(assemble(p, { mudTop: 1.0, mudBot: 0, rust: 0.14, tone: 0.13, darken: 0.34 }))
  return g
}

// ===========================================================================
// Armoured car — Rolls-Royce pattern: louvred bonnet, cylindrical turret with a
// bevelled crown, flat rear deck, full-length running boards/fenders, spare
// wheel on the hull side, headlamps, twin rear wheels, four spoked wheels.
// ===========================================================================

/** Local upgraded wheel: steel tyre + 8 spokes + hub. Group faces +Z (caller
 *  sets rotation.y = π/2), matching the shared buildSpokedWheel convention. */
function buildCarWheel(radius: number): THREE.Group {
  const w = new THREE.Group()
  const p: ColoredPart[] = []
  // tube sized so the outer radius equals `radius` → wheel seats at y = radius
  p.push({ geo: new THREE.TorusGeometry(radius * 0.85, radius * 0.15, 6, 16), hex: 0x1c1e20 })  // solid tyre
  p.push({ geo: new THREE.TorusGeometry(radius * 0.62, radius * 0.05, 4, 14), hex: 0x54585c })  // steel rim
  p.push({ geo: xf(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, radius * 0.34, 8), 0, 0, 0, Math.PI / 2), hex: 0x3c4247 })
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI
    p.push(part(new THREE.BoxGeometry(radius * 1.4, radius * 0.06, radius * 0.05), 0x5a5f63, 0, 0, 0, 0, 0, a))
  }
  w.add(assemble(p, { tone: 0.1, darken: 0.3 }))
  return w
}

export function buildArmoredCar(): THREE.Group {
  const g = new THREE.Group()
  const p: ColoredPart[] = []
  const body = PALETTE.khaki
  const dark = PALETTE.steelDark
  const rivet = 0x2c2f31

  // --- lower hull / chassis
  p.push(part(new THREE.BoxGeometry(1.66, 0.86, 3.5, 2, 1, 4), body, 0, 0.95, 0.3))

  // --- long louvred bonnet at the front, radiator, headlamps
  p.push(part(new THREE.BoxGeometry(1.28, 0.66, 1.7), body, 0, 0.98, -1.95))
  p.push(part(new THREE.BoxGeometry(1.18, 0.5, 0.16), 0x2e3236, 0, 1.02, -2.85)) // radiator
  p.push(part(new THREE.CylinderGeometry(0.6, 0.6, 0.14, 10), dark, 0, 1.28, -2.82, Math.PI / 2)) // rad top round
  // vertical louvre slats down both sides of the bonnet
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const z = -2.6 + i * 0.22
      p.push(part(new THREE.BoxGeometry(0.03, 0.5, 0.05), 0x33373b, side * 0.65, 0.98, z))
    }
  }
  for (const side of [-1, 1]) {
    p.push(part(new THREE.CylinderGeometry(0.13, 0.13, 0.12, 10), PALETTE.brass, side * 0.5, 1.12, -2.92, Math.PI / 2))
    p.push(part(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 10), 0xd8cba0, side * 0.5, 1.12, -2.98, Math.PI / 2)) // lens
  }

  // --- armoured crew superstructure + flat rear deck
  p.push(part(new THREE.BoxGeometry(1.66, 0.72, 1.5, 2, 1, 2), body, 0, 1.62, -0.35))
  p.push(part(new THREE.BoxGeometry(1.66, 0.28, 1.35), body, 0, 1.42, 1.35)) // rear deck
  rivetRow(p, [-0.83, 1.98, -1.0], [-0.83, 1.98, 0.3], 6, 0.045, rivet)
  rivetRow(p, [0.83, 1.98, -1.0], [0.83, 1.98, 0.3], 6, 0.045, rivet)

  // --- full-length running boards + curved fenders over each wheel
  for (const side of [-1, 1]) {
    p.push(part(new THREE.BoxGeometry(0.3, 0.1, 3.7), 0x3a3e33, side * 0.94, 0.62, 0.1))
    for (const wz of [-1.65, 1.5]) {
      p.push(part(new THREE.BoxGeometry(0.5, 0.12, 1.05), 0x40443a, side * 0.9, 1.02, wz))
    }
  }

  // --- spare wheel strapped to the right hull side, behind the cab
  const spare = buildCarWheel(0.4)
  spare.position.set(0.92, 1.35, 0.95)
  spare.rotation.y = Math.PI / 2  // flat against the hull side (disc faces +x)
  g.add(spare)
  p.push(part(new THREE.BoxGeometry(0.06, 0.9, 0.1), 0x2b2118, 0.94, 1.35, 0.95)) // strap

  // --- turret: cylinder + bevelled crown, keeps child mg (named 'turret')
  const turret = new THREE.Group()
  turret.name = 'turret'
  turret.position.set(0, 2.06, -0.35)
  const tp: ColoredPart[] = []
  tp.push({ geo: new THREE.CylinderGeometry(0.6, 0.64, 0.56, 12), hex: dark })
  tp.push(part(new THREE.CylinderGeometry(0.5, 0.62, 0.18, 12), dark, 0, 0.37, 0)) // bevelled crown
  tp.push(part(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 12), 0x2c3035, 0, 0.48, 0))
  // vision-slit band + rivets
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    tp.push(part(new THREE.BoxGeometry(0.1, 0.05, 0.03), 0x141618,
      Math.sin(a) * 0.61, 0.1, Math.cos(a) * 0.61, 0, -a, 0))
  }
  turret.add(assemble(tp, { tone: 0.1, darken: 0.3 }))
  const mgGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.7, 8)
  mgGeo.rotateX(Math.PI / 2)
  const mg = fm(mgGeo, mat.steel)
  mg.position.set(0, 0.02, -0.6)
  turret.add(mg)
  g.add(turret)

  // --- wheels: four named spoked wheels + a twin-rear hint (static inner discs)
  const wheelDefs: Array<[string, number, number]> = [
    ['wheel0', -0.86, -1.65], ['wheel1', 0.86, -1.65],
    ['wheel2', -0.86, 1.5], ['wheel3', 0.86, 1.5],
  ]
  for (const [name, x, z] of wheelDefs) {
    const wheel = buildCarWheel(0.47)
    wheel.position.set(x, 0.47, z)
    wheel.rotation.y = Math.PI / 2
    wheel.name = name
    g.add(wheel)
  }
  for (const side of [-1, 1]) {
    p.push(part(new THREE.CylinderGeometry(0.4, 0.4, 0.18, 10), 0x1e2022, side * 0.66, 0.47, 1.5, 0, 0, Math.PI / 2))
  }

  // --- mud thrown up over the running boards and lower hull
  mudClumps(p, 0, 0.1, 0.2, 0.9, 0.4, 1.8, 16, 0x51)

  g.add(assemble(p, { mudTop: 0.85, mudBot: 0, rust: 0.12, tone: 0.12, darken: 0.32 }))
  return g
}

// ===========================================================================
// Biplane — tapered octagonal fuselage, round engine cowl with head bumps,
// extruded airfoil wings with ribs & rounded tips, full strut pairs + cabane,
// landing gear, cockpit ring, forward MG, twisted two-blade prop, and proper
// roundels / Balkenkreuz on wingtips AND fuselage, striped rudder.
// ===========================================================================

// airfoil cross-section: [chord (z), thickness (y)]; LE toward -z (front)
const AIRFOIL: Array<[number, number]> = [
  [-0.55, 0.0], [-0.4, 0.075], [-0.15, 0.07], [0.2, 0.045],
  [0.55, 0.015], [0.75, 0.004], [0.55, -0.012], [0.2, -0.022],
  [-0.15, -0.024], [-0.4, -0.014],
]

/** One extruded airfoil wing of given span, at world (0, y, z), with chordwise
 *  rib strips and rounded tip caps, pushed as parts into `out`. */
function addWing(out: ColoredPart[], span: number, y: number, z: number, hex: number): void {
  const w = extrudePts(AIRFOIL, span)
  out.push({ geo: xf(w, 0, y, z), hex })
  const ribCount = Math.round(span / 0.5)
  for (let i = 0; i <= ribCount; i++) {
    const x = -span / 2 + (i / ribCount) * span
    out.push(part(new THREE.BoxGeometry(0.03, 0.03, 1.05), hex, x, y + 0.072, z + 0.08))
  }
  // rounded tips: a slim chordwise half-round at each end
  for (const side of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(0.05, 0.05, 1.15, 6)
    cap.rotateX(Math.PI / 2)
    out.push(part(cap, hex, side * span / 2, y, z + 0.08))
  }
}

/** British roundel (3 discs) or German Balkenkreuz (cross + white edge) at a
 *  point, oriented flat-up (axis 'y') or side-facing (axis 'x'). */
function addMarking(out: ColoredPart[], german: boolean, x: number, y: number, z: number, up: boolean, scale: number, nrm = 1): void {
  const rot: [number, number, number] = up ? [0, 0, 0] : [0, 0, Math.PI / 2]
  // stack the coplanar layers outward along the surface normal (+y when flat,
  // ±x per `nrm` when side-facing) so the marking sits ON the surface — not
  // buried in it (rudder faces) or floating off it (fuselage sides).
  const at = (k: number): [number, number, number] => up ? [x, y + k, z] : [x + k * nrm, y, z]
  if (german) {
    const white = 0xcabf9e, black = 0x17191b
    for (const [w, d] of [[0.5, 0.16], [0.16, 0.5]] as Array<[number, number]>) {
      out.push(part(new THREE.BoxGeometry(w * scale, 0.014, d * scale), white, ...at(0.006), ...rot))
    }
    for (const [w, d] of [[0.4, 0.1], [0.1, 0.4]] as Array<[number, number]>) {
      out.push(part(new THREE.BoxGeometry(w * scale, 0.016, d * scale), black, ...at(0.014), ...rot))
    }
  } else {
    const rings: Array<[number, number]> = [[0.32, 0x2c3d63], [0.2, 0xcabf9e], [0.09, 0x7a3026]]
    rings.forEach(([r, c], i) => {
      out.push(part(new THREE.CylinderGeometry(r * scale, r * scale, 0.02, 12), c, ...at(0.006 + i * 0.006), ...rot))
    })
  }
}

export function buildBiplane(german: boolean): THREE.Group {
  const g = new THREE.Group()
  const p: ColoredPart[] = []
  const body = german ? PALETTE.feldgrau : PALETTE.khaki
  const strutHex = PALETTE.woodDark
  const fy = 1.2  // fuselage centreline height

  // --- tapered octagonal fuselage (three merged segments, nose fat → tail thin)
  const segs: Array<[number, number, number, number]> = [
    [0.3, 0.34, 1.3, -1.35],  // radiusTop(+z), radiusBottom(-z), length, centreZ
    [0.2, 0.3, 1.6, 0.1],
    [0.07, 0.2, 1.5, 1.55],
  ]
  for (const [rt, rb, len, zc] of segs) {
    const s = new THREE.CylinderGeometry(rt, rb, len, 8)
    s.rotateX(Math.PI / 2)
    p.push(part(s, body, 0, fy, zc))
  }
  // rounded engine cowl + radial cylinder-head bumps
  p.push(part(new THREE.CylinderGeometry(0.36, 0.34, 0.34, 12), 0x3a3f43, 0, fy, -2.0, Math.PI / 2))
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2
    p.push(part(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), 0x2c3034,
      Math.sin(a) * 0.3, fy + Math.cos(a) * 0.3, -2.02, Math.PI / 2))
  }

  // --- wings (stagger: top wing forward & high, lower wing aft & low)
  addWing(p, 7.0, fy + 0.62, -0.15, body)   // upper
  addWing(p, 6.4, fy - 0.5, 0.15, body)     // lower

  // --- interplane strut PAIRS both sides + cabane struts to the fuselage
  const strut = (x: number, z: number): THREE.BufferGeometry => {
    const s = new THREE.CylinderGeometry(0.028, 0.028, 1.12, 5)
    return xf(s, x, fy + 0.06, z)
  }
  for (const side of [-1, 1]) {
    p.push({ geo: strut(side * 2.45, -0.35), hex: strutHex })
    p.push({ geo: strut(side * 2.45, 0.2), hex: strutHex })
    // cabane struts up to the top wing centre
    p.push(part(new THREE.CylinderGeometry(0.026, 0.026, 0.7, 5), strutHex, side * 0.32, fy + 0.4, -0.35, 0.25 * side, 0, 0.28 * side))
    p.push(part(new THREE.CylinderGeometry(0.026, 0.026, 0.7, 5), strutHex, side * 0.32, fy + 0.4, 0.15, -0.25 * side, 0, 0.28 * side))
  }

  // --- tail: horizontal stabiliser (airfoil) + fin + rudder
  addWing(p, 1.9, fy + 0.02, 1.95, body)
  p.push(part(new THREE.BoxGeometry(0.06, 0.55, 0.6), body, 0, fy + 0.32, 2.05)) // fin
  p.push(part(new THREE.BoxGeometry(0.05, 0.5, 0.42), body, 0, fy + 0.3, 2.4))   // rudder
  if (!german) {
    // RFC rudder stripes: blue / white / red aft-to-fore
    const stripes: Array<[number, number]> = [[0x2c3d63, 2.28], [0xcabf9e, 2.4], [0x7a3026, 2.52]]
    for (const [c, sz] of stripes) p.push(part(new THREE.BoxGeometry(0.06, 0.5, 0.1), c, 0, fy + 0.3, sz))
  } else {
    // Balkenkreuz on BOTH rudder faces (rudder slab half-thickness 0.025) so the
    // cross clears the surface and renders, instead of being buried at x≈0.
    addMarking(p, true, 0.025, fy + 0.3, 2.42, false, 0.7, 1)
    addMarking(p, true, -0.025, fy + 0.3, 2.42, false, 0.7, -1)
  }

  // --- landing gear: two V-struts + axle + two disc wheels + tail skid
  const gearY = 0.28
  for (const side of [-1, 1]) {
    p.push(part(new THREE.CylinderGeometry(0.035, 0.035, 1.0, 5), strutHex, side * 0.34, (fy - 0.5 + gearY) / 2 + 0.25, -1.0, 0, 0, side * 0.5))
    p.push(part(new THREE.CylinderGeometry(0.035, 0.035, 1.0, 5), strutHex, side * 0.62, (fy - 0.5 + gearY) / 2 + 0.25, -1.0, 0, 0, side * 0.22))
  }
  const axle = new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6)
  axle.rotateZ(Math.PI / 2)
  p.push(part(axle, 0x2c3034, 0, gearY, -1.0))
  for (const side of [-1, 1]) {
    p.push(part(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 12), 0x24262a, side * 0.6, gearY, -1.0, 0, 0, Math.PI / 2))
    p.push(part(new THREE.CylinderGeometry(0.1, 0.1, 0.13, 8), 0x3c4247, side * 0.6, gearY, -1.0, 0, 0, Math.PI / 2))
  }
  p.push(part(new THREE.BoxGeometry(0.05, 0.35, 0.1), strutHex, 0, fy - 0.2, 2.35, -0.7, 0, 0)) // tail skid

  // --- cockpit ring behind the top-wing cutout + forward MG
  p.push(part(new THREE.TorusGeometry(0.17, 0.035, 5, 12), 0x2a2620, 0, fy + 0.28, 0.45, Math.PI / 2, 0, 0))
  p.push(part(new THREE.CylinderGeometry(0.14, 0.14, 0.04, 10), 0x111214, 0, fy + 0.28, 0.45, Math.PI / 2)) // dark opening
  p.push(part(new THREE.BoxGeometry(0.12, 0.1, 0.3), 0x2c3034, 0.0, fy + 0.34, -0.9)) // MG body
  const mgB = new THREE.CylinderGeometry(0.025, 0.03, 0.5, 6)
  mgB.rotateX(Math.PI / 2)
  p.push(part(mgB, 0x1f2226, 0, fy + 0.36, -1.2))

  // --- national markings on wingtips AND fuselage sides
  for (const side of [-1, 1]) {
    addMarking(p, german, side * 2.7, fy + 0.62 + 0.07, -0.05, true, 1.0)   // upper wingtips
    // fuselage sides: sit on the tail segment's surface (radius ≈0.21 at z=0.7),
    // layers pushed outward per side so the marking clears the hull, not floats.
    addMarking(p, german, side * 0.21, fy, 0.7, false, 0.85, side)
  }

  g.add(assemble(p, { tone: 0.1, darken: 0.26 }))

  // --- two-blade twisted prop + spinner hub (named 'prop', spins about Z)
  const prop = new THREE.Group()
  prop.name = 'prop'
  prop.position.set(0, fy, -2.2)
  const blade = (down: boolean): THREE.BufferGeometry => {
    const s = new THREE.Shape()
    const pts: Array<[number, number]> = [
      [0, 0.075], [0.5, 0.055], [0.85, 0.03], [1.0, 0.0],
      [0.85, -0.03], [0.5, -0.055], [0, -0.075],
    ]
    s.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1])
    s.closePath()
    const b = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false })
    b.translate(0, 0, -0.01)
    b.rotateZ(Math.PI / 2)                     // span → +y
    b.rotateY(down ? -0.3 : 0.3)               // twist / pitch
    if (down) b.rotateZ(Math.PI)               // second blade points down
    return b
  }
  prop.add(fm(blade(false), mat.woodDark))
  prop.add(fm(blade(true), mat.woodDark))
  const spinner = new THREE.CylinderGeometry(0.001, 0.09, 0.18, 10)
  spinner.rotateX(-Math.PI / 2)
  const spin = fm(spinner, mat.brass)
  spin.position.set(0, 0, -0.06)
  prop.add(spin)
  g.add(prop)

  return g
}

// ===========================================================================
// Horse — anatomy pass: deep chest, rising belly, shoulder/haunch muscle, neck
// tapering to a real head, mane, curved tail, jointed legs. Leg-root groups
// stay named & hip-pivoted (gallop code rotates them ±x); head stays named &
// poll-pivoted (nod). Military tack: saddle, blanket, girth, bridle.
// ===========================================================================

export function buildHorse(): THREE.Group {
  const g = new THREE.Group()
  const coat = 0x5a4230
  const coatDark = 0x46331f
  const mane = 0x2e2013
  const leather = 0x3f2c1a
  const blanket = 0x3a4636

  // --- body + neck + tack, one merged vertex-coloured mesh (all static) ------
  const bp: ColoredPart[] = []
  // barrel/chest (deep, forward) → rump (rounder, rear); belly slung lower
  bp.push(part(new THREE.SphereGeometry(0.42, 9, 7), coat, 0, 1.02, -0.32, 0, 0, 0, 1.35, 1.05, 0.95)) // chest
  bp.push(part(new THREE.SphereGeometry(0.42, 9, 7), coat, 0, 1.06, 0.42, 0, 0, 0, 1.3, 0.95, 1.0))    // rump
  bp.push(part(new THREE.SphereGeometry(0.4, 8, 6), coat, 0, 0.9, 0.05, 0, 0, 0, 1.5, 0.72, 0.85))     // belly
  // shoulder & haunch muscle masses
  for (const side of [-1, 1]) {
    bp.push(part(new THREE.SphereGeometry(0.24, 7, 6), coat, side * 0.24, 1.02, -0.5, 0, 0, 0, 0.9, 1.05, 1.1)) // shoulder
    bp.push(part(new THREE.SphereGeometry(0.27, 7, 6), coat, side * 0.26, 1.05, 0.55, 0, 0, 0, 0.95, 1.1, 1.05)) // haunch
  }
  // neck taper from chest up to the poll
  bp.push(part(new THREE.CylinderGeometry(0.15, 0.26, 0.8, 7), coat, 0, 1.36, -0.62, 0.95, 0, 0))
  bp.push(part(new THREE.SphereGeometry(0.16, 6, 5), coat, 0, 1.16, -0.42, 0, 0, 0, 1.1, 1.0, 1.2)) // withers/crest base
  // mane strip along the neck crest
  for (let i = 0; i < 9; i++) {
    const t = i / 8
    bp.push(part(new THREE.BoxGeometry(0.05, 0.14, 0.1), mane,
      0, 1.16 + t * 0.4, -0.44 - t * 0.34, 0.95, 0, 0))
  }
  // curved tapering tail (tube + tuft)
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.05, 0.78),
    new THREE.Vector3(0, 0.85, 0.98),
    new THREE.Vector3(0, 0.5, 1.02),
    new THREE.Vector3(0, 0.22, 0.9),
  ])
  bp.push({ geo: new THREE.TubeGeometry(tailCurve, 10, 0.075, 6, false), hex: mane })
  bp.push(part(new THREE.ConeGeometry(0.09, 0.22, 6), mane, 0, 0.16, 0.86, Math.PI * 0.9, 0, 0))
  // --- military tack: saddle blanket, saddle, girth ---
  bp.push(part(new THREE.BoxGeometry(0.66, 0.08, 0.9), blanket, 0, 1.42, 0.02, 0, 0, 0, 1, 1, 1)) // blanket
  bp.push(part(new THREE.BoxGeometry(0.5, 0.12, 0.5), leather, 0, 1.5, 0.02))                     // saddle seat
  for (const side of [-1, 1]) {
    bp.push(part(new THREE.BoxGeometry(0.08, 0.24, 0.42), leather, side * 0.3, 1.34, 0.02))       // saddle flap
  }
  bp.push(part(new THREE.TorusGeometry(0.42, 0.04, 4, 12), leather, 0, 1.0, 0.05, 0, 0, 0, 1.05, 0.95, 1)) // girth around the barrel

  g.add(assemble(bp, { mudTop: 0.55, mudBot: 0.0, tone: 0.14, darken: 0.3 }))

  // --- head: named group, pivots at the poll; base tilt 0.35 (gallop overrides)
  const head = new THREE.Group()
  head.name = 'head'
  head.position.set(0, 1.52, -0.8)
  head.rotation.x = 0.35
  const hp: ColoredPart[] = []
  hp.push(part(new THREE.BoxGeometry(0.17, 0.18, 0.24), coatDark, 0, 0.0, -0.16, 0, 0, 0, 1, 1, 1))   // skull/brow
  hp.push(part(new THREE.BoxGeometry(0.13, 0.13, 0.3), coatDark, 0, -0.06, -0.4, 0, 0, 0, 0.9, 0.9, 1)) // muzzle
  hp.push(part(new THREE.BoxGeometry(0.12, 0.1, 0.2), coatDark, 0, -0.13, -0.26))                       // jaw
  hp.push(part(new THREE.BoxGeometry(0.14, 0.04, 0.03), 0x161310, 0, -0.05, -0.55))                     // nose band (bridle)
  for (const side of [-1, 1]) {
    hp.push(part(new THREE.ConeGeometry(0.045, 0.15, 5), coatDark, side * 0.07, 0.16, -0.02))           // ears
    hp.push(part(new THREE.BoxGeometry(0.02, 0.24, 0.03), 0x161310, side * 0.08, -0.02, -0.24, 0.3, 0, 0)) // cheek strap
  }
  hp.push(part(new THREE.SphereGeometry(0.028, 5, 4), 0x0d0b09, -0.09, 0.02, -0.2))                     // eyes
  hp.push(part(new THREE.SphereGeometry(0.028, 5, 4), 0x0d0b09, 0.09, 0.02, -0.2))
  head.add(assemble(hp, { tone: 0.12, darken: 0.22 }))
  g.add(head)

  // --- legs: named hip-pivot groups; children hang to the ground (hoof ≈ y0).
  //     Front legs bend at the knee, hind legs at the hock — a static offset in
  //     the group; the gallop code rotates each group root about x.
  const legDefs: Array<[string, number, number, boolean]> = [
    ['legFL', -0.22, -0.55, false], ['legFR', 0.22, -0.55, false],
    ['legBL', -0.24, 0.6, true], ['legBR', 0.24, 0.6, true],
  ]
  for (const [name, x, z, hind] of legDefs) {
    const leg = new THREE.Group()
    leg.name = name
    leg.position.set(x, 1.05, z)
    const lp: ColoredPart[] = []
    const bend = hind ? -0.12 : 0.08   // knee forward / hock back
    // upper (forearm / gaskin) — tapered, slight muscle at top
    lp.push(part(new THREE.CylinderGeometry(0.085, 0.06, 0.44, 6), coat, 0, -0.22, 0))
    lp.push(part(new THREE.SphereGeometry(0.1, 6, 5), coat, 0, -0.05, hind ? 0.02 : -0.02, 0, 0, 0, 1, 1.2, 1))
    // knee / hock joint
    lp.push(part(new THREE.SphereGeometry(0.06, 6, 5), coatDark, 0, -0.45, bend * 0.5))
    // lower cannon — angled by the bend
    lp.push(part(new THREE.CylinderGeometry(0.045, 0.035, 0.4, 6), coatDark, 0, -0.66, bend, bend * 0.9, 0, 0))
    // pastern → hoof
    lp.push(part(new THREE.CylinderGeometry(0.038, 0.045, 0.1, 6), coatDark, 0, -0.9, bend * 1.4, 0.35, 0, 0))
    lp.push(part(new THREE.BoxGeometry(0.1, 0.09, 0.13), 0x171310, 0, -1.0, bend * 1.6 + 0.02))
    leg.add(assemble(lp, { mudTop: -0.55, mudBot: -1.05, tone: 0.1, darken: 0.3 }))
    g.add(leg)
  }

  return g
}
