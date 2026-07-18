/**
 * Poison gas as fluid: clouds are sets of blobs advected by the live wind
 * field, expanding and thinning, scrubbed out by rain. Gas does not check
 * uniforms — a wind shift feeds your own cloud back over your parapet.
 */
import type { GasCloud, Soldier, Team } from '../core/types'
import { COMBAT } from '../core/config'
import { snd, type Ctx } from './sim'
import { killSoldier } from './combat'

export function createGasCloud(ctx: Ctx, x: number, z: number, team: Team): void {
  const blobs = []
  for (let i = 0; i < 5; i++) {
    const ang = ctx.rand() * Math.PI * 2
    const r = ctx.rand() * 3
    blobs.push({ x: x + Math.cos(ang) * r, z: z + Math.sin(ang) * r, r: 3.5 + ctx.rand() * 2, c: 1 })
  }
  ctx.s.clouds.push({ id: ctx.s.nextId++, team, blobs, age: 0 })
}

export function updateGas(ctx: Ctx, dt: number): void {
  const { s } = ctx
  const w = ctx.weather.state
  const decay = (0.012 + w.rain * 0.04) * dt
  s.gasAlarmCooldown = Math.max(0, s.gasAlarmCooldown - dt)

  let writeIdx = 0
  for (let i = 0; i < s.clouds.length; i++) {
    const cloud = s.clouds[i]
    cloud.age += dt
    let maxC = 0
    for (const b of cloud.blobs) {
      b.x += (w.windX * 0.8 + (ctx.rand() - 0.5) * 0.4) * dt
      b.z += (w.windZ * 0.8 + (ctx.rand() - 0.5) * 0.4) * dt
      if (b.r < 15) b.r += 0.06 * dt * (1 + w.windX * w.windX * 0.01)
      b.c = Math.max(0, b.c - decay - (b.r - 3.5) * 0.0004 * dt)
      if (b.c > maxC) maxC = b.c
    }
    if (maxC > 0.06) s.clouds[writeIdx++] = cloud

    // Gas alarm: an enemy cloud drifting onto the position.
    if (cloud.team === 'german' && s.gasAlarmCooldown <= 0) {
      for (const b of cloud.blobs) {
        if (b.z > 45 && b.c > 0.2) {
          s.gasAlarmCooldown = 25
          snd(s, { name: 'gas_gong', x: 0, y: 2, z: 90, gain: 1 })
          ctx.events.emit('gasAlarm', { incoming: true })
          if (ctx.mods.autoMasks) s.masksOn = true
          break
        }
      }
    }
  }
  s.clouds.length = writeIdx

  // Damage pass.
  for (const u of s.units) {
    if (u.disbanded) continue
    for (const c of u.crew) if (c.hp > 0) gasTick(ctx, c, dt)
  }
  for (const e of s.enemies) if (e.hp > 0) gasTick(ctx, e, dt)
}

function gasTick(ctx: Ctx, sol: Soldier, dt: number): void {
  // Attribute the dose: whose gas is actually in this man's lungs?
  const concBrit = concentrationAt(ctx, sol.pos.x, sol.pos.z, 'brit')
  const concGer = concentrationAt(ctx, sol.pos.x, sol.pos.z, 'german')
  const conc = concBrit + concGer
  if (conc <= 0.02) return
  let mult: number
  if (sol.team === 'brit') {
    mult = sol.masked ? ctx.mods.gasResistMasked : 1
  } else {
    mult = sol.masked ? 0.15 : 1
  }
  const dmg = conc * COMBAT.gasDps * mult * dt
  sol.gasExposure = Math.min(3, sol.gasExposure + conc * dt * 2)
  sol.morale = Math.max(0, sol.morale - conc * dt * (sol.masked ? 0.01 : 0.06))
  sol.hp -= dmg
  if (sol.hp <= 0) {
    // Only the player's own gas earns bounty/ledger credit; a German gassed
    // by his own drifting barrage is the Kaiser's problem, not your kill.
    const playerGas = sol.team === 'german' && concBrit >= concGer
    if (playerGas) {
      killSoldier(ctx, sol, 'brit', -1)
      const d = ctx.s.director.dmgByCategory
      d.gas = (d.gas ?? 0) + 40
    } else {
      // Die without crediting the opposing ledger.
      killSoldier(ctx, sol, sol.team, -1)
    }
  }
}

export function concentrationAt(ctx: Ctx, x: number, z: number, team?: Team): number {
  let total = 0
  for (const cloud of ctx.s.clouds) {
    if (team && cloud.team !== team) continue
    for (const b of cloud.blobs) {
      const dx = x - b.x, dz = z - b.z
      const d2 = dx * dx + dz * dz
      if (d2 < b.r * b.r) {
        total += b.c * (1 - Math.sqrt(d2) / b.r)
      }
    }
  }
  return Math.min(1.5, total)
}

/** Pack blob data for the particle system: stride 5 = x,y,z,r,c. */
export function collectGasBlobs(ctx: Ctx, out: Float32Array): number {
  let n = 0
  for (const cloud of ctx.s.clouds) {
    for (const b of cloud.blobs) {
      if (n * 5 + 5 > out.length) return n
      const y = ctx.terrain.heightAt(b.x, b.z)
      out[n * 5] = b.x
      out[n * 5 + 1] = y + 1.2
      out[n * 5 + 2] = b.z
      out[n * 5 + 3] = b.r
      out[n * 5 + 4] = b.c
      n++
    }
  }
  return n
}
