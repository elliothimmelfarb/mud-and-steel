/**
 * Draws every physically-simulated round in flight. Each bullet is two additive
 * instances riding its real position and velocity: a tinted glow streak whose
 * length scales with speed, and — for tracer rounds — a thinner near-white core
 * inside it, so a tracer reads as a burning round rather than a flat colored
 * line. Yours burn amber, theirs ember-red; ordinary ball ammunition is a faint
 * short mote you mostly sense. Rebuilt from live state every frame; the streaks
 * feed the bloom pass for free.
 *
 * Replaces the old flat LineSegments renderer. Length/thickness/colour tuning
 * lives in COMBAT so the feel is a config value, not a magic number.
 */
import * as THREE from 'three'
import type { Bullet } from '../core/types'
import { COMBAT } from '../core/config'
import type { EffectsSystem } from './effects'

const MAX = 400
const AXIS_X = new THREE.Vector3(1, 0, 0)

// Faction tracer tints — friendly amber vs enemy ember-red reads instantly in a
// crossfire. Ball rounds stay a dim warm grey regardless of side.
const TRACER_BRIT = new THREE.Color('#ffce6e')
const TRACER_GER = new THREE.Color('#ff5f3c')
const BALL_TINT = new THREE.Color('#d8cdb4')

export class RoundRenderer {
  private geo: THREE.BoxGeometry
  private glow: THREE.InstancedMesh
  private core: THREE.InstancedMesh
  private effects: EffectsSystem | null

  // scratch — zero per-frame allocation
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private dir = new THREE.Vector3()
  private pos = new THREE.Vector3()
  private scl = new THREE.Vector3()
  private col = new THREE.Color()

  constructor(scene: THREE.Scene, effects: EffectsSystem | null = null) {
    this.effects = effects
    // Unit box translated so it grows backwards along -X from the head; the head
    // sits at the bullet's real position and the tail trails the flight path.
    const geo = new THREE.BoxGeometry(1, 1, 1)
    geo.translate(-0.5, 0, 0)
    this.geo = geo

    this.glow = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      MAX,
    )
    this.core = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xfff6e0, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      MAX,
    )
    this.glow.frustumCulled = false
    this.core.frustumCulled = false
    this.glow.renderOrder = 6
    this.core.renderOrder = 7
    scene.add(this.glow)
    scene.add(this.core)
    for (let i = 0; i < MAX; i++) { this.hide(this.glow, i); this.hide(this.core, i) }
    this.glow.instanceMatrix.needsUpdate = true
    this.core.instanceMatrix.needsUpdate = true
  }

  private hide(mesh: THREE.InstancedMesh, i: number): void {
    this.m.makeScale(0, 0, 0)
    this.m.setPosition(0, -9999, 0)
    mesh.setMatrixAt(i, this.m)
  }

  /** Rebuild both instance buffers from the live bullet list (once per frame). */
  sync(bullets: Bullet[]): void {
    const n = Math.min(bullets.length, MAX)
    const ref = COMBAT.bulletSpeed
    for (let i = 0; i < n; i++) {
      const b = bullets[i]
      const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z) || 1
      this.dir.set(b.vel.x / speed, b.vel.y / speed, b.vel.z / speed)
      this.q.setFromUnitVectors(AXIS_X, this.dir)
      this.pos.set(b.pos.x, b.pos.y, b.pos.z)

      const tracer = b.tracer
      // Slower spent rounds draw shorter — a subtle read on energy without
      // simulating drag on the streak itself.
      const speedK = Math.min(1.4, Math.max(0.5, speed / ref))
      const len = (tracer ? COMBAT.tracerStreakLen : COMBAT.ballStreakLen) * speedK
      const thick = tracer ? 0.06 : 0.03

      this.scl.set(len, thick, thick)
      this.m.compose(this.pos, this.q, this.scl)
      this.glow.setMatrixAt(i, this.m)

      if (tracer) this.col.copy(b.team === 'brit' ? TRACER_BRIT : TRACER_GER)
      else this.col.copy(BALL_TINT).multiplyScalar(0.55)
      this.glow.setColorAt(i, this.col)

      if (tracer) {
        this.scl.set(len * 0.72, thick * 0.42, thick * 0.42)
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
      } else {
        this.hide(this.core, i)
      }
    }
    for (let i = n; i < MAX; i++) { this.hide(this.glow, i); this.hide(this.core, i) }

    this.glow.instanceMatrix.needsUpdate = true
    this.core.instanceMatrix.needsUpdate = true
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    ;(this.glow.material as THREE.Material).dispose()
    ;(this.core.material as THREE.Material).dispose()
    this.glow.parent?.remove(this.glow)
    this.core.parent?.remove(this.core)
  }
}
