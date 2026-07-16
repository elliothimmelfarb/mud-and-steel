/**
 * Emplaced weapons & trench kit — the crewed guns the player builds, plus the
 * small kit props (periscope, stretcher). Complex builds returning
 * THREE.Group over the shared material set. Meshes named 'barrel'/'lamp' are
 * looked up by the renderer for recoil/aiming/light effects — keep the names.
 */

import * as THREE from 'three'
import { buildSpokedWheel, fm, mat, wrapVC } from './shared'
import { sandbagGeometry } from './groundcover'

/** 18-pdr field gun: shield, barrel, trail, two spoked wheels. */
export function buildFieldGun(): THREE.Group {
  const g = new THREE.Group()

  const shield = fm(new THREE.BoxGeometry(1.5, 1.0, 0.06), mat.steelDark)
  shield.position.set(0, 0.75, -0.5)
  shield.rotation.x = -0.08
  g.add(shield)

  const barrelGeo = new THREE.CylinderGeometry(0.055, 0.07, 2.6, 8)
  barrelGeo.rotateX(Math.PI / 2)
  const barrel = fm(barrelGeo, mat.steel)
  barrel.position.set(0, 0.85, -1.2)
  barrel.name = 'barrel'
  g.add(barrel)

  const breech = fm(new THREE.BoxGeometry(0.28, 0.3, 0.4), mat.steelDark)
  breech.position.set(0, 0.85, -0.15)
  g.add(breech)

  const axle = fm(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6), mat.steelDark)
  axle.rotation.z = Math.PI / 2
  axle.position.set(0, 0.55, 0.1)
  g.add(axle)

  for (const side of [-1, 1]) {
    const trail = fm(new THREE.BoxGeometry(0.12, 0.12, 2.2), mat.wood)
    trail.position.set(side * 0.18, 0.32, 1.4)
    trail.rotation.y = side * 0.05
    g.add(trail)
  }

  for (const side of [-1, 1]) {
    const wheel = buildSpokedWheel(0.55)
    wheel.position.set(side * 0.8, 0.55, 0.1)
    wheel.rotation.y = Math.PI / 2
    g.add(wheel)
  }

  return g
}

/** Vickers MG: tripod, water-jacket barrel, condenser can. */
export function buildVickers(): THREE.Group {
  const g = new THREE.Group()

  const legDefs: Array<[number, number]> = [[-0.28, 0.35], [0.28, 0.35], [0, -0.4]]
  for (const [x, z] of legDefs) {
    const leg = fm(new THREE.CylinderGeometry(0.025, 0.03, 0.78, 5), mat.steelDark)
    leg.position.set(x * 0.5, 0.38, z * 0.5)
    leg.rotation.x = z > 0 ? 0.35 : -0.15
    leg.rotation.z = -x * 0.5
    g.add(leg)
  }

  const cradle = fm(new THREE.BoxGeometry(0.22, 0.14, 0.3), mat.steelDark)
  cradle.position.set(0, 0.76, 0)
  g.add(cradle)

  const barrelGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.7, 8)
  barrelGeo.rotateX(Math.PI / 2)
  const barrel = fm(barrelGeo, mat.steel)
  barrel.position.set(0, 0.8, -0.55)
  barrel.name = 'barrel'
  g.add(barrel)

  const can = fm(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 6), mat.steelDark)
  can.position.set(0.28, 0.35, -0.15)
  g.add(can)

  const hoseGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.5, 4)
  hoseGeo.rotateZ(Math.PI / 2.3)
  const hose = fm(hoseGeo, mat.steelDark)
  hose.position.set(0.16, 0.55, -0.3)
  g.add(hose)

  const grip = fm(new THREE.BoxGeometry(0.06, 0.16, 0.03), mat.wood)
  grip.position.set(0, 0.7, 0.18)
  g.add(grip)

  return g
}

/** Stokes mortar: angled tube, bipod, base plate. */
export function buildStokesMortar(): THREE.Group {
  const g = new THREE.Group()

  const baseplate = fm(new THREE.CylinderGeometry(0.35, 0.38, 0.06, 8), mat.steelDark)
  baseplate.position.set(0, 0.03, 0.15)
  g.add(baseplate)

  const tubeGeo = new THREE.CylinderGeometry(0.055, 0.06, 1.3, 8)
  const tube = fm(tubeGeo, mat.steel)
  tube.position.set(0, 0.75, -0.1)
  tube.rotation.x = -0.25
  tube.name = 'barrel'
  g.add(tube)

  for (const side of [-1, 1]) {
    const leg = fm(new THREE.CylinderGeometry(0.03, 0.035, 0.85, 5), mat.steelDark)
    leg.position.set(side * 0.32, 0.42, 0.05)
    leg.rotation.z = side * 0.3
    leg.rotation.x = -0.15
    g.add(leg)
  }

  return g
}

/** Livens-style gas projector: rack of 6 angled tubes half-buried. */
export function buildGasProjector(): THREE.Group {
  const g = new THREE.Group()

  const earth = fm(new THREE.BoxGeometry(2.2, 0.2, 1.4), mat.mud)
  earth.position.set(0, 0.1, 0)
  g.add(earth)

  const rows = 2, cols = 3
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tube = fm(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 6), mat.steelDark)
      tube.position.set(-0.7 + c * 0.7, 0.55, -0.3 + r * 0.55)
      tube.rotation.x = -0.55
      g.add(tube)
    }
  }

  return g
}

/** Searchlight: drum lamp on a yoke mount, generator box alongside. */
export function buildSearchlight(): THREE.Group {
  const g = new THREE.Group()

  const genBox = fm(new THREE.BoxGeometry(0.9, 0.6, 0.6), mat.steelDark)
  genBox.position.set(-1.0, 0.3, 0)
  g.add(genBox)

  const mountPost = fm(new THREE.CylinderGeometry(0.05, 0.06, 1.1, 6), mat.steelDark)
  mountPost.position.set(0, 0.55, 0)
  g.add(mountPost)

  const yoke = fm(new THREE.BoxGeometry(0.5, 0.06, 0.06), mat.steel)
  yoke.position.set(0, 1.05, 0)
  g.add(yoke)

  const lampGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.4, 10)
  lampGeo.rotateZ(Math.PI / 2)
  const lamp = fm(lampGeo, mat.steel)
  lamp.position.set(0, 1.15, 0)
  lamp.name = 'lamp'
  g.add(lamp)

  const lens = fm(new THREE.CircleGeometry(0.28, 10), mat.brass)
  lens.rotation.y = Math.PI / 2
  lens.position.set(0.21, 1.15, 0)
  g.add(lens)

  return g
}

/** Flare post: small rocket rack on a stake, ringed by sandbags. */
export function buildFlarePost(): THREE.Group {
  const g = new THREE.Group()

  const postGeo = new THREE.BoxGeometry(0.12, 1.0, 0.12)
  postGeo.translate(0, 0.5, 0)
  g.add(fm(postGeo, mat.wood))

  const rackGeo = new THREE.BoxGeometry(0.4, 0.08, 0.3)
  rackGeo.translate(0, 0.95, 0)
  g.add(fm(rackGeo, mat.woodDark))

  for (let i = 0; i < 3; i++) {
    const tube = fm(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 5), mat.brass)
    tube.position.set(-0.12 + i * 0.12, 1.15, 0)
    tube.rotation.x = -0.5
    g.add(tube)
  }

  const ringCount = 8
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2
    const bag = wrapVC(sandbagGeometry())
    bag.position.set(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55)
    bag.rotation.y = a
    g.add(bag)
  }

  return g
}

/** Two poles with a canvas panel between them. */
export function buildStretcher(): THREE.Group {
  const g = new THREE.Group()
  const poleLen = 2.1

  for (const side of [-1, 1]) {
    const pole = fm(new THREE.CylinderGeometry(0.025, 0.025, poleLen, 6), mat.wood)
    pole.rotation.z = Math.PI / 2
    pole.position.set(0, 0.12, side * 0.28)
    g.add(pole)
  }

  const canvas = fm(new THREE.BoxGeometry(poleLen * 0.82, 0.02, 0.5), mat.cloth)
  canvas.position.set(0, 0.13, 0)
  g.add(canvas)

  for (const x of [-poleLen / 2, poleLen / 2]) {
    for (const side of [-1, 1]) {
      const cap = fm(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 5), mat.woodDark)
      cap.rotation.z = Math.PI / 2
      cap.position.set(x, 0.12, side * 0.28)
      g.add(cap)
    }
  }

  return g
}

/** Simple trench periscope: shaft, angled mirror head, grip. */
export function buildPeriscope(): THREE.Group {
  const g = new THREE.Group()

  const shaft = fm(new THREE.BoxGeometry(0.06, 1.3, 0.06), mat.steelDark)
  shaft.position.set(0, 0.65, 0)
  g.add(shaft)

  const topBox = fm(new THREE.BoxGeometry(0.12, 0.16, 0.09), mat.steel)
  topBox.position.set(0, 1.35, 0.015)
  topBox.rotation.x = 0.5
  g.add(topBox)

  const grip = fm(new THREE.BoxGeometry(0.14, 0.05, 0.05), mat.woodDark)
  grip.position.set(0, 0.45, 0)
  g.add(grip)

  return g
}
