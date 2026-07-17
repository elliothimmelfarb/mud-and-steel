/**
 * MUD & STEEL — procedural synthesis recipes.
 *
 * Every sound in the game is built here from oscillators, filtered noise,
 * envelopes and a little FM. No samples, no files, no network.
 *
 * A recipe receives a `SynthVoice` build context: it creates nodes on the
 * shared AudioContext, connects everything into `v.mix`, schedules starts and
 * stops sample-accurately from `v.t0`, registers every scheduled source in
 * `v.sources` (so the engine can steal the voice), and returns the total
 * duration in real seconds.
 */

import type { SfxName, LoopName } from './audio'

// ---------------------------------------------------------------------------
// Shared pre-rendered buffers (generated ONCE per context)
// ---------------------------------------------------------------------------

export interface Buffers {
  white: AudioBuffer
  pink: AudioBuffer
  brown: AudioBuffer
  /** Sparse random decaying pops — droplets, fire crackle, embers. */
  crackle: AudioBuffer
}

export function createBuffers(ctx: AudioContext): Buffers {
  const sr = ctx.sampleRate
  const len = (sr * 2) | 0

  const white = ctx.createBuffer(1, len, sr)
  const wd = white.getChannelData(0)
  for (let i = 0; i < len; i++) wd[i] = Math.random() * 2 - 1

  // Paul Kellet pink noise approximation
  const pink = ctx.createBuffer(1, len, sr)
  const pd = pink.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
  }

  // Leaky-integrated brown noise
  const brown = ctx.createBuffer(1, len, sr)
  const bd = brown.getChannelData(0)
  let acc = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    acc = (acc + 0.02 * w) / 1.02
    bd[i] = acc * 3.5
  }

  // Crackle: ~46 random noise pops with exponential decay
  const crackle = ctx.createBuffer(1, len, sr)
  const cd = crackle.getChannelData(0)
  for (let p = 0; p < 46; p++) {
    const at = (Math.random() * (len - 512)) | 0
    const amp = (0.25 + Math.random() * 0.75) * (Math.random() < 0.5 ? -1 : 1)
    const decay = 30 + Math.random() * 260
    for (let i = 0; i < 512; i++) {
      cd[at + i] += amp * Math.exp(-i / decay) * (Math.random() * 2 - 1)
    }
  }

  return { white, pink, brown, crackle }
}

/** Stereo exponential-decay noise IR: shared battlefield reverb. */
export function createImpulseResponse(ctx: AudioContext, seconds = 1.8): AudioBuffer {
  const sr = ctx.sampleRate
  const len = (sr * seconds) | 0
  const ir = ctx.createBuffer(2, len, sr)
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      const t = i / sr
      // short early slap + long exponential tail; channels decorrelated by the noise
      const e = Math.exp(-t * 3.4) * (1 + 0.5 * Math.exp(-t * 40))
      d[i] = (Math.random() * 2 - 1) * e * 0.5
    }
  }
  return ir
}

// ---------------------------------------------------------------------------
// Voice build context + private construction helpers
// ---------------------------------------------------------------------------

export interface SynthVoice {
  ctx: AudioContext
  bufs: Buffers
  /** Recipes connect all output into this node. */
  mix: GainNode
  /** AudioContext time the sound begins. */
  t0: number
  /** Playback rate: scales all frequencies up, all times down. */
  rate: number
  /** Every scheduled source must be pushed here (voice stealing). */
  sources: AudioScheduledSourceNode[]
}

export type Recipe = (v: SynthVoice) => number
export type LoopRecipe = (v: SynthVoice) => void

/** Nominal seconds → absolute context time, scaled by rate. */
function T(v: SynthVoice, s: number): number {
  return v.t0 + s / v.rate
}

function osc(v: SynthVoice, type: OscillatorType, freq: number, at = 0): OscillatorNode {
  const o = v.ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(freq * v.rate, T(v, at))
  v.sources.push(o)
  return o
}

function noiseSrc(v: SynthVoice, buf: keyof Buffers, rate = 1): AudioBufferSourceNode {
  const s = v.ctx.createBufferSource()
  s.buffer = v.bufs[buf]
  s.loop = true
  s.playbackRate.value = rate * v.rate
  v.sources.push(s)
  return s
}

function gain(v: SynthVoice, value: number): GainNode {
  const g = v.ctx.createGain()
  g.gain.value = value
  return g
}

function filt(v: SynthVoice, type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
  const f = v.ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq * v.rate
  f.Q.value = q
  return f
}

/** Linear attack to `peak`, then natural setTarget decay toward silence. */
function env(v: SynthVoice, peak: number, attack: number, tau: number, at = 0): GainNode {
  const g = v.ctx.createGain()
  const t = T(v, at)
  const a = Math.max(0.0008, attack) / v.rate
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(peak, t + a)
  g.gain.setTargetAtTime(0, t + a, tau / v.rate)
  return g
}

interface BurstOpts {
  buf?: keyof Buffers
  at?: number
  peak: number
  attack?: number
  /** Decay time constant (seconds, nominal). */
  tau: number
  /** When the source is stopped, nominal seconds from `at`. */
  dur: number
  ftype?: BiquadFilterType
  freq?: number
  q?: number
  /** Optional filter frequency sweep target over `dur`. */
  freqEnd?: number
  nrate?: number
}

/** Filtered, enveloped noise burst — the workhorse of the whole battlefield. */
function burst(v: SynthVoice, o: BurstOpts): GainNode {
  const at = o.at ?? 0
  const s = noiseSrc(v, o.buf ?? 'white', o.nrate ?? 1)
  const e = env(v, o.peak, o.attack ?? 0.001, o.tau, at)
  let head: AudioNode = s
  if (o.freq !== undefined) {
    const f = filt(v, o.ftype ?? 'bandpass', o.freq, o.q ?? 1)
    if (o.freqEnd !== undefined) {
      f.frequency.setValueAtTime(o.freq * v.rate, T(v, at))
      f.frequency.exponentialRampToValueAtTime(Math.max(25, o.freqEnd * v.rate), T(v, at + o.dur))
    }
    s.connect(f)
    head = f
  }
  head.connect(e)
  e.connect(v.mix)
  s.start(T(v, at), Math.random() * 1.4)
  s.stop(T(v, at + o.dur))
  return e
}

interface ToneOpts {
  type?: OscillatorType
  f0: number
  f1?: number
  /** Seconds to glide f0→f1 (defaults to dur). */
  sweepT?: number
  at?: number
  peak: number
  attack?: number
  tau: number
  dur: number
  /** Optional shaping filter. */
  ff?: number
  ftype?: BiquadFilterType
  q?: number
  vibHz?: number
  vibAmt?: number
}

/** Enveloped oscillator with optional gliss, vibrato and shaping filter. */
function tone(v: SynthVoice, o: ToneOpts): OscillatorNode {
  const at = o.at ?? 0
  const os = osc(v, o.type ?? 'sine', o.f0, at)
  if (o.f1 !== undefined) {
    os.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 * v.rate), T(v, at + (o.sweepT ?? o.dur)))
  }
  if (o.vibHz !== undefined && o.vibAmt !== undefined) {
    const lfo = osc(v, 'sine', o.vibHz, at)
    const lg = gain(v, o.vibAmt * v.rate)
    lfo.connect(lg)
    lg.connect(os.frequency)
    lfo.start(T(v, at))
    lfo.stop(T(v, at + o.dur))
  }
  const e = env(v, o.peak, o.attack ?? 0.002, o.tau, at)
  if (o.ff !== undefined) {
    const f = filt(v, o.ftype ?? 'lowpass', o.ff, o.q ?? 0.8)
    os.connect(f)
    f.connect(e)
  } else {
    os.connect(e)
  }
  e.connect(v.mix)
  os.start(T(v, at))
  os.stop(T(v, at + o.dur))
  return os
}

/** Inharmonic struck-metal partial stack (gongs, clangs, bayonets). */
function metal(
  v: SynthVoice, at: number, base: number, ratios: readonly number[],
  peak: number, tau: number, dur: number,
): void {
  let i = 0
  for (const r of ratios) {
    tone(v, { at, f0: base * r, peak: peak / (1 + i * 0.8), tau: tau * (1 - i * 0.1), dur, attack: 0.001 })
    i++
  }
}

/** Small per-shot randomization: a multiplier centred on 1, spread ±amt. */
function jitter(amt: number): number {
  return 1 + (Math.random() * 2 - 1) * amt
}

interface ReportOpts {
  /** Broadband muzzle transient (the initial "crack"). */
  crackPeak: number
  crackFreq: number
  crackTau?: number
  /** Filtered report body (its tone and weight). */
  bodyPeak: number
  bodyFreq: number
  bodyTau: number
  bodyDur: number
  bodyBuf?: keyof Buffers
  bodyQ?: number
  /** Trench slapback: a quieter, delayed, darker reflection (0 = none). */
  slap?: number
  slapAt?: number
}

/**
 * The shared spine of every small-arm report: a sharp broadband transient, a
 * filtered body, and a single early reflection that reads as the trench walls
 * throwing the muzzle blast back a few milliseconds later. Every layer is
 * pitch/filter/timing jittered per call so a sustained burst never sounds like
 * one stamped sample repeating. Mechanism sounds (bolt, rattle) are layered on
 * top by each weapon's own recipe.
 */
function report(v: SynthVoice, o: ReportOpts): void {
  const jf = jitter(0.05)
  const cTau = o.crackTau ?? 0.006
  // 1) muzzle transient — the whip of the crack
  burst(v, {
    peak: o.crackPeak, tau: cTau, dur: cTau * 6,
    ftype: 'highpass', freq: o.crackFreq * jf, q: 0.7,
  })
  // 2) report body — brown/white through a bandpass gives tone + heft
  burst(v, {
    buf: o.bodyBuf ?? 'brown', peak: o.bodyPeak, tau: o.bodyTau, dur: o.bodyDur,
    ftype: 'bandpass', freq: o.bodyFreq * jf, q: o.bodyQ ?? 0.8,
  })
  // 3) trench slapback — a darker, quieter echo a few ms behind the report
  if (o.slap) {
    const at = (o.slapAt ?? 0.022) * jitter(0.18)
    burst(v, {
      at, peak: o.crackPeak * o.slap, tau: cTau * 3, dur: 0.11,
      ftype: 'bandpass', freq: o.crackFreq * 0.55 * jf, q: 0.9,
    })
  }
}

/** A single dry metallic action click (bolt lug, feed pawl) with timing jitter. */
function mechClick(v: SynthVoice, at: number, freq: number, peak: number): void {
  const jf = jitter(0.08)
  burst(v, { at, peak, tau: 0.01, dur: 0.045, ftype: 'bandpass', freq: freq * jf, q: 2.6 })
  burst(v, { at: at + 0.006, buf: 'brown', peak: peak * 0.5, tau: 0.02, dur: 0.06, ftype: 'lowpass', freq: 520, q: 0.7 })
}

/** Start every registered source at t0 (loops only — one-shots self-start). */
function startAll(v: SynthVoice): void {
  for (const s of v.sources) {
    if (s instanceof AudioBufferSourceNode) s.start(v.t0, Math.random() * 1.4)
    else s.start(v.t0)
  }
}

// ---------------------------------------------------------------------------
// One-shot recipes
// ---------------------------------------------------------------------------

export const SFX_RECIPES: Record<SfxName, Recipe> = {
  // Lee-Enfield .303: a sharp dry crack over a low body, a whip of trench
  // slapback, then the unmistakable SMLE bolt — lift, draw, thumb a round,
  // ram home. Every shot is pitch/timing jittered so rapid fire stays alive.
  rifle(v) {
    report(v, {
      crackPeak: 1.0, crackFreq: 900, crackTau: 0.007,
      bodyPeak: 0.8, bodyFreq: 320, bodyTau: 0.07, bodyDur: 0.3,
      slap: 0.28, slapAt: 0.021,
    })
    // A short low fundamental under the noise gives the crack its punch —
    // the "thump" you feel in the shoulder behind the bright report.
    tone(v, { f0: 155 * jitter(0.05), f1: 72, sweepT: 0.06, peak: 0.5, tau: 0.05, dur: 0.16 })
    // Bolt cycle: two bright lug clicks (lift + draw) then a duller close.
    mechClick(v, 0.15 * jitter(0.12), 2900, 0.15)
    mechClick(v, 0.205 * jitter(0.1), 3400, 0.11)
    burst(v, { at: 0.27 * jitter(0.08), buf: 'brown', peak: 0.12, tau: 0.016, dur: 0.06, ftype: 'lowpass', freq: 650, q: 0.8 })
    return 0.42 / v.rate
  },

  // The same shot, a long way off: all crack gone, just a woolly thud
  rifle_far(v) {
    burst(v, { peak: 0.7, attack: 0.006, tau: 0.09, dur: 0.5, ftype: 'lowpass', freq: 750, q: 0.5 })
    tone(v, { f0: 110, f1: 65, peak: 0.5, tau: 0.12, dur: 0.42 })
    return 0.55 / v.rate
  },

  // One air-cooled Lewis round: a light, bright clatter with a snappy bolt
  // tick riding on top. Deliberately cheap and tight so ~8-9/s layers cleanly
  // into a rattle; the per-shot jitter is what keeps the burst from droning.
  mg(v) {
    report(v, {
      crackPeak: 0.75, crackFreq: 1500, crackTau: 0.006,
      bodyPeak: 0.4, bodyFreq: 300, bodyTau: 0.03, bodyDur: 0.09, bodyQ: 0.9,
    })
    tone(v, { f0: 190 * jitter(0.06), f1: 110, peak: 0.36, tau: 0.03, dur: 0.09 })
    burst(v, { at: 0.014, peak: 0.11, tau: 0.008, dur: 0.03, ftype: 'bandpass', freq: 3100 * jitter(0.1), q: 3 })
    return 0.14 / v.rate
  },

  // One Vickers/MG08 round: the water-jacket makes it heavier, darker and a
  // touch slower to die than the Lewis — a deeper thud with a wet mechanical
  // clank of the fusee and feed block, still cheap enough to sustain all day.
  mg_vickers(v) {
    report(v, {
      crackPeak: 0.82, crackFreq: 1150, crackTau: 0.008,
      bodyPeak: 0.6, bodyFreq: 220, bodyTau: 0.05, bodyDur: 0.14, bodyBuf: 'brown', bodyQ: 0.8,
    })
    tone(v, { f0: 150 * jitter(0.06), f1: 78, peak: 0.42, tau: 0.045, dur: 0.13 })
    burst(v, { at: 0.02, peak: 0.13, tau: 0.012, dur: 0.05, ftype: 'bandpass', freq: 1900 * jitter(0.1), q: 2.4 })
    return 0.2 / v.rate
  },

  // Webley .455: a stubby dry bark with more low-end thump than a rifle and a
  // faint hammer/cylinder click, snappy per-shot for double-action fire.
  pistol(v) {
    report(v, {
      crackPeak: 0.72, crackFreq: 950, crackTau: 0.008,
      bodyPeak: 0.5, bodyFreq: 300, bodyTau: 0.045, bodyDur: 0.16, bodyBuf: 'brown', bodyQ: 0.9,
      slap: 0.22, slapAt: 0.02,
    })
    tone(v, { f0: 340 * jitter(0.06), f1: 175, peak: 0.34, tau: 0.045, dur: 0.13 })
    burst(v, { at: 0.05 * jitter(0.15), peak: 0.08, tau: 0.008, dur: 0.03, ftype: 'bandpass', freq: 2400, q: 2.2 })
    return 0.24 / v.rate
  },

  // Sniper SMLE: the rifle's crack but heavier and slower — one authoritative
  // report with a long body the engine drenches in reverb, then a slow bolt.
  sniper(v) {
    report(v, {
      crackPeak: 1.25, crackFreq: 700, crackTau: 0.012,
      bodyPeak: 0.9, bodyFreq: 240, bodyTau: 0.11, bodyDur: 0.5, bodyQ: 0.7,
      slap: 0.3, slapAt: 0.028,
    })
    tone(v, { f0: 130 * jitter(0.05), f1: 60, peak: 0.7, tau: 0.14, dur: 0.45 })
    mechClick(v, 0.24 * jitter(0.1), 2600, 0.12)
    mechClick(v, 0.33 * jitter(0.1), 3000, 0.09)
    return 0.6 / v.rate
  },

  // Hollow tube "thoomp": resonant noise + falling sine
  mortar_launch(v) {
    burst(v, { buf: 'pink', peak: 0.9, attack: 0.004, tau: 0.1, dur: 0.35, ftype: 'bandpass', freq: 260, q: 2.2 })
    tone(v, { f0: 170, f1: 68, sweepT: 0.16, peak: 0.8, attack: 0.004, tau: 0.09, dur: 0.3 })
    return 0.4 / v.rate
  },

  // 18-pounder: an enormous concussive slam. A hard broadband crack rides a
  // deep sub thump that punches the chest, a long low blast-wash rolls out, and
  // the recoiling carriage rattles and clangs as the barrel runs back on its
  // buffer. The extra sub layer is the "low-end weight" a field gun needs.
  fieldgun(v) {
    burst(v, { peak: 1.0, tau: 0.04, dur: 0.25, ftype: 'lowpass', freq: 2600, q: 0.5 })
    burst(v, { buf: 'brown', peak: 1.55, tau: 0.24, dur: 1.1, ftype: 'lowpass', freq: 480, q: 0.4 })
    // Two detuned sub sines for a fatter, chest-punching fundamental.
    tone(v, { f0: 60 * jitter(0.04), f1: 34, peak: 1.1, tau: 0.3, dur: 0.9 })
    tone(v, { f0: 41 * jitter(0.04), f1: 26, peak: 0.85, tau: 0.42, dur: 1.2 })
    // A distinct blast slapback off the gun pit / parados a beat later.
    burst(v, { at: 0.05 * jitter(0.2), buf: 'brown', peak: 0.55, tau: 0.12, dur: 0.5, ftype: 'lowpass', freq: 900, q: 0.5 })
    // Recoil carriage rattle — buffer clangs as the barrel runs out and back.
    for (let i = 0; i < 5; i++) {
      burst(v, {
        at: 0.11 + i * 0.05 + Math.random() * 0.025, peak: 0.1 * jitter(0.3), tau: 0.012, dur: 0.05,
        ftype: 'bandpass', freq: 2000 + Math.random() * 2000, q: 3,
      })
    }
    return 1.3 / v.rate
  },

  // Grenade / small shell: thump, blast, short rumble
  explosion_small(v) {
    tone(v, { f0: 95, f1: 42, sweepT: 0.28, peak: 1.1, attack: 0.004, tau: 0.16, dur: 0.5 })
    tone(v, { f0: 52 * jitter(0.05), f1: 30, sweepT: 0.35, peak: 0.7, attack: 0.006, tau: 0.26, dur: 0.7 })
    burst(v, { buf: 'brown', peak: 1.25, attack: 0.002, tau: 0.16, dur: 0.7, ftype: 'lowpass', freq: 950, q: 0.5 })
    burst(v, { buf: 'brown', at: 0.06, peak: 0.55, attack: 0.09, tau: 0.5, dur: 1.9, ftype: 'lowpass', freq: 230, q: 0.4 })
    return 2.0 / v.rate
  },

  // 5.9-inch: deep sub sweep, big blast, long rumble, falling debris
  explosion_big(v) {
    tone(v, { f0: 74, f1: 30, sweepT: 0.5, peak: 1.5, attack: 0.005, tau: 0.3, dur: 0.9 })
    // Ground-shaking sub: a slow, very low sine under the whole blast.
    tone(v, { f0: 40 * jitter(0.05), f1: 22, sweepT: 0.7, peak: 1.0, attack: 0.008, tau: 0.5, dur: 1.4 })
    burst(v, { buf: 'brown', peak: 1.6, attack: 0.003, tau: 0.26, dur: 1.1, ftype: 'lowpass', freq: 760, q: 0.5 })
    burst(v, { buf: 'brown', at: 0.1, peak: 0.7, attack: 0.14, tau: 0.9, dur: 3.4, ftype: 'lowpass', freq: 175, q: 0.4 })
    for (let i = 0; i < 9; i++) {
      burst(v, {
        at: 0.45 + Math.random() * 1.2, peak: 0.05 + Math.random() * 0.05, tau: 0.015, dur: 0.05,
        ftype: 'highpass', freq: 1300 + Math.random() * 1500, q: 1,
      })
    }
    return 3.6 / v.rate
  },

  // Miles away: no attack, all low rolling boom
  explosion_far(v) {
    tone(v, { at: 0.03, f0: 52, f1: 33, sweepT: 0.6, peak: 0.8, attack: 0.05, tau: 0.5, dur: 1.6 })
    burst(v, { buf: 'brown', at: 0.02, peak: 0.75, attack: 0.06, tau: 0.45, dur: 1.6, ftype: 'lowpass', freq: 240, q: 0.4 })
    burst(v, { buf: 'brown', at: 0.5, peak: 0.28, attack: 0.3, tau: 0.8, dur: 2.6, ftype: 'lowpass', freq: 130, q: 0.4 })
    return 2.8 / v.rate
  },

  // Clods and mud raining back down
  dirt_shower(v) {
    burst(v, { buf: 'pink', peak: 0.3, attack: 0.05, tau: 0.28, dur: 0.9, ftype: 'bandpass', freq: 850, q: 0.7, freqEnd: 400 })
    for (let i = 0; i < 8; i++) {
      burst(v, {
        at: 0.05 + Math.random() * 0.5, peak: 0.05 + Math.random() * 0.06, tau: 0.01, dur: 0.04,
        ftype: 'bandpass', freq: 600 + Math.random() * 900, q: 2,
      })
    }
    return 1.0 / v.rate
  },

  // Gas shell bursting: soft hollow cough then a long hiss
  gas_pop(v) {
    burst(v, { buf: 'pink', peak: 0.7, attack: 0.003, tau: 0.09, dur: 0.3, ftype: 'bandpass', freq: 380, q: 2.6 })
    burst(v, { peak: 0.16, attack: 0.05, tau: 0.55, dur: 1.6, ftype: 'highpass', freq: 3800, q: 0.5 })
    return 1.7 / v.rate
  },

  // Empty shell casing beaten as a gas alarm — three clangs
  gas_gong(v) {
    const amps = [1, 0.82, 0.62] as const
    for (let s = 0; s < 3; s++) {
      const at = s * 0.62
      const amp = amps[s] as number
      // FM clangor: metallic attack complexity that dies into pure ring
      const car = osc(v, 'sine', 397, at)
      const mod = osc(v, 'sine', 631, at)
      const mg = gain(v, 0)
      mg.gain.setValueAtTime(520 * v.rate, T(v, at))
      mg.gain.setTargetAtTime(40 * v.rate, T(v, at), 0.18 / v.rate)
      mod.connect(mg)
      mg.connect(car.frequency)
      const e = env(v, 0.55 * amp, 0.001, 0.5, at)
      car.connect(e)
      e.connect(v.mix)
      car.start(T(v, at)); car.stop(T(v, at + 1.55))
      mod.start(T(v, at)); mod.stop(T(v, at + 1.55))
      metal(v, at, 397, [1, 2.31, 3.72], 0.3 * amp, 0.55, 1.55)
      burst(v, { at, peak: 0.3 * amp, tau: 0.015, dur: 0.05, ftype: 'bandpass', freq: 2400, q: 1.5 })
    }
    return 2.9 / v.rate
  },

  // Bayonet on bayonet: clash of steel then a body-blow thud
  melee(v) {
    metal(v, 0, 2450, [1, 1.62, 2.13], 0.4, 0.09, 0.5)
    burst(v, { peak: 0.5, tau: 0.012, dur: 0.05, ftype: 'highpass', freq: 3000, q: 1 })
    burst(v, { buf: 'brown', at: 0.04, peak: 0.5, tau: 0.07, dur: 0.3, ftype: 'lowpass', freq: 220, q: 0.6 })
    return 0.5 / v.rate
  },

  // Brief formant-swept cry — restrained, never comedic
  death_cry(v) {
    const jit = 0.9 + Math.random() * 0.25
    const os = osc(v, 'sawtooth', 230 * jit)
    os.frequency.exponentialRampToValueAtTime(130 * jit * v.rate, T(v, 0.55))
    const lfo = osc(v, 'sine', 6.5)
    const lg = gain(v, 10 * v.rate)
    lfo.connect(lg)
    lg.connect(os.frequency)
    const e = env(v, 0.42, 0.09, 0.17)
    const f1 = filt(v, 'bandpass', 620 * jit, 3)
    f1.frequency.setValueAtTime(620 * jit * v.rate, v.t0)
    f1.frequency.exponentialRampToValueAtTime(370 * v.rate, T(v, 0.55))
    const f2 = filt(v, 'bandpass', 1280 * jit, 4)
    f2.frequency.setValueAtTime(1280 * jit * v.rate, v.t0)
    f2.frequency.exponentialRampToValueAtTime(750 * v.rate, T(v, 0.55))
    const g2 = gain(v, 0.5)
    os.connect(f1); f1.connect(e)
    os.connect(f2); f2.connect(g2); g2.connect(e)
    e.connect(v.mix)
    os.start(v.t0); os.stop(T(v, 0.6))
    lfo.start(v.t0); lfo.stop(T(v, 0.6))
    return 0.7 / v.rate
  },

  // Four-beat gallop, two strides
  horse(v) {
    const beat = [0, 0.09, 0.2, 0.29] as const
    for (let c = 0; c < 2; c++) {
      for (let b = 0; b < 4; b++) {
        burst(v, {
          buf: 'brown',
          at: c * 0.52 + (beat[b] as number) + Math.random() * 0.012,
          peak: (b === 3 ? 0.55 : 0.38) * (0.9 + Math.random() * 0.2),
          attack: 0.003, tau: 0.035, dur: 0.12,
          ftype: 'lowpass', freq: 300 + Math.random() * 80, q: 0.7,
        })
      }
    }
    return 1.15 / v.rate
  },

  // Cutters through wire: bright ting, snap, lower ring
  wire_snip(v) {
    burst(v, { peak: 0.4, tau: 0.008, dur: 0.03, ftype: 'highpass', freq: 2500, q: 1 })
    tone(v, { f0: 3300, peak: 0.3, tau: 0.045, dur: 0.25 })
    tone(v, { at: 0.03, f0: 1900, f1: 1500, peak: 0.18, tau: 0.06, dur: 0.25 })
    return 0.3 / v.rate
  },

  // Three hammer knocks on timber
  build(v) {
    for (let i = 0; i < 3; i++) {
      const at = i * 0.21 + Math.random() * 0.02
      burst(v, { at, buf: 'pink', peak: 0.55, tau: 0.03, dur: 0.12, ftype: 'bandpass', freq: 640 + Math.random() * 120, q: 1.6 })
      burst(v, { at, peak: 0.2, tau: 0.008, dur: 0.03, ftype: 'highpass', freq: 2600, q: 1 })
    }
    return 0.75 / v.rate
  },

  // Shovel: scrape into mud, then the spoil lands
  dig(v) {
    burst(v, { peak: 0.32, attack: 0.06, tau: 0.09, dur: 0.32, ftype: 'bandpass', freq: 1300, q: 0.9, freqEnd: 700 })
    burst(v, { buf: 'brown', at: 0.2, peak: 0.5, tau: 0.06, dur: 0.28, ftype: 'lowpass', freq: 260, q: 0.6 })
    for (let i = 0; i < 5; i++) {
      burst(v, {
        at: 0.22 + Math.random() * 0.18, peak: 0.05, tau: 0.01, dur: 0.04,
        ftype: 'bandpass', freq: 900 + Math.random() * 700, q: 2,
      })
    }
    return 0.55 / v.rate
  },

  // Requisition refund: coin chinks under a paper shuffle
  sell(v) {
    for (let i = 0; i < 3; i++) {
      tone(v, { at: i * 0.07 + Math.random() * 0.015, f0: 4200 + Math.random() * 1600, peak: 0.14, tau: 0.03, dur: 0.1 })
    }
    burst(v, { buf: 'pink', at: 0.02, peak: 0.18, attack: 0.05, tau: 0.08, dur: 0.3, ftype: 'highpass', freq: 2300, q: 0.6 })
    return 0.4 / v.rate
  },

  // Papery period UI: typewriter tick
  ui_click(v) {
    burst(v, { peak: 0.3, tau: 0.01, dur: 0.04, ftype: 'bandpass', freq: 2100, q: 2.5 })
    tone(v, { f0: 720, peak: 0.12, tau: 0.015, dur: 0.05 })
    return 0.08 / v.rate
  },

  // Page-turn swish with a soft latch
  ui_open(v) {
    burst(v, { buf: 'pink', peak: 0.2, attack: 0.04, tau: 0.07, dur: 0.22, ftype: 'bandpass', freq: 900, q: 0.8, freqEnd: 2600 })
    burst(v, { at: 0.16, peak: 0.1, tau: 0.008, dur: 0.03, ftype: 'highpass', freq: 3200, q: 1 })
    return 0.26 / v.rate
  },

  // Dull rubber-stamp thunk of refusal
  ui_error(v) {
    tone(v, { f0: 170, f1: 115, peak: 0.32, tau: 0.07, dur: 0.2, ff: 600 })
    burst(v, { buf: 'brown', peak: 0.2, tau: 0.03, dur: 0.1, ftype: 'lowpass', freq: 420, q: 0.7 })
    return 0.25 / v.rate
  },

  // Two-note brass swell, G up to C
  upgrade(v) {
    tone(v, { type: 'sawtooth', f0: 196, peak: 0.3, attack: 0.05, tau: 0.1, dur: 0.24, ff: 1100, q: 1, vibHz: 5, vibAmt: 2 })
    tone(v, { type: 'sawtooth', at: 0.2, f0: 261.63, peak: 0.34, attack: 0.06, tau: 0.24, dur: 0.55, ff: 1300, q: 1, vibHz: 5.5, vibAmt: 3 })
    return 0.8 / v.rate
  },

  // Officer's pea-whistle: shrill trilled blast
  whistle_attack(v) {
    const os = osc(v, 'square', 2480)
    const lfo = osc(v, 'square', 21)
    const lg = gain(v, 130 * v.rate)
    lfo.connect(lg)
    lg.connect(os.frequency)
    const f = filt(v, 'bandpass', 2500, 2)
    const e = gain(v, 0)
    e.gain.setValueAtTime(0, v.t0)
    e.gain.linearRampToValueAtTime(0.32, T(v, 0.02))
    e.gain.setValueAtTime(0.32, T(v, 0.72))
    e.gain.linearRampToValueAtTime(0.0001, T(v, 0.82))
    os.connect(f); f.connect(e); e.connect(v.mix)
    os.start(v.t0); os.stop(T(v, 0.85))
    lfo.start(v.t0); lfo.stop(T(v, 0.85))
    return 0.9 / v.rate
  },

  // Very pop, faint magnesium sizzle drifting down
  flare_pop(v) {
    burst(v, { buf: 'pink', peak: 0.35, attack: 0.002, tau: 0.05, dur: 0.2, ftype: 'bandpass', freq: 520, q: 1.6 })
    burst(v, { at: 0.05, peak: 0.06, attack: 0.08, tau: 0.4, dur: 1.2, ftype: 'highpass', freq: 4600, q: 0.5 })
    return 1.3 / v.rate
  },

  // Bolt out, clip in, bolt home
  reload(v) {
    const ats = [0, 0.13, 0.3] as const
    const fqs = [1700, 1400, 2100] as const
    for (let i = 0; i < 3; i++) {
      burst(v, { at: ats[i] as number, peak: 0.3, tau: 0.012, dur: 0.05, ftype: 'bandpass', freq: fqs[i] as number, q: 2.5 })
      burst(v, { at: (ats[i] as number) + 0.012, buf: 'brown', peak: 0.14, tau: 0.02, dur: 0.06, ftype: 'lowpass', freq: 500, q: 0.7 })
    }
    return 0.45 / v.rate
  },

  // Vickers water jacket letting go
  steam_vent(v) {
    burst(v, { peak: 0.5, attack: 0.02, tau: 0.55, dur: 1.9, ftype: 'highpass', freq: 2800, q: 0.5, freqEnd: 5000 })
    return 2.0 / v.rate
  },

  // Long rolling storm with random rumble peaks
  thunder(v) {
    const dur = 3.2 + Math.random() * 1.2
    const s = noiseSrc(v, 'brown', 0.85)
    const f = filt(v, 'lowpass', 320, 0.5)
    f.frequency.setValueAtTime(340 * v.rate, v.t0)
    f.frequency.linearRampToValueAtTime(150 * v.rate, T(v, dur))
    const e = gain(v, 0)
    e.gain.setValueAtTime(0, v.t0)
    let t = 0.1
    e.gain.linearRampToValueAtTime(0.8, T(v, t))
    const steps = 4
    for (let i = 0; i < steps; i++) {
      const seg = (dur - 0.5 - t) / (steps - i)
      e.gain.linearRampToValueAtTime(0.15 + Math.random() * 0.25, T(v, t + seg * (0.3 + Math.random() * 0.2)))
      e.gain.linearRampToValueAtTime(0.35 + Math.random() * 0.5, T(v, t + seg * (0.7 + Math.random() * 0.2)))
      t += seg
    }
    e.gain.linearRampToValueAtTime(0.0001, T(v, dur))
    s.connect(f); f.connect(e); e.connect(v.mix)
    s.start(v.t0, Math.random() * 1.4)
    s.stop(T(v, dur + 0.05))
    return (dur + 0.1) / v.rate
  },

  // The Last Post, first phrase — C, C, F
  bugle_victory(v) {
    const notes: ReadonlyArray<readonly [number, number, number]> = [
      [0, 261.63, 0.34],
      [0.38, 261.63, 0.2],
      [0.62, 349.23, 0.95],
    ]
    for (const [at, f0, len] of notes) {
      tone(v, {
        type: 'sawtooth', at, f0, peak: 0.34, attack: 0.05, tau: len * 0.55, dur: len + 0.3,
        ff: 900, q: 0.8, vibHz: 5.2, vibAmt: f0 * 0.008,
      })
    }
    return 2.0 / v.rate
  },

  // Low minor cluster swelling and dying — the line has broken
  drone_defeat(v) {
    for (const f0 of [65.41, 77.78, 98.0, 130.81]) {
      const os = osc(v, 'sawtooth', f0 * (1 + (Math.random() - 0.5) * 0.006))
      const fl = filt(v, 'lowpass', 380, 0.6)
      const e = gain(v, 0)
      e.gain.setValueAtTime(0, v.t0)
      e.gain.linearRampToValueAtTime(0.13, T(v, 1.3))
      e.gain.setValueAtTime(0.13, T(v, 1.9))
      e.gain.linearRampToValueAtTime(0.0001, T(v, 3.6))
      os.connect(fl); fl.connect(e); e.connect(v.mix)
      os.start(v.t0); os.stop(T(v, 3.7))
    }
    return 3.8 / v.rate
  },

  // Something heavy into a flooded crater, droplets after
  splash(v) {
    burst(v, { buf: 'pink', peak: 0.55, attack: 0.004, tau: 0.07, dur: 0.3, ftype: 'bandpass', freq: 850, q: 1.1, freqEnd: 450 })
    for (let i = 0; i < 5; i++) {
      tone(v, {
        at: 0.07 + Math.random() * 0.3, f0: 1000 + Math.random() * 800, f1: 500, sweepT: 0.03,
        peak: 0.08, tau: 0.02, dur: 0.05,
      })
    }
    return 0.5 / v.rate
  },

  // Solid shot on armour plate: clang with long metallic ring modes
  tank_hit(v) {
    burst(v, { buf: 'brown', peak: 1.2, tau: 0.06, dur: 0.3, ftype: 'lowpass', freq: 1400, q: 0.6 })
    metal(v, 0, 178, [1, 1.64, 2.42, 3.86], 0.7, 0.42, 1.5)
    burst(v, { peak: 0.5, tau: 0.01, dur: 0.04, ftype: 'highpass', freq: 2200, q: 1 })
    return 1.5 / v.rate
  },

  // The classic descending whine, random curve every time
  ricochet(v) {
    burst(v, { peak: 0.35, tau: 0.012, dur: 0.05, ftype: 'highpass', freq: 2000, q: 1 })
    const os = osc(v, 'sine', 2300 + Math.random() * 900, 0.015)
    os.frequency.exponentialRampToValueAtTime(
      (1200 + Math.random() * 500) * v.rate, T(v, 0.125 + Math.random() * 0.08))
    os.frequency.exponentialRampToValueAtTime((550 + Math.random() * 250) * v.rate, T(v, 0.42))
    const e = env(v, 0.28, 0.01, 0.13, 0.015)
    os.connect(e); e.connect(v.mix)
    os.start(T(v, 0.015)); os.stop(T(v, 0.45))
    return 0.5 / v.rate
  },

  // Gas casualty: two short muffled coughs, kept quiet
  cough(v) {
    burst(v, { buf: 'pink', peak: 0.3, attack: 0.015, tau: 0.05, dur: 0.16, ftype: 'bandpass', freq: 480, q: 3.5, freqEnd: 300 })
    burst(v, { buf: 'pink', at: 0.14, peak: 0.22, attack: 0.012, tau: 0.06, dur: 0.18, ftype: 'bandpass', freq: 420, q: 3.5, freqEnd: 260 })
    return 0.35 / v.rate
  },

  // A supersonic round splitting the air a hand's breadth away: the ballistic
  // N-wave. NOT a muzzle report — it has no body or tail, just an ultra-short
  // whip-CRACK with a tearing hiss of disturbed air. Placed at the round's
  // closest approach so 3D panning throws it past the ear, distinct from both
  // the distant muzzle bark and the descending whine of a ricochet.
  supersonic_crack(v) {
    const jf = jitter(0.1)
    burst(v, { peak: 0.95, tau: 0.0035, dur: 0.018, ftype: 'highpass', freq: 3400 * jf, q: 0.7 })
    burst(v, { at: 0.005, peak: 0.42, tau: 0.008, dur: 0.03, ftype: 'bandpass', freq: 1700 * jf, q: 1.3 })
    // the ripping air behind the shock front
    burst(v, { at: 0.004, buf: 'pink', peak: 0.2, attack: 0.001, tau: 0.028, dur: 0.09, ftype: 'highpass', freq: 2400, q: 0.5 })
    return 0.12 / v.rate
  },

  // Sparse dawn birdsong over the parapet: a short warble of a few chirps,
  // each a fast up-or-down glide with a flutter of vibrato. Kept quiet and
  // fully randomized so no two calls repeat — used only by the dawn ambience.
  birdsong(v) {
    const notes = 2 + ((Math.random() * 3) | 0)
    const base = 2500 + Math.random() * 1500
    let at = 0
    for (let i = 0; i < notes; i++) {
      const f0 = base * (0.8 + Math.random() * 0.5)
      const f1 = f0 * (0.65 + Math.random() * 0.7)
      const len = 0.07 + Math.random() * 0.06
      tone(v, {
        at, f0, f1, sweepT: len * 0.7, peak: 0.05 + Math.random() * 0.03,
        attack: 0.006, tau: 0.035, dur: len,
        vibHz: 16 + Math.random() * 12, vibAmt: f0 * 0.012,
      })
      at += len * 0.55 + Math.random() * 0.07
    }
    return (at + 0.2) / v.rate
  },
}

// ---------------------------------------------------------------------------
// The shell whistle — duration is gameplay-critical, sized to the caller
// ---------------------------------------------------------------------------

export function shellWhistleRecipe(v: SynthVoice, seconds: number): number {
  const s = Math.max(0.25, Math.min(10, seconds))
  const fStart = (1750 + Math.random() * 150) * v.rate
  const fEnd = 280 * v.rate

  const os = osc(v, 'sine', fStart / v.rate)
  os.frequency.exponentialRampToValueAtTime(fEnd, v.t0 + s)
  // vibrato deepens as it falls
  const lfo = osc(v, 'sine', 5.5)
  const lg = gain(v, 0)
  lg.gain.setValueAtTime(6 * v.rate, v.t0)
  lg.gain.linearRampToValueAtTime(26 * v.rate, v.t0 + s)
  lfo.connect(lg)
  lg.connect(os.frequency)
  const e = gain(v, 0)
  e.gain.setValueAtTime(0.0001, v.t0)
  e.gain.exponentialRampToValueAtTime(0.09, v.t0 + Math.min(0.4, s * 0.3))
  e.gain.exponentialRampToValueAtTime(0.62, v.t0 + s * 0.97)
  e.gain.linearRampToValueAtTime(0, v.t0 + s) // dead cut at impact
  os.connect(e)
  e.connect(v.mix)

  // A sub-octave partial an octave below the whine, growing as it nears — this
  // is what turns a thin whistle into a heavy shell bearing down on you.
  const sub = osc(v, 'sine', fStart / v.rate / 2)
  sub.frequency.exponentialRampToValueAtTime(Math.max(30, fEnd / 2), v.t0 + s)
  const sg = gain(v, 0)
  sg.gain.setValueAtTime(0.0001, v.t0)
  sg.gain.exponentialRampToValueAtTime(0.3, v.t0 + s * 0.97)
  sg.gain.linearRampToValueAtTime(0, v.t0 + s)
  sub.connect(sg); sg.connect(v.mix)

  // breathy air noise tracking the gliss
  const n = noiseSrc(v, 'white', 1)
  const bp = filt(v, 'bandpass', fStart / v.rate, 9)
  bp.frequency.setValueAtTime(fStart, v.t0)
  bp.frequency.exponentialRampToValueAtTime(fEnd, v.t0 + s)
  const ng = gain(v, 0)
  ng.gain.setValueAtTime(0.0001, v.t0)
  ng.gain.exponentialRampToValueAtTime(0.34, v.t0 + s * 0.97)
  ng.gain.linearRampToValueAtTime(0, v.t0 + s)
  n.connect(bp); bp.connect(ng); ng.connect(v.mix)

  os.start(v.t0); os.stop(v.t0 + s + 0.02)
  lfo.start(v.t0); lfo.stop(v.t0 + s + 0.02)
  sub.start(v.t0); sub.stop(v.t0 + s + 0.02)
  n.start(v.t0, Math.random() * 1.4); n.stop(v.t0 + s + 0.02)
  return s
}

// ---------------------------------------------------------------------------
// Loop recipes — endless, LFO-driven, no timers
// ---------------------------------------------------------------------------

export const LOOP_RECIPES: Record<LoopName, LoopRecipe> = {
  // Chugging Daimler: LFO-gated saws over a low rumble
  tank_engine(v) {
    const saw1 = osc(v, 'sawtooth', 46)
    const saw2 = osc(v, 'sawtooth', 47.3)
    const fl = filt(v, 'lowpass', 340, 0.7)
    const chug = gain(v, 0.5)
    const lfo = osc(v, 'square', 8.6)
    const lg = gain(v, 0.42)
    lfo.connect(lg); lg.connect(chug.gain)
    saw1.connect(fl); saw2.connect(fl); fl.connect(chug)
    const sg = gain(v, 0.5)
    chug.connect(sg); sg.connect(v.mix)
    const n = noiseSrc(v, 'brown', 0.9)
    const nf = filt(v, 'lowpass', 170, 0.5)
    const ng = gain(v, 0.4)
    n.connect(nf); nf.connect(ng); ng.connect(v.mix)
    const wob = osc(v, 'sine', 0.17)
    const wg = gain(v, 2.5)
    wob.connect(wg); wg.connect(saw1.frequency); wg.connect(saw2.frequency)
    startAll(v)
  },

  // Droning prop: detuned saws beating, fast flutter, slow wow
  plane(v) {
    const s1 = osc(v, 'sawtooth', 106)
    const s2 = osc(v, 'sawtooth', 109.7)
    const s3 = osc(v, 'square', 53)
    const g3 = gain(v, 0.5)
    const fl = filt(v, 'lowpass', 750, 0.6)
    const flut = gain(v, 0.55)
    const lfo = osc(v, 'sine', 15.5)
    const lg = gain(v, 0.22)
    lfo.connect(lg); lg.connect(flut.gain)
    const wow = osc(v, 'sine', 0.23)
    const wg = gain(v, 3.2)
    wow.connect(wg); wg.connect(s1.frequency); wg.connect(s2.frequency)
    s1.connect(fl); s2.connect(fl); s3.connect(g3); g3.connect(fl)
    fl.connect(flut)
    const out = gain(v, 0.4)
    flut.connect(out); out.connect(v.mix)
    startAll(v)
  },

  // Roaring pressurised burn
  flamethrower(v) {
    const n1 = noiseSrc(v, 'white', 0.85)
    const bp = filt(v, 'bandpass', 520, 0.7)
    const lfo = osc(v, 'sine', 3.6)
    const lg = gain(v, 190)
    lfo.connect(lg); lg.connect(bp.frequency)
    const g1 = gain(v, 0.85)
    n1.connect(bp); bp.connect(g1); g1.connect(v.mix)
    const n2 = noiseSrc(v, 'brown', 1)
    const lp = filt(v, 'lowpass', 260, 0.5)
    const g2 = gain(v, 0.55)
    n2.connect(lp); lp.connect(g2); g2.connect(v.mix)
    const flick = osc(v, 'sine', 11.3)
    const fg = gain(v, 0.15)
    flick.connect(fg); fg.connect(g1.gain)
    startAll(v)
  },

  // Steady rain sheet + droplet ticks on tin and timber
  rain(v) {
    const n = noiseSrc(v, 'pink', 1)
    const lp = filt(v, 'lowpass', 3200, 0.4)
    const g1 = gain(v, 0.5)
    n.connect(lp); lp.connect(g1); g1.connect(v.mix)
    const c = noiseSrc(v, 'crackle', 1.6)
    const hp = filt(v, 'highpass', 3600, 0.6)
    const g2 = gain(v, 0.14)
    c.connect(hp); hp.connect(g2); g2.connect(v.mix)
    startAll(v)
  },

  // Slow-breathing wind over the parapet, thin whistle through the wire
  wind(v) {
    const n = noiseSrc(v, 'brown', 0.75)
    const bp = filt(v, 'bandpass', 400, 0.45)
    const lfo1 = osc(v, 'sine', 0.11)
    const lg1 = gain(v, 210)
    lfo1.connect(lg1); lg1.connect(bp.frequency)
    const g1 = gain(v, 0.55)
    const lfo2 = osc(v, 'sine', 0.19)
    const lg2 = gain(v, 0.22)
    lfo2.connect(lg2); lg2.connect(g1.gain)
    n.connect(bp); bp.connect(g1); g1.connect(v.mix)
    const n2 = noiseSrc(v, 'pink', 1)
    const bp2 = filt(v, 'bandpass', 1400, 6)
    const lg3 = gain(v, 500)
    lfo1.connect(lg3); lg3.connect(bp2.frequency)
    const g2 = gain(v, 0.05)
    n2.connect(bp2); bp2.connect(g2); g2.connect(v.mix)
    startAll(v)
  },

  // Faint magnesium sizzle overhead
  flare_burn(v) {
    const n = noiseSrc(v, 'white', 1)
    const hp = filt(v, 'highpass', 4300, 0.5)
    const g1 = gain(v, 0.11)
    const lfo = osc(v, 'sine', 6.7)
    const lg = gain(v, 0.04)
    lfo.connect(lg); lg.connect(g1.gain)
    n.connect(hp); hp.connect(g1); g1.connect(v.mix)
    const c = noiseSrc(v, 'crackle', 2.3)
    const hp2 = filt(v, 'highpass', 2900, 0.6)
    const g2 = gain(v, 0.05)
    c.connect(hp2); hp2.connect(g2); g2.connect(v.mix)
    startAll(v)
  },

  // Crackling wreck fire: two crackle layers over a breathing roar
  fire_burn(v) {
    const c = noiseSrc(v, 'crackle', 1)
    const lp = filt(v, 'lowpass', 2500, 0.5)
    const g1 = gain(v, 0.7)
    c.connect(lp); lp.connect(g1); g1.connect(v.mix)
    const n = noiseSrc(v, 'brown', 0.85)
    const lp2 = filt(v, 'lowpass', 330, 0.5)
    const g2 = gain(v, 0.42)
    const lfo = osc(v, 'sine', 0.5)
    const lg = gain(v, 0.12)
    lfo.connect(lg); lg.connect(g2.gain)
    n.connect(lp2); lp2.connect(g2); g2.connect(v.mix)
    const c2 = noiseSrc(v, 'crackle', 0.63)
    const lp3 = filt(v, 'lowpass', 1400, 0.5)
    const g3 = gain(v, 0.5)
    c2.connect(lp3); lp3.connect(g3); g3.connect(v.mix)
    startAll(v)
  },
}

/**
 * Sparse eerie night bed used internally by setAmbience (not a public loop).
 * A low minor drone slowly breathing, plus a very faint high airy shimmer that
 * gives the night its own timbre against the daytime wind bed it crossfades in
 * over — the two beds are the day/night crossfade the field asked for.
 */
export const NIGHT_DRONE: LoopRecipe = (v) => {
  const o1 = osc(v, 'sine', 54)
  const o2 = osc(v, 'sine', 81.5)
  const o3 = osc(v, 'triangle', 108.7)
  const g1 = gain(v, 0.5)
  const g2 = gain(v, 0.3)
  const g3 = gain(v, 0.12)
  const sum = gain(v, 1)
  const lfo = osc(v, 'sine', 0.07)
  const lg = gain(v, 0.18)
  lfo.connect(lg); lg.connect(sum.gain)
  o1.connect(g1); o2.connect(g2); o3.connect(g3)
  g1.connect(sum); g2.connect(sum); g3.connect(sum)
  sum.connect(v.mix)
  // Thin, slowly-panning high air — cold night wind far above the trench.
  const air = noiseSrc(v, 'pink', 1)
  const abp = filt(v, 'bandpass', 2600, 1.2)
  const alfo = osc(v, 'sine', 0.05)
  const alg = gain(v, 900)
  alfo.connect(alg); alg.connect(abp.frequency)
  const ag = gain(v, 0.05)
  const alfo2 = osc(v, 'sine', 0.13)
  const alg2 = gain(v, 0.03)
  alfo2.connect(alg2); alg2.connect(ag.gain)
  air.connect(abp); abp.connect(ag); ag.connect(v.mix)
  startAll(v)
}
