/**
 * Renders the deformable heightfield with a single injected-shader standard
 * material: grass → churned mud → scorch by shell-churn, dark revetted trench
 * floors, and murky standing water (low roughness = sun glint) in flooded
 * craters. Vertex data re-uploads only for dirty regions.
 */
import * as THREE from 'three'
import type { Terrain, DirtyRegion } from './terrain'

const GRASS_A = new THREE.Color(0x7d7a4e) // dry summer grass
const GRASS_B = new THREE.Color(0x646c42) // greener patches
const MUD_A = new THREE.Color(0x635239)
const MUD_B = new THREE.Color(0x524432)
const SCORCH = new THREE.Color(0x2e2620)
const TRENCH_FLOOR = new THREE.Color(0x3b3225)
const WATER = new THREE.Color(0x333c33)

function makeNoiseDataTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  // Two-octave tileable-ish value noise, good enough for ground breakup.
  const rand = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return s - Math.floor(s)
  }
  const smooth = (x: number, y: number, freq: number) => {
    const xi = Math.floor(x / freq), yi = Math.floor(y / freq)
    const xf = (x % freq) / freq, yf = (y % freq) / freq
    const ux = xf * xf * (3 - 2 * xf), uy = yf * yf * (3 - 2 * yf)
    const a = rand(xi, yi), b = rand(xi + 1, yi), c = rand(xi, yi + 1), d = rand(xi + 1, yi + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = smooth(x, y, 64) * 0.6 + smooth(x, y, 16) * 0.3 + smooth(x, y, 5) * 0.1
      const i = (y * size + x) * 4
      data[i] = data[i + 1] = data[i + 2] = (v * 255) | 0
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  return tex
}

export class TerrainMesh {
  readonly mesh: THREE.Mesh
  private geo: THREE.BufferGeometry
  private terrain: Terrain
  private uniforms: { uNoise: { value: THREE.Texture }; uWet: { value: number }; uTime: { value: number } }

  constructor(terrain: Terrain) {
    this.terrain = terrain
    const { cols, rows } = terrain
    const vcount = (cols + 1) * (rows + 1)

    const positions = new Float32Array(vcount * 3)
    const normals = new Float32Array(vcount * 3)
    const churn = new Float32Array(vcount)
    const trench = new Float32Array(vcount)
    const water = new Float32Array(vcount)

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
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    this.geo = geo

    this.uniforms = {
      uNoise: { value: makeNoiseDataTexture(256) },
      uWet: { value: 0 },
      uTime: { value: 0 },
    }

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 })
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aChurn; attribute float aTrench; attribute float aWater;
          varying float vChurn; varying float vTrench; varying float vWater; varying vec3 vWpos;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vChurn = aChurn; vTrench = aTrench; vWater = aWater;
          vWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uNoise; uniform float uWet; uniform float uTime;
          varying float vChurn; varying float vTrench; varying float vWater; varying vec3 vWpos;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float n = texture2D(uNoise, vWpos.xz * 0.018).r;
            float n2 = texture2D(uNoise, vWpos.xz * 0.11).r;
            vec3 grass = mix(vec3(${GRASS_A.r}, ${GRASS_A.g}, ${GRASS_A.b}), vec3(${GRASS_B.r}, ${GRASS_B.g}, ${GRASS_B.b}), n);
            grass *= 0.9 + n2 * 0.2;
            vec3 mud = mix(vec3(${MUD_A.r}, ${MUD_A.g}, ${MUD_A.b}), vec3(${MUD_B.r}, ${MUD_B.g}, ${MUD_B.b}), n2);
            float mudMix = clamp(vChurn * 1.5 + uWet * 0.4 * n2, 0.0, 1.0);
            vec3 col = mix(grass, mud, mudMix);
            col = mix(col, vec3(${SCORCH.r}, ${SCORCH.g}, ${SCORCH.b}), clamp(vChurn * vChurn * 1.3, 0.0, 1.0) * 0.75);
            col = mix(col, vec3(${TRENCH_FLOOR.r}, ${TRENCH_FLOOR.g}, ${TRENCH_FLOOR.b}), vTrench * 0.6);
            // Standing water: murky, with a faint animated shimmer band.
            float shimmer = sin(vWpos.x * 3.1 + uTime * 0.8) * sin(vWpos.z * 2.7 - uTime * 0.6) * 0.03;
            col = mix(col, vec3(${WATER.r}, ${WATER.g}, ${WATER.b}) + shimmer, clamp(vWater, 0.0, 1.0) * 0.85);
            // Damp sheen darkening on wet churned ground.
            col *= 1.0 - uWet * 0.18 * vChurn;
            diffuseColor.rgb = col;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.12, clamp(vWater * 1.2, 0.0, 1.0));
          roughnessFactor = mix(roughnessFactor, 0.5, uWet * vChurn * 0.5);`)
    }

    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.name = 'terrain'

    this.syncRegion({ minCol: 0, minRow: 0, maxCol: cols, maxRow: rows })
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

    const minC = Math.max(0, reg.minCol - 1), maxC = Math.min(t.cols, reg.maxCol + 1)
    const minR = Math.max(0, reg.minRow - 1), maxR = Math.min(t.rows, reg.maxRow + 1)
    const posArr = pos.array as Float32Array
    const norArr = nor.array as Float32Array
    const inv2Cell = 1 / (2 * t.cell)

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const i = t.vi(c, r)
        posArr[i * 3 + 1] = t.heights[i]
        ;(churn.array as Float32Array)[i] = t.churn[i]
        ;(trench.array as Float32Array)[i] = t.trench[i]
        ;(water.array as Float32Array)[i] = t.water[i]
        // Finite-difference normal (clamped at edges).
        const hl = t.heights[t.vi(Math.max(0, c - 1), r)]
        const hr = t.heights[t.vi(Math.min(t.cols, c + 1), r)]
        const hd = t.heights[t.vi(c, Math.max(0, r - 1))]
        const hu = t.heights[t.vi(c, Math.min(t.rows, r + 1))]
        let nx = (hl - hr) * inv2Cell, ny = 1, nz = (hd - hu) * inv2Cell
        const len = Math.hypot(nx, ny, nz)
        norArr[i * 3] = nx / len; norArr[i * 3 + 1] = ny / len; norArr[i * 3 + 2] = nz / len
      }
    }
    pos.needsUpdate = true
    nor.needsUpdate = true
    churn.needsUpdate = true
    trench.needsUpdate = true
    water.needsUpdate = true
  }
}
