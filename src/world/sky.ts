/**
 * Sky dome, sun/moon lighting, fog, and the pooled flare lights.
 * Time of day is continuous: dawn stand-tos, high noon, night assaults under
 * drifting parachute flares.
 *
 * The sun's shadow frustum is a tight ~140m box that tracks a focus point
 * (see `setFocus`) instead of covering the whole map, so close-up shadow
 * resolution stays sharp. Call `setFocus` once per frame with whatever the
 * active camera is actually looking at (defaults to the world origin).
 */
import * as THREE from 'three'

const ZENITH_DAY = new THREE.Color(0x7d8ba0)     // Flanders sky: pale, never postcard-blue
const HORIZON_DAY = new THREE.Color(0xbcab7e)    // dust, smoke and distance
const ZENITH_NIGHT = new THREE.Color(0x0a0d16)
const HORIZON_NIGHT = new THREE.Color(0x1a1c1e)
const ZENITH_DUSK = new THREE.Color(0x4a4a5e)
const HORIZON_DUSK = new THREE.Color(0xb06b3a)   // the famous dirty orange, evenings
const ZENITH_DAWN = new THREE.Color(0x5c4a63)    // bruised mauve, mornings
const HORIZON_DAWN = new THREE.Color(0xb98a8a)   // dusky rose over the wire
const SUN_WARM = new THREE.Color(0xffe8c4)
const SUN_LOW = new THREE.Color(0xff9d5c)        // evening sun
const SUN_DAWN = new THREE.Color(0xffb49a)       // morning sun
const MOON = new THREE.Color(0x8a95b5)
const RAIN_GREY = new THREE.Color(0x555a5e)

// Sun shadow frustum: a small box that follows a focus point rather than a
// fixed frustum sized for the whole map. Keeps shadow texels small (sharp)
// right where the camera is looking, at the cost of shadows fading out past
// the box edges elsewhere. 140m square, texel-snapped to avoid shimmer.
const SHADOW_BOX_HALF = 70
const SHADOW_DIST = 320    // fixed light-to-focus distance along the sun direction
const SHADOW_NEAR = 140
const SHADOW_FAR = 520

export class Sky {
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly moonLight: THREE.DirectionalLight
  readonly dome: THREE.Mesh
  readonly flarePool: THREE.PointLight[] = []
  private stars: THREE.Points
  private domeUniforms: {
    uZenith: { value: THREE.Color }
    uHorizon: { value: THREE.Color }
    uSunDir: { value: THREE.Vector3 }
    uSunGlow: { value: number }
    uTime: { value: number }
    uHaze: { value: number }
    uCloudAmount: { value: number }
    uCloudBrightness: { value: number }
  }
  private fog: THREE.FogExp2
  private sunDir = new THREE.Vector3(0, 1, 0)
  private focusX = 0
  private focusZ = 0

  constructor(scene: THREE.Scene) {
    // -- lights --
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    // Bias tuned for the ~140m/2048px focus box (~0.07m/texel). A tight box
    // needs far less slope-scaled bias than a whole-map frustum did — too
    // much here just reintroduces peter-panning.
    this.sun.shadow.bias = -0.00035
    this.sun.shadow.normalBias = 0.12
    scene.add(this.sun, this.sun.target)
    this.applySunTransform() // sane initial frustum before the first setConditions() call

    this.moonLight = new THREE.DirectionalLight(MOON, 0)
    scene.add(this.moonLight, this.moonLight.target)

    this.hemi = new THREE.HemisphereLight(0x9aa4b0, 0x4a4436, 0.55)
    scene.add(this.hemi)

    // -- flare pool (parachute flares at night) --
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffe9b0, 0, 200, 2)
      l.visible = false
      scene.add(l)
      this.flarePool.push(l)
    }

    // -- dome --
    this.domeUniforms = {
      uZenith: { value: ZENITH_DAY.clone() },
      uHorizon: { value: HORIZON_DAY.clone() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunGlow: { value: 1 },
      uTime: { value: 0 },
      uHaze: { value: 0.3 },
      uCloudAmount: { value: 0.35 },
      uCloudBrightness: { value: 1 },
    }
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.domeUniforms,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform float uSunGlow;
        uniform float uTime, uHaze, uCloudAmount, uCloudBrightness;
        varying vec3 vDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        float fbm(vec2 p) {
          float v = 0.0, amp = 0.5;
          for (int i = 0; i < 4; i++) { v += amp * noise(p); p *= 2.03; amp *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));

          // Horizon haze band: dust and distance thicken the sky low down.
          float hazeBand = 1.0 - smoothstep(0.0, 0.22, h);
          col = mix(col, uHorizon * 1.12, hazeBand * uHaze);

          // Drifting cloud layer: cheap fbm sheared across the dome, faded
          // out near the zenith and behind the horizon.
          float cloudMask = smoothstep(0.02, 0.3, h) * (1.0 - smoothstep(0.7, 1.0, h));
          if (cloudMask > 0.001) {
            vec2 cuv = dir.xz / max(h, 0.1) * 0.12 + vec2(uTime * 0.012, uTime * 0.007);
            float clouds = fbm(cuv);
            clouds = smoothstep(0.42, 0.88, clouds) * cloudMask * uCloudAmount;
            vec3 cloudColor = mix(vec3(uCloudBrightness), uHorizon, 0.3);
            col = mix(col, cloudColor, clouds);
          }

          // Sun disc + glow.
          float s = max(dot(dir, uSunDir), 0.0);
          col += vec3(1.0, 0.75, 0.45) * pow(s, 220.0) * 1.4 * uSunGlow;  // disc
          col += vec3(1.0, 0.6, 0.3) * pow(s, 6.0) * 0.16 * uSunGlow;     // haze
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), domeMat)
    this.dome.frustumCulled = false
    scene.add(this.dome)

    // -- stars --
    const starCount = 420
    const sp = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
      const az = Math.random() * Math.PI * 2
      const el = Math.random() * Math.PI * 0.48 + 0.05
      sp[i * 3] = Math.cos(el) * Math.cos(az) * 860
      sp[i * 3 + 1] = Math.sin(el) * 860
      sp[i * 3 + 2] = Math.cos(el) * Math.sin(az) * 860
    }
    const sgeo = new THREE.BufferGeometry()
    sgeo.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    this.stars = new THREE.Points(sgeo, new THREE.PointsMaterial({
      color: 0xcdd4e8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false,
    }))
    this.stars.frustumCulled = false
    scene.add(this.stars)

    this.fog = new THREE.FogExp2(HORIZON_DAY.getHex(), 0.0026)
    scene.fog = this.fog
  }

  /**
   * Re-centers the tight sun shadow frustum on a focus point (e.g. the
   * active camera's look-at target, or the player in first-person). Safe to
   * call every frame — cheap CPU-side matrix bookkeeping only. Defaults to
   * the world origin if never called.
   */
  setFocus(x: number, z: number): void {
    this.focusX = x
    this.focusZ = z
    this.applySunTransform()
  }

  /**
   * Raises/lowers the sun shadow map resolution (1024 / 2048 / 4096). Default
   * is 2048 without ever calling this. Pair with GameRenderer.setQuality —
   * e.g. call `sky.setShadowQuality(q)` alongside `renderer.setQuality(q, ...)`
   * to get 4096 at quality 2.
   */
  setShadowQuality(q: 0 | 1 | 2): void {
    const size = q >= 2 ? 4096 : q === 0 ? 1024 : 2048
    if (this.sun.shadow.mapSize.x === size) return
    this.sun.shadow.mapSize.set(size, size)
    this.sun.shadow.map?.dispose()
    this.sun.shadow.map = null
  }

  /**
   * tod: 0 = midnight, 0.5 = noon. fogAmount 0..1 (weather), battle glowNorth
   * adds a faint artillery-fire glow on the horizon at night.
   */
  setConditions(tod: number, fogAmount: number, rain: number): void {
    const sunAngle = (tod - 0.25) * Math.PI * 2 // sunrise 06:00 in the east
    const elev = Math.sin(sunAngle)
    const east = Math.cos(sunAngle)
    // Sun path: east → south → west (battlefield faces north).
    const dir = new THREE.Vector3(east, Math.max(elev, -0.3), 0.45).normalize()
    this.sunDir.copy(dir)
    this.domeUniforms.uSunDir.value.copy(dir)
    this.applySunTransform()

    const day = smooth01((elev + 0.12) / 0.35)         // 0 night → 1 day
    const dusk = Math.max(0, 1 - Math.abs(elev) / 0.28) // near horizon
    const isMorning = tod < 0.5

    // Lighting
    const overcast = 1 - rain * 0.55 - fogAmount * 0.3
    this.sun.intensity = (0.15 + day * 2.8) * Math.max(0.28, overcast)
    this.sun.color.copy(SUN_WARM).lerp(isMorning ? SUN_DAWN : SUN_LOW, dusk)
    this.sun.visible = elev > -0.06
    this.moonLight.position.set(-east * 200, Math.max(0.2, -elev) * 260, -120)
    this.moonLight.intensity = (1 - day) * 0.3
    this.hemi.intensity = 0.16 + day * 0.95 * Math.max(0.4, overcast)
    this.domeUniforms.uSunGlow.value = day * Math.max(0.15, 1 - rain * 0.8)

    // Sky colors
    const zen = this.domeUniforms.uZenith.value
    const hor = this.domeUniforms.uHorizon.value
    zen.copy(ZENITH_NIGHT).lerp(ZENITH_DAY, day)
    hor.copy(HORIZON_NIGHT).lerp(HORIZON_DAY, day)
    if (dusk > 0) {
      const zenTarget = isMorning ? ZENITH_DAWN : ZENITH_DUSK
      const horTarget = isMorning ? HORIZON_DAWN : HORIZON_DUSK
      zen.lerp(zenTarget, dusk * 0.7)
      hor.lerp(horTarget, dusk * 0.85)
    }
    // Rain greys everything toward slate.
    zen.lerp(RAIN_GREY, rain * 0.5)
    hor.lerp(RAIN_GREY, rain * 0.45)

    ;(this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, (1 - day) - rain * 0.7 - fogAmount * 0.8) * 0.9

    // Dome atmosphere: drifting clouds thicken with weather, dim at night;
    // horizon haze thickens with fog/rain (always a little present — dust).
    this.domeUniforms.uTime.value = performance.now() * 0.001
    this.domeUniforms.uHaze.value = Math.min(1, 0.22 + fogAmount * 0.55 + rain * 0.25)
    this.domeUniforms.uCloudAmount.value = Math.min(1, 0.22 + rain * 0.55 + fogAmount * 0.35)
    this.domeUniforms.uCloudBrightness.value = 0.15 + day * 0.85

    // Fog: exponential falloff so distant no-man's land melts into haze
    // rather than hard-cutting. Weather fog dominates; night closes
    // distances too. Color inherits the horizon (so it matches the dome),
    // darkened at night and naturally warm at dawn/dusk via `hor` above.
    const hazeVis = fogAmount * 0.9 + rain * 0.4 + (1 - day) * 0.22
    this.fog.density = 0.0016 + hazeVis * 0.0068
    this.fog.color.copy(hor).multiplyScalar(0.55 + day * 0.45)
  }

  /** Returns true while it's too dark to shoot at unlit men. */
  isNight(tod: number): boolean {
    return Math.sin((tod - 0.25) * Math.PI * 2) < 0.02
  }

  /**
   * Repositions the sun + its shadow camera around the current focus point,
   * texel-snapping the focus in the shadow camera's local (right/up) space
   * so the shadow doesn't shimmer as the focus drifts frame to frame.
   */
  private applySunTransform(): void {
    const dir = this.sunDir
    const worldUp = Math.abs(dir.y) > 0.995 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(worldUp, dir).normalize()
    const camUp = new THREE.Vector3().crossVectors(dir, right).normalize()

    const texel = (SHADOW_BOX_HALF * 2) / this.sun.shadow.mapSize.x
    const focus = new THREE.Vector3(this.focusX, 0, this.focusZ)
    const rd = focus.dot(right)
    const ud = focus.dot(camUp)
    const snapR = Math.round(rd / texel) * texel - rd
    const snapU = Math.round(ud / texel) * texel - ud
    focus.addScaledVector(right, snapR).addScaledVector(camUp, snapU)

    this.sun.position.copy(focus).addScaledVector(dir, SHADOW_DIST)
    this.sun.target.position.copy(focus)

    const cam = this.sun.shadow.camera as THREE.OrthographicCamera
    cam.left = -SHADOW_BOX_HALF
    cam.right = SHADOW_BOX_HALF
    cam.top = SHADOW_BOX_HALF
    cam.bottom = -SHADOW_BOX_HALF
    cam.near = SHADOW_NEAR
    cam.far = SHADOW_FAR
    cam.updateProjectionMatrix()
  }
}

function smooth01(v: number): number {
  const t = Math.max(0, Math.min(1, v))
  return t * t * (3 - 2 * t)
}
