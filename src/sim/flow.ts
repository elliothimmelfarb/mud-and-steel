/**
 * Builds pathfinding cost fields from the LIVE battlefield: slope, mud,
 * flooded craters, wire, gas concentration, wrecks. Recomputed whenever
 * shellfire reshapes the ground.
 */
import { WIRE_SEGMENT_LEN, WORLD } from '../core/config'
import { concentrationAt } from './gas'
import type { Ctx } from './sim'

export function rebuildFlow(ctx: Ctx): void {
  const { s, terrain, flowInf, flowVeh } = ctx

  const cols = flowInf.cols, rows = flowInf.rows
  const cell = WORLD.cell * 2
  const originX = -WORLD.width / 2, originZ = -WORLD.depth / 2

  for (let r = 0; r < rows; r++) {
    const z = originZ + (r + 0.5) * cell
    for (let c = 0; c < cols; c++) {
      const x = originX + (c + 0.5) * cell
      const i = r * cols + c
      const slope = terrain.slopeAt(x, z)
      const mud = terrain.mudAt(x, z)
      const flooded = terrain.floodedAt(x, z)
      const trench = terrain.trenchAt(x, z)
      const gas = concentrationAt(ctx, x, z)

      let inf = 1 + slope * 2.5 + mud * 1.6 + (flooded ? 2.2 : 0) + gas * 9
      // Men will use the trench once they own it; until then it's the objective, not a route.
      let veh = 1 + slope * 7 + mud * 2.5 + (flooded ? 6 : 0)
      // Tanks cross trenches slowly; a sharp cost cliff here makes the field's
      // gradients shear sideways and strands vehicles crabbing along the ridge.
      if (trench > 0.4) veh += 6
      if (slope > 0.85) veh = Number.POSITIVE_INFINITY

      flowInf.cost[i] = inf
      flowVeh.cost[i] = veh
    }
  }

  // Wire and traps.
  const stamp = (fx: number, fz: number, radius: number, addInf: number, addVeh: number) => {
    const minC = Math.max(0, Math.floor((fx - radius - originX) / cell))
    const maxC = Math.min(cols - 1, Math.floor((fx + radius - originX) / cell))
    const minR = Math.max(0, Math.floor((fz - radius - originZ) / cell))
    const maxR = Math.min(rows - 1, Math.floor((fz + radius - originZ) / cell))
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const i = r * cols + c
        flowInf.cost[i] += addInf
        if (addVeh === Number.POSITIVE_INFINITY) flowVeh.cost[i] = addVeh
        else flowVeh.cost[i] += addVeh
      }
    }
  }
  for (const d of s.defences) {
    if (d.hp <= 0) continue
    if (d.kind === 'wire') stamp(d.pos.x, d.pos.z, WIRE_SEGMENT_LEN / 2, 12, 0.5)
    else if (d.kind === 'tanktrap') stamp(d.pos.x, d.pos.z, 3, 1.5, Number.POSITIVE_INFINITY)
  }
  for (const v of s.vehicles) {
    if (v.dead) stamp(v.pos.x, v.pos.z, 4, 6, Number.POSITIVE_INFINITY)
  }

  // Targets: the un-captured front sections; once something falls, the support
  // line joins the target list (the breach becomes a funnel). Captured sections
  // are NOT targets — men must flow THROUGH them, not orbit them.
  const infTargets: Array<{ x: number; z: number }> = []
  let anyCaptured = false
  for (const sec of s.sections) {
    if (sec.captured) { anyCaptured = true; continue }
    if (sec.line === 'front') infTargets.push({ x: sec.mid.x, z: sec.mid.z - 3 })
  }
  if (anyCaptured) {
    for (const sec of s.sections) {
      if (sec.line === 'support' && !sec.captured) infTargets.push({ x: sec.mid.x, z: sec.mid.z - 3 })
    }
  }
  // Everything taken (or nothing left to take): head for the breach line.
  if (infTargets.length === 0 || s.sections.every((sec) => sec.line !== 'front' || sec.captured)) {
    infTargets.push({ x: -60, z: WORLD.breachZ + 6 }, { x: 0, z: WORLD.breachZ + 6 }, { x: 60, z: WORLD.breachZ + 6 })
  }
  flowInf.compute(infTargets)

  const vehTargets: Array<{ x: number; z: number }> = []
  for (let x = -100; x <= 100; x += 40) vehTargets.push({ x, z: WORLD.frontTrenchZ - 30 })
  flowVeh.compute(vehTargets)

  ctx.flowDirty = false
}
