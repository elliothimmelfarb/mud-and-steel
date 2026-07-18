/**
 * Battlefield dressing + dynamic prop rendering: dead trees, ruins, graves,
 * duckboards, and the live-synced defences (wire, traps, lights) and crewed
 * weapon/vehicle models.
 */
import * as THREE from 'three'
import type { Defence, Unit, Vec2, Vehicle } from '../core/types'
import { forkRand } from '../core/rng'
import { TRENCH, WIRE_SEGMENT_LEN, WORLD } from '../core/config'
import type { Terrain } from '../world/terrain'
import {
  buildAmmoBoxes, buildChurchRuin, buildDugout, buildFieldGun, buildGasProjector,
  buildPeriscope,
  buildRuin, buildSearchlight, buildFlarePost, buildStokesMortar, buildTankA7V, buildTankMkIV,
  buildArmoredCar, buildVickers, corrugatedSheetGeometry, crossGraveGeometry,
  deadTreeGeometry, duckboardGeometry,
  sandbagGeometry, sandbagCourseGeometry, revetmentPanelGeometry, scalingLadderGeometry,
  stakeGeometry, tankTrapGeometry, wireCoilGeometry, wirePostGeometry,
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

    // Duckboards run the deep, muddy floor of each trench. On the fire/support
    // lines that deep floor sits on the PARADOS side of the fire step, so the
    // boards are nudged off the centreline toward the parados (opposite the
    // enemy-facing bench the men stand on); the communication trenches and the
    // traverse jogs have a symmetric floor, so their boards stay centred.
    const boards = makeInstanced(duckboardGeometry(), t.layout === 'bigpush' ? 900 : 460, this.scene)
    const boardCap = t.layout === 'bigpush' ? 896 : 456
    let b = 0
    // Each entry knows its facing so the parados nudge lands on the correct
    // (away-from-enemy) side of the German system too.
    const boardLines: Array<{ line: Vec2[]; facing: 1 | -1; parapetLine: boolean }> = [
      { line: t.frontLine, facing: 1, parapetLine: true },
      { line: t.supportLine, facing: 1, parapetLine: true },
      ...t.commLines.map((l) => ({ line: l, facing: 1 as const, parapetLine: false })),
    ]
    if (t.layout === 'bigpush') {
      boardLines.push(
        { line: t.germanLine, facing: -1, parapetLine: true },
        { line: t.germanSupportLine, facing: -1, parapetLine: true },
        ...t.germanCommLines.map((l) => ({ line: l, facing: -1 as const, parapetLine: false })),
      )
    }
    for (const { line, facing, parapetLine: isParapetLine } of boardLines) {
      // Push the boards onto the deep floor, which on a fire step sits on the
      // parados side of the centreline.
      for (let s = 0; s < line.length - 1 && b < boardCap; s++) {
        const a = line[s], c = line[s + 1]
        const len = Math.hypot(c.x - a.x, c.z - a.z)
        if (len < 1.6) continue
        // Parados normal (away from the enemy: +z for British, -z for German).
        let nx = (c.z - a.z) / len, nz = -(c.x - a.x) / len
        if (nz * facing < 0) { nx = -nx; nz = -nz }
        // Only the benched bays keep the off-centre floor; traverses and links
        // are symmetric corridors.
        const isBay = Math.abs(c.x - a.x) >= 8 && Math.abs(c.x - a.x) > 2 * Math.abs(c.z - a.z)
        const parados = isParapetLine && isBay ? 0.95 : 0
        // Duckboards are X-long: yawing local +Z onto the parados normal lays
        // the stringers along the trench, treads across it.
        const yaw = Math.atan2(nx, nz)
        for (let d = 1; d < len - 0.5 && b < boardCap; d += 1.9) {
          const x = a.x + (c.x - a.x) * (d / len) + nx * parados
          const z = a.z + (c.z - a.z) * (d / len) + nz * parados
          // A board belongs on the DEEP floor. Skip bench tops, the guarded
          // junction steps (both read trench≈0) and any spot steep enough that
          // a laid board would climb a wall — the old wall-ladder artefact.
          if (t.trenchAt(x, z) < 0.45) continue
          const e2 = 0.7
          let gx = (t.heightAt(x + e2, z) - t.heightAt(x - e2, z)) / (2 * e2)
          let gz = (t.heightAt(x, z + e2) - t.heightAt(x, z - e2)) / (2 * e2)
          if (Math.hypot(gx, gz) > 0.34) continue
          // Loosely conform to the floor slope so a board rests on the mud.
          gx = Math.max(-0.3, Math.min(0.3, gx)); gz = Math.max(-0.3, Math.min(0.3, gz))
          _e.set(gz * 0.55, yaw, -gx * 0.55, 'XYZ')
          _q.setFromEuler(_e)
          _v.set(x, t.heightAt(x, z) + 0.03, z)
          _m.compose(_v, _q, _s)
          boards.setMatrixAt(b++, _m)
        }
      }
    }
    boards.count = b
    boards.instanceMatrix.needsUpdate = true

    // Revetment: what turns a dirt ditch into a built fortification. Sandbag
    // courses cap the parapet lip (nested INTO the crest, not perched on it);
    // timber plank panels line the parados wall, RAKED to the measured wall
    // slope so the boards lie against the earth — a vertical panel on a sloped
    // wall leaves a jarring daylight gap behind the slats. The German line far
    // north gets the sandbag treatment only (it's a horizon read).
    const dressMul = t.layout === 'bigpush' ? 2 : 1
    const bags = makeInstanced(sandbagCourseGeometry(), 380 * dressMul, this.scene)
    const revet = makeInstanced(revetmentPanelGeometry(1.45), 260 * dressMul, this.scene)
    // Timber facing on the fire step's riser. The carved bench is real geometry,
    // but at the terrain's 1 m cell it renders as a smooth ramp — this plank
    // face is what makes it read as a BUILT step from the trench floor. LOW on
    // purpose: a full-height face at the centreline reads as a fence walling
    // the trench (and pokes into the skyline from behind); a boarded lower
    // riser under an earth lip reads as a two-tier fire step.
    const stepFace = makeInstanced(revetmentPanelGeometry(1.0), 260 * dressMul, this.scene)
    const sheets = makeInstanced(corrugatedSheetGeometry(), 90 * dressMul, this.scene)
    const ladders = makeInstanced(scalingLadderGeometry(), 24 * dressMul, this.scene)
    let bg = 0, rv = 0, sf = 0, sh = 0, ld = 0
    const dressLines: Array<{ line: Vec2[]; facing: 1 | -1; full: boolean }> = [
      { line: t.frontLine, facing: 1, full: true },
      { line: t.supportLine, facing: 1, full: true },
      // Classic: the horizon line gets sandbags only. Big Push: the German
      // front is a REAL fighting line ten seconds' sprint away — full
      // revetment, fire-step facing, ladders, the lot. Same for their support.
      { line: t.germanLine, facing: -1, full: t.layout === 'bigpush' },
    ]
    if (t.layout === 'bigpush') {
      dressLines.push({ line: t.germanSupportLine, facing: -1, full: true })
    }
    for (const { line, facing, full } of dressLines) {
      for (let s = 0; s < line.length - 1; s++) {
        const a = line[s], c = line[s + 1]
        const abx = c.x - a.x, abz = c.z - a.z
        const len = Math.hypot(abx, abz)
        if (len < 1) continue
        // Traverse jogs (z-running) get no dressing — bare earth walls between
        // bays. Links keep sandbags (their parapet bank is the traverse
        // island's crown) but only bays have a bench to face.
        if (Math.abs(abx) <= 2 * Math.abs(abz)) continue
        const isBay = Math.abs(abx) >= 8
        // Enemy-facing unit normal, matching the fire-step carve.
        let nx = -abz / len, nz = abx / len
        if (nz * facing > 0) { nx = -nx; nz = -nz }
        // All these geometries are X-long with +Z as the face. Yawing local +Z
        // onto the enemy normal runs them along the trench: bags face out over
        // the parapet, revetment boards face back into the trench. The fire-step
        // face looks the other way — out of the riser, across the deep floor.
        const yaw = Math.atan2(nx, nz)
        const yawIn = Math.atan2(-nx, -nz)
        // Along-segment unit vector, for probing where an instance's two ENDS
        // will land. At every 90° corner a perpendicular corridor crosses the
        // segment end — dressing laid blindly there juts into the path, so
        // each piece first checks the ground it needs actually exists.
        const ax = abx / len, az = abz / len
        for (let d = 1.15; d < len - 0.5; d += 2.3) {
          const cx = a.x + abx * (d / len)
          const cz = a.z + abz * (d / len)
          // Sandbag course nests into the enemy parapet crest, with a touch of
          // settle-roll so a long wall undulates instead of beading. Skip any
          // run whose ends would hang over a crossing corridor's cut.
          if (bg < 378 * dressMul) {
            const sx = cx + nx * (TRENCH.width / 2 + 0.85)
            const sz = cz + nz * (TRENCH.width / 2 + 0.85)
            const overhangs = t.trenchAt(sx - ax * 1.15, sz - az * 1.15) > 0.2
              || t.trenchAt(sx + ax * 1.15, sz + az * 1.15) > 0.2
            if (!overhangs) {
              _e.set(0, yaw, (rand() - 0.5) * 0.07)
              _q.setFromEuler(_e)
              _v.set(sx, t.heightAt(sx, sz) - 0.07, sz)
              _m.compose(_v, _q, _s)
              bags.setMatrixAt(bg++, _m)
            }
          }
          if (!full) continue
          // Wall pieces seat on the DEEP floor. Near corners the floor sample
          // can land on a half-carved ramp — the whole panel rides up and its
          // top clears the lip. The trench mask is the depth truth: skip any
          // site whose floor isn't genuinely down.
          if (t.trenchAt(cx - nx * 0.5, cz - nz * 0.5) < 0.72) continue
          const floorY = t.heightAt(cx - nx * 0.5, cz - nz * 0.5)
          // Parados plank revetment: base pushed into the wall foot, panel
          // raked back to the wall's measured rise so it LIES on the slope.
          // Only where BOTH panel ends have a wall behind them — at corners
          // the crossing corridor leaves nothing to lean on.
          if (rv < 256 * dressMul) {
            const px = cx - nx * 0.95, pz = cz - nz * 0.95
            const wallAt = (ex: number, ez: number): number =>
              t.heightAt(ex - nx * 0.75, ez - nz * 0.75) - floorY
            if (wallAt(px - ax, pz - az) > 0.9 && wallAt(px + ax, pz + az) > 0.9) {
              const wallY = t.heightAt(cx - nx * 2.1, cz - nz * 2.1)
              const rise = Math.max(0.9, wallY - floorY)
              const lean = Math.min(0.62, Math.atan2(1.5, rise))
              _e.set(-lean, yaw, 0, 'YXZ')
              _q.setFromEuler(_e)
              _v.set(px, floorY - 0.05, pz)
              _m.compose(_v, _q, _s)
              revet.setMatrixAt(rv++, _m)
            }
          }
          // Fire-step riser face: seated at the bench's foot, raked to the
          // riser, top tucked under the bench edge. Bays only — links have a
          // plain symmetric floor, no bench — and only where the bench truly
          // rises behind both panel ends.
          if (isBay && sf < 256 * dressMul) {
            const px = cx - nx * 0.15, pz = cz - nz * 0.15
            const benchBehind = (ex: number, ez: number): number =>
              t.heightAt(ex + nx * 0.95, ez + nz * 0.95) - floorY
            if (benchBehind(px - ax, pz - az) > 0.9 && benchBehind(px + ax, pz + az) > 0.9) {
              _e.set(-0.42, yawIn, 0, 'YXZ')
              _q.setFromEuler(_e)
              _v.set(px, floorY - 0.03, pz)
              _m.compose(_v, _q, _s)
              stepFace.setMatrixAt(sf++, _m)
            }
          }
        }
        if (!full) continue
        // A scrounged corrugated sheet leaning on the parados here and there.
        if (sh < 90 * dressMul && rand() < 0.45) {
          const f = 0.25 + rand() * 0.5
          const cx = a.x + abx * f, cz = a.z + abz * f
          if (t.trenchAt(cx - nx * 0.5, cz - nz * 0.5) < 0.72) continue
          const floorY = t.heightAt(cx - nx * 0.5, cz - nz * 0.5)
          _e.set(-0.5 - rand() * 0.15, yaw + (rand() - 0.5) * 0.3, 0, 'YXZ')
          _q.setFromEuler(_e)
          _v.set(cx - nx * 0.9, floorY - 0.02, cz - nz * 0.9)
          _m.compose(_v, _q, _s)
          sheets.setMatrixAt(sh++, _m)
        }
        // Scaling ladders against the enemy wall of the fire bays, head over
        // the parapet — ready for a raid. Front line only, every few bays.
        if ((line === t.frontLine || (t.layout === 'bigpush' && line === t.germanLine)) && isBay && ld < 24 * dressMul && s % 3 === 0) {
          // Mid-bay, between sandbag runs — at a corner a ladder reads as a
          // stray plank; centred on the bay it reads as what it is.
          const f = 0.42 + rand() * 0.12
          const cx = a.x + abx * f, cz = a.z + abz * f
          // Feet must stand ON the bench (mask ≈ 0 there); a corner cut reads
          // as corridor and would drop the ladder into the path.
          if (t.trenchAt(cx + nx * 1.1, cz + nz * 1.1) < 0.2) {
            const benchY = t.heightAt(cx + nx * 1.1, cz + nz * 1.1)
            _e.set(-0.34, yawIn, 0, 'YXZ')
            _q.setFromEuler(_e)
            _v.set(cx + nx * 1.1, benchY - 0.02, cz + nz * 1.1)
            _m.compose(_v, _q, _s)
            ladders.setMatrixAt(ld++, _m)
          }
        }
      }
    }
    bags.count = bg; bags.instanceMatrix.needsUpdate = true
    revet.count = rv; revet.instanceMatrix.needsUpdate = true
    stepFace.count = sf; stepFace.instanceMatrix.needsUpdate = true
    sheets.count = sh; sheets.instanceMatrix.needsUpdate = true
    ladders.count = ld; ladders.instanceMatrix.needsUpdate = true

    // The German wire belt: two rusted rows in front of their parapet with
    // staggered assault lanes — the gaps the field-grey columns pour through.
    // Scenery only (their own wire must never bleed their own assault).
    const gWire = makeInstanced(wireCoilGeometry(), 140, this.scene)
    const gPosts = makeInstanced(wirePostGeometry(), 220, this.scene)
    let gw = 0, gp = 0
    // Belt sits in front of wherever their fire trench actually is.
    const gz0 = t.layout === 'bigpush' ? -(WORLD.frontTrenchZ - 0.5) : WORLD.enemySpawnZ - 13
    for (const rowOff of [5.5, 8.5]) {
      for (let x = -TRENCH.frontSpanX + 3; x < TRENCH.frontSpanX - 3 && gw < 140; x += 6) {
        const lanePhase = (x + (rowOff > 7 ? 19 : 0) + 1000) % 38
        if (lanePhase < 7) continue // assault lane
        const z = gz0 + rowOff + (rand() - 0.5) * 1.4
        const wx = x + (rand() - 0.5) * 1.5
        _e.set(0, (rand() - 0.5) * 0.22, (rand() - 0.5) * 0.12)
        _q.setFromEuler(_e)
        _v.set(wx, t.heightAt(wx, z), z)
        _s.set(1, 0.75 + rand() * 0.3, 1)
        _m.compose(_v, _q, _s)
        _s.set(1, 1, 1)
        gWire.setMatrixAt(gw++, _m)
        for (const side of [-2.1, 2.1]) {
          if (gp >= 220) break
          const px = wx + side + (rand() - 0.5) * 0.8
          const pz = z + (rand() - 0.5) * 0.6
          _e.set((rand() - 0.5) * 0.14, 0, (rand() - 0.5) * 0.14)
          _q.setFromEuler(_e)
          _v.set(px, t.heightAt(px, pz), pz)
          _m.compose(_v, _q, _s)
          gPosts.setMatrixAt(gp++, _m)
        }
      }
    }
    gWire.count = gw; gWire.instanceMatrix.needsUpdate = true
    gPosts.count = gp; gPosts.instanceMatrix.needsUpdate = true

    // A few trench periscopes on the fire bays, peeking over the parapet —
    // offset from the ladder bays so the furniture never doubles up.
    const periTemplate = buildPeriscope()
    let nPeri = 0
    for (let s = 0; s < t.frontLine.length - 1 && nPeri < 6; s++) {
      if (s % 3 !== 1) continue
      const a = t.frontLine[s], c = t.frontLine[s + 1]
      const abx = c.x - a.x, abz = c.z - a.z
      if (Math.abs(abx) < 8 || Math.abs(abx) <= 2 * Math.abs(abz)) continue
      const len = Math.hypot(abx, abz)
      let nx = -abz / len, nz = abx / len
      if (nz > 0) { nx = -nx; nz = -nz }
      const f = 0.28 + rand() * 0.12
      const px = a.x + abx * f + nx * 1.35
      const pz = a.z + abz * f + nz * 1.35
      const peri = periTemplate.clone(true)
      peri.position.set(px, t.heightAt(px, pz), pz)
      peri.rotation.y = Math.atan2(-nx, -nz) + Math.PI
      this.scene.add(peri)
      nPeri++
    }

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
