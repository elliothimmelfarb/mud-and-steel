/**
 * MUD & STEEL — render/effects.ts
 *
 * The game's visual soul: pooled GPU particle VFX.
 *
 * Architecture
 * ------------
 * Two big pooled particle layers, each a single THREE.Points with a custom
 * ShaderMaterial:
 *   - additive layer: muzzle flashes, shell-burst fire, tracers, sparks, flame
 *   - alpha layer:    smoke, dirt, dust, gas wisps, debris, blood, steam
 *
 * Particle motion is integrated ON THE GPU (pos = birthPos + vel*age +
 * 0.5*g*age^2 + wind*windFactor*age + turbulence), so the CPU only touches
 * attribute memory when SPAWNING — ring buffers with addUpdateRange() keep
 * uploads to the freshly written span. Zero allocations in update().
 *
 * One 4x4 canvas-generated 512px sprite atlas holds every shape: soft disc,
 * harsh flash star, fBm smoke blobs, dirt chunks, spark streak, ember, gas
 * wisp, flame puff, water splash, rain streak, dust, debris chunk, halo ring.
 *
 * Rain is its own small Points cloud (~800 streaks) in a 60 m box that follows
 * the camera. Dynamic lights come from a round-robin pool of 6 PointLights.
 */

import * as THREE from 'three'

export interface EmitterHandle {
  move(x: number, y: number, z: number): void
  stop(): void
}

// ---------------------------------------------------------------------------
// Sprite atlas layout (4x4 cells, index = col + row*4, flipY = false)
// ---------------------------------------------------------------------------

const SPR = {
  SOFT: 0, // gaussian soft disc
  FLASH: 1, // harsh flash star
  SMOKE_A: 2, // fBm smoke blob
  SMOKE_B: 3, // fBm smoke blob variant
  DIRT_A: 4, // hard irregular dirt clod
  DIRT_B: 5, // dirt clod variant
  SPARK: 6, // horizontal bright streak (random rotation)
  EMBER: 7, // small hard-core glowing dot
  GAS: 8, // low-frequency wispy blob
  FLAME: 9, // noisy blob with hot core
  SPLASH: 10, // water splash crown
  RAIN: 11, // vertical rain streak
  DUST: 12, // very soft wide dust disc
  SMOKE_C: 13, // third smoke variant
  DEBRIS: 14, // angular chunk
  RING: 15, // soft halo ring (concussion wave)
} as const

const ATLAS_SIZE = 512
const CELL = 128

// ---------------------------------------------------------------------------
// Tiny deterministic noise for atlas generation (startup only)
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function fbm(x: number, y: number, oct: number): number {
  let sum = 0
  let amp = 0.5
  let f = 1
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * f, y * f) * amp
    amp *= 0.5
    f *= 2.03
  }
  return sum
}

/** Random in [a, b). */
function rr(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

// ---------------------------------------------------------------------------
// Atlas painting
// ---------------------------------------------------------------------------

function cellOrigin(idx: number): [number, number] {
  return [(idx % 4) * CELL, Math.floor(idx / 4) * CELL]
}

function paintNoiseCell(
  ctx: CanvasRenderingContext2D,
  idx: number,
  seed: number,
  freq: number,
  shape: (r: number, n: number) => number,
): void {
  const [ox, oy] = cellOrigin(idx)
  const img = ctx.createImageData(CELL, CELL)
  const d = img.data
  let k = 0
  for (let py = 0; py < CELL; py++) {
    for (let px = 0; px < CELL; px++) {
      const nx = (px + 0.5) / CELL - 0.5
      const ny = (py + 0.5) / CELL - 0.5
      const r = Math.sqrt(nx * nx + ny * ny) * 2
      const n = fbm((px * freq) / CELL + seed, (py * freq) / CELL + seed * 1.93, 4)
      let a = shape(r, n)
      a *= clamp01((0.97 - r) * 7) // hard-zero margin so cells never bleed
      d[k] = 255
      d[k + 1] = 255
      d[k + 2] = 255
      d[k + 3] = Math.round(clamp01(a) * 255)
      k += 4
    }
  }
  ctx.putImageData(img, ox, oy)
}

function paintRadialCell(
  ctx: CanvasRenderingContext2D,
  idx: number,
  stops: ReadonlyArray<readonly [number, string]>,
  radius: number,
): void {
  const [ox, oy] = cellOrigin(idx)
  const cx = ox + 64
  const cy = oy + 64
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  for (const [o, c] of stops) g.addColorStop(o, c)
  ctx.save()
  ctx.beginPath()
  ctx.rect(ox, oy, CELL, CELL)
  ctx.clip()
  ctx.fillStyle = g
  ctx.fillRect(ox, oy, CELL, CELL)
  ctx.restore()
}

/** Thin elongated gradient spike drawn along local +x, both directions. */
function paintSpike(ctx: CanvasRenderingContext2D, len: number, thin: number, alpha: number): void {
  ctx.save()
  ctx.scale(1, thin)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, len)
  g.addColorStop(0, `rgba(255,255,255,${alpha})`)
  g.addColorStop(0.4, `rgba(255,255,255,${alpha * 0.5})`)
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, len, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function buildAtlas(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = ATLAS_SIZE
  cv.height = ATLAS_SIZE
  const ctx = cv.getContext('2d')
  if (ctx === null) throw new Error('effects: 2d canvas context unavailable')
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)

  // 0 — soft gaussian disc
  paintRadialCell(ctx, SPR.SOFT, [
    [0, 'rgba(255,255,255,1)'],
    [0.22, 'rgba(255,255,255,0.83)'],
    [0.55, 'rgba(255,255,255,0.32)'],
    [1, 'rgba(255,255,255,0)'],
  ], 58)

  // 1 — harsh flash star: 4 jittered spikes (8 tips) + hot core
  {
    const [ox, oy] = cellOrigin(SPR.FLASH)
    ctx.save()
    ctx.beginPath()
    ctx.rect(ox, oy, CELL, CELL)
    ctx.clip()
    ctx.translate(ox + 64, oy + 64)
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI + (hash2(i, 7.7) - 0.5) * 0.55
      const len = 44 + hash2(i, 3.3) * 16
      ctx.save()
      ctx.rotate(ang)
      paintSpike(ctx, len, 0.075 + hash2(i, 9.1) * 0.05, 0.95)
      ctx.restore()
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 25)
    core.addColorStop(0, 'rgba(255,255,255,1)')
    core.addColorStop(0.45, 'rgba(255,255,255,0.85)')
    core.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(0, 0, 25, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  // 2, 3, 13 — smoke blobs (fBm density)
  const smokeShape = (r: number, n: number): number => {
    const dens = 0.78 - r * (1.25 - (n - 0.47) * 1.1)
    return Math.pow(clamp01(dens * 1.7), 1.35) * (0.5 + 0.5 * n)
  }
  paintNoiseCell(ctx, SPR.SMOKE_A, 3.1, 5, smokeShape)
  paintNoiseCell(ctx, SPR.SMOKE_B, 17.7, 6, smokeShape)
  paintNoiseCell(ctx, SPR.SMOKE_C, 31.9, 4, smokeShape)

  // 4, 5 — dirt clods (hard threshold edges)
  const dirtShape = (r: number, n: number): number => {
    const b = 0.62 - r * 1.05 + (n - 0.5) * 0.85
    return clamp01(b * 7)
  }
  paintNoiseCell(ctx, SPR.DIRT_A, 8.2, 7, dirtShape)
  paintNoiseCell(ctx, SPR.DIRT_B, 23.5, 8, dirtShape)

  // 6 — spark streak (horizontal lens)
  {
    const [ox, oy] = cellOrigin(SPR.SPARK)
    ctx.save()
    ctx.beginPath()
    ctx.rect(ox, oy, CELL, CELL)
    ctx.clip()
    ctx.translate(ox + 64, oy + 64)
    paintSpike(ctx, 56, 0.16, 1)
    paintSpike(ctx, 30, 0.3, 0.8)
    ctx.restore()
  }

  // 7 — ember: hard bright core, tight halo
  paintRadialCell(ctx, SPR.EMBER, [
    [0, 'rgba(255,255,255,1)'],
    [0.28, 'rgba(255,255,255,0.95)'],
    [0.42, 'rgba(255,255,255,0.3)'],
    [1, 'rgba(255,255,255,0)'],
  ], 50)

  // 8 — gas wisp: low-frequency, very soft, lobed
  paintNoiseCell(ctx, SPR.GAS, 5.9, 2.6, (r, n) => {
    const dens = 0.66 - r * (1.05 - (n - 0.5) * 1.3)
    return Math.pow(clamp01(dens * 1.5), 1.7) * (0.35 + 0.65 * n)
  })

  // 9 — flame puff: noisy body + hot center
  paintNoiseCell(ctx, SPR.FLAME, 11.3, 5, (r, n) => {
    const body = clamp01((0.85 - r * (1.3 - (n - 0.5) * 0.7)) * 1.6)
    const core = clamp01(0.55 - r * 1.8)
    return clamp01(Math.pow(body, 1.2) * (0.55 + 0.45 * n) + core)
  })

  // 10 — water splash crown: fanned streaks + base blob
  {
    const [ox, oy] = cellOrigin(SPR.SPLASH)
    ctx.save()
    ctx.beginPath()
    ctx.rect(ox, oy, CELL, CELL)
    ctx.clip()
    ctx.translate(ox + 64, oy + 94)
    for (let i = 0; i < 9; i++) {
      const ang = -Math.PI / 2 + (i / 8 - 0.5) * 1.9 + (hash2(i, 5.1) - 0.5) * 0.25
      const len = 34 + hash2(i, 11.4) * 42
      ctx.save()
      ctx.rotate(ang)
      ctx.translate(len * 0.45, 0)
      paintSpike(ctx, len * 0.55, 0.1 + hash2(i, 2.8) * 0.06, 0.85)
      ctx.restore()
    }
    const base = ctx.createRadialGradient(0, 0, 0, 0, 0, 30)
    base.addColorStop(0, 'rgba(255,255,255,0.9)')
    base.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = base
    ctx.save()
    ctx.scale(1, 0.45)
    ctx.beginPath()
    ctx.arc(0, 0, 30, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.restore()
  }

  // 11 — rain streak: thin vertical line, feathered ends
  {
    const [ox, oy] = cellOrigin(SPR.RAIN)
    const cx = ox + 64
    const g = ctx.createLinearGradient(0, oy + 6, 0, oy + 122)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.18, 'rgba(255,255,255,0.5)')
    g.addColorStop(0.82, 'rgba(255,255,255,0.85)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(cx - 3, oy + 6, 6, 116)
  }

  // 12 — dust: extremely soft wide disc
  paintRadialCell(ctx, SPR.DUST, [
    [0, 'rgba(255,255,255,0.55)'],
    [0.45, 'rgba(255,255,255,0.34)'],
    [1, 'rgba(255,255,255,0)'],
  ], 60)

  // 14 — debris: angular chunk polygon
  {
    const [ox, oy] = cellOrigin(SPR.DEBRIS)
    ctx.save()
    ctx.beginPath()
    ctx.rect(ox, oy, CELL, CELL)
    ctx.clip()
    ctx.beginPath()
    const cx = ox + 64
    const cy = oy + 64
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      const rad = 34 * (0.55 + hash2(i, 21.3) * 0.7)
      const px = cx + Math.cos(a) * rad
      const py = cy + Math.sin(a) * rad * 0.8
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fill()
    ctx.restore()
  }

  // 15 — halo ring
  paintRadialCell(ctx, SPR.RING, [
    [0, 'rgba(255,255,255,0)'],
    [0.52, 'rgba(255,255,255,0)'],
    [0.7, 'rgba(255,255,255,0.65)'],
    [0.88, 'rgba(255,255,255,0)'],
    [1, 'rgba(255,255,255,0)'],
  ], 60)

  const tex = new THREE.CanvasTexture(cv)
  tex.flipY = false
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// Particle layer shaders (shared vertex; fragment differs via ADDITIVE define)
// ---------------------------------------------------------------------------

const LAYER_VERT = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uSizeScale;
attribute vec3 aVel;
attribute vec2 aTiming;   // birth, life
attribute vec2 aSizes;    // size0, size1
attribute vec4 aColor;    // rgb, peak alpha
attribute vec4 aMisc;     // rot0, rotSpeed, gravY, windFactor
attribute vec4 aExtra;    // spriteIdx, fadeIn, fadeOutPow, turbulence
varying vec4 vColor;
varying float vRot;
varying float vSprite;
#include <fog_pars_vertex>
void main() {
  float life = aTiming.y;
  float age = uTime - aTiming.x;
  float alive = step(0.0001, life) * step(0.0, age) * (1.0 - step(life, age));
  float t = clamp(age / max(life, 0.0001), 0.0, 1.0);

  vec3 p = position + aVel * age;
  p.xz += uWind * (aMisc.w * age);
  p.y += 0.5 * aMisc.z * age * age;
  // falling particles pile up just below their spawn height, then fade
  if (aMisc.z < -0.001) { p.y = max(p.y, position.y - 0.35); }

  float turb = aExtra.w;
  if (turb > 0.0) {
    float seed = fract(sin(dot(position.xz, vec2(127.1, 311.7))) * 43758.5453) * 6.28318;
    float sw = turb * min(age, 2.0) * 0.5;
    p.x += sin(age * 1.9 + seed) * sw;
    p.z += cos(age * 1.4 + seed * 1.71) * sw;
    p.y += sin(age * 2.6 + seed * 0.63) * sw * 0.6;
  }

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  float size = mix(aSizes.x, aSizes.y, t);
  gl_PointSize = clamp(size * uSizeScale / max(-mvPosition.z, 0.1), 0.0, 512.0);

  float env = smoothstep(0.0, max(aExtra.y, 0.001), t) * pow(1.0 - t, aExtra.z);
  vColor = vec4(aColor.rgb, aColor.a * env * alive);
  vRot = aMisc.x + aMisc.y * age;
  vSprite = aExtra.x;
  gl_Position = projectionMatrix * mvPosition;
  if (alive < 0.5) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); gl_PointSize = 0.0; }
  #include <fog_vertex>
}
`

const LAYER_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
varying float vRot;
varying float vSprite;
#include <fog_pars_fragment>
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRot);
  float s = sin(vRot);
  uv = mat2(c, s, -s, c) * uv;
  uv = clamp(uv + 0.5, 0.02, 0.98);
  vec2 cell = vec2(mod(vSprite, 4.0), floor(vSprite / 4.0));
  vec4 tex = texture2D(uMap, (cell + uv) * 0.25);
  float a = vColor.a * tex.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * tex.rgb, a);
  #ifdef ADDITIVE
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      gl_FragColor.rgb *= 1.0 - fogFactor;
    #endif
  #else
    #include <fog_fragment>
  #endif
}
`

// ---------------------------------------------------------------------------
// Rain shaders
// ---------------------------------------------------------------------------

const RAIN_BOX = 60
const RAIN_COUNT = 800

const RAIN_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCamPos;
uniform vec2 uWind;
uniform float uIntensity;
uniform float uSizeScale;
attribute vec2 aSeed;   // speed rand, visibility rand
varying float vAlpha;
void main() {
  vec3 p = position;
  float speed = 16.0 + aSeed.x * 8.0;
  float y = mod(p.y - uTime * speed, ${RAIN_BOX.toFixed(1)});
  vec3 wp;
  wp.x = uCamPos.x + p.x + uWind.x * (y * -0.05);
  wp.z = uCamPos.z + p.z + uWind.y * (y * -0.05);
  wp.y = uCamPos.y - 12.0 + y;
  float vis = step(aSeed.y, uIntensity);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_PointSize = clamp((1.1 + aSeed.x * 0.6) * uSizeScale / max(-mv.z, 0.1), 0.0, 64.0);
  vAlpha = (0.22 + 0.32 * uIntensity) * vis;
  gl_Position = projectionMatrix * mv;
  if (vis < 0.5) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); gl_PointSize = 0.0; }
}
`

const RAIN_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
void main() {
  vec2 uv = clamp(gl_PointCoord, 0.02, 0.98);
  vec4 tex = texture2D(uMap, (vec2(3.0, 2.0) + uv) * 0.25);
  float a = tex.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(0.72, 0.76, 0.82), a);
}
`

// ---------------------------------------------------------------------------
// One pooled particle layer (ring buffer over a single THREE.Points)
// ---------------------------------------------------------------------------

class ParticleLayer {
  readonly points: THREE.Points
  readonly capacity: number

  private readonly geo: THREE.BufferGeometry
  private readonly mat: THREE.ShaderMaterial
  private readonly attrs: THREE.BufferAttribute[]

  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly timing: Float32Array
  private readonly sizes: Float32Array
  private readonly color: Float32Array
  private readonly misc: Float32Array
  private readonly extra: Float32Array

  private readonly uTime: THREE.IUniform<number>
  private readonly uWind: THREE.IUniform<THREE.Vector2>
  private readonly uSizeScale: THREE.IUniform<number>

  private cursor = 0
  private pendStart = 0
  private pendCount = 0
  private pendWrapped = false

  constructor(capacity: number, additive: boolean, map: THREE.Texture) {
    this.capacity = capacity
    this.pos = new Float32Array(capacity * 3)
    this.vel = new Float32Array(capacity * 3)
    this.timing = new Float32Array(capacity * 2)
    this.sizes = new Float32Array(capacity * 2)
    this.color = new Float32Array(capacity * 4)
    this.misc = new Float32Array(capacity * 4)
    this.extra = new Float32Array(capacity * 4)

    this.geo = new THREE.BufferGeometry()
    this.attrs = []
    const mk = (arr: Float32Array, itemSize: number, name: string): THREE.BufferAttribute => {
      const a = new THREE.BufferAttribute(arr, itemSize)
      a.setUsage(THREE.DynamicDrawUsage)
      this.geo.setAttribute(name, a)
      this.attrs.push(a)
      return a
    }
    mk(this.pos, 3, 'position')
    mk(this.vel, 3, 'aVel')
    mk(this.timing, 2, 'aTiming')
    mk(this.sizes, 2, 'aSizes')
    mk(this.color, 4, 'aColor')
    mk(this.misc, 4, 'aMisc')
    mk(this.extra, 4, 'aExtra')
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6)

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector2(0, 0) },
        uSizeScale: { value: 600 },
        uMap: { value: null },
      },
    ])
    uniforms['uMap'].value = map

    this.mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: LAYER_VERT,
      fragmentShader: LAYER_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
      defines: additive ? { ADDITIVE: 1 } : {},
    })
    this.uTime = this.mat.uniforms['uTime'] as THREE.IUniform<number>
    this.uWind = this.mat.uniforms['uWind'] as THREE.IUniform<THREE.Vector2>
    this.uSizeScale = this.mat.uniforms['uSizeScale'] as THREE.IUniform<number>

    this.points = new THREE.Points(this.geo, this.mat)
    this.points.frustumCulled = false
    this.points.matrixAutoUpdate = false
    this.points.renderOrder = additive ? 21 : 20
  }

  /**
   * Write one particle into the ring buffer. All motion/fade happens on the
   * GPU from these values alone.
   */
  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    birth: number, life: number,
    s0: number, s1: number,
    r: number, g: number, b: number, a: number,
    rot0: number, rotV: number,
    grav: number, windF: number,
    sprite: number,
    fadeIn: number, fadePow: number,
    turb: number,
  ): void {
    if (life <= 0) return
    const i = this.cursor
    const i2 = i * 2
    const i3 = i * 3
    const i4 = i * 4
    this.pos[i3] = x
    this.pos[i3 + 1] = y
    this.pos[i3 + 2] = z
    this.vel[i3] = vx
    this.vel[i3 + 1] = vy
    this.vel[i3 + 2] = vz
    this.timing[i2] = birth
    this.timing[i2 + 1] = life
    this.sizes[i2] = s0
    this.sizes[i2 + 1] = s1
    this.color[i4] = r
    this.color[i4 + 1] = g
    this.color[i4 + 2] = b
    this.color[i4 + 3] = a
    this.misc[i4] = rot0
    this.misc[i4 + 1] = rotV
    this.misc[i4 + 2] = grav
    this.misc[i4 + 3] = windF
    this.extra[i4] = sprite
    this.extra[i4 + 1] = fadeIn
    this.extra[i4 + 2] = fadePow
    this.extra[i4 + 3] = turb
    if (this.pendCount === 0) this.pendStart = i
    this.pendCount++
    this.cursor++
    if (this.cursor >= this.capacity) {
      this.cursor = 0
      this.pendWrapped = true
    }
  }

  /** Push the freshly written span(s) to the GPU as narrow update ranges. */
  flush(): void {
    if (this.pendCount === 0) return
    const wrap = this.pendWrapped || this.pendCount >= this.capacity
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k]
      const isz = a.itemSize
      if (wrap) a.addUpdateRange(0, this.capacity * isz)
      else a.addUpdateRange(this.pendStart * isz, this.pendCount * isz)
      a.needsUpdate = true
    }
    this.pendCount = 0
    this.pendWrapped = false
  }

  setFrame(time: number, windX: number, windZ: number, sizeScale: number): void {
    this.uTime.value = time
    this.uWind.value.set(windX, windZ)
    this.uSizeScale.value = sizeScale
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
  }
}

// ---------------------------------------------------------------------------
// Internal pools
// ---------------------------------------------------------------------------

interface FlashSlot {
  light: THREE.PointLight
  i0: number
  decay: number
  t: number
}

interface EmitterSlot {
  active: boolean
  kind: 'smoke' | 'fire'
  rate: number
  x: number
  y: number
  z: number
  acc: number
  gen: number
}

const ADD_CAP: readonly number[] = [1600, 3000, 4500]
const ALPHA_CAP: readonly number[] = [2200, 4000, 6000]
const QUALITY_MUL: readonly number[] = [0.45, 0.7, 1]

const EMITTER_SLOTS = 32
// Bumped 6→8: muzzle flashes now throw real, brighter ground light in both
// views (see muzzleFlash), so a machine-gun burst mustn't round-robin-evict the
// shell-impact/explosion light the player values out of the shared pool.
const FLASH_POOL = 8
const TWO_PI = Math.PI * 2

// Palette (muted, Western Front)
const GAS_C0 = { r: 0.722, g: 0.722, b: 0.416 } // #b8b86a
const GAS_C1 = { r: 0.478, g: 0.541, b: 0.353 } // #7a8a5a

// ---------------------------------------------------------------------------
// EffectsSystem
// ---------------------------------------------------------------------------

export class EffectsSystem {
  private readonly scene: THREE.Scene
  private readonly atlas: THREE.CanvasTexture

  private add: ParticleLayer
  private alp: ParticleLayer

  private quality: 0 | 1 | 2 = 2
  private particleScale = 1
  private reduceFlashes = false
  /** Combined spawn-count multiplier (quality x settings). */
  private mul = 1
  /** Time-of-day darkness (0 day … 1 full dark), pushed in each frame by Game. */
  private night = 0
  /**
   * Brightness scale for dynamic fire-light under photosensitivity mode. Read by
   * RoundRenderer's tracer-light pool so it dims in lockstep with the flash
   * strobe cap. Public because RoundRenderer owns that pool but shares this
   * setting. Mirrors strobeMul()'s 0.45 factor.
   */
  lightScale = 1

  private time = 0
  private disposed = false

  // rain
  private readonly rainPts: THREE.Points
  private readonly rainMat: THREE.ShaderMaterial
  private readonly rainTime: THREE.IUniform<number>
  private readonly rainCam: THREE.IUniform<THREE.Vector3>
  private readonly rainWind: THREE.IUniform<THREE.Vector2>
  private readonly rainInt: THREE.IUniform<number>
  private readonly rainSize: THREE.IUniform<number>
  private rainIntensity = 0

  // dynamic lights
  private readonly flashSlots: FlashSlot[] = []
  private flashCursor = 0

  // continuous emitters
  private readonly emitters: EmitterSlot[] = []
  private readonly noopHandle: EmitterHandle = { move: () => undefined, stop: () => undefined }

  // gas cloud state (re-sent every frame by the sim)
  private gasData: Float32Array | null = null
  private gasCount = 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.atlas = buildAtlas()

    this.add = new ParticleLayer(ADD_CAP[this.quality], true, this.atlas)
    this.alp = new ParticleLayer(ALPHA_CAP[this.quality], false, this.atlas)
    scene.add(this.alp.points)
    scene.add(this.add.points)

    // --- rain cloud -------------------------------------------------------
    const rpos = new Float32Array(RAIN_COUNT * 3)
    const rseed = new Float32Array(RAIN_COUNT * 2)
    for (let i = 0; i < RAIN_COUNT; i++) {
      rpos[i * 3] = rr(-RAIN_BOX / 2, RAIN_BOX / 2)
      rpos[i * 3 + 1] = rr(0, RAIN_BOX)
      rpos[i * 3 + 2] = rr(-RAIN_BOX / 2, RAIN_BOX / 2)
      rseed[i * 2] = Math.random()
      rseed[i * 2 + 1] = Math.random()
    }
    const rgeo = new THREE.BufferGeometry()
    rgeo.setAttribute('position', new THREE.BufferAttribute(rpos, 3))
    rgeo.setAttribute('aSeed', new THREE.BufferAttribute(rseed, 2))
    rgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6)
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector2() },
        uIntensity: { value: 0 },
        uSizeScale: { value: 600 },
        uMap: { value: this.atlas },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    })
    this.rainTime = this.rainMat.uniforms['uTime'] as THREE.IUniform<number>
    this.rainCam = this.rainMat.uniforms['uCamPos'] as THREE.IUniform<THREE.Vector3>
    this.rainWind = this.rainMat.uniforms['uWind'] as THREE.IUniform<THREE.Vector2>
    this.rainInt = this.rainMat.uniforms['uIntensity'] as THREE.IUniform<number>
    this.rainSize = this.rainMat.uniforms['uSizeScale'] as THREE.IUniform<number>
    this.rainPts = new THREE.Points(rgeo, this.rainMat)
    this.rainPts.frustumCulled = false
    this.rainPts.matrixAutoUpdate = false
    this.rainPts.renderOrder = 22
    this.rainPts.visible = false
    scene.add(this.rainPts)

    // --- flash light pool -------------------------------------------------
    for (let i = 0; i < FLASH_POOL; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 40, 2)
      light.castShadow = false
      light.visible = false
      scene.add(light)
      this.flashSlots.push({ light, i0: 0, decay: 0.2, t: 1 })
    }

    // --- emitter slots ----------------------------------------------------
    for (let i = 0; i < EMITTER_SLOTS; i++) {
      this.emitters.push({ active: false, kind: 'smoke', rate: 0, x: 0, y: 0, z: 0, acc: 0, gen: 0 })
    }

    this.updateMul()
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  setQuality(q: 0 | 1 | 2): void {
    if (q === this.quality || this.disposed) return
    this.quality = q
    // Rebuild the two big layers at the new capacity (existing particles are
    // dropped — quality changes happen in the settings menu, not mid-firefight).
    this.scene.remove(this.add.points)
    this.scene.remove(this.alp.points)
    this.add.dispose()
    this.alp.dispose()
    this.add = new ParticleLayer(ADD_CAP[q], true, this.atlas)
    this.alp = new ParticleLayer(ALPHA_CAP[q], false, this.atlas)
    this.scene.add(this.alp.points)
    this.scene.add(this.add.points)
    this.updateMul()
  }

  setParticleScale(s: number): void {
    this.particleScale = Math.min(1, Math.max(0.25, s))
    this.updateMul()
  }

  setReduceFlashes(v: boolean): void {
    this.reduceFlashes = v
    this.lightScale = v ? 0.45 : 1
  }

  /** Push in the frame's time-of-day darkness (0 day … 1 full dark). */
  setNight(nightFactor: number): void {
    this.night = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor
  }

  private updateMul(): void {
    this.mul = QUALITY_MUL[this.quality] * this.particleScale
  }

  /** Scaled count, at least 1 (for effects that must always read). */
  private n1(base: number): number {
    const n = Math.round(base * this.mul)
    return n < 1 ? 1 : n
  }

  /** Scaled count, may be 0 (for garnish). */
  private n0(base: number): number {
    return Math.round(base * this.mul)
  }

  /** Alpha multiplier for bright strobe sprites under photosensitivity mode. */
  private strobeMul(): number {
    return this.reduceFlashes ? 0.45 : 1
  }

  // -------------------------------------------------------------------------
  // Frame update — zero allocations
  // -------------------------------------------------------------------------

  update(dt: number, camera: THREE.PerspectiveCamera, windX: number, windZ: number): void {
    if (this.disposed) return
    if (dt > 0.1) dt = 0.1
    if (dt < 0) dt = 0
    this.time += dt

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const sizeScale = (window.innerHeight * dpr) / (2 * Math.tan(camera.fov * Math.PI / 360))

    this.add.setFrame(this.time, windX, windZ, sizeScale)
    this.alp.setFrame(this.time, windX, windZ, sizeScale)

    // rain
    this.rainTime.value = this.time
    this.rainCam.value.copy(camera.position)
    this.rainWind.value.set(windX, windZ)
    this.rainInt.value = this.rainIntensity
    this.rainSize.value = sizeScale
    this.rainPts.visible = this.rainIntensity > 0.001

    // flash light envelopes
    for (let i = 0; i < this.flashSlots.length; i++) {
      const f = this.flashSlots[i]
      if (!f.light.visible) continue
      f.t += dt
      const k = 1 - f.t / f.decay
      if (k <= 0) {
        f.light.intensity = 0
        f.light.visible = false
      } else {
        f.light.intensity = f.i0 * k * k
      }
    }

    // continuous emitters
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i]
      if (!e.active) continue
      e.acc += e.rate * dt * this.mul
      let guard = 0
      while (e.acc >= 1 && guard < 24) {
        e.acc -= 1
        guard++
        if (e.kind === 'smoke') this.spawnEmitterSmoke(e.x, e.y, e.z)
        else this.spawnEmitterFire(e.x, e.y, e.z)
      }
      if (e.acc > 24) e.acc = 24
    }

    // gas cloud wisps (probabilistic per-blob churn; sim advects the blobs)
    if (this.gasData !== null && this.gasCount > 0) {
      const d = this.gasData
      let spawned = 0
      for (let i = 0; i < this.gasCount && spawned < 48; i++) {
        const o = i * 5
        const gr = d[o + 3]
        const gc = d[o + 4]
        if (gc <= 0.015 || gr <= 0.05) continue
        const expect = gc * (1.0 + gr * 0.45) * dt * this.mul
        if (Math.random() >= expect) continue
        spawned++
        const ang = Math.random() * TWO_PI
        const rad = Math.sqrt(Math.random()) * gr * 0.8
        const px = d[o] + Math.cos(ang) * rad
        const pz = d[o + 2] + Math.sin(ang) * rad
        const py = d[o + 1] + rr(0.15, 0.5 + gr * 0.15)
        const mixT = Math.random()
        const cr = GAS_C0.r + (GAS_C1.r - GAS_C0.r) * mixT
        const cg = GAS_C0.g + (GAS_C1.g - GAS_C0.g) * mixT
        const cb = GAS_C0.b + (GAS_C1.b - GAS_C0.b) * mixT
        this.alp.spawn(
          px, py, pz,
          rr(-0.25, 0.25), rr(0.02, 0.14), rr(-0.25, 0.25),
          this.time + rr(0, 0.08), rr(3.5, 6.5),
          gr * rr(0.5, 0.75), gr * rr(1.1, 1.5),
          cr, cg, cb, (0.09 + 0.09 * Math.random()) * Math.min(gc * 1.6, 1),
          Math.random() * TWO_PI, rr(-0.22, 0.22),
          -0.05, 0.85,
          SPR.GAS,
          0.3, 1.15,
          rr(0.5, 1.1),
        )
      }
    }

    this.add.flush()
    this.alp.flush()
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  explosion(
    x: number, y: number, z: number,
    radius: number,
    opts?: { big?: boolean; dirt?: boolean; water?: boolean },
  ): void {
    if (this.disposed) return
    const big = opts?.big === true
    const water = opts?.water === true
    const dirt = opts?.dirt === true && !water
    const rad = Math.min(Math.max(radius, 0.8), 14)
    const m = big ? 1.35 : 1
    const t0 = this.time
    const strobe = this.strobeMul()

    // 1) instant flash star + soft glow
    this.add.spawn(
      x, y + rad * 0.3, z, 0, 0, 0,
      t0, this.reduceFlashes ? 0.13 : 0.09,
      rad * 1.6 * m, rad * 2.4 * m,
      1, 0.9, 0.66, (water ? 0.55 : 1) * strobe,
      Math.random() * TWO_PI, 0, 0, 0,
      SPR.FLASH, 0.02, 1, 0,
    )
    this.add.spawn(
      x, y + rad * 0.35, z, 0, 0.8, 0,
      t0, 0.2,
      rad * 1.2 * m, rad * 3 * m,
      1, 0.62, 0.3, 0.5 * strobe,
      Math.random() * TWO_PI, 0, 0, 0,
      SPR.SOFT, 0.05, 1.4, 0,
    )
    if (big && !water) {
      // concussion halo
      this.add.spawn(
        x, y + 0.6, z, 0, 0, 0,
        t0, 0.45,
        rad * 1.4, rad * 5,
        1, 0.85, 0.6, 0.22 * strobe,
        0, 0, 0, 0,
        SPR.RING, 0.03, 1.6, 0,
      )
    }

    // 2) fire puffs (skipped for water hits)
    if (!water) {
      const nf = this.n1((4 + rad * 1.6) * m)
      for (let i = 0; i < nf; i++) {
        const ang = Math.random() * TWO_PI
        const sp = rr(1.5, 2.2 + rad * 1.6)
        this.add.spawn(
          x + rr(-0.3, 0.3) * rad * 0.3, y + rr(0, 0.4) * rad, z + rr(-0.3, 0.3) * rad * 0.3,
          Math.cos(ang) * sp, rr(1, 3 + rad * 0.8), Math.sin(ang) * sp,
          t0 + rr(0, 0.05), rr(0.25, 0.55),
          rad * rr(0.22, 0.3), rad * rr(0.5, 0.65),
          1, rr(0.42, 0.6), rr(0.1, 0.2), rr(0.65, 0.9),
          Math.random() * TWO_PI, rr(-3, 3),
          1.2, 0.1,
          SPR.FLAME, 0.05, 1.7, 0.4,
        )
      }
    }

    // 3) sparks / embers
    const ns = this.n0((water ? 3 : 6 + rad * 2) * m)
    for (let i = 0; i < ns; i++) {
      const ang = Math.random() * TWO_PI
      const sp = rr(5, 12 + rad * 2)
      const vy = rr(3, 9 + rad * 1.5)
      this.add.spawn(
        x, y + 0.3, z,
        Math.cos(ang) * sp * rr(0.3, 1), vy, Math.sin(ang) * sp * rr(0.3, 1),
        t0 + rr(0, 0.04), rr(0.35, 0.9),
        rr(0.09, 0.18), rr(0.04, 0.09),
        1, rr(0.65, 0.8), rr(0.3, 0.42), 0.9,
        Math.random() * TWO_PI, rr(-8, 8),
        -14, 0,
        Math.random() < 0.5 ? SPR.EMBER : SPR.SPARK, 0.02, 0.8, 0,
      )
    }

    // 4) dirt column — dark umber clods hurled up, arcing back down
    if (dirt) {
      const nd = this.n1((8 + rad * 3) * m)
      for (let i = 0; i < nd; i++) {
        const vy = rr(5, 7 + rad * 2.2)
        const life = ((2 * vy) / 9.8) * rr(0.85, 1.15)
        const shade = rr(0.75, 1.15)
        this.alp.spawn(
          x + rr(-0.25, 0.25) * rad, y + rr(0, 0.3), z + rr(-0.25, 0.25) * rad,
          rr(-1, 1) * rad * 0.9, vy, rr(-1, 1) * rad * 0.9,
          t0 + rr(0, 0.05), life,
          rad * rr(0.08, 0.16), rad * rr(0.12, 0.22),
          0.23 * shade, 0.17 * shade, 0.12 * shade, rr(0.8, 0.95),
          Math.random() * TWO_PI, rr(-5, 5),
          -9.8, 0.05,
          Math.random() < 0.5 ? SPR.DIRT_A : SPR.DIRT_B, 0.02, 0.5, 0,
        )
      }
      // low dust skirt
      const ndu = this.n0(3 * m)
      for (let i = 0; i < ndu; i++) {
        const ang = Math.random() * TWO_PI
        this.alp.spawn(
          x + Math.cos(ang) * rad * 0.5, y + 0.25, z + Math.sin(ang) * rad * 0.5,
          Math.cos(ang) * rr(1.5, 3.5), rr(0.3, 0.8), Math.sin(ang) * rr(1.5, 3.5),
          t0 + rr(0, 0.1), rr(1.8, 3.5),
          rad * 0.5, rad * rr(1.2, 1.7),
          0.35, 0.3, 0.24, rr(0.16, 0.24),
          Math.random() * TWO_PI, rr(-0.6, 0.6),
          0, 0.8,
          SPR.DUST, 0.1, 1.3, 0.3,
        )
      }
    }

    // 5) water: muddy splash column + spray instead of fire
    if (water) {
      const nw = this.n1((6 + rad * 2.5) * m)
      for (let i = 0; i < nw; i++) {
        const ang = Math.random() * TWO_PI
        const sp = rr(0.5, rad * 0.7)
        const vy = rr(5, 9 + rad * 1.6)
        const life = ((2 * vy) / 9.8) * rr(0.8, 1)
        this.alp.spawn(
          x + Math.cos(ang) * 0.3, y + 0.15, z + Math.sin(ang) * 0.3,
          Math.cos(ang) * sp, vy, Math.sin(ang) * sp,
          t0 + rr(0, 0.06), life,
          rr(0.4, 0.7) * (rad * 0.3 + 0.4), rr(0.5, 0.9) * (rad * 0.3 + 0.4),
          0.52, 0.5, 0.44, rr(0.55, 0.75),
          Math.random() * TWO_PI, rr(-1.5, 1.5),
          -9.8, 0.1,
          SPR.SPLASH, 0.03, 0.9, 0,
        )
      }
      // hanging mist
      const nm = this.n0(3 * m)
      for (let i = 0; i < nm; i++) {
        this.alp.spawn(
          x + rr(-0.5, 0.5) * rad * 0.4, y + rr(0.4, 1.2), z + rr(-0.5, 0.5) * rad * 0.4,
          rr(-0.4, 0.4), rr(0.4, 1), rr(-0.4, 0.4),
          t0 + rr(0.05, 0.25), rr(1.5, 3),
          rad * 0.45, rad * rr(1, 1.4),
          0.72, 0.72, 0.68, rr(0.18, 0.28),
          Math.random() * TWO_PI, rr(-0.4, 0.4),
          0, 0.9,
          SPR.DUST, 0.15, 1.3, 0.4,
        )
      }
    }

    // 6) lingering smoke — the thick 1916 atmosphere. Drifts with the wind.
    const nsm = this.n1((water ? 2 : 3 + rad * 1.2) * m)
    for (let i = 0; i < nsm; i++) {
      const shade = rr(0.75, 1.2)
      const spr = Math.random() < 0.34 ? SPR.SMOKE_A : Math.random() < 0.5 ? SPR.SMOKE_B : SPR.SMOKE_C
      this.alp.spawn(
        x + rr(-0.4, 0.4) * rad * 0.5, y + rr(0.2, 0.8) * rad * 0.5, z + rr(-0.4, 0.4) * rad * 0.5,
        rr(-0.35, 0.35), rr(0.5, 1.4), rr(-0.35, 0.35),
        t0 + rr(0.05, 0.4), rr(8, 14),
        rad * rr(0.45, 0.6), rad * rr(1.4, 1.9),
        0.33 * shade, 0.31 * shade, 0.285 * shade, (water ? 0.2 : rr(0.26, 0.38)) * (big ? 1.15 : 1),
        Math.random() * TWO_PI, rr(-0.25, 0.25),
        0, 1,
        spr, 0.12, 1.4, 0.25,
      )
    }

    // 7) dynamic light
    // Physical light units (candela): needs to carry a few lux tens of meters.
    this.flash(x, y + 1, z, water ? 0xcfd8e0 : 0xffa54a, rad * (big ? 260 : 150) * (water ? 0.4 : 1), big ? 0.4 : 0.26)
  }

  /**
   * `scale` shrinks the whole effect toward the muzzle. Third-person shots leave
   * it at 1; the first-person viewmodel passes a fraction so a world-scale flash
   * doesn't balloon a metre past a barrel that's only ~1m from the eye — it hugs
   * the muzzle tip instead of hanging out in front of it.
   */
  muzzleFlash(x: number, y: number, z: number, dirX: number, dirZ: number, big?: boolean, scale = 1, core = true): void {
    if (this.disposed) return
    const len = Math.hypot(dirX, dirZ)
    const dx = len > 1e-5 ? dirX / len : 0
    const dz = len > 1e-5 ? dirZ / len : -1
    const isBig = big === true
    const t0 = this.time
    const strobe = this.strobeMul()
    const sc = scale
    const s = (isBig ? 2 : 0.9) * sc

    // the flash itself, pushed slightly out of the barrel. `core` is off for the
    // first-person viewmodel, which draws its own barrel-welded flash and only
    // wants the world ejecta (sparks, smoke, brass) from here.
    if (core) this.add.spawn(
      x + dx * 0.35 * sc, y, z + dz * 0.35 * sc, dx * 1.5 * sc, 0.2, dz * 1.5 * sc,
      t0, this.reduceFlashes ? rr(0.07, 0.1) : rr(0.05, 0.08),
      s * rr(0.85, 1.15), s * rr(0.55, 0.75),
      1, 0.88, 0.58, 0.95 * strobe,
      Math.random() * TWO_PI, 0, 0, 0,
      SPR.FLASH, 0.02, 0.9, 0,
    )
    // sparks kicked forward
    const ns = this.n0(isBig ? 4 : 2)
    for (let i = 0; i < ns; i++) {
      const sp = rr(7, 16) * (isBig ? 1.5 : 1) * sc
      this.add.spawn(
        x + dx * 0.4 * sc, y, z + dz * 0.4 * sc,
        dx * sp + rr(-2, 2) * sc, rr(0.5, 2.5) * sc, dz * sp + rr(-2, 2) * sc,
        t0, rr(0.08, 0.22),
        rr(0.08, 0.16) * s, rr(0.03, 0.07) * s,
        1, 0.78, 0.42, 0.85,
        Math.random() * TWO_PI, 0, -6, 0,
        SPR.SPARK, 0.02, 0.8, 0,
      )
    }
    // powder smoke curling off the muzzle
    if (Math.random() < (isBig ? 1 : 0.45) * this.mul) {
      this.alp.spawn(
        x + dx * 0.7 * sc, y + 0.1, z + dz * 0.7 * sc,
        dx * rr(0.8, 1.5) * sc, rr(0.3, 0.7), dz * rr(0.8, 1.5) * sc,
        t0 + 0.02, rr(1.2, 2.4) * (isBig ? 1.6 : 1),
        rr(0.18, 0.3) * s, rr(0.7, 1.1) * s,
        0.5, 0.48, 0.45, rr(0.14, 0.22),
        Math.random() * TWO_PI, rr(-0.8, 0.8),
        0, 1,
        SPR.SMOKE_B, 0.12, 1.3, 0.2,
      )
    }
    // Brass casing flicked out to the side — rifles/MGs only, not artillery.
    if (!isBig && Math.random() < 0.7 * this.mul + 0.15) {
      const bx = -dz, bz = dx // perpendicular to the line of fire
      this.alp.spawn(
        x + dx * 0.05 * sc, y + 0.02, z + dz * 0.05 * sc,
        bx * rr(1.4, 2.6) + dx * rr(-0.3, 0.4), rr(1.6, 2.8), bz * rr(1.4, 2.6) + dz * rr(-0.3, 0.4),
        t0, rr(0.5, 0.85),
        0.04, 0.032,
        0.72, 0.55, 0.24, 0.95,
        Math.random() * TWO_PI, rr(-14, 14),
        -9.8, 0,
        SPR.DEBRIS, 0.02, 0.5, 0,
      )
    }
    // A pop of dynamic light so muzzle fire actually lights the mud. Fires in
    // BOTH views now — `core` gates only the world flash SPRITE (the first-person
    // viewmodel draws its own barrel-welded flash), but the ground light is
    // called with the true world muzzle position either way, so first person
    // finally gets the same warm pool on the trench floor that third person does.
    // Scaled by `night`: a subtle warm lick by day, a real stab of light after
    // dark. Warm-tinted (never white) so bloom + chromatic aberration clip warm.
    // Pushed a touch further down-range so the inverse-square falloff spares the
    // camera-close viewmodel barrel (which the barrel-welded flash sprite already
    // lights) and lands its warm pool out on the mud where it's wanted — this is
    // what stops a boresighted burst white-clipping the near gun into a CA fringe.
    if (isBig) {
      this.flash(x + dx * 1.8 * sc, y + 0.35, z + dz * 1.8 * sc, 0xffc070, 80 + this.night * 90, 0.14)
    } else {
      this.flash(x + dx * 1.0 * sc, y + 0.12, z + dz * 1.0 * sc, 0xffb45a, 32 + this.night * 55, 0.07)
    }
  }

  /**
   * One faint drifting wisp of powder smoke left hanging behind a tracer round.
   * Called probabilistically per round per frame by the RoundRenderer, so a
   * burst threads smoke down-range without flooding the pool.
   */
  tracerTrail(x: number, y: number, z: number): void {
    if (this.disposed) return
    this.alp.spawn(
      x, y, z,
      rr(-0.1, 0.1), rr(0.15, 0.45), rr(-0.1, 0.1),
      this.time, rr(0.35, 0.6),
      0.08, rr(0.26, 0.42),
      0.82, 0.78, 0.66, 0.16 * this.strobeMul() + 0.02,
      Math.random() * TWO_PI, rr(-0.4, 0.4),
      0, 0.9,
      SPR.SOFT, 0.15, 1.2, 0.2,
    )
  }

  /**
   * The terminal mark of a physical round: a material-correct puff, kicked
   * debris, and — on a hard shallow strike — a bright ricochet spark fan and a
   * pop of light. The sim resolves the surface at the point of impact; this
   * only decides how it looks.
   */
  impact(
    surface: import('../core/types').ImpactSurface,
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    spark: boolean,
  ): void {
    if (this.disposed) return
    const t0 = this.time
    let nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-4) { nx = 0; ny = 1; nz = 0; nl = 1 }
    nx /= nl; ny /= nl; nz /= nl

    // Flesh: a brief dark spray thrown back off the wound. The blood that
    // settles on a kill is handled separately — this is the strike itself.
    // `nx/ny/nz` IS -velocity here (see ballistics.ts's impact fx call for
    // 'flesh'), so everything below throws back roughly toward the shooter.
    if (surface === 'flesh') {
      // Main spray — unchanged in spirit, just now respecting `mul` like every
      // other spawn in this file (it never did before; low-particle-density
      // settings should thin this out same as everything else).
      const n = this.n1(3 + (Math.random() < 0.5 ? 1 : 0))
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * TWO_PI
        const sp = rr(0.6, 2.2)
        this.alp.spawn(
          x, y, z,
          nx * rr(1, 3) + Math.cos(ang) * sp, ny * rr(0.5, 1.8) + rr(0.3, 1), nz * rr(1, 3) + Math.sin(ang) * sp,
          t0, rr(0.22, 0.45),
          rr(0.06, 0.12), rr(0.13, 0.24),
          0.34, 0.05, 0.04, rr(0.4, 0.55),
          Math.random() * TWO_PI, rr(-2, 2),
          -6, 0,
          SPR.SOFT, 0.04, 1.1, 0,
        )
      }
      // A tighter, faster cone hugging -velocity: a couple of small droplets
      // flicked harder and straighter than the main spray above, arcing under
      // full gravity so they read as flung matter rather than settling haze.
      // Jitter is a small offset off the cone axis, not a full-circle fan —
      // that's what keeps this "tight" next to the wider spray it sits inside.
      const nb = this.n0(2)
      for (let i = 0; i < nb; i++) {
        const jx = rr(-0.4, 0.4), jz = rr(-0.4, 0.4)
        this.alp.spawn(
          x, y, z,
          nx * rr(3, 6) + jx * 2, ny * rr(2, 4) + rr(0.5, 1.5), nz * rr(3, 6) + jz * 2,
          t0 + rr(0, 0.02), rr(0.18, 0.32),
          rr(0.05, 0.09), rr(0.1, 0.17),
          0.3, 0.04, 0.035, rr(0.45, 0.6),
          Math.random() * TWO_PI, rr(-3, 3),
          -9.8, 0,
          SPR.SOFT, 0.03, 1, 0,
        )
      }
      // One faint low mist hanging at the wound — restrained, memorial not
      // spectacle (see blood()'s comment below, which holds for this too).
      this.alp.spawn(
        x, y + rr(-0.05, 0.1), z,
        rr(-0.15, 0.15), rr(0.1, 0.3), rr(-0.15, 0.15),
        t0 + rr(0, 0.05), rr(0.5, 0.9),
        rr(0.08, 0.12), rr(0.22, 0.32),
        0.28, 0.05, 0.045, rr(0.14, 0.2) * this.strobeMul(),
        Math.random() * TWO_PI, rr(-0.3, 0.3),
        -1, 0.3,
        SPR.DUST, 0.08, 1.2, 0.15,
      )
      return
    }

    // Dust puff palette + debris count per surface.
    let pr = 0.42, pg = 0.36, pb = 0.28, puffA = 0.5, clods = 3, wet = false
    let puffSpr: number = SPR.DUST
    if (surface === 'steel') { pr = 0.62; pg = 0.63; pb = 0.6; puffA = 0.38; clods = 0 }
    else if (surface === 'sandbag') { pr = 0.62; pg = 0.55; pb = 0.4; puffA = 0.6; clods = 2 }
    else if (surface === 'mud') { pr = 0.26; pg = 0.22; pb = 0.17; puffA = 0.6; clods = 4; wet = true }
    else if (surface === 'water') { pr = 0.52; pg = 0.55; pb = 0.54; puffA = 0.5; clods = 3; wet = true; puffSpr = SPR.SPLASH }

    // The puff, pushed out along the surface normal.
    this.alp.spawn(
      x + nx * 0.1, y + ny * 0.1 + 0.04, z + nz * 0.1,
      nx * rr(0.6, 1.4), rr(0.4, 1) + ny * 0.6, nz * rr(0.6, 1.4),
      t0, rr(0.35, 0.6),
      rr(0.26, 0.4), rr(0.55, 0.9),
      pr, pg, pb, puffA * rr(0.75, 1) * this.strobeMul(),
      Math.random() * TWO_PI, rr(-0.5, 0.5),
      0, 0.8,
      puffSpr, 0.06, 1.2, 0.2,
    )

    // Kicked clods / spray. Mud and dirt punch a taller, NARROWER geyser than
    // a generic kick — a round striking loose ground drives debris mostly UP
    // through the hole it just made, not sideways — while a sandbagged
    // parapet throws actual hessian-fibre chunks (DEBRIS), not clods of earth.
    const geyser = surface === 'mud' || surface === 'dirt'
    const spLo = geyser ? 0.4 : 1.5, spHi = geyser ? 1.6 : 5
    const vyLo = geyser ? 4 : 2, vyHi = geyser ? 9 : 6
    const nc = this.n0(clods)
    for (let i = 0; i < nc; i++) {
      const ang = Math.random() * TWO_PI
      const sp = rr(spLo, spHi)
      const vy = rr(vyLo, vyHi)
      const life = ((2 * vy) / 9.8) * rr(0.8, 1.1)
      const shade = rr(0.75, 1.15)
      const spr = surface === 'sandbag'
        ? SPR.DEBRIS
        : wet && Math.random() < 0.5 ? SPR.SPLASH : (Math.random() < 0.5 ? SPR.DIRT_A : SPR.DIRT_B)
      this.alp.spawn(
        x, y + 0.05, z,
        nx * sp * 0.4 + Math.cos(ang) * sp, vy, nz * sp * 0.4 + Math.sin(ang) * sp,
        t0 + rr(0, 0.03), life,
        rr(0.06, 0.14), rr(0.08, 0.18),
        pr * shade, pg * shade, pb * shade, rr(0.7, 0.9),
        Math.random() * TWO_PI, rr(-6, 6),
        -9.8, 0,
        spr, 0.02, 0.5, 0,
      )
    }

    // Mud/dirt: the low skirt of dust every real geyser throws out sideways
    // at ground level even while the clods themselves go mostly straight up.
    if (geyser) {
      const ndu = this.n0(2)
      for (let i = 0; i < ndu; i++) {
        const ang = Math.random() * TWO_PI
        const shade = rr(0.75, 1.15)
        this.alp.spawn(
          x + Math.cos(ang) * 0.12, y + 0.05, z + Math.sin(ang) * 0.12,
          Math.cos(ang) * rr(0.6, 1.3), rr(0.15, 0.4), Math.sin(ang) * rr(0.6, 1.3),
          t0 + rr(0, 0.05), rr(0.8, 1.5),
          rr(0.12, 0.2), rr(0.3, 0.46),
          pr * shade, pg * shade, pb * shade, rr(0.14, 0.2),
          Math.random() * TWO_PI, rr(-0.5, 0.5),
          0, 0.7,
          SPR.DUST, 0.08, 1.2, 0.2,
        )
      }
    }

    // Sparks: always a couple off steel, otherwise only on a real ricochet.
    // Steel gets its own brighter, tighter, shorter-lived fan — this is the
    // one surface where sparks should really pop, not just accompany a puff.
    if (spark || surface === 'steel') {
      const isSteel = surface === 'steel'
      const nsp = this.n1(isSteel ? 6 : 2)
      for (let i = 0; i < nsp; i++) {
        const ang = Math.random() * TWO_PI
        const sp = rr(4, 12)
        // Tighter fan: more of the kick goes into the directional (nx/nz)
        // term and less into the perpendicular scatter than the generic case.
        const fan = isSteel ? 0.32 : 0.5
        const dirLo = isSteel ? 4 : 2, dirHi = isSteel ? 8 : 5
        this.add.spawn(
          x + nx * 0.05, y + ny * 0.05 + 0.04, z + nz * 0.05,
          nx * rr(dirLo, dirHi) + Math.cos(ang) * sp * fan,
          ny * rr(1, 3) + rr(1, 4),
          nz * rr(dirLo, dirHi) + Math.sin(ang) * sp * fan,
          t0, isSteel ? rr(0.06, 0.16) : rr(0.12, 0.3),
          rr(0.08, 0.14), rr(0.02, 0.05),
          1, isSteel ? 0.86 : 0.8, isSteel ? 0.5 : 0.42, (isSteel ? 1 : 0.9) * this.strobeMul(),
          Math.random() * TWO_PI, 0,
          -10, 0,
          SPR.SPARK, 0.02, 0.8, 0,
        )
      }
      if (spark) this.flash(x + nx * 0.2, y + 0.2, z + nz * 0.2, 0xffd08a, 30, 0.06)
    }

    // Steel: a thin wisp of smoke off the hot strike point, on top of the
    // spark fan and the existing ricochet light pop above.
    if (surface === 'steel') {
      const nsm = this.n0(1)
      for (let i = 0; i < nsm; i++) {
        this.alp.spawn(
          x + nx * 0.1, y + ny * 0.1 + 0.06, z + nz * 0.1,
          nx * rr(0.2, 0.5), rr(0.4, 0.8), nz * rr(0.2, 0.5),
          t0 + rr(0, 0.05), rr(0.5, 0.9),
          rr(0.08, 0.14), rr(0.24, 0.36),
          0.55, 0.53, 0.5, rr(0.14, 0.2),
          Math.random() * TWO_PI, rr(-0.4, 0.4),
          0, 0.9,
          SPR.SMOKE_B, 0.08, 1.2, 0.15,
        )
      }
    }
  }

  dirtBurst(x: number, y: number, z: number, amount: number): void {
    if (this.disposed) return
    let n = Math.round(amount * this.mul)
    if (n < 1) n = 1
    else if (n > 40) n = 40
    const t0 = this.time
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TWO_PI
      const sp = rr(0.5, 2.2)
      const vy = rr(2, 6)
      const life = ((2 * vy) / 9.8) * rr(0.8, 1.1)
      const shade = rr(0.75, 1.15)
      this.alp.spawn(
        x, y + 0.05, z,
        Math.cos(ang) * sp, vy, Math.sin(ang) * sp,
        t0 + rr(0, 0.03), life,
        rr(0.08, 0.2), rr(0.1, 0.24),
        0.24 * shade, 0.18 * shade, 0.125 * shade, rr(0.75, 0.9),
        Math.random() * TWO_PI, rr(-6, 6),
        -9.8, 0,
        Math.random() < 0.5 ? SPR.DIRT_A : SPR.DIRT_B, 0.02, 0.6, 0,
      )
    }
    // one small dust breath
    this.alp.spawn(
      x, y + 0.15, z,
      rr(-0.3, 0.3), rr(0.3, 0.7), rr(-0.3, 0.3),
      t0, rr(0.8, 1.5),
      rr(0.25, 0.4), rr(0.7, 1.1),
      0.4, 0.35, 0.28, rr(0.12, 0.18),
      Math.random() * TWO_PI, rr(-0.5, 0.5),
      0, 0.7,
      SPR.DUST, 0.08, 1.2, 0.2,
    )
  }

  debris(x: number, y: number, z: number): void {
    if (this.disposed) return
    const t0 = this.time
    const n = this.n1(7)
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TWO_PI
      const sp = rr(2, 9)
      const vy = rr(3, 10)
      const life = ((2 * vy) / 9.8) * rr(0.85, 1.1)
      const shade = rr(0.6, 1.1)
      this.alp.spawn(
        x, y + 0.2, z,
        Math.cos(ang) * sp, vy, Math.sin(ang) * sp,
        t0 + rr(0, 0.03), life,
        rr(0.12, 0.3), rr(0.1, 0.26),
        0.21 * shade, 0.17 * shade, 0.13 * shade, 0.95,
        Math.random() * TWO_PI, rr(-11, 11),
        -9.8, 0,
        Math.random() < 0.6 ? SPR.DEBRIS : SPR.DIRT_B, 0.02, 0.4, 0,
      )
    }
    // couple of sparks + a dust wisp
    const nsp = this.n0(3)
    for (let i = 0; i < nsp; i++) {
      const ang = Math.random() * TWO_PI
      this.add.spawn(
        x, y + 0.2, z,
        Math.cos(ang) * rr(3, 8), rr(2, 7), Math.sin(ang) * rr(3, 8),
        t0, rr(0.2, 0.5),
        rr(0.08, 0.14), rr(0.03, 0.06),
        1, 0.72, 0.35, 0.85,
        Math.random() * TWO_PI, rr(-6, 6),
        -12, 0,
        SPR.SPARK, 0.02, 0.8, 0,
      )
    }
    this.alp.spawn(
      x, y + 0.3, z,
      rr(-0.3, 0.3), rr(0.5, 1), rr(-0.3, 0.3),
      t0, rr(1.5, 3),
      0.4, rr(1, 1.5),
      0.35, 0.32, 0.28, rr(0.15, 0.22),
      Math.random() * TWO_PI, rr(-0.5, 0.5),
      0, 0.9,
      SPR.SMOKE_C, 0.1, 1.3, 0.25,
    )
  }

  blood(x: number, y: number, z: number): void {
    if (this.disposed) return
    // Restraint: a few brief dark puffs that settle. Memorial, not spectacle.
    const t0 = this.time
    const n = 4 + (Math.random() < 0.5 ? 2 : 0)
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TWO_PI
      const sp = rr(0.4, 1.6)
      const shade = rr(0.8, 1.15)
      this.alp.spawn(
        x, y + rr(-0.1, 0.2), z,
        Math.cos(ang) * sp, rr(0.4, 1.4), Math.sin(ang) * sp,
        t0 + rr(0, 0.03), rr(0.35, 0.7),
        rr(0.1, 0.18), rr(0.24, 0.4),
        0.3 * shade, 0.05 * shade, 0.045 * shade, rr(0.4, 0.55),
        Math.random() * TWO_PI, rr(-1.5, 1.5),
        -5, 0.1,
        Math.random() < 0.5 ? SPR.SOFT : SPR.DUST, 0.05, 1.2, 0,
      )
    }
  }

  flame(x: number, y: number, z: number, dirX: number, dirZ: number, length: number): void {
    if (this.disposed) return
    const dl = Math.hypot(dirX, dirZ)
    const dx = dl > 1e-5 ? dirX / dl : 0
    const dz = dl > 1e-5 ? dirZ / dl : -1
    const px = -dz // perpendicular for spread
    const pz = dx
    const reach = Math.max(length, 2)
    const speed = reach / 0.45
    const t0 = this.time
    const n = this.n1(4)
    for (let i = 0; i < n; i++) {
      const spd = speed * rr(0.7, 1.05)
      const side = rr(-1, 1) * speed * 0.14
      const heat = Math.random()
      this.add.spawn(
        x + dx * rr(0, 0.6) + px * rr(-0.15, 0.15), y + rr(-0.1, 0.15), z + dz * rr(0, 0.6) + pz * rr(-0.15, 0.15),
        dx * spd + px * side, rr(0.4, 1.6), dz * spd + pz * side,
        t0 + rr(0, 0.04), rr(0.3, 0.5),
        rr(0.2, 0.32), rr(0.75, 1.05) + reach * 0.1,
        1, 0.45 + heat * 0.35, 0.12 + heat * 0.3, rr(0.6, 0.85),
        Math.random() * TWO_PI, rr(-4, 4),
        2.5, 0.15,
        SPR.FLAME, 0.02, 1.8, 1.4,
      )
    }
    // oily black after-smoke, further down-range
    const nsm = this.n0(1.6)
    for (let i = 0; i < nsm; i++) {
      const f = rr(0.35, 1)
      this.alp.spawn(
        x + dx * reach * f + px * rr(-0.5, 0.5), y + rr(0.2, 0.6), z + dz * reach * f + pz * rr(-0.5, 0.5),
        dx * rr(0.5, 1.4), rr(0.8, 1.7), dz * rr(0.5, 1.4),
        t0 + rr(0.1, 0.3), rr(1.5, 3.2),
        rr(0.35, 0.55), rr(1.3, 1.9),
        0.09, 0.08, 0.075, rr(0.28, 0.4),
        Math.random() * TWO_PI, rr(-0.9, 0.9),
        0, 1,
        Math.random() < 0.5 ? SPR.SMOKE_A : SPR.SMOKE_C, 0.15, 1.3, 0.5,
      )
    }
  }

  smokePuff(x: number, y: number, z: number, size: number): void {
    if (this.disposed) return
    const s = Math.max(size, 0.3)
    const t0 = this.time
    const n = this.n1(2.4)
    for (let i = 0; i < n; i++) {
      const shade = rr(0.85, 1.2)
      const spr = Math.random() < 0.34 ? SPR.SMOKE_A : Math.random() < 0.5 ? SPR.SMOKE_B : SPR.SMOKE_C
      this.alp.spawn(
        x + rr(-0.25, 0.25) * s, y + rr(0, 0.3) * s, z + rr(-0.25, 0.25) * s,
        rr(-0.25, 0.25), rr(0.35, 0.9), rr(-0.25, 0.25),
        t0 + rr(0, 0.2), rr(4, 9) * (0.7 + Math.min(s, 3) * 0.15),
        s * rr(0.4, 0.6), s * rr(1.2, 1.7),
        0.47 * shade, 0.45 * shade, 0.42 * shade, rr(0.24, 0.34),
        Math.random() * TWO_PI, rr(-0.3, 0.3),
        0, 1,
        spr, 0.12, 1.35, 0.25,
      )
    }
  }

  steam(x: number, y: number, z: number): void {
    if (this.disposed) return
    const t0 = this.time
    const n = this.n1(2)
    for (let i = 0; i < n; i++) {
      this.alp.spawn(
        x + rr(-0.12, 0.12), y + rr(0, 0.15), z + rr(-0.12, 0.12),
        rr(-0.2, 0.2), rr(1.1, 2), rr(-0.2, 0.2),
        t0 + rr(0, 0.12), rr(0.9, 1.9),
        rr(0.14, 0.24), rr(0.55, 0.85),
        0.85, 0.85, 0.83, rr(0.28, 0.4),
        Math.random() * TWO_PI, rr(-0.8, 0.8),
        0, 0.6,
        Math.random() < 0.5 ? SPR.SOFT : SPR.SMOKE_B, 0.12, 1.4, 0.3,
      )
    }
  }

  emitter(x: number, y: number, z: number, kind: 'smoke' | 'fire', rate: number): EmitterHandle {
    if (this.disposed) return this.noopHandle
    let slot: EmitterSlot | null = null
    for (let i = 0; i < this.emitters.length; i++) {
      if (!this.emitters[i].active) {
        slot = this.emitters[i]
        break
      }
    }
    if (slot === null) return this.noopHandle
    const e = slot
    e.active = true
    e.kind = kind
    e.rate = Math.max(rate, 0)
    e.x = x
    e.y = y
    e.z = z
    e.acc = 0
    e.gen++
    const gen = e.gen
    return {
      move: (nx: number, ny: number, nz: number): void => {
        if (e.gen === gen) {
          e.x = nx
          e.y = ny
          e.z = nz
        }
      },
      stop: (): void => {
        if (e.gen === gen) e.active = false
      },
    }
  }

  private spawnEmitterSmoke(x: number, y: number, z: number): void {
    const shade = rr(0.5, 0.9)
    const spr = Math.random() < 0.34 ? SPR.SMOKE_A : Math.random() < 0.5 ? SPR.SMOKE_B : SPR.SMOKE_C
    this.alp.spawn(
      x + rr(-0.3, 0.3), y + rr(0, 0.3), z + rr(-0.3, 0.3),
      rr(-0.2, 0.2), rr(0.7, 1.3), rr(-0.2, 0.2),
      this.time, rr(3.5, 7),
      rr(0.5, 0.75), rr(1.9, 2.6),
      0.22 * shade, 0.21 * shade, 0.2 * shade, rr(0.26, 0.36),
      Math.random() * TWO_PI, rr(-0.4, 0.4),
      0, 1,
      spr, 0.14, 1.35, 0.3,
    )
  }

  private spawnEmitterFire(x: number, y: number, z: number): void {
    const heat = Math.random()
    this.add.spawn(
      x + rr(-0.25, 0.25), y + rr(0, 0.2), z + rr(-0.25, 0.25),
      rr(-0.3, 0.3), rr(1, 2.4), rr(-0.3, 0.3),
      this.time, rr(0.3, 0.6),
      rr(0.4, 0.6), rr(0.8, 1.15),
      1, 0.42 + heat * 0.3, 0.1 + heat * 0.2, rr(0.5, 0.75),
      Math.random() * TWO_PI, rr(-3, 3),
      1.5, 0.1,
      SPR.FLAME, 0.05, 1.7, 0.8,
    )
    if (Math.random() < 0.22) {
      this.add.spawn(
        x, y + 0.3, z,
        rr(-1.2, 1.2), rr(2, 4.5), rr(-1.2, 1.2),
        this.time, rr(0.4, 0.9),
        rr(0.06, 0.1), rr(0.02, 0.05),
        1, 0.68, 0.3, 0.85,
        0, 0, -7, 0.2,
        SPR.EMBER, 0.02, 0.9, 0.3,
      )
    }
  }

  setGasBlobs(data: Float32Array, count: number): void {
    this.gasData = data
    this.gasCount = Math.max(0, Math.min(count, Math.floor(data.length / 5)))
  }

  rain(intensity: number): void {
    this.rainIntensity = clamp01(intensity)
  }

  flash(x: number, y: number, z: number, color: number, intensity: number, decaySec: number): void {
    if (this.disposed) return
    const f = this.flashSlots[this.flashCursor]
    this.flashCursor = (this.flashCursor + 1) % this.flashSlots.length
    f.light.position.set(x, y, z)
    f.light.color.setHex(color)
    f.i0 = intensity * (this.reduceFlashes ? 0.4 : 1)
    f.decay = Math.max(decaySec, 0.05)
    f.t = 0
    f.light.intensity = f.i0
    f.light.distance = Math.min(12 + intensity * 0.15, 80)
    f.light.visible = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scene.remove(this.add.points)
    this.scene.remove(this.alp.points)
    this.add.dispose()
    this.alp.dispose()
    this.scene.remove(this.rainPts)
    this.rainPts.geometry.dispose()
    this.rainMat.dispose()
    for (let i = 0; i < this.flashSlots.length; i++) {
      const f = this.flashSlots[i]
      this.scene.remove(f.light)
      f.light.dispose()
    }
    this.flashSlots.length = 0
    for (let i = 0; i < this.emitters.length; i++) this.emitters[i].active = false
    this.gasData = null
    this.gasCount = 0
    this.atlas.dispose()
  }
}
