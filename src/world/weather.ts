/**
 * Live weather simulation. Wind meanders and matters (gas!), rain fronts roll
 * through and flood the craters, fog closes in at dawn. Nothing is scripted —
 * the run seed decides whether your big push happens in sunshine or slime.
 */
import type { WeatherState } from '../core/types'
import { WEATHER } from '../core/config'
import { ValueNoise2D } from '../core/rng'

export class Weather {
  readonly state: WeatherState = {
    windX: 1.2, windZ: 0.4,
    rain: 0, fog: 0, wetness: 0.12,
    tod: 0.32, // ~07:40, morning stand-to
    night: false,
    thunderT: 8,
  }

  private noise: ValueNoise2D
  private t: number
  private todTarget: number
  /** Extra bias applied by the wave director ('rain' waves etc). */
  private rainBias = 0
  private fogBias = 0

  constructor(seed: number) {
    this.noise = new ValueNoise2D(seed ^ 0x1f2e3d)
    this.t = (seed % 1000) * 3.7
    this.todTarget = this.state.tod
  }

  update(dt: number): { thunder: boolean } {
    const s = this.state
    this.t += dt

    // Wind: direction and speed wander on separate slow noise channels.
    const angle = this.noise.at(this.t * WEATHER.windMeanderScale, 3.1) * Math.PI * 4
    const speed = WEATHER.windMin +
      this.noise.at(this.t * WEATHER.windMeanderScale * 0.7, 11.7) * (WEATHER.windMax - WEATHER.windMin)
    // Ease toward the target so gusts feel physical, not twitchy.
    const k = Math.min(1, dt * 0.25)
    s.windX += (Math.cos(angle) * speed - s.windX) * k
    s.windZ += (Math.sin(angle) * speed - s.windZ) * k

    // Rain fronts.
    const front = this.noise.at(this.t * 0.006 + 50, 27.3)
    const rainTarget = Math.max(0, Math.min(1, (front - 0.58) * 4 + this.rainBias))
    s.rain += (rainTarget - s.rain) * Math.min(1, dt * 0.08)

    // Fog: dawn mist + weather fronts.
    const dawn = Math.max(0, 1 - Math.abs(s.tod - 0.27) / 0.06)
    const fogFront = this.noise.at(this.t * 0.005 + 90, 63.9)
    const fogTarget = Math.max(0, Math.min(1, dawn * 0.55 + (fogFront - 0.62) * 3 + this.fogBias))
    s.fog += (fogTarget - s.fog) * Math.min(1, dt * 0.06)

    // Ground wetness integrates rainfall; dries slowly.
    s.wetness = Math.max(0, Math.min(1,
      s.wetness + s.rain * WEATHER.rainWetRate * dt - (1 - s.rain) * WEATHER.dryRate * dt))

    // Time drifts slowly during play; big jumps happen between waves.
    // Always move FORWARD around the clock — the sun never runs backwards.
    let todDelta = this.todTarget - s.tod
    todDelta -= Math.floor(todDelta) // shortest forward distance in [0,1)
    if (todDelta > 0.001) s.tod += todDelta * Math.min(1, dt * 0.1)
    s.tod += 0.00018 * dt
    s.tod -= Math.floor(s.tod)
    s.night = Math.sin((s.tod - 0.25) * Math.PI * 2) < 0.02

    // Thunder when the storm is heavy.
    let thunder = false
    if (s.rain > 0.65) {
      s.thunderT -= dt
      if (s.thunderT <= 0) {
        thunder = true
        s.thunderT = 12 + this.noise.at(this.t, 5.5) * 30
      }
    }
    return { thunder }
  }

  /** Called between waves: advance the clock and apply the director's bias. */
  advanceWave(night: boolean, bias: 'clear' | 'rain' | 'fog'): void {
    const s = this.state
    if (night) {
      // Jump to full dark.
      this.todTarget = 0.97
    } else {
      this.todTarget = s.tod + WEATHER.todPerWave
      // If the jump would land us in the dark on a day wave, roll through to morning.
      const sin = Math.sin((this.todTarget % 1 - 0.25) * Math.PI * 2)
      if (sin < 0.1) this.todTarget = Math.floor(this.todTarget) + 1.3 - 1 + 0.02 // ~07:15 next day
    }
    this.todTarget -= Math.floor(this.todTarget)
    this.rainBias = bias === 'rain' ? 0.45 : 0
    this.fogBias = bias === 'fog' ? 0.4 : 0
  }

  /** Wind speed in m/s and compass-ish bearing for the HUD vane. */
  windInfo(): { speed: number; angle: number; blowsTowardPlayer: boolean } {
    const s = this.state
    const speed = Math.hypot(s.windX, s.windZ)
    return {
      speed,
      angle: Math.atan2(s.windX, -s.windZ), // 0 = blowing north (toward the enemy)
      blowsTowardPlayer: s.windZ > 0.35,     // gas warning: it will drift onto your line
    }
  }
}
