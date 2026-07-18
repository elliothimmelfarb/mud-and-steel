/**
 * MUD & STEEL — procedural props (barrel module).
 *
 * Everything is generated geometry, no external assets. Two families:
 *
 *  - "Instancing geometries" (deadTreeGeometry, wirePostGeometry, ...) return a single
 *    merged THREE.BufferGeometry with a baked per-vertex 'color' attribute (lower/inner
 *    faces darkened for a grounded look). The caller instances these with ONE shared
 *    MeshStandardMaterial({ vertexColors: true }).
 *
 *  - "Complex builds" (buildRuin, buildFieldGun, ...) return a THREE.Group of meshes
 *    using a small set of module-cached materials (≤8 total). Some parts reuse the
 *    same baked-vertex-color trick (via the shared `vc` material) so multi-tone detail
 *    doesn't require extra material instances.
 *
 * The implementations live in props/ by theme; this barrel keeps every
 * import site stable:
 *
 *   props/shared.ts       palette, baking helpers, cached materials, textures
 *   props/groundcover.ts  trees, wire, sandbags, traps, boards, graves, rubble
 *   props/structures.ts   ruins, church, dugout, ammo boxes
 *   props/emplacements.ts guns, searchlight, flare post, trench kit
 *   props/vehicles.ts     tanks, armoured car, biplanes, horse
 *
 * Sim/world convention: x west→east, z north→south, y up. Forward for built groups is -Z.
 */

export { PALETTE, makeSoftCircleTexture, makeNoiseTexture } from './props/shared'
export {
  deadTreeGeometry, wirePostGeometry, wireCoilGeometry, sandbagGeometry,
  tankTrapGeometry, duckboardGeometry, crossGraveGeometry, rubbleGeometry,
  stakeGeometry, sandbagCourseGeometry, revetmentPanelGeometry,
  scalingLadderGeometry, corrugatedSheetGeometry,
} from './props/groundcover'
export { buildRuin, buildChurchRuin, buildDugout, buildAmmoBoxes } from './props/structures'
export {
  buildFieldGun, buildVickers, buildStokesMortar, buildGasProjector,
  buildSearchlight, buildFlarePost, buildStretcher, buildPeriscope,
} from './props/emplacements'
export {
  buildTankA7V, buildTankMkIV, buildArmoredCar, buildBiplane, buildHorse,
} from './props/vehicles'
