/**
 * Vehicles & beasts — tanks, the armoured car, aircraft, cavalry horses.
 * Complex builds returning THREE.Group over the shared material set. Named
 * meshes ('barrel', 'turret', 'prop', 'wheel0'..'wheel3', horse legs/head)
 * are animated by the renderer — keep the names.
 */

import * as THREE from 'three'
import { PALETTE, buildSpokedWheel, fm, mat, pm } from './shared'

/** A7V: 7.3m armoured box, riveted-seam plates, front 57mm gun, track skirts. */
export function buildTankA7V(): THREE.Group {
  const g = new THREE.Group()
  const hullHex = PALETTE.feldgrau

  const hull = pm(new THREE.BoxGeometry(3.0, 2.0, 7.3), hullHex, 0.3)
  hull.position.set(0, 1.3, 0)
  g.add(hull)

  for (const y of [0.7, 1.5]) {
    const seam = pm(new THREE.BoxGeometry(3.05, 0.05, 7.35), hullHex, 0.1)
    seam.position.set(0, 0.3 + y, 0)
    g.add(seam)
  }

  for (const side of [-1, 1]) {
    const skirt = fm(new THREE.BoxGeometry(0.4, 1.0, 7.3), mat.steelDark)
    skirt.position.set(side * 1.55, 0.5, 0)
    g.add(skirt)
  }

  const barrelGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.6, 8)
  barrelGeo.rotateX(Math.PI / 2)
  const barrel = fm(barrelGeo, mat.steel)
  barrel.position.set(0, 1.1, -4.1)
  barrel.name = 'barrel'
  g.add(barrel)

  const mantlet = fm(new THREE.BoxGeometry(0.7, 0.7, 0.3), mat.steelDark)
  mantlet.position.set(0, 1.1, -3.5)
  g.add(mantlet)

  const cupola = fm(new THREE.CylinderGeometry(0.35, 0.4, 0.4, 8), mat.steelDark)
  cupola.position.set(0, 2.5, 1.5)
  g.add(cupola)

  return g
}

/** Mk IV: 8m rhomboid hull with side sponsons and a track ridge line. */
export function buildTankMkIV(): THREE.Group {
  const g = new THREE.Group()
  const hullHex = PALETTE.khaki
  const bodyLen = 8, bodyH = 2.6, bodyW = 2.6

  const mid = pm(new THREE.BoxGeometry(bodyLen, bodyH * 0.5, bodyW), hullHex, 0.25)
  mid.position.set(0, 1.3, 0)
  g.add(mid)

  const topTaper = pm(new THREE.BoxGeometry(bodyLen * 0.7, bodyH * 0.35, bodyW * 0.8), hullHex, 0.2)
  topTaper.position.set(0, 1.3 + bodyH * 0.42, 0)
  g.add(topTaper)

  const trackFront = pm(new THREE.BoxGeometry(bodyH * 0.8, bodyH * 0.8, bodyW * 1.05), PALETTE.steelDark, 0.2)
  trackFront.position.set(bodyLen / 2 - 0.3, 1.0, 0)
  trackFront.rotation.z = Math.PI / 4
  g.add(trackFront)

  const trackRear = trackFront.clone()
  trackRear.position.set(-bodyLen / 2 + 0.3, 1.0, 0)
  g.add(trackRear)

  const ridge = fm(new THREE.BoxGeometry(bodyLen * 0.85, 0.15, 0.15), mat.steelDark)
  ridge.position.set(0, 2.15, bodyW / 2)
  g.add(ridge)
  const ridge2 = ridge.clone()
  ridge2.position.z = -bodyW / 2
  g.add(ridge2)

  for (const side of [-1, 1]) {
    const sponson = fm(new THREE.BoxGeometry(1.0, 1.0, 1.4), mat.steelDark)
    sponson.position.set(side * (bodyW / 2 + 0.4), 1.3, 0.3)
    g.add(sponson)

    const barrelGeo = new THREE.CylinderGeometry(0.06, 0.07, 1.2, 8)
    barrelGeo.rotateZ(Math.PI / 2)
    const barrel = fm(barrelGeo, mat.steel)
    barrel.position.set(side * (bodyW / 2 + 1.0), 1.3, 0.3)
    barrel.name = 'barrel'
    g.add(barrel)
  }

  return g
}

/** Turreted armoured car with four named wheels. */
export function buildArmoredCar(): THREE.Group {
  const g = new THREE.Group()
  const hullHex = PALETTE.khaki

  const body = pm(new THREE.BoxGeometry(1.7, 1.1, 3.6), hullHex, 0.25)
  body.position.set(0, 0.85, 0)
  g.add(body)

  const hood = pm(new THREE.BoxGeometry(1.4, 0.6, 1.1), hullHex, 0.2)
  hood.position.set(0, 0.55, -1.9)
  g.add(hood)

  const turret = fm(new THREE.CylinderGeometry(0.55, 0.6, 0.55, 8), mat.steelDark)
  turret.position.set(0, 1.7, 0.2)
  turret.name = 'turret'
  g.add(turret)

  const mgGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.6, 6)
  mgGeo.rotateX(Math.PI / 2)
  const mg = fm(mgGeo, mat.steel)
  mg.position.set(0, 0, -0.5)
  turret.add(mg)

  const wheelDefs: Array<[string, number, number]> = [
    ['wheel0', -0.85, -1.3], ['wheel1', 0.85, -1.3],
    ['wheel2', -0.85, 1.3], ['wheel3', 0.85, 1.3],
  ]
  for (const [name, x, z] of wheelDefs) {
    const wheel = buildSpokedWheel(0.42)
    wheel.position.set(x, 0.42, z)
    wheel.rotation.y = Math.PI / 2
    wheel.name = name
    g.add(wheel)
  }

  return g
}

/** ~7m wingspan two-decker with roundels (British) or crosses (German). */
export function buildBiplane(german: boolean): THREE.Group {
  const g = new THREE.Group()
  const bodyHex = german ? PALETTE.feldgrau : PALETTE.khaki

  const fuselage = pm(new THREE.BoxGeometry(0.55, 0.55, 4.2), bodyHex, 0.25)
  fuselage.position.set(0, 1.1, 0)
  g.add(fuselage)

  const wingSpan = 7
  const wingGeo = new THREE.BoxGeometry(wingSpan, 0.08, 0.9)
  for (const y of [1.35, 0.85]) {
    const wing = pm(wingGeo.clone(), bodyHex, 0.15)
    wing.position.set(0, y, -0.2)
    g.add(wing)
  }

  for (const side of [-1, 1]) {
    for (const zoff of [-0.35, 0.15]) {
      const strut = fm(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 4), mat.woodDark)
      strut.position.set(side * 2.6, 1.1, -0.2 + zoff)
      g.add(strut)
    }
  }

  const tail = pm(new THREE.BoxGeometry(1.8, 0.05, 0.6), bodyHex, 0.1)
  tail.position.set(0, 1.15, 1.95)
  g.add(tail)

  const fin = pm(new THREE.BoxGeometry(0.05, 0.5, 0.55), bodyHex, 0.1)
  fin.position.set(0, 1.4, 2.0)
  g.add(fin)

  const prop = fm(new THREE.BoxGeometry(0.09, 1.1, 0.03), mat.woodDark)
  prop.position.set(0, 1.1, -2.15)
  prop.name = 'prop'
  g.add(prop)

  const hub = fm(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 6), mat.brass)
  hub.rotation.x = Math.PI / 2
  hub.position.set(0, 1.1, -2.15)
  g.add(hub)

  for (const side of [-1, 1]) {
    if (german) {
      const cross1 = fm(new THREE.BoxGeometry(0.5, 0.02, 0.14), mat.steelDark)
      cross1.position.set(side * 2.2, 1.39, -0.2)
      g.add(cross1)
      const cross2 = fm(new THREE.BoxGeometry(0.14, 0.02, 0.5), mat.steelDark)
      cross2.position.set(side * 2.2, 1.39, -0.2)
      g.add(cross2)
    } else {
      const ring1 = fm(new THREE.CircleGeometry(0.32, 10), mat.steelDark)
      ring1.rotation.x = -Math.PI / 2
      ring1.position.set(side * 2.2, 1.39, -0.2)
      g.add(ring1)
      const ring2 = fm(new THREE.CircleGeometry(0.18, 10), mat.brass)
      ring2.rotation.x = -Math.PI / 2
      ring2.position.set(side * 2.2, 1.40, -0.2)
      g.add(ring2)
    }
  }

  return g
}

/** Low-poly cavalry horse, ~1.6m at the shoulder. */
export function buildHorse(): THREE.Group {
  const g = new THREE.Group()
  const coat = 0x5a4230
  const coatDark = 0x3a2b1e
  const hoofHex = 0x1c1712

  const body = pm(new THREE.SphereGeometry(0.4, 8, 6), coat, 0.25)
  body.scale.set(1.55, 0.85, 0.85)
  body.position.set(0, 1.05, 0)
  g.add(body)

  const neck = pm(new THREE.CylinderGeometry(0.16, 0.22, 0.75, 6), coat, 0.15)
  neck.position.set(0, 1.35, -0.55)
  neck.rotation.x = 0.9
  g.add(neck)

  const head = pm(new THREE.BoxGeometry(0.22, 0.28, 0.55), coatDark, 0.1)
  head.position.set(0, 1.62, -0.95)
  head.rotation.x = 0.35
  head.name = 'head'
  g.add(head)

  const earGeo = new THREE.ConeGeometry(0.045, 0.14, 4)
  for (const side of [-1, 1]) {
    const ear = pm(earGeo.clone(), coatDark, 0.1)
    ear.position.set(side * 0.08, 1.78, -0.85)
    g.add(ear)
  }

  const tail = pm(new THREE.ConeGeometry(0.08, 0.55, 5), coatDark, 0.2)
  tail.position.set(0, 0.95, 0.68)
  tail.rotation.x = Math.PI + 0.3
  g.add(tail)

  const legLen = 1.0
  const legDefs: Array<[string, number, number]> = [
    ['legFL', -0.18, -0.5], ['legFR', 0.18, -0.5],
    ['legBL', -0.18, 0.5], ['legBR', 0.18, 0.5],
  ]
  for (const [name, x, z] of legDefs) {
    const leg = new THREE.Group()
    leg.position.set(x, 1.05, z)
    leg.name = name

    const upperGeo = new THREE.CylinderGeometry(0.06, 0.05, legLen * 0.55, 5)
    upperGeo.translate(0, -legLen * 0.275, 0)
    leg.add(pm(upperGeo, coat, 0.3))

    const lowerGeo = new THREE.CylinderGeometry(0.045, 0.035, legLen * 0.45, 5)
    lowerGeo.translate(0, -legLen * 0.55 - legLen * 0.225, 0)
    leg.add(pm(lowerGeo, coatDark, 0.35))

    const hoofGeo = new THREE.BoxGeometry(0.09, 0.06, 0.11)
    hoofGeo.translate(0, -legLen * 0.55 - legLen * 0.45 + 0.03, 0.02)
    leg.add(pm(hoofGeo, hoofHex, 0.1))

    g.add(leg)
  }

  return g
}
