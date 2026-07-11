/**
 * Renders the deformable heightfield with a single injected-shader standard
 * material: dry-khaki grass → churned mud → scorch by shell-churn, pale
 * thrown-up subsoil on crater rims and parapets, concavity-darkened trench
 * bottoms and shell pits, and murky standing water (low roughness = sun glint)
 * in flooded craters. All ground noise is evaluated procedurally in the
 * fragment shader from world coordinates — no wrapping noise texture, so no
 * tiling seams at any distance. Vertex data re-uploads only for dirty regions
 * (partial GPU uploads via BufferAttribute update ranges).
 */
import * as THREE from 'three'
import type { Terrain, DirtyRegion } from './terrain'

// -- palette (hex → linear via THREE.Color, embedded as vec3 literals) --------
function v3(c: THREE.Color): string {
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
}

const PALETTE = {
  grassDry: v3(new THREE.Color(0x8a7f52)),   // dry khaki summer grass
  grassGreen: v3(new THREE.Color(0x596b3c)), // greener hollows / fresh patches
  mudWet: v3(new THREE.Color(0x413226)),     // saturated wet brown
  mudDry: v3(new THREE.Color(0x6f5e45)),     // dried pale mud
  earthPale: v3(new THREE.Color(0x80715a)),  // thrown-up subsoil (rims, parapets)
  scorch: v3(new THREE.Color(0x251f18)),     // burnt shell scorch
  trenchFloor: v3(new THREE.Color(0x3a3123)),
  water: v3(new THREE.Color(0x333f37)),      // murky green-brown standing water
}

export class TerrainMesh {
  readonly mesh: THREE.Mesh
  private geo: THREE.BufferGeometry
  private terrain: Terrain
  private uniforms: { uWet: { value: number }; uTime: { value: number } }

  constructor(terrain: Terrain) {
    this.terrain = terrain
    const { cols, rows } = terrain
    const vcount = (cols + 1) * (rows + 1)

    const positions = new Float32Array(vcount * 3)
    const normals = new Float32Array(vcount * 3)
    const churn = new Float32Array(vcount)
    const trench = new Float32Array(vcount)
    const water = new Float32Array(vcount)
    const ao = new Float32Array(vcount)

    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const i = terrain.vi(c, r)
        positions[i * 3] = terrain.worldX(c)
        positions[i * 3 + 1] = terrain.heights[i]
        positions[i * 3 + 2] = terrain.worldZ(r)
      }
    }

    const indices = new Uint32Array(cols * rows * 6)
    let k = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = terrain.vi(c, r), b = terrain.vi(c + 1, r)
        const d = terrain.vi(c, r + 1), e = terrain.vi(c + 1, r + 1)
        indices[k++] = a; indices[k++] = d; indices[k++] = b
        indices[k++] = b; indices[k++] = d; indices[k++] = e
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geo.setAttribute('aChurn', new THREE.BufferAttribute(churn, 1))
    geo.setAttribute('aTrench', new THREE.BufferAttribute(trench, 1))
    geo.setAttribute('aWater', new THREE.BufferAttribute(water, 1))
    geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    this.geo = geo

    this.uniforms = {
      uWet: { value: 0 },
      uTime: { value: 0 },
    }

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 })
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aChurn; attribute float aTrench; attribute float aWater; attribute float aAO;
          varying float vChurn; varying float vTrench; varying float vWater; varying float vAO; varying vec3 vWpos;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vChurn = aChurn; vTrench = aTrench; vWater = aWater; vAO = aAO;
          vWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uWet; uniform float uTime;
          varying float vChurn; varying float vTrench; varying float vWater; varying float vAO; varying vec3 vWpos;

          // Seamless procedural ground noise (Hoskins hash — no sin precision
          // issues, no texture wrap seams).
          float msHash(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
          }
          float msNoise(vec2 p) {
            vec2 i = floor(p); vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            float a = msHash(i);
            float b = msHash(i + vec2(1.0, 0.0));
            float c = msHash(i + vec2(0.0, 1.0));
            float d = msHash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
          }
          float msFbm(vec2 p) {
            return msNoise(p) * 0.55 + msNoise(p * 2.73 + 17.1) * 0.27 + msNoise(p * 6.41 + 47.7) * 0.18;
          }

          // Cross-chunk scratch (set in the color pass, reused for roughness
          // and normal detail).
          float gFine; float gMicro; float gPit; float gMud; float gWaterMix;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec2 wp = vWpos.xz;
            float dist = length(vViewPosition);
            // Detail scales: macro patchiness (~50 m), meso clumps (~12 m),
            // fine breakup (~2 m), micro grain (~0.5 m, faded at RTS range).
            float macro = msFbm(wp * 0.02);
            float meso  = msFbm(wp * 0.083 + 3.7);
            float fine  = msNoise(wp * 0.51 + 9.1);
            float micro = msNoise(wp * 2.17 + 31.7);
            float microFade = 1.0 - smoothstep(30.0, 85.0, dist);
            micro = mix(0.5, micro, microFade);
            gFine = fine; gMicro = micro;

            float pit   = clamp(vAO, 0.0, 1.0);   // concave: trench bottoms, shell pits
            float crest = clamp(-vAO, 0.0, 1.0);  // convex: rims, parapets
            gPit = pit;

            // Grass: dry khaki with greener hollows and mottled patches.
            vec3 grass = mix(${PALETTE.grassDry}, ${PALETTE.grassGreen},
              clamp(macro * 1.2 - 0.08 + (meso - 0.5) * 0.4, 0.0, 1.0));
            grass *= 0.86 + fine * 0.2 + (micro - 0.5) * 0.14;

            // Mud: wetness drags it dark and saturated; dry mud bleaches pale.
            float dry = clamp(0.28 + meso * 0.8 + (fine - 0.5) * 0.42 - uWet * 0.62, 0.0, 1.0);
            vec3 mud = mix(${PALETTE.mudWet}, ${PALETTE.mudDry}, dry);
            mud *= 0.9 + (micro - 0.5) * 0.22;

            float mudMix = clamp(vChurn * 1.45 + uWet * 0.35 * meso + pit * 0.35, 0.0, 1.0);
            gMud = mudMix;
            vec3 col = mix(grass, mud, mudMix);

            // Thrown-up pale subsoil on crater rims and parapets.
            col = mix(col, ${PALETTE.earthPale} * (0.88 + fine * 0.22),
              clamp(crest * (0.5 + vChurn * 0.7), 0.0, 0.85));
            // Scorch where the ground is churned to ruin.
            col = mix(col, ${PALETTE.scorch}, clamp(vChurn * vChurn * 1.25, 0.0, 1.0) * (0.5 + fine * 0.32));
            // Trodden trench floors.
            col = mix(col, ${PALETTE.trenchFloor} * (0.85 + fine * 0.3), vTrench * 0.62);
            // Concavity AO: pits and trench bottoms shade down (deeper when wet).
            col *= 1.0 - pit * (0.34 + uWet * 0.2);

            // Standing water: dark saturated margin, then murky water with a
            // faint animated shimmer.
            float wtr = clamp(vWater * 1.05, 0.0, 1.0);
            gWaterMix = wtr;
            col *= 1.0 - smoothstep(0.02, 0.3, wtr) * (1.0 - wtr) * 0.35;
            float shim = sin(wp.x * 2.1 + uTime * 0.6) * sin(wp.y * 2.7 - uTime * 0.45) * 0.5 + 0.5;
            vec3 waterCol = ${PALETTE.water} * (0.82 + shim * 0.12 + meso * 0.14);
            col = mix(col, waterCol, wtr * 0.92);
            // Damp sheen darkening on wet churned ground.
            col *= 1.0 - uWet * 0.15 * vChurn * (1.0 - wtr);
            diffuseColor.rgb = col;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          // Dry ground micro variation, rain slick on churned mud, mirror pools.
          roughnessFactor -= (gFine - 0.5) * 0.1 + (gMicro - 0.5) * 0.06;
          roughnessFactor = mix(roughnessFactor, 0.38, clamp(uWet * (0.25 + vChurn * 0.75 + gPit * 0.35), 0.0, 1.0));
          roughnessFactor = mix(roughnessFactor, 0.09, gWaterMix);
          roughnessFactor = clamp(roughnessFactor, 0.05, 1.0);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            // Close-range clod/rut bump from the same procedural noise —
            // fades out by ~70 m so RTS range stays clean.
            float nDist = length(vViewPosition);
            float nFade = 1.0 - smoothstep(22.0, 70.0, nDist);
            if (nFade > 0.001) {
              float e = 0.28;
              vec2 bp = vWpos.xz * 1.9;
              float gx = (msNoise(bp + vec2(e, 0.0)) - msNoise(bp - vec2(e, 0.0))) / (2.0 * e);
              float gz = (msNoise(bp + vec2(0.0, e)) - msNoise(bp - vec2(0.0, e))) / (2.0 * e);
              vec2 bp2 = vWpos.xz * 0.55 + 7.3;
              gx += (msNoise(bp2 + vec2(e, 0.0)) - msNoise(bp2 - vec2(e, 0.0))) / (2.0 * e) * 0.7;
              gz += (msNoise(bp2 + vec2(0.0, e)) - msNoise(bp2 - vec2(0.0, e))) / (2.0 * e) * 0.7;
              float bs = nFade * 0.14 * (0.55 + vChurn * 0.9 + gPit * 0.3) * (1.0 - gWaterMix);
              // viewMatrix is a rigid transform: rotate the world-space slope
              // gradient into view space and tilt the surface normal.
              normal = normalize(normal + (viewMatrix * vec4(-gx * bs, 0.0, -gz * bs, 0.0)).xyz);
            }
            // Standing water lies flat, with a barely-moving ripple.
            if (gWaterMix > 0.01) {
              float rip = sin(vWpos.x * 1.4 + uTime * 1.1) * sin(vWpos.z * 1.1 - uTime * 0.8);
              vec3 flat_ = (viewMatrix * vec4(rip * 0.02, 1.0, -rip * 0.016, 0.0)).xyz;
              normal = normalize(mix(normal, normalize(flat_), gWaterMix * 0.75));
            }
          }`)
    }

    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.name = 'terrain'

    this.syncRegion({ minCol: 0, minRow: 0, maxCol: cols, maxRow: rows })
    geo.computeBoundingSphere()

    // Subscribe to deformation updates (chain any handler wired before us).
    const prev = terrain.onDirty
    terrain.onDirty = (r: DirtyRegion) => { prev?.(r); this.handleDirty(r) }
  }

  /** Called by the game when the terrain reports a dirty region. */
  handleDirty(r: DirtyRegion): void {
    this.syncRegion(r)
  }

  update(dt: number, wetness: number): void {
    this.uniforms.uTime.value += dt
    this.uniforms.uWet.value += (wetness - this.uniforms.uWet.value) * Math.min(1, dt * 0.5)
  }

  private syncRegion(reg: DirtyRegion): void {
    const t = this.terrain
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute
    const nor = this.geo.getAttribute('normal') as THREE.BufferAttribute
    const churn = this.geo.getAttribute('aChurn') as THREE.BufferAttribute
    const trench = this.geo.getAttribute('aTrench') as THREE.BufferAttribute
    const water = this.geo.getAttribute('aWater') as THREE.BufferAttribute
    const ao = this.geo.getAttribute('aAO') as THREE.BufferAttribute

    const minC = Math.max(0, reg.minCol - 1), maxC = Math.min(t.cols, reg.maxCol + 1)
    const minR = Math.max(0, reg.minRow - 1), maxR = Math.min(t.rows, reg.maxRow + 1)
    const posArr = pos.array as Float32Array
    const norArr = nor.array as Float32Array
    const churnArr = churn.array as Float32Array
    const trenchArr = trench.array as Float32Array
    const waterArr = water.array as Float32Array
    const aoArr = ao.array as Float32Array
    const inv2Cell = 1 / (2 * t.cell)

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const i = t.vi(c, r)
        posArr[i * 3 + 1] = t.heights[i]
        churnArr[i] = t.churn[i]
        trenchArr[i] = t.trench[i]
        waterArr[i] = t.water[i]
        aoArr[i] = t.ao[i]
        // Finite-difference normal (clamped at edges).
        const hl = t.heights[t.vi(Math.max(0, c - 1), r)]
        const hr = t.heights[t.vi(Math.min(t.cols, c + 1), r)]
        const hd = t.heights[t.vi(c, Math.max(0, r - 1))]
        const hu = t.heights[t.vi(c, Math.min(t.rows, r + 1))]
        const nx = (hl - hr) * inv2Cell, ny = 1, nz = (hd - hu) * inv2Cell
        const len = Math.hypot(nx, ny, nz)
        norArr[i * 3] = nx / len; norArr[i * 3 + 1] = ny / len; norArr[i * 3 + 2] = nz / len
      }
    }

    // Partial GPU upload: a row-aligned contiguous span covering the dirty
    // rows (the renderer merges + clears ranges after each upload).
    const start = t.vi(0, minR)
    const count = t.vi(t.cols, maxR) - start + 1
    pos.addUpdateRange(start * 3, count * 3); pos.needsUpdate = true
    nor.addUpdateRange(start * 3, count * 3); nor.needsUpdate = true
    churn.addUpdateRange(start, count); churn.needsUpdate = true
    trench.addUpdateRange(start, count); trench.needsUpdate = true
    water.addUpdateRange(start, count); water.needsUpdate = true
    ao.addUpdateRange(start, count); ao.needsUpdate = true
  }
}
