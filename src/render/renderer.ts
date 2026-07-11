/**
 * WebGL renderer + post chain: subtle bloom (muzzle flashes, flares, fires),
 * then a period grade pass — vignette, film grain, gentle sepia desaturation,
 * and a shellshock pulse when heavy ordnance lands near the camera.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uGrain: { value: 0.026 },
    uVignette: { value: 0.34 },
    uSepia: { value: 0.12 },
    uShock: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uSepia, uShock;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      // Shellshock: brief radial smear + pull toward center.
      if (uShock > 0.001) {
        vec2 d = uv - 0.5;
        uv -= d * uShock * 0.06;
      }
      vec3 col = texture2D(tDiffuse, uv).rgb;
      if (uShock > 0.001) {
        vec2 d = (vUv - 0.5) * uShock * 0.02;
        col = col * 0.6 + 0.2 * texture2D(tDiffuse, uv + d).rgb + 0.2 * texture2D(tDiffuse, uv - d).rgb;
      }
      // Gentle period grade: lift toward sepia, crush blues a touch.
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      vec3 sepia = vec3(lum * 1.08, lum * 0.94, lum * 0.74);
      col = mix(col, sepia, uSepia);
      col *= 1.0 - uShock * 0.25;
      // Vignette.
      float v = distance(vUv, vec2(0.5));
      col *= 1.0 - smoothstep(0.42, 0.86, v) * uVignette;
      // Animated grain.
      float g = hash(vUv * (700.0 + fract(uTime) * 90.0)) - 0.5;
      col += g * uGrain * (0.6 + (1.0 - lum) * 0.8);
      gl_FragColor = vec4(col, 1.0);
    }`,
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private grade: ShaderPass
  private usePost = true
  private shock = 0

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.25
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.5, 1600)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.32, 0.55, 0.86)
    this.composer.addPass(this.bloom)
    this.grade = new ShaderPass(GradeShader)
    this.composer.addPass(this.grade)
    this.composer.addPass(new OutputPass())

    window.addEventListener('resize', this.onResize)
  }

  private onResize = (): void => {
    const el = this.renderer.domElement.parentElement
    if (!el) return
    const w = el.clientWidth, h = el.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
  }

  setQuality(q: 0 | 1 | 2, postfx: boolean, shadows: boolean): void {
    this.usePost = postfx && q > 0
    this.bloom.enabled = q === 2
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 0 ? 1 : 2))
    this.renderer.shadowMap.enabled = shadows && q > 0
    // Force material recompile when toggling shadows.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined
      if (m) m.needsUpdate = true
    })
  }

  /** Kick the shellshock effect (0..1). Decays on its own. */
  addShock(v: number): void {
    this.shock = Math.min(1, this.shock + v)
  }

  render(dt: number): void {
    this.shock = Math.max(0, this.shock - dt * 1.4)
    const u = this.grade.uniforms as typeof GradeShader.uniforms
    u.uTime.value += dt
    u.uShock.value = this.shock * this.shock
    if (this.usePost) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize)
    this.renderer.dispose()
  }
}
