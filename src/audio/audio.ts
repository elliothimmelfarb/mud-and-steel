/**
 * MUD & STEEL — procedural audio engine.
 *
 * Everything is synthesized in WebAudio (see ./synth.ts) — no files.
 *
 * Bus graph:
 *   [voices/loops] → sfx | ambience | ui → master → lowpass (muffle)
 *                                                 → compressor → destination
 *   positional voices also send → reverbIn → convolver (generated IR) → master
 *
 * Positional model (2D top-down world, y = height):
 *   pan       = lateral bearing relative to listener yaw (StereoPanner)
 *   gain      = 1 / (1 + d / 45)
 *   lowpass   = 16 kHz at 0 m → 1.2 kHz at 300 m (exponential)
 *   wet send  grows with distance — far things live in the reverb.
 *
 * Voice management: hard cap of 28 one-shots; the quietest is stolen when
 * full. Noise buffers and the reverb IR are rendered once per context. All
 * synthesis is scheduled sample-accurately on the AudioContext clock; the
 * single setInterval only paces ambience booms and reclaims finished voices.
 *
 * Every public method silently no-ops before unlock().
 */

import {
  createBuffers,
  createImpulseResponse,
  SFX_RECIPES,
  LOOP_RECIPES,
  NIGHT_DRONE,
  shellWhistleRecipe,
  type Buffers,
  type SynthVoice,
  type LoopRecipe,
} from './synth'

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

export type SfxName =
  | 'rifle' | 'rifle_far' | 'mg' | 'mg_vickers' | 'pistol' | 'sniper'
  | 'mortar_launch' | 'fieldgun' | 'explosion_small' | 'explosion_big'
  | 'explosion_far' | 'dirt_shower' | 'gas_pop' | 'gas_gong' | 'melee'
  | 'death_cry' | 'horse' | 'wire_snip' | 'build' | 'dig' | 'sell'
  | 'ui_click' | 'ui_open' | 'ui_error' | 'upgrade' | 'whistle_attack'
  | 'flare_pop' | 'reload' | 'steam_vent' | 'thunder' | 'bugle_victory'
  | 'drone_defeat' | 'splash' | 'tank_hit' | 'ricochet' | 'cough'
  | 'supersonic_crack' | 'birdsong'

export type LoopName =
  | 'tank_engine' | 'plane' | 'flamethrower' | 'rain' | 'wind'
  | 'flare_burn' | 'fire_burn'

export type Bus = 'master' | 'sfx' | 'ambience' | 'ui'

export interface LoopHandle {
  setPos(x: number, y: number, z: number): void
  setGain(g: number): void
  stop(fadeSec?: number): void
}

interface PlayOpts {
  x?: number
  y?: number
  z?: number
  gain?: number
  rate?: number
}

interface AmbienceState {
  battle: number
  rain: number
  wind: number
  /** Continuous darkness dial (0 day … 1 full dark) — crossfades the beds. */
  nightFactor: number
  /** Time of day (0 midnight, 0.5 noon) — drives sparse dawn birdsong. */
  tod: number
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MAX_VOICES = 28
const REF_DIST = 45
const VOICE_POOL_MAX = 64
/** 1200/16000 — exponent base for the distance lowpass curve. */
const LP_RATIO = 0.075
/** 700/20000 — exponent base for the muffle curve. */
const MUFFLE_RATIO = 0.035

interface Graph {
  ctx: AudioContext
  bufs: Buffers
  buses: Record<Bus, GainNode>
  masterLP: BiquadFilterNode
  reverbIn: GainNode
}

interface VoiceSlot {
  mix: GainNode | null
  lp: BiquadFilterNode | null
  pan: StereoPannerNode | null
  out: GainNode | null
  wet: GainNode | null
  sources: AudioScheduledSourceNode[]
  endTime: number
  loudness: number
}

interface LoopInst {
  mix: GainNode
  lp: BiquadFilterNode
  pan: StereoPannerNode
  out: GainNode
  wet: GainNode
  sources: AudioScheduledSourceNode[]
  userGain: number
  x: number
  y: number
  z: number
  positional: boolean
  stopped: boolean
}

function newSlot(): VoiceSlot {
  return { mix: null, lp: null, pan: null, out: null, wet: null, sources: [], endTime: 0, loudness: 0 }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

const UI_NAMES: ReadonlySet<SfxName> = new Set<SfxName>(['ui_click', 'ui_open', 'ui_error'])

/** Reverb-send multiplier per sound (default 1). 0 = fully dry. */
const VERB_MUL: Partial<Record<SfxName, number>> = {
  sniper: 1.7,
  fieldgun: 1.4,
  explosion_small: 1.25,
  explosion_big: 1.4,
  explosion_far: 1.6,
  gas_gong: 1.3,
  thunder: 1.5,
  bugle_victory: 1.2,
  drone_defeat: 1.1,
  cough: 0.4,
  // A near-miss crack is a dry, immediate air event — very little room tail.
  supersonic_crack: 0.35,
  // Birdsong sits in the open air of dawn, a touch of space but not drenched.
  birdsong: 0.6,
  ui_click: 0,
  ui_open: 0,
  ui_error: 0,
}

/** Loops that belong on the ambience bus rather than sfx. */
const AMBIENT_LOOPS: ReadonlySet<LoopName> = new Set<LoopName>(['rain', 'wind'])

const NOOP_LOOP: LoopHandle = {
  setPos(_x: number, _y: number, _z: number): void { /* engine locked */ },
  setGain(_g: number): void { /* engine locked */ },
  stop(_fadeSec?: number): void { /* engine locked */ },
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class AudioEngine {
  private g: Graph | null = null
  private disposed = false

  private readonly busVols: Record<Bus, number> = { master: 1, sfx: 1, ambience: 1, ui: 1 }
  private muffle = 0

  // listener
  private lx = 0
  private ly = 0
  private lz = 0
  private yaw = 0
  private cosYaw = 1
  private sinYaw = 0

  // voices
  private readonly voices: VoiceSlot[] = []
  private readonly dying: VoiceSlot[] = []
  private readonly voicePool: VoiceSlot[] = []
  private scratch: SynthVoice | null = null

  // loops
  private readonly loops: LoopInst[] = []

  // ambience
  private ambTimer: ReturnType<typeof setInterval> | null = null
  private ambStarted = false
  private ambBattle = 0
  private ambRainV = 0
  private ambWindV = 0
  private ambNightFactor = 0
  private ambTod = 0.5
  private nextBoom = 0
  private nextBird = 0
  private rainInst: LoopInst | null = null
  private windInst: LoopInst | null = null
  private nightInst: LoopInst | null = null
  private readonly boomOpts: PlayOpts = { x: 0, y: 0, z: 0, gain: 1, rate: 1 }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Create/resume the AudioContext on a user gesture. Idempotent. */
  unlock(): void {
    if (this.disposed) return
    if (this.g) {
      if (this.g.ctx.state === 'suspended') void this.g.ctx.resume()
      return
    }
    if (typeof AudioContext === 'undefined') return
    let ctx: AudioContext
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })
    } catch {
      return
    }
    if (ctx.state === 'suspended') void ctx.resume()

    const bufs = createBuffers(ctx)

    const master = ctx.createGain()
    const masterLP = ctx.createBiquadFilter()
    masterLP.type = 'lowpass'
    masterLP.frequency.value = 20000
    masterLP.Q.value = 0.5
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -12
    comp.knee.value = 18
    comp.ratio.value = 6
    comp.attack.value = 0.004
    comp.release.value = 0.18
    // Brick-wall safety limiter after the glue compressor: hard knee, high
    // ratio, fast attack, ceiling just below 0 dBFS. The richer layered weapon
    // reports and twin-sub artillery can momentarily stack loud; this catches
    // the peaks so the master never clips, without colouring normal levels.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -1.5
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.12
    master.connect(masterLP)
    masterLP.connect(comp)
    comp.connect(limiter)
    limiter.connect(ctx.destination)

    const mkBus = (): GainNode => {
      const b = ctx.createGain()
      b.connect(master)
      return b
    }
    const buses: Record<Bus, GainNode> = {
      master,
      sfx: mkBus(),
      ambience: mkBus(),
      ui: mkBus(),
    }

    const reverbIn = ctx.createGain()
    const conv = ctx.createConvolver()
    conv.buffer = createImpulseResponse(ctx, 1.8)
    const reverbOut = ctx.createGain()
    reverbOut.gain.value = 0.55
    reverbIn.connect(conv)
    conv.connect(reverbOut)
    reverbOut.connect(master)

    this.g = { ctx, bufs, buses, masterLP, reverbIn }

    // reusable recipe build context (avoids a per-play object)
    this.scratch = {
      ctx,
      bufs,
      mix: master, // placeholder; overwritten before every recipe run
      t0: 0,
      rate: 1,
      sources: [],
    }

    this.applyBus('master')
    this.applyBus('sfx')
    this.applyBus('ambience')
    this.applyBus('ui')
    this.applyMuffle()

    this.nextBoom = ctx.currentTime + 4 + Math.random() * 8
    this.nextBird = ctx.currentTime + 2 + Math.random() * 4
    this.ambTimer = setInterval(() => this.ambTick(), 400)

    if (this.ambStarted) {
      this.setAmbience({
        battle: this.ambBattle,
        rain: this.ambRainV,
        wind: this.ambWindV,
        nightFactor: this.ambNightFactor,
        tod: this.ambTod,
      })
    }
  }

  get unlocked(): boolean {
    return this.g !== null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.ambTimer !== null) {
      clearInterval(this.ambTimer)
      this.ambTimer = null
    }
    const g = this.g
    this.g = null
    this.scratch = null
    this.voices.length = 0
    this.dying.length = 0
    this.voicePool.length = 0
    this.loops.length = 0
    this.rainInst = this.windInst = this.nightInst = null
    if (g) {
      try {
        void g.ctx.close()
      } catch {
        /* already closed */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Buses & global filters
  // -------------------------------------------------------------------------

  setBusVolume(bus: Bus, v: number): void {
    this.busVols[bus] = clamp01(v)
    this.applyBus(bus)
  }

  getBusVolume(bus: Bus): number {
    return this.busVols[bus]
  }

  private applyBus(bus: Bus): void {
    const g = this.g
    if (!g) return
    const v = this.busVols[bus]
    // perceptual-ish square curve; a little master headroom for the compressor
    const target = v * v * (bus === 'master' ? 0.9 : 1)
    g.buses[bus].gain.setTargetAtTime(target, g.ctx.currentTime, 0.03)
  }

  /** 0 = clear (20 kHz), 1 = gas mask / concussion (~700 Hz). */
  setMuffled(m: number): void {
    this.muffle = clamp01(m)
    this.applyMuffle()
  }

  private applyMuffle(): void {
    const g = this.g
    if (!g) return
    const cutoff = 20000 * Math.pow(MUFFLE_RATIO, this.muffle)
    g.masterLP.frequency.setTargetAtTime(cutoff, g.ctx.currentTime, 0.09)
  }

  // -------------------------------------------------------------------------
  // Listener
  // -------------------------------------------------------------------------

  setListener(x: number, y: number, z: number, yawRad: number): void {
    this.lx = x
    this.ly = y
    this.lz = z
    this.yaw = yawRad
    this.cosYaw = Math.cos(yawRad)
    this.sinYaw = Math.sin(yawRad)
    for (let i = 0; i < this.loops.length; i++) {
      this.updateLoopSpatial(this.loops[i] as LoopInst, 0.08)
    }
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  play(name: SfxName, opts?: PlayOpts): void {
    this.spawn(name, 0, opts)
  }

  /** The iconic falling shell whistle, ending exactly at impact. */
  shellWhistle(secondsToImpact: number, opts?: PlayOpts): void {
    this.spawn(null, secondsToImpact, opts)
  }

  private spawn(name: SfxName | null, whistleSec: number, opts?: PlayOpts): void {
    const g = this.g
    if (!g) return
    const ctx = g.ctx
    const now = ctx.currentTime
    this.pruneList(this.voices, now)
    this.pruneList(this.dying, now)

    const base = opts?.gain ?? 1
    const rate = clamp(opts?.rate ?? 1, 0.25, 4)
    const positional = opts !== undefined && (opts.x !== undefined || opts.z !== undefined)

    let atten = 1
    let pan = 0
    let cutoff = 18000
    let dist = 0
    if (positional) {
      const dx = (opts.x ?? this.lx) - this.lx
      const dy = (opts.y ?? this.ly) - this.ly
      const dz = (opts.z ?? this.lz) - this.lz
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      atten = 1 / (1 + dist / REF_DIST)
      if (dist > 0.5) {
        pan = clamp((dx * this.cosYaw + dz * this.sinYaw) / dist, -1, 1) * 0.75
      }
      cutoff = 16000 * Math.pow(LP_RATIO, Math.min(dist, 300) / 300)
    }

    const loudness = base * atten
    if (loudness < 0.004) return // inaudibly far — don't spend a voice

    const slot = this.acquireVoice(loudness, now)
    if (!slot) return

    const mix = ctx.createGain()
    mix.gain.value = base * atten
    const bus = name !== null && UI_NAMES.has(name) ? g.buses.ui : g.buses.sfx
    let tail: AudioNode = mix
    let lp: BiquadFilterNode | null = null
    let panNode: StereoPannerNode | null = null
    if (positional) {
      lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = cutoff
      lp.Q.value = 0.2
      panNode = ctx.createStereoPanner()
      panNode.pan.value = pan
      mix.connect(lp)
      lp.connect(panNode)
      tail = panNode
    }
    tail.connect(bus)

    // reverb send (post-gain, post-distance-filter — far things get wetter)
    let wet: GainNode | null = null
    const vm = name !== null ? VERB_MUL[name] ?? 1 : 0.9
    if (vm > 0) {
      const wetAmt = (positional ? Math.min(0.75, 0.1 + dist / 150) : 0.06) * vm
      wet = ctx.createGain()
      wet.gain.value = wetAmt
      ;(lp ?? mix).connect(wet)
      wet.connect(g.reverbIn)
    }

    const sv = this.scratch as SynthVoice
    sv.mix = mix
    sv.t0 = now + 0.003
    sv.rate = rate
    sv.sources = slot.sources
    const dur = name !== null ? SFX_RECIPES[name](sv) : shellWhistleRecipe(sv, whistleSec)

    slot.mix = mix
    slot.lp = lp
    slot.pan = panNode
    slot.wet = wet
    slot.out = null
    slot.endTime = sv.t0 + dur + 0.3
    slot.loudness = loudness
  }

  // -------------------------------------------------------------------------
  // Voice management
  // -------------------------------------------------------------------------

  private acquireVoice(loudness: number, now: number): VoiceSlot | null {
    if (this.voices.length >= MAX_VOICES) {
      let qi = 0
      for (let i = 1; i < this.voices.length; i++) {
        if ((this.voices[i] as VoiceSlot).loudness < (this.voices[qi] as VoiceSlot).loudness) qi = i
      }
      const q = this.voices[qi] as VoiceSlot
      if (q.loudness >= loudness) return null // the newcomer is the quietest
      // steal: fast fade so there's no click, then reclaim shortly after
      if (q.mix) q.mix.gain.setTargetAtTime(0, now, 0.006)
      for (let i = 0; i < q.sources.length; i++) {
        try {
          ;(q.sources[i] as AudioScheduledSourceNode).stop(now + 0.03)
        } catch {
          /* already stopped */
        }
      }
      q.endTime = now + 0.08
      q.loudness = 0
      this.voices[qi] = this.voices[this.voices.length - 1] as VoiceSlot
      this.voices.pop()
      this.dying.push(q)
    }
    const slot = this.voicePool.pop() ?? newSlot()
    this.voices.push(slot)
    return slot
  }

  private pruneList(list: VoiceSlot[], now: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i] as VoiceSlot
      if (s.endTime <= now) {
        list[i] = list[list.length - 1] as VoiceSlot
        list.pop()
        this.releaseSlot(s)
      }
    }
  }

  private releaseSlot(s: VoiceSlot): void {
    s.mix?.disconnect()
    s.lp?.disconnect()
    s.pan?.disconnect()
    s.out?.disconnect()
    s.wet?.disconnect()
    s.mix = null
    s.lp = null
    s.pan = null
    s.out = null
    s.wet = null
    s.sources.length = 0
    s.endTime = 0
    s.loudness = 0
    if (this.voicePool.length < VOICE_POOL_MAX) this.voicePool.push(s)
  }

  // -------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------

  loop(name: LoopName, opts?: PlayOpts): LoopHandle {
    const g = this.g
    if (!g) return NOOP_LOOP
    const bus = AMBIENT_LOOPS.has(name) ? g.buses.ambience : g.buses.sfx
    const inst = this.mkLoopInst(LOOP_RECIPES[name], bus, opts?.gain ?? 1)
    if (opts !== undefined && (opts.x !== undefined || opts.z !== undefined)) {
      inst.positional = true
      inst.x = opts.x ?? this.lx
      inst.y = opts.y ?? this.ly
      inst.z = opts.z ?? this.lz
    }
    this.updateLoopSpatial(inst, 0) // snap initial spatialization
    const eng = this
    return {
      setPos(x: number, y: number, z: number): void {
        inst.x = x
        inst.y = y
        inst.z = z
        inst.positional = true
        eng.updateLoopSpatial(inst, 0.08)
      },
      setGain(gv: number): void {
        inst.userGain = Math.max(0, gv)
        eng.updateLoopSpatial(inst, 0.05)
      },
      stop(fadeSec = 0.08): void {
        eng.stopLoop(inst, fadeSec)
      },
    }
  }

  private mkLoopInst(recipe: LoopRecipe, bus: GainNode, userGain: number): LoopInst {
    const g = this.g as Graph
    const ctx = g.ctx
    const mix = ctx.createGain()
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 18000
    lp.Q.value = 0.3
    const pan = ctx.createStereoPanner()
    const out = ctx.createGain()
    out.gain.value = userGain
    const wet = ctx.createGain()
    wet.gain.value = 0.05
    mix.connect(lp)
    lp.connect(pan)
    pan.connect(out)
    out.connect(bus)
    out.connect(wet) // post-fader send: fading the loop fades its reverb too
    wet.connect(g.reverbIn)

    const inst: LoopInst = {
      mix, lp, pan, out, wet,
      sources: [],
      userGain,
      x: 0, y: 0, z: 0,
      positional: false,
      stopped: false,
    }
    const sv = this.scratch as SynthVoice
    sv.mix = mix
    sv.t0 = ctx.currentTime + 0.005
    sv.rate = 1
    sv.sources = inst.sources
    recipe(sv)
    this.loops.push(inst)
    return inst
  }

  /** Re-derive pan / attenuation / distance filter; tc=0 snaps instantly. */
  private updateLoopSpatial(inst: LoopInst, tc: number): void {
    const g = this.g
    if (!g || inst.stopped) return
    let atten = 1
    let pan = 0
    let cutoff = 18000
    let wet = 0.05
    if (inst.positional) {
      const dx = inst.x - this.lx
      const dy = inst.y - this.ly
      const dz = inst.z - this.lz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      atten = 1 / (1 + dist / REF_DIST)
      if (dist > 0.5) {
        pan = clamp((dx * this.cosYaw + dz * this.sinYaw) / dist, -1, 1) * 0.75
      }
      cutoff = 16000 * Math.pow(LP_RATIO, Math.min(dist, 300) / 300)
      wet = Math.min(0.5, 0.08 + dist / 250)
    }
    const target = inst.userGain * atten
    const t = g.ctx.currentTime
    if (tc <= 0) {
      inst.out.gain.value = target
      inst.pan.pan.value = pan
      inst.lp.frequency.value = cutoff
      inst.wet.gain.value = wet
    } else {
      inst.out.gain.setTargetAtTime(target, t, tc)
      inst.pan.pan.setTargetAtTime(pan, t, tc)
      inst.lp.frequency.setTargetAtTime(cutoff, t, tc)
      inst.wet.gain.setTargetAtTime(wet, t, tc)
    }
  }

  private stopLoop(inst: LoopInst, fadeSec: number): void {
    if (inst.stopped) return
    inst.stopped = true
    const i = this.loops.indexOf(inst)
    if (i >= 0) {
      this.loops[i] = this.loops[this.loops.length - 1] as LoopInst
      this.loops.pop()
    }
    const g = this.g
    if (!g) return
    const t = g.ctx.currentTime
    const fade = Math.max(0.01, fadeSec)
    inst.out.gain.setTargetAtTime(0, t, fade / 3)
    const stopAt = t + fade + 0.1
    for (let s = 0; s < inst.sources.length; s++) {
      try {
        ;(inst.sources[s] as AudioScheduledSourceNode).stop(stopAt)
      } catch {
        /* already stopped */
      }
    }
    // hand the node corpse to the voice reaper for disconnection
    const slot = this.voicePool.pop() ?? newSlot()
    slot.mix = inst.mix
    slot.lp = inst.lp
    slot.pan = inst.pan
    slot.out = inst.out
    slot.wet = inst.wet
    slot.endTime = stopAt + 0.05
    slot.loudness = 0
    this.dying.push(slot)
  }

  // -------------------------------------------------------------------------
  // Ambience — rain/wind beds, night drone, distant guns
  // -------------------------------------------------------------------------

  setAmbience(s: AmbienceState): void {
    this.ambBattle = clamp01(s.battle)
    this.ambRainV = clamp01(s.rain)
    this.ambWindV = clamp01(s.wind)
    this.ambNightFactor = clamp01(s.nightFactor)
    this.ambTod = s.tod
    this.ambStarted = true
    const g = this.g
    if (!g) return

    if (this.rainInst === null && this.ambRainV > 0.004) {
      this.rainInst = this.mkLoopInst(LOOP_RECIPES.rain, g.buses.ambience, 0)
    }
    if (this.rainInst !== null) {
      this.rainInst.userGain = this.ambRainV
      this.crossfadeLoop(this.rainInst, 0.9)
    }

    if (this.windInst === null && this.ambWindV > 0.004) {
      this.windInst = this.mkLoopInst(LOOP_RECIPES.wind, g.buses.ambience, 0)
    }
    if (this.windInst !== null) {
      this.windInst.userGain = this.ambWindV
      this.crossfadeLoop(this.windInst, 0.9)
    }

    // Night bed crossfades CONTINUOUSLY on nightFactor (not a hard boolean),
    // so the eerie drone swells in over the dying daytime wind through the
    // whole dusk→dark glide and ebbs back out at dawn. Spun up lazily the first
    // time any darkness appears, then left to breathe via its gain.
    if (this.nightInst === null && this.ambNightFactor > 0.02) {
      this.nightInst = this.mkLoopInst(NIGHT_DRONE, g.buses.ambience, 0)
    }
    if (this.nightInst !== null) {
      this.nightInst.userGain = this.ambNightFactor * 0.06
      this.crossfadeLoop(this.nightInst, 2.0)
    }
  }

  private crossfadeLoop(inst: LoopInst, tc: number): void {
    const g = this.g
    if (!g || inst.stopped) return
    inst.out.gain.setTargetAtTime(inst.userGain, g.ctx.currentTime, tc)
  }

  /**
   * 400 ms housekeeping tick: reclaim finished voices and pace the distant
   * artillery texture. Calm front: a boom every ~20 s; full battle: capped
   * at one every ~2 s — they are texture, always far off to the north.
   */
  private ambTick(): void {
    const g = this.g
    if (!g) return
    const now = g.ctx.currentTime
    this.pruneList(this.voices, now)
    this.pruneList(this.dying, now)
    if (!this.ambStarted) return
    this.ambBird(now)
    if (now < this.nextBoom) return
    const period = 22 - 19.8 * this.ambBattle // 22 s calm → 2.2 s at battle=1
    this.nextBoom = now + period * (0.5 + Math.random())
    const o = this.boomOpts
    o.x = this.lx + (Math.random() - 0.5) * 700
    o.y = 0
    o.z = this.lz - 380 - Math.random() * 420 // always beyond the north horizon
    o.gain = 0.5 + Math.random() * 0.4
    o.rate = 0.8 + Math.random() * 0.4
    this.play('explosion_far', o)
  }

  /**
   * Sparse dawn birdsong. Only sings in the narrow window around sunrise (tod
   * ~0.27), only while the light is still low but not pitch-dark, and only when
   * the front is quiet — birds fall silent under a barrage. Each call is placed
   * off to a random side, up in whatever thin trees survive, and kept faint.
   */
  private ambBird(now: number): void {
    if (now < this.nextBird) return
    // Triangular window peaking at sunrise, ~1.5 h wide either side.
    const dawn = Math.max(0, 1 - Math.abs(this.ambTod - 0.27) / 0.07)
    // Sing at half-light (dawn drone still up a little) but not full dark or
    // broad day, and only when the guns are quiet.
    const quiet = Math.max(0, 1 - this.ambBattle / 0.4)
    const chance = dawn * quiet * clamp01(this.ambNightFactor / 0.5)
    if (chance < 0.03) {
      this.nextBird = now + 4 + Math.random() * 6 // idle poll, cheap
      return
    }
    // Denser calling the nearer the peak of dawn: 2.5 s..10 s between warbles.
    this.nextBird = now + (2.5 + Math.random() * 7.5) / Math.max(0.15, chance)
    const side = Math.random() < 0.5 ? -1 : 1
    this.play('birdsong', {
      x: this.lx + side * (14 + Math.random() * 40),
      y: 4 + Math.random() * 4,
      z: this.lz + (Math.random() - 0.5) * 60,
      gain: 0.22 + Math.random() * 0.16,
      rate: 0.92 + Math.random() * 0.22,
    })
  }
}
