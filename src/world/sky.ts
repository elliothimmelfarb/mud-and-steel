/**
 * Sky dome, sun/moon lighting, fog, and the pooled flare lights.
 * Time of day is continuous: dawn stand-tos, high noon, night assaults under
 * drifting parachute flares.
 */
import * as THREE from 'three'

const ZENITH_DAY = new THREE.Color(0x7d8ba0)     // Flanders sky: pale, never postcard-blue
const HORIZON_DAY = new THREE.Color(0xb5a98c)    // dust and distance
const ZENITH_NIGHT = new THREE.Color(0x0a0d16)
const HORIZON_NIGHT = new THREE.Color(0x1a1c1e)
const ZENITH_DUSK = new THREE.Color(0x4a4a5e)
const HORIZON_DUSK = new THREE.Color(0xb06b3a)   // the famous dirty orange
const SUN_WARM = new THREE.Color(0xffe8c4)
const SUN_LOW = new THREE.Color(0xff9d5c)
const MOON = new THREE.Color(0x8a95b5)
const RAIN_GREY = new THREE.Color(0x555a5e)

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
  }
  private fog: THREE.Fog

  constructor(scene: THREE.Scene) {
    // -- lights --
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const cam = this.sun.shadow.camera
    // Cover the world's half-diagonal (~267 m) at any sun azimuth.
    cam.left = -270; cam.right = 270; cam.top = 280; cam.bottom = -280
    cam.near = 20; cam.far = 700
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.4
    scene.add(this.sun, this.sun.target)

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
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
          float s = max(dot(normalize(vDir), uSunDir), 0.0);
          col += vec3(1.0, 0.75, 0.45) * pow(s, 220.0) * 1.4 * uSunGlow;  // disc
          col += vec3(1.0, 0.6, 0.3) * pow(s, 6.0) * 0.16 * uSunGlow;    // haze
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

    this.fog = new THREE.Fog(HORIZON_DAY.clone(), 180, 720)
    scene.fog = this.fog
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
    this.sun.position.copy(dir).multiplyScalar(320)
    this.sun.target.position.set(0, 0, 0)
    this.domeUniforms.uSunDir.value.copy(dir)

    const day = smooth01((elev + 0.12) / 0.35)         // 0 night → 1 day
    const dusk = Math.max(0, 1 - Math.abs(elev) / 0.28) // near horizon

    // Lighting
    const overcast = 1 - rain * 0.55 - fogAmount * 0.3
    this.sun.intensity = (0.2 + day * 2.6) * Math.max(0.3, overcast)
    this.sun.color.copy(SUN_WARM).lerp(SUN_LOW, dusk)
    this.sun.visible = elev > -0.06
    this.moonLight.position.set(-east * 200, Math.max(0.2, -elev) * 260, -120)
    this.moonLight.intensity = (1 - day) * 0.42
    this.hemi.intensity = 0.3 + day * 0.85 * Math.max(0.45, overcast)
    this.domeUniforms.uSunGlow.value = day * Math.max(0.15, 1 - rain * 0.8)

    // Sky colors
    const zen = this.domeUniforms.uZenith.value
    const hor = this.domeUniforms.uHorizon.value
    zen.copy(ZENITH_NIGHT).lerp(ZENITH_DAY, day)
    hor.copy(HORIZON_NIGHT).lerp(HORIZON_DAY, day)
    if (dusk > 0) {
      zen.lerp(ZENITH_DUSK, dusk * 0.7)
      hor.lerp(HORIZON_DUSK, dusk * 0.85)
    }
    // Rain greys everything toward slate.
    zen.lerp(RAIN_GREY, rain * 0.5)
    hor.lerp(RAIN_GREY, rain * 0.45)

    ;(this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, (1 - day) - rain * 0.7 - fogAmount * 0.8) * 0.9

    // Fog: weather fog dominates; night closes distances too.
    this.fog.color.copy(hor)
    const vis = 1 - fogAmount * 0.82 - rain * 0.25 - (1 - day) * 0.2
    this.fog.near = 40 + 240 * Math.max(0.06, vis)
    this.fog.far = 200 + 720 * Math.max(0.1, vis)
  }

  /** Returns true while it's too dark to shoot at unlit men. */
  isNight(tod: number): boolean {
    return Math.sin((tod - 0.25) * Math.PI * 2) < 0.02
  }
}

function smooth01(v: number): number {
  const t = Math.max(0, Math.min(1, v))
  return t * t * (3 - 2 * t)
}
