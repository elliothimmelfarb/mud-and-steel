/**
 * Draws every physically-simulated round in flight. Each bullet rides its real
 * position and velocity across up to three additive instances: a tinted glow
 * streak whose length scales with speed, a thinner near-white core inside it
 * for tracer rounds, and — for tracer rounds only — a small camera-facing
 * HEAD dot at the round's exact position. Yours burn amber, theirs ember-red;
 * ordinary ball ammunition is a faint short mote you mostly sense and gets no
 * head. Rebuilt from live state every frame; the streaks feed the bloom pass
 * for free.
 *
 * Replaces the old flat LineSegments renderer. Length/thickness/colour tuning
 * lives in COMBAT so the feel is a config value, not a magic number.
 *
 * Geometry note: the glow/core streaks are flat, feathered-texture QUADs —
 * not boxes — billboarded about their own flight axis (see `sync`). A solid
 * box presents a hard rectangular face and CA-fringed edges the instant you
 * look anywhere near down its length, which a fired round's own camera does
 * constantly (you are, after all, standing right behind it). A quad whose
 * width axis is derived from the camera's own view direction instead
 * degenerates gracefully to an edge-on sliver in that exact case, rather than
 * a slab across the screen — see the `right`/`widthK` maths below.
 *
 * That edge-on degeneration is a deliberate trade, but it has a blind spot:
 * sighting straight down your OWN line of fire — the common case for the
 * shooter, since a rifle/Lewis/Vickers fires at whatever you're looking at —
 * is exactly the view where the flight-axis billboard collapses to a sliver.
 * A burst would read as near-invisible receding dots instead of a stream of
 * tracers. The HEAD dot fixes that: it billboards to the CAMERA instead of
 * the flight axis, so it presents a full round face from every angle,
 * including dead down the barrel, and stays bright exactly when the tail
 * goes edge-on.
 */
import * as THREE from 'three'
import type { Bullet } from '../core/types'
import { COMBAT } from '../core/config'
import type { EffectsSystem } from './effects'

const MAX = 400

// Rounds whose head lands closer than this to the camera never draw at all —
// belt-and-suspenders against a slab filling the screen: your own round on
// the muzzle before the sim's first tick has moved it (the traveled-distance
// clamp in `sync` already handles that case) or an enemy round passing
// straight through your position (which it does not).
const NEAR_CAM_SKIP = 1.2

// Faction tracer tints — friendly amber vs enemy ember-red reads instantly in a
// crossfire. Ball rounds stay a dim warm grey regardless of side.
const TRACER_BRIT = new THREE.Color('#ffce6e')
const TRACER_GER = new THREE.Color('#ff5f3c')
const BALL_TINT = new THREE.Color('#d8cdb4')

// Cast-light tints for the moving tracer-light pool — deliberately WARMER and
// whiter than the streak tints above so the light thrown onto mud, sandbags and
// faces reads as real fire-light, not a coloured dot smeared across the ground.
const TRACER_LIGHT_BRIT = 0xffb050
const TRACER_LIGHT_GER = 0xff6a40
// Pool size by render quality (q0 off, q1, q2). A small FIXED pool of moving
// PointLights is re-bound each frame to the nearest in-flight tracers — the
// impression of every nearby round glowing without one light per bullet. The
// count only ever changes in the settings menu (setQuality), never per frame,
// so a forward renderer never recompiles its light programs mid-firefight.
const TRACER_LIGHT_SIZES: readonly number[] = [0, 3, 5]
const TRACER_LIGHT_MAX = 5
// A tracer past this camera distance casts light too faint to notice — cull it
// from selection so the pool always spends its lights on the near, visible rounds.
const TRACER_LIGHT_RANGE = 60

// Head-dot sizing: a small, only mildly distance-scaled world size so it reads
// as a crisp bright mote at any range and can never balloon into a slab. It
// grows a little with range (countering perspective shrink, the way a HUD
// reticle would) but is hard-capped well below anything that could read as a
// close-up blob.
//
// HEAD_SIZE_MIN got a small bump (0.12 -> 0.14) so a burst of your own
// tracers reads clearly against dark ground/trench timber instead of
// vanishing into a handful of near-invisible pinpricks — see the M2P
// workstream doc. This is a size change, not a brightness one: the texture's
// warm-core fix (see `buildHeadTexture`) is what keeps a boresighted burst of
// overlapping heads blooming warm rather than clipping to a white blob: a
// slightly bigger warm-clamped mote is safe to stack, a slightly *brighter*
// pure-white one would not have been.
const HEAD_SIZE_MIN = 0.14
const HEAD_SIZE_MAX = 0.22
const HEAD_SIZE_GROWTH = 0.006 // world metres of size per metre of camera distance

/**
 * A single small canvas cell: brightest right at the "head" end (u→1, where
 * the quad's local origin sits — the round's real position) and feathered
 * to nothing at the "tail" end (u→0) and across the width (v→0/1). This is
 * what turns a hard-edged rod into a streak that visibly trails the round —
 * and, because every edge is a gradient rather than a step, never throws the
 * hard magenta/green chromatic-aberration fringe a crisp box edge does.
 */
function buildTracerTexture(): THREE.CanvasTexture {
  const w = 64, h = 24
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (ctx === null) throw new Error('roundRenderer: 2d canvas context unavailable')
  const img = ctx.createImageData(w, h)
  const d = img.data
  let k = 0
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h
    const cross = Math.abs(v - 0.5) * 2                    // 0 at centerline → 1 at edge
    const crossFall = Math.max(0, 1 - cross * cross)        // soft, no hard rectangle edge
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w                                // 0 = tail, 1 = head
      const along = Math.pow(u, 1.6)                         // gathers brightness toward the head
      const a = Math.max(0, Math.min(1, along * crossFall))
      d[k] = 255; d[k + 1] = 255; d[k + 2] = 255
      d[k + 3] = Math.round(a * 255)
      k += 4
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

/**
 * A soft round dot for the tracer HEAD — feathered like `buildTracerTexture`
 * (no hard edge, so no CA fringe), but painted with an actual colour
 * gradient rather than plain white-with-fading-alpha.
 *
 * Why that matters: every head instance gets multiplied by ONE flat
 * per-instance faction tint (amber or ember), uniformly across the whole
 * quad. If this texture were pure white feathering to transparent, the tint
 * would apply evenly everywhere and the head would just be a flat-coloured
 * dot — no "hotter center" read at all. Instead the RGB itself desaturates
 * toward the middle: the centre is a warm near-white, the rim is already a
 * warm, partly-desaturated amber. Multiplying both by the same faction tint
 * still leaves the centre relatively brighter and whiter than the rim
 * (suppressing green/blue twice over darkens the rim more than the centre),
 * which is what sells "burning-hot point" instead of "coloured dot" without
 * ever touching per-instance colour or adding a second instance layer.
 *
 * The centre stop is deliberately `#fff0d0`, not `#ffffff`: this dot sits on
 * an additive layer, so a tracer crossing the bright dawn sky (or a burst of
 * several boresighted heads stacking on top of each other) pushes the
 * rendered pixel well past white regardless of what's painted here — the
 * question is only which direction it clips. A pure-`#ffffff` centre clips
 * flat white, and the grade pass's chromatic aberration then splits that hard
 * clip into a magenta/green fringe (the same failure the muzzle-flash core
 * had before it was warmed to `0xffcf8a`). A centre that's already nudged
 * toward amber clips warm instead — it blooms like a hot ember, not a
 * hard-edged white dot with a CA halo.
 */
function buildHeadTexture(): THREE.CanvasTexture {
  const size = 32
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')
  if (ctx === null) throw new Error('roundRenderer: 2d canvas context unavailable')
  const c = size / 2
  const g = ctx.createRadialGradient(c, c, 0, c, c, c)
  g.addColorStop(0, 'rgba(255,240,208,1)')
  g.addColorStop(0.28, 'rgba(255,238,214,0.95)')
  g.addColorStop(0.6, 'rgba(255,214,168,0.42)')
  g.addColorStop(1, 'rgba(255,190,140,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

export class RoundRenderer {
  private geo: THREE.PlaneGeometry
  private tex: THREE.CanvasTexture
  private glow: THREE.InstancedMesh
  private core: THREE.InstancedMesh
  private headGeo: THREE.PlaneGeometry
  private headTex: THREE.CanvasTexture
  private head: THREE.InstancedMesh
  private effects: EffectsSystem | null

  // Moving tracer-light pool (see TRACER_LIGHT_SIZES). Owned here because this
  // is the one place that already loops every live bullet each frame with its
  // world position, velocity, tracer flag, team and camera distance in hand.
  private scene: THREE.Scene
  private tracerLights: THREE.PointLight[] = []
  private tlQuality: 0 | 1 | 2
  // Per-slot state: the bullet id each light is currently riding (-1 = free),
  // and the bullet-array index bound to it THIS frame (-1 = none). Ids give
  // frame-to-frame continuity so a light rides one round smoothly instead of
  // teleporting between rounds and strobing.
  private tlBoundId = new Int32Array(TRACER_LIGHT_MAX).fill(-1)
  private tlTargetIdx = new Int32Array(TRACER_LIGHT_MAX).fill(-1)
  // Nearest-K selection scratch (K = pool size ≤ TRACER_LIGHT_MAX), zero-alloc.
  private selIdx = new Int32Array(TRACER_LIGHT_MAX)
  private selId = new Int32Array(TRACER_LIGHT_MAX)
  private selDist = new Float64Array(TRACER_LIGHT_MAX)
  private selUsed = new Uint8Array(TRACER_LIGHT_MAX)
  private selCount = 0

  // scratch — zero per-frame allocation
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private dir = new THREE.Vector3()
  private pos = new THREE.Vector3()
  private scl = new THREE.Vector3()
  private col = new THREE.Color()
  private toCam = new THREE.Vector3()
  private right = new THREE.Vector3()
  private up = new THREE.Vector3()
  private basis = new THREE.Matrix4()

  constructor(scene: THREE.Scene, effects: EffectsSystem | null = null, quality: 0 | 1 | 2 = 2) {
    this.effects = effects
    this.scene = scene
    this.tlQuality = quality
    // Unit quad translated so it grows backwards along -X from the head; the
    // head sits at the bullet's real position and the tail trails the flight
    // path. Local +Y is the width axis, feathered by `tex`; local Z carries no
    // geometry (it is the quad's face normal once oriented — see `sync`).
    const geo = new THREE.PlaneGeometry(1, 1)
    geo.translate(-0.5, 0, 0)
    this.geo = geo
    this.tex = buildTracerTexture()

    this.glow = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: this.tex, color: 0xffffff, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
      MAX,
    )
    this.core = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        // Warmed off pure white: an additive near-white streak clips straight
        // through the bloom threshold and the grade pass's chromatic
        // aberration splits that hard clip into a magenta/green fringe.
        map: this.tex, color: 0xffe4ae, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
      MAX,
    )
    this.glow.frustumCulled = false
    this.core.frustumCulled = false
    this.glow.renderOrder = 6
    this.core.renderOrder = 7
    scene.add(this.glow)
    scene.add(this.core)

    // The head quad is centred on its own origin (no -X translate like the
    // tail's `geo`) because it billboards to the CAMERA every frame rather
    // than the flight axis — its centre must sit exactly on `b.pos`, not
    // trail behind it. Colour is left at neutral white: the faction warmth
    // comes from the per-instance tint below, and the "hotter core" comes
    // from `buildHeadTexture`'s own gradient (see its doc comment).
    //
    // Opacity got a small bump (0.62 -> 0.72, M2P) so your own outgoing burst
    // reads as clearly present against dark ground/trench timber, not just a
    // handful of faint pinpricks. It's still nowhere near the aggressive
    // multiplier that would clip a boresighted burst of overlapping heads to
    // a flat white blob — that risk is retired at the texture level, by
    // `buildHeadTexture` clamping its hottest stop to a warm near-white
    // rather than pure `#ffffff`, so stacked additive heads bloom warm
    // instead of clipping white with a CA fringe.
    const headGeo = new THREE.PlaneGeometry(1, 1)
    this.headGeo = headGeo
    this.headTex = buildHeadTexture()
    this.head = new THREE.InstancedMesh(
      headGeo,
      new THREE.MeshBasicMaterial({
        map: this.headTex, color: 0xffffff, transparent: true, opacity: 0.72,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
      MAX,
    )
    this.head.frustumCulled = false
    // Drawn after (on top of) the streaks so the head reads as the streak's
    // hot tip rather than being buried under the tail's own additive glow.
    this.head.renderOrder = 8
    scene.add(this.head)

    for (let i = 0; i < MAX; i++) { this.hide(this.glow, i); this.hide(this.core, i); this.hide(this.head, i) }
    this.glow.instanceMatrix.needsUpdate = true
    this.core.instanceMatrix.needsUpdate = true
    this.head.instanceMatrix.needsUpdate = true

    this.buildTracerLights()
  }

  /**
   * (Re)build the moving tracer-light pool for the current quality tier. Lights
   * are created once per tier and left `visible = true` forever at intensity 0
   * when idle — toggling visibility or count is what forces a forward-renderer
   * material recompile, so we only ever do that here, on the (rare) menu action.
   */
  private buildTracerLights(): void {
    for (const l of this.tracerLights) { this.scene.remove(l); l.dispose() }
    this.tracerLights.length = 0
    const n = TRACER_LIGHT_SIZES[this.tlQuality] ?? 0
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(TRACER_LIGHT_BRIT, 0, 15, 2)
      l.castShadow = false
      l.visible = true // never toggled — see the doc above
      this.scene.add(l)
      this.tracerLights.push(l)
    }
    this.tlBoundId.fill(-1)
    this.tlTargetIdx.fill(-1)
  }

  /** Menu-only: resize the tracer-light pool to a new quality tier. */
  setQuality(q: 0 | 1 | 2): void {
    if (q === this.tlQuality) return
    this.tlQuality = q
    this.buildTracerLights()
  }

  private hide(mesh: THREE.InstancedMesh, i: number): void {
    this.m.makeScale(0, 0, 0)
    this.m.setPosition(0, -9999, 0)
    mesh.setMatrixAt(i, this.m)
  }

  /**
   * Orient the streak quad about a flight (or launch) axis and return its draw-
   * width factor, writing the result into `this.q`. The quad's width tangent is
   * whatever is left of the view direction once the axis is subtracted out (a
   * cross product), so the textured face always presents itself squarely from
   * the side; staring straight down the axis collapses that tangent — the case
   * that used to produce a giant slab — so `widthK` shrinks the drawn width
   * along with it rather than forcing a fixed rectangle into view. Reuses
   * `this.dir` as the axis scratch; `this.toCam` must already hold the
   * normalized round→camera direction.
   */
  private streakQuat(ax: number, ay: number, az: number): number {
    this.dir.set(ax, ay, az)
    this.right.crossVectors(this.dir, this.toCam)
    let widthK = this.right.length()
    if (widthK < 1e-4) {
      // Perfectly end-on: any stable perpendicular works, since the quad is
      // already a sliver — pick world-up, or world-right if the axis is
      // near-vertical (where up would be parallel to it).
      this.right.set(Math.abs(this.dir.y) > 0.98 ? 1 : 0, Math.abs(this.dir.y) > 0.98 ? 0 : 1, 0)
      this.right.crossVectors(this.dir, this.right).normalize()
      widthK = 0.12
    } else {
      this.right.multiplyScalar(1 / widthK)
      // Never fully vanish — a tracer coming straight at you still reads as a
      // small glowing point, not nothing.
      widthK = Math.max(0.12, widthK)
    }
    this.up.crossVectors(this.dir, this.right)
    this.basis.makeBasis(this.dir, this.right, this.up)
    this.q.setFromRotationMatrix(this.basis)
    return widthK
  }

  /**
   * Rebuild all three instance buffers from the live bullet list (once per
   * frame). `camX/camY/camZ` is the render camera's world position — used to
   * skip rounds sitting on top of it, to billboard each streak about its own
   * flight axis, AND to billboard each head dot to face the camera directly
   * (see the class doc). Deliberately just the camera's position, not its
   * full orientation: the head's basis is built from the round→camera vector
   * plus world-up, which is indistinguishable from a true camera-quaternion
   * billboard for a dot this small, and it means this call site never had to
   * change to hand the renderer a `THREE.Camera` reference.
   */
  sync(bullets: Bullet[], camX: number, camY: number, camZ: number, nightFactor = 0, dt = 0): void {
    const n = Math.min(bullets.length, MAX)
    const ref = COMBAT.bulletSpeed
    // Tracer-light selection is worth doing only after dark (their cast light is
    // invisible by day) and only when the pool exists (quality gating).
    const lightsActive = this.tracerLights.length > 0 && nightFactor >= 0.05
    const lightK = this.tracerLights.length
    this.selCount = 0
    for (let i = 0; i < n; i++) {
      const b = bullets[i]
      const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z) || 1
      this.dir.set(b.vel.x / speed, b.vel.y / speed, b.vel.z / speed)
      this.pos.set(b.pos.x, b.pos.y, b.pos.z)

      this.toCam.set(camX - b.pos.x, camY - b.pos.y, camZ - b.pos.z)
      const camDist = this.toCam.length()
      if (camDist < NEAR_CAM_SKIP) {
        // Belt-and-suspenders against a slab (or a head-dot) filling the
        // screen right at the muzzle — see NEAR_CAM_SKIP's doc above.
        this.hide(this.glow, i); this.hide(this.core, i); this.hide(this.head, i)
        continue
      }
      this.toCam.multiplyScalar(1 / camDist)

      const tracer = b.tracer

      // Nearest-K tracer selection for the moving light pool: keep the K rounds
      // closest to the camera (past K they're too faint to cast useful light).
      // Worst-of-K eviction, zero-alloc; the actual light binding happens after
      // the loop so it can keep continuity with last frame (see bindTracerLights).
      if (lightsActive && tracer && camDist < TRACER_LIGHT_RANGE) {
        if (this.selCount < lightK) {
          this.selIdx[this.selCount] = i
          this.selId[this.selCount] = b.id
          this.selDist[this.selCount] = camDist
          this.selCount++
        } else {
          let worst = 0
          for (let k = 1; k < lightK; k++) if (this.selDist[k] > this.selDist[worst]) worst = k
          if (camDist < this.selDist[worst]) {
            this.selIdx[worst] = i
            this.selId[worst] = b.id
            this.selDist[worst] = camDist
          }
        }
      }

      // Slower spent rounds draw shorter — a subtle read on energy without
      // simulating drag on the streak itself.
      const speedK = Math.min(1.4, Math.max(0.5, speed / ref))
      const baseLen = (tracer ? COMBAT.tracerStreakLen : COMBAT.ballStreakLen) * speedK
      // Distance the round has actually flown from its ballistic birth. The
      // streak is never drawn further back than this, or a round would trail
      // back through (and past) the camera on the frame it leaves the barrel.
      const traveled = Math.hypot(b.pos.x - b.spawn.x, b.pos.y - b.spawn.y, b.pos.z - b.spawn.z)

      // --- Launch bridge --------------------------------------------------
      // At 550 m/s over a 30 Hz sim a round is already ~18 m downrange on its
      // first visible frame — far past the 6.5 m trailing streak, so the tracer
      // read as "popping in" mid-flight with a gap back to the muzzle. While the
      // round's head is still within `tracerLaunchLen` of the true muzzle tip
      // (`b.muzzle` — the very point the first-person flash is welded to), reach
      // the streak all the way back to it and orient the quad along head→muzzle,
      // so the tracer is seen LEAVING the barrel as one connected streak; past
      // that it detaches to the normal trailing length. Gated on `b.muzzle`, so
      // only the player's own first-person rounds are bridged — AI tracers,
      // whose ballistic `spawn` already sits at their gun, are untouched. The
      // `> baseLen` guard keeps a round that hasn't yet outrun its trail on the
      // ordinary path (no sudden lengthening at very short range).
      let widthK: number
      let len: number
      const mz = b.muzzle
      if (mz !== undefined) {
        const adx = b.pos.x - mz.x, ady = b.pos.y - mz.y, adz = b.pos.z - mz.z
        const anchorDist = Math.hypot(adx, ady, adz)
        if (anchorDist > baseLen && anchorDist <= COMBAT.tracerLaunchLen) {
          widthK = this.streakQuat(adx / anchorDist, ady / anchorDist, adz / anchorDist)
          len = anchorDist
        } else {
          widthK = this.streakQuat(this.dir.x, this.dir.y, this.dir.z)
          len = Math.min(baseLen, traveled)
        }
      } else {
        widthK = this.streakQuat(this.dir.x, this.dir.y, this.dir.z)
        len = Math.min(baseLen, traveled)
      }
      const thick = tracer ? 0.06 : 0.03

      this.scl.set(len, thick * widthK, 1)
      this.m.compose(this.pos, this.q, this.scl)
      this.glow.setMatrixAt(i, this.m)

      if (tracer) this.col.copy(b.team === 'brit' ? TRACER_BRIT : TRACER_GER)
      else this.col.copy(BALL_TINT).multiplyScalar(0.55)
      this.glow.setColorAt(i, this.col)

      if (tracer) {
        this.scl.set(len * 0.72, thick * 0.42 * widthK, 1)
        this.m.compose(this.pos, this.q, this.scl)
        this.core.setMatrixAt(i, this.m)
        // A burning round smokes: drop the occasional drifting wisp behind it.
        if (this.effects !== null && Math.random() < COMBAT.tracerTrailChance) {
          this.effects.tracerTrail(
            b.pos.x - this.dir.x * len,
            b.pos.y - this.dir.y * len,
            b.pos.z - this.dir.z * len,
          )
        }

        // --- Head: a small, always-camera-facing glow at the round's real
        // position (see the class doc for why this exists). `this.right`/
        // `this.up`/`this.basis`/`this.q`/`this.scl`/`this.m` from the streak
        // billboard above are all already baked into `glow`/`core`'s instance
        // matrices by this point, so they're free to reuse here rather than
        // adding a second set of scratch fields.
        this.right.set(0, 1, 0).cross(this.toCam) // world-up × view dir → screen "right"
        const headK = this.right.length()
        if (headK < 1e-4) {
          // Camera looking almost straight down/up at the round — practically
          // never happens in this game's ground-level combat, but cheap to
          // guard so the basis can't collapse to a zero matrix.
          this.right.set(1, 0, 0)
        } else {
          this.right.multiplyScalar(1 / headK)
        }
        this.up.crossVectors(this.toCam, this.right)
        // Local Z is the quad's face normal — pointed straight at the camera
        // (`toCam`), not down the flight axis like the streak above. That's
        // the entire difference that keeps this dot visible when the tail
        // goes edge-on.
        this.basis.makeBasis(this.right, this.up, this.toCam)
        this.q.setFromRotationMatrix(this.basis)

        const headSize = Math.min(HEAD_SIZE_MAX, HEAD_SIZE_MIN + camDist * HEAD_SIZE_GROWTH)
        this.scl.set(headSize, headSize, 1)
        this.m.compose(this.pos, this.q, this.scl)
        this.head.setMatrixAt(i, this.m)
        this.head.setColorAt(i, this.col) // same faction tint as the glow streak
      } else {
        this.hide(this.core, i)
        this.hide(this.head, i)
      }
    }
    for (let i = n; i < MAX; i++) { this.hide(this.glow, i); this.hide(this.core, i); this.hide(this.head, i) }

    this.glow.instanceMatrix.needsUpdate = true
    this.core.instanceMatrix.needsUpdate = true
    this.head.instanceMatrix.needsUpdate = true
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true
    if (this.head.instanceColor) this.head.instanceColor.needsUpdate = true

    this.bindTracerLights(bullets, nightFactor, dt, lightsActive)
  }

  /**
   * Drive the moving tracer-light pool from this frame's nearest-K selection.
   * Continuity by bullet id: a light already riding a still-selected round keeps
   * riding it (smooth), a light whose round left the set is freed and eased
   * dark, and freshly-selected rounds ignite from intensity 0 in place on a free
   * light — never flying a lit light across the field. Intensity eases toward a
   * night- and speed-scaled target; position snaps so the light truly rides the
   * round downrange. Zero allocation.
   */
  private bindTracerLights(bullets: Bullet[], nightFactor: number, dt: number, active: boolean): void {
    const lights = this.tracerLights
    const nL = lights.length
    if (nL === 0) return
    const ease = dt > 0 ? Math.min(1, dt * 16) : 1
    // Daytime / feature-off: ease every light dark and drop all bindings.
    if (!active) {
      for (let k = 0; k < nL; k++) {
        lights[k].intensity += (0 - lights[k].intensity) * ease
        this.tlBoundId[k] = -1
        this.tlTargetIdx[k] = -1
      }
      return
    }

    const sel = this.selCount
    for (let s = 0; s < sel; s++) this.selUsed[s] = 0
    for (let k = 0; k < nL; k++) this.tlTargetIdx[k] = -1

    // Pass 1: keep existing bindings whose bullet is still selected (ride).
    for (let k = 0; k < nL; k++) {
      const id = this.tlBoundId[k]
      if (id < 0) continue
      let match = -1
      for (let s = 0; s < sel; s++) if (this.selUsed[s] === 0 && this.selId[s] === id) { match = s; break }
      if (match >= 0) { this.tlTargetIdx[k] = this.selIdx[match]; this.selUsed[match] = 1 }
      else this.tlBoundId[k] = -1 // its round left the near set — free the light
    }

    // Pass 2: bind freshly-selected rounds to free lights, igniting from dark.
    for (let s = 0; s < sel; s++) {
      if (this.selUsed[s] === 1) continue
      let free = -1
      for (let k = 0; k < nL; k++) if (this.tlBoundId[k] < 0 && this.tlTargetIdx[k] < 0) { free = k; break }
      if (free < 0) break
      this.tlTargetIdx[free] = this.selIdx[s]
      this.tlBoundId[free] = this.selId[s]
      this.selUsed[s] = 1
      lights[free].intensity = 0 // ignite in place, don't fly a lit light in
    }

    // Pass 3: drive each light — ride its bound round, or ease dark if unbound.
    const scale = this.effects ? this.effects.lightScale : 1
    for (let k = 0; k < nL; k++) {
      const l = lights[k]
      const ti = this.tlTargetIdx[k]
      if (ti < 0) { l.intensity += (0 - l.intensity) * ease; continue }
      const b = bullets[ti]
      l.position.set(b.pos.x, b.pos.y, b.pos.z)
      l.color.setHex(b.team === 'brit' ? TRACER_LIGHT_BRIT : TRACER_LIGHT_GER)
      const spd = Math.hypot(b.vel.x, b.vel.y, b.vel.z)
      const fade = Math.min(1, spd / COMBAT.bulletSpeed)
      const target = (6 + nightFactor * 30) * fade * scale
      l.intensity += (target - l.intensity) * ease
    }
  }

  dispose(): void {
    this.geo.dispose()
    this.tex.dispose()
    this.headGeo.dispose()
    this.headTex.dispose()
    ;(this.glow.material as THREE.Material).dispose()
    ;(this.core.material as THREE.Material).dispose()
    ;(this.head.material as THREE.Material).dispose()
    this.glow.parent?.remove(this.glow)
    this.core.parent?.remove(this.core)
    this.head.parent?.remove(this.head)
    for (const l of this.tracerLights) { this.scene.remove(l); l.dispose() }
    this.tracerLights.length = 0
  }
}
