/**
 * Battlefield dressing + dynamic prop rendering: dead trees, ruins, graves,
 * duckboards, and the live-synced defences (wire, traps, lights) and crewed
 * weapon/vehicle models.
 */
import * as THREE from 'three'
import type { Defence, Unit, Vehicle } from '../core/types'
import { forkRand } from '../core/rng'
import { TRENCH, WIRE_SEGMENT_LEN, WORLD } from '../core/config'
import type { Terrain } from '../world/terrain'
import {
  buildAmmoBoxes, buildChurchRuin, buildDugout, buildFieldGun, buildGasProjector,
  buildRuin, buildSearchlight, buildFlarePost, buildStokesMortar, buildTankA7V, buildTankMkIV,
  buildArmoredCar, buildVickers, crossGraveGeometry, deadTreeGeometry, duckboardGeometry,
  sandbagGeometry, stakeGeometry, tankTrapGeometry, wireCoilGeometry, wirePostGeometry,
  PALETTE,
} from './props'
import { dressClutter } from './clutter'

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)

function makeInstanced(geo: THREE.BufferGeometry, cap: number, scene: THREE.Scene): THREE.InstancedMesh {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 })
  const im = new THREE.InstancedMesh(geo, mat, cap)
  im.castShadow = true
  im.receiveShadow = true
  im.frustumCulled = false
  im.count = 0
  scene.add(im)
  return im
}

export class Scenery {
  private wireCoils: THREE.InstancedMesh
  private wirePosts: THREE.InstancedMesh
  private traps: THREE.InstancedMesh
  private stakes: THREE.InstancedMesh
  private sandbags: THREE.InstancedMesh
  private unitProps = new Map<number, THREE.Group>()
  private vehicleProps = new Map<number, { group: THREE.Group; deadDressed: boolean }>()
  private defenceProps = new Map<number, THREE.Group>()
  private beams = new Map<number, THREE.Mesh>()
  private beamMat: THREE.MeshBasicMaterial

  constructor(private scene: THREE.Scene, private terrain: Terrain, seed: number) {
    this.dressStatic(seed)
    this.wireCoils = makeInstanced(wireCoilGeometry(), 420, scene)
    this.wirePosts = makeInstanced(wirePostGeometry(), 840, scene)
    this.traps = makeInstanced(tankTrapGeometry(), 80, scene)
    this.stakes = makeInstanced(stakeGeometry(), 120, scene)
    this.sandbags = makeInstanced(sandbagGeometry(), 400, scene)
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff2c0, transparent: true, opacity: 0.10, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  }

  // -- static dressing --------------------------------------------------------

  private dressStatic(seed: number): void {
    const rand = forkRand(seed, 'scenery')
    const t = this.terrain
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 })

    // Shattered trees, thickest in no-man's land.
    for (let i = 0; i < 16; i++) {
      const x = (rand() - 0.5) * (WORLD.width - 30)
      const z = -180 + rand() * 300
      if (t.trenchAt(x, z) > 0.15) continue
      const tree = new THREE.Mesh(deadTreeGeometry(rand), treeMat)
      tree.position.set(x, t.heightAt(x, z), z)
      tree.rotation.y = rand() * Math.PI * 2
      tree.castShadow = true
      this.scene.add(tree)
    }

    // Instanced ground clutter: grass, stones, battle debris, spent brass. Uses
    // its own 'clutter' stream so it's stable regardless of the dressing above.
    dressClutter(this.scene, t, seed)

    // Ruined farm + church, mid-field landmarks.
    const ruin1 = buildRuin(rand)
    ruin1.position.set(-70 + rand() * 30, 0, -80 + rand() * 40)
    ruin1.position.y = t.heightAt(ruin1.position.x, ruin1.position.z)
    this.scene.add(ruin1)
    const ruin2 = buildRuin(rand)
    ruin2.position.set(50 + rand() * 40, 0, -40 + rand() * 40)
    ruin2.position.y = t.heightAt(ruin2.position.x, ruin2.position.z)
    ruin2.rotation.y = rand() * Math.PI
    this.scene.add(ruin2)
    const church = buildChurchRuin(rand)
    church.position.set((rand() - 0.5) * 120, 0, WORLD.enemySpawnZ + 35)
    church.position.y = t.heightAt(church.position.x, church.position.z)
    this.scene.add(church)

    // Graves behind the support line — the sector's history.
    const graves = makeInstanced(crossGraveGeometry(), 40, this.scene)
    let g = 0
    for (let i = 0; i < 26; i++) {
      const x = -40 + rand() * 80
      const z = WORLD.supportTrenchZ + 34 + rand() * 18
      if (t.trenchAt(x, z) > 0.1) continue
      _e.set((rand() - 0.5) * 0.15, rand() * 0.4 - 0.2, (rand() - 0.5) * 0.2)
      _q.setFromEuler(_e)
      _v.set(x, t.heightAt(x, z), z)
      _m.compose(_v, _q, _s)
      graves.setMatrixAt(g++, _m)
    }
    graves.count = g
    graves.instanceMatrix.needsUpdate = true

    // Duckboards along the trench floors.
    const boards = makeInstanced(duckboardGeometry(), 400, this.scene)
    let b = 0
    const lines = [t.frontLine, t.supportLine, ...t.commLines]
    for (const line of lines) {
      for (let s = 0; s < line.length - 1 && b < 396; s++) {
        const a = line[s], c = line[s + 1]
        const len = Math.hypot(c.x - a.x, c.z - a.z)
        const ang = Math.atan2(c.x - a.x, c.z - a.z)
        for (let d = 1; d < len - 0.5 && b < 396; d += 2.05) {
          const x = a.x + (c.x - a.x) * (d / len)
          const z = a.z + (c.z - a.z) * (d / len)
          _e.set(0, ang, 0)
          _q.setFromEuler(_e)
          _v.set(x, t.heightAt(x, z) + 0.04, z)
          _m.compose(_v, _q, _s)
          boards.setMatrixAt(b++, _m)
        }
      }
    }
    boards.count = b
    boards.instanceMatrix.needsUpdate = true

    // Dugout entrances + stores on the support line.
    for (const cx of TRENCH.commTrenchXs) {
      const dug = buildDugout()
      dug.position.set(cx + 4, t.heightAt(cx + 4, WORLD.supportTrenchZ + 5), WORLD.supportTrenchZ + 5)
      dug.rotation.y = Math.PI
      this.scene.add(dug)
      const boxes = buildAmmoBoxes(rand)
      boxes.position.set(cx - 5, t.heightAt(cx - 5, WORLD.supportTrenchZ + 8), WORLD.supportTrenchZ + 8)
      this.scene.add(boxes)
    }
  }

  // -- dynamic sync ------------------------------------------------------------

  /**
   * Session-lived model templates for the heavyweight builders. The upgraded
   * tanks/guns run to hundreds of merged parts plus per-vertex weathering
   * passes — building one synchronously in the per-frame sync caused a hitch
   * exactly on the "tank arrives" beat. Each kind is built ONCE here and every
   * spawn gets a cheap `clone(true)` (three.js clones share geometry and
   * materials by reference and keep child names, so 'barrel'/'turret'/wheel
   * lookups and dead-dressing behave identically).
   */
  private templates = new Map<string, THREE.Group>()

  private fromTemplate(kind: string, build: () => THREE.Group): THREE.Group {
    let t = this.templates.get(kind)
    if (!t) {
      t = build()
      this.templates.set(kind, t)
    }
    return t.clone(true)
  }

  /**
   * Free the GPU resources a dead entity's group owns, before it's dropped.
   *
   * `ownedGeometries` — pass true only for groups whose builder ran fresh for
   * this entity (searchlights/flareposts). Unit/vehicle groups are CLONES of
   * the session-lived templates above: their geometry is shared, so disposing
   * it would corrupt the template and every other live clone.
   *
   * Materials are shared module-cached `mat.*` everywhere, so disposing them
   * would corrupt still-living props. The ONLY owned materials are the
   * per-instance clones made when a vehicle is dead-dressed (see
   * syncVehicles) — the caller opts into freeing those via `ownedMaterials`.
   */
  private disposeGroup(root: THREE.Object3D, ownedGeometries: boolean, ownedMaterials: boolean): void {
    const geos = new Set<THREE.BufferGeometry>()
    const mats = new Set<THREE.Material>()
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      if (ownedGeometries && mesh.geometry && !geos.has(mesh.geometry)) {
        geos.add(mesh.geometry)
        mesh.geometry.dispose()
      }
      if (ownedMaterials) {
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of list) {
          if (m && !mats.has(m)) { mats.add(m); m.dispose() }
        }
      }
    })
  }

  syncDefences(defences: Defence[], night: boolean): void {
    const t = this.terrain
    let coil = 0, post = 0, trap = 0, stake = 0, bag = 0
    const liveIds = new Set<number>()

    for (const d of defences) {
      if (d.hp <= 0) continue
      const y = t.heightAt(d.pos.x, d.pos.z)
      switch (d.kind) {
        case 'wire': {
          if (coil < 420) {
            _e.set(0, d.angle, (d.wear - 0.5) * 0.2)
            _q.setFromEuler(_e)
            _v.set(d.pos.x, y, d.pos.z)
            _s.set(1, 1 - d.wear * 0.55, 1)
            _m.compose(_v, _q, _s)
            _s.set(1, 1, 1)
            this.wireCoils.setMatrixAt(coil++, _m)
          }
          for (const side of [-1, 1]) {
            if (post >= 840) break
            const px = d.pos.x + Math.cos(d.angle) * side * WIRE_SEGMENT_LEN * 0.4
            const pz = d.pos.z - Math.sin(d.angle) * side * WIRE_SEGMENT_LEN * 0.4
            _e.set(0, 0, side * 0.1)
            _q.setFromEuler(_e)
            _v.set(px, t.heightAt(px, pz), pz)
            _m.compose(_v, _q, _s)
            this.wirePosts.setMatrixAt(post++, _m)
          }
          break
        }
        case 'tanktrap': {
          if (trap < 80) {
            _e.set(0, d.angle, 0)
            _q.setFromEuler(_e)
            _v.set(d.pos.x, y, d.pos.z)
            _m.compose(_v, _q, _s)
            this.traps.setMatrixAt(trap++, _m)
          }
          break
        }
        case 'mine': {
          if (stake < 120) {
            _q.identity()
            _v.set(d.pos.x, y, d.pos.z)
            _m.compose(_v, _q, _s)
            this.stakes.setMatrixAt(stake++, _m)
          }
          break
        }
        case 'sandbags': {
          for (let i = 0; i < 8 && bag < 400; i++) {
            const ox = (i - 3.5) * 0.55
            _e.set(0, (i * 0.7) % 1, 0)
            _q.setFromEuler(_e)
            const bx = d.pos.x + ox, bz = d.pos.z - 1.6
            _v.set(bx, t.heightAt(bx, bz) + 0.15, bz)
            _m.compose(_v, _q, _s)
            this.sandbags.setMatrixAt(bag++, _m)
          }
          break
        }
        case 'searchlight':
        case 'flarepost': {
          liveIds.add(d.id)
          let g = this.defenceProps.get(d.id)
          if (!g) {
            g = d.kind === 'searchlight' ? buildSearchlight() : buildFlarePost()
            this.scene.add(g)
            this.defenceProps.set(d.id, g)
          }
          g.position.set(d.pos.x, y, d.pos.z)
          if (d.kind === 'searchlight') {
            g.rotation.y = -d.angle
            let beam = this.beams.get(d.id)
            if (!beam) {
              const geo = new THREE.ConeGeometry(11, 150, 12, 1, true)
              geo.translate(0, -75, 0)
              geo.rotateX(Math.PI / 2)
              beam = new THREE.Mesh(geo, this.beamMat)
              this.scene.add(beam)
              this.beams.set(d.id, beam)
            }
            beam.visible = night && d.active
            beam.position.set(d.pos.x, y + 1.6, d.pos.z)
            beam.rotation.y = -d.angle + Math.PI
          }
          break
        }
      }
    }

    // Remove props for dead searchlights/flareposts.
    for (const [id, g] of this.defenceProps) {
      if (!liveIds.has(id)) {
        this.scene.remove(g)
        this.disposeGroup(g, true, false) // fresh-built per defence; materials shared mat.*
        this.defenceProps.delete(id)
        const beam = this.beams.get(id)
        if (beam) {
          this.scene.remove(beam)
          beam.geometry.dispose() // per-searchlight cone; beamMat is shared, leave it
          this.beams.delete(id)
        }
      }
    }

    this.wireCoils.count = coil
    this.wirePosts.count = post
    this.traps.count = trap
    this.stakes.count = stake
    this.sandbags.count = bag
    this.wireCoils.instanceMatrix.needsUpdate = true
    this.wirePosts.instanceMatrix.needsUpdate = true
    this.traps.instanceMatrix.needsUpdate = true
    this.stakes.instanceMatrix.needsUpdate = true
    this.sandbags.instanceMatrix.needsUpdate = true
  }

  /**
   * @param possessedUnitId  While the player is manning an emplaced weapon in
   *   first person, its WORLD platform mesh is hidden — the camera sits inside
   *   the gun, so the full-size shield/wheels/barrel would otherwise wall the
   *   view 360° around and occlude the first-person viewmodel. Pass -1 (the
   *   default) to show every platform, e.g. in the commander view.
   */
  syncUnits(units: Unit[], possessedUnitId = -1): void {
    const live = new Set<number>()
    for (const u of units) {
      if (u.disbanded) continue
      let builder: (() => THREE.Group) | null = null
      switch (u.kind) {
        case 'vickers': builder = buildVickers; break
        case 'mortar': builder = buildStokesMortar; break
        case 'fieldgun': builder = buildFieldGun; break
        case 'gasproj': builder = buildGasProjector; break
        default: break
      }
      if (!builder) continue
      live.add(u.id)
      let g = this.unitProps.get(u.id)
      if (!g) {
        g = this.fromTemplate(u.kind, builder)
        this.scene.add(g)
        this.unitProps.set(u.id, g)
      }
      g.visible = u.id !== possessedUnitId // you operate it from the inside; don't wall the view
      g.position.set(u.pos.x, this.terrain.heightAt(u.pos.x, u.pos.z), u.pos.z)
      const gunner = u.crew.find((c) => c.hp > 0)
      if (gunner) g.rotation.y = -gunner.facing
    }
    for (const [id, g] of this.unitProps) {
      if (!live.has(id)) {
        this.scene.remove(g)
        this.disposeGroup(g, false, false) // template clone: geometry + materials both shared
        this.unitProps.delete(id)
      }
    }
  }

  syncVehicles(vehicles: Vehicle[]): void {
    const live = new Set<number>()
    for (const v of vehicles) {
      live.add(v.id)
      let entry = this.vehicleProps.get(v.id)
      if (!entry) {
        const group = this.fromTemplate(
          v.kind,
          v.kind === 'etank' ? buildTankA7V : v.kind === 'friendlytank' ? buildTankMkIV : buildArmoredCar,
        )
        this.scene.add(group)
        entry = { group, deadDressed: false }
        this.vehicleProps.set(v.id, entry)
      }
      const y = this.terrain.heightAt(v.pos.x, v.pos.z)
      entry.group.position.set(v.pos.x, y, v.pos.z)
      // Sit the hull on the actual ground: pitch over crests, roll on cambers.
      const dirX = Math.sin(v.facing), dirZ = -Math.cos(v.facing)
      const rightX = -Math.cos(v.facing), rightZ = -Math.sin(v.facing)
      const hF = this.terrain.heightAt(v.pos.x + dirX * 2.8, v.pos.z + dirZ * 2.8)
      const hB = this.terrain.heightAt(v.pos.x - dirX * 2.8, v.pos.z - dirZ * 2.8)
      const hR = this.terrain.heightAt(v.pos.x + rightX * 1.4, v.pos.z + rightZ * 1.4)
      const hL = this.terrain.heightAt(v.pos.x - rightX * 1.4, v.pos.z - rightZ * 1.4)
      entry.group.rotation.order = 'YXZ'
      entry.group.rotation.y = -v.facing + Math.PI
      entry.group.rotation.x = -Math.atan2(hF - hB, 5.6)
      entry.group.rotation.z = Math.atan2(hR - hL, 2.8) + (v.bogged ? 0.06 : 0)
      if (v.dead && !entry.deadDressed) {
        entry.deadDressed = true
        entry.group.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (mesh.isMesh) {
            const m = (mesh.material as THREE.MeshStandardMaterial).clone()
            m.color.multiplyScalar(0.28)
            mesh.material = m
          }
        })
      }
    }
    for (const [id, entry] of this.vehicleProps) {
      if (!live.has(id)) {
        this.scene.remove(entry.group)
        // Dead-dressed vehicles carry per-instance cloned materials (owned);
        // otherwise materials are the shared mat.* set. Geometry belongs to
        // the session-lived template — never dispose it.
        this.disposeGroup(entry.group, false, entry.deadDressed)
        this.vehicleProps.delete(id)
      }
    }
  }
}

export const SCENERY_PALETTE = PALETTE
