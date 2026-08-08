/**
 * The conductor. Owns the run lifecycle (build → assault → debrief), the
 * economy, placement, orders, upgrades, saves, and the seam between the
 * 30 Hz sim and the render/audio layers.
 */
import * as THREE from 'three'
import type {
  BuildableId, CasualtyRecord, DefenceKindId, Difficulty, GameSettings,
  Soldier, Stance, TargetPriority, Team, Unit, UnitKindId, WavePlan,
} from '../core/types'
import {
  BUILD_ORDER, DEEDS, DEFENCE_DEFS, ECONOMY, PLACEMENT, RANKS,
  SIM_DT, TRENCH, UNIT_DEFS, UPGRADE_DEFS, VET_XP, WORLD,
} from '../core/config'

/** Ground speed (m/s) that reads as a flat-out run in the stride animation. */
const GAIT_FULL_SPEED = 3.4
/** Stride-clock rate at a standstill (idle shuffle) and per m/s of real speed. */
const GAIT_IDLE_RATE = 1.2
const GAIT_RATE_PER_SPEED = 2.4
import { EventBus } from '../core/events'
import { forkRand, hashString, type Rand } from '../core/rng'
import {
  fieldDate, intelFlavor, makeEpitaph, makeRegiment, writeLetterHome,
} from '../core/flavor'
import { clearRun, saveRun, submitScore, type RunSave } from '../core/save'
import { Terrain } from '../world/terrain'
import { TerrainMesh } from '../world/terrainMesh'
import { Sky } from '../world/sky'
import { Weather } from '../world/weather'
import { GameRenderer } from '../render/renderer'
import { CameraRig, Input, rayGround } from '../render/controls'
import { SoldierRenderer, type SoldierPose } from '../render/unitMeshes'
import { Scenery } from '../render/scenery'
import { EffectsSystem, type EmitterHandle } from '../render/effects'
import { RoundRenderer } from '../render/roundRenderer'
import type { AudioEngine, SfxName } from '../audio/audio'
import { reqOf as simReqOf, type Ctx } from '../sim/sim'
import { Mods } from '../sim/mods'
import { projectToFireStep, sectionAt } from '../sim/trench'
import { leadCrew } from '../sim/veterancy'
import { spawnEnemy } from '../sim/enemies'
import { standSurface } from '../sim/ballistics'
import { collectGasBlobs } from '../sim/gas'
import { SimRunner } from '../sim/runner'
import { LockstepSession } from '../net/lockstep'
import type { Transport } from '../net/transport'
import {
  costOf as cmdCostOf, createUnit as simCreateUnit, fieldBuildAllowed as simFieldBuildAllowed,
  isUnitKind as simIsUnitKind, marchPathLength, MARCH_SPEED, orderReady as simOrderReady,
  padSpotValid as simPadSpotValid,
  unitClearance as simUnitClearance, upgradeAvailable as simUpgradeAvailable,
  type Cmd, type OrderId,
} from '../sim/commands'
import { FpsMode } from './fps'
import { setViewmodelEmissive, type FireParams } from './weapons'

export type { OrderId } from '../sim/commands'

/** A finished Big Push battle, portable: seed + envelope log IS the battle. */
export interface ReplayRecord {
  v: 1
  seedStr: string
  matchLen: import('../core/types').MatchLength
  /** From-start AI persona to re-derive (SP), or null (MP — adopted-AI
   *  envelopes are in the log). */
  persona: import('../sim/ai').AiPersona | null
  /** Which chair the recording was fought from — playback must sit in it or
   *  the AI ends up on the wrong side of the wire. */
  side?: import('../core/types').Team
  envs: import('../sim/commands').Envelope[]
  /** The player embodied someone: first-person actions are not yet in the
   *  command stream, so playback may diverge from the battle as fought. */
  embodied?: boolean
}

export interface IntelData {
  wave: number
  date: string
  title: string
  rows: Array<{ icon: string; label: string; detail: string }>
  weatherLine: string
  adviceLine: string
}

export interface SelectedInfo {
  unitId: number
  kind: UnitKindId
  name: string
  rank: string
  kills: number
  vet: number
  /** Terse deed labels for the named man, e.g. ["Cool under fire", "Marksmanship"]. */
  deeds: string[]
  wavesServed: number
  /** Experience toward the next rank, 0..1; null once a full Sergeant. */
  rankProgress: number | null
  crewAlive: number
  crewMax: number
  hpFrac: number
  heat: number
  /** Average nerve of the living crew, 0 (broken) .. 1 (steady). */
  morale: number
  /** Average suppression on the living crew, 0 (calm) .. 1 (heads down). */
  suppression: number
  /** Rounds left in the ready supply; -1 when the weapon is not ammo-limited. */
  ammo: number
  /** Size of a full load for ammo-limited weapons; 0 when not applicable. */
  ammoMax: number
  targeting: TargetPriority
  sellValue: number
  fallenBack: boolean
}

/** HUD hooks the game calls; the HUD module fills these in. */
export interface HudBridge {
  showIntel(data: IntelData, beginLabel: string, onBegin: () => void): void
  showLetter(text: string, signature: string): void
  banner(text: string): void
  toast(text: string, kind: 'info' | 'warn' | 'danger' | 'good'): void
  gameOver(victory: boolean, canContinue: boolean): void
  refreshShop(): void
  openPause(): void
  openHelp(): void
  hasOverlay(): boolean
}

const ENEMY_LABELS: Record<string, { icon: string; label: string }> = {
  einf: { icon: 'INF', label: 'Line infantry' },
  eofficer: { icon: 'OFF', label: 'Officers' },
  ecav: { icon: 'CAV', label: 'Uhlan cavalry' },
  estorm: { icon: 'STM', label: 'Stosstruppen' },
  emg: { icon: 'MG', label: 'Machine-gun teams' },
  esniper: { icon: 'SNP', label: 'Marksmen' },
  epioneer: { icon: 'PNR', label: 'Pioneers' },
  eflamer: { icon: 'FLM', label: 'Flame pioneers' },
  ecar: { icon: 'CAR', label: 'Armoured cars' },
  etank: { icon: 'TNK', label: 'A7V heavy tanks' },
}

/** Despatch citations for a deed bitmask, e.g. "for coolness under heavy fire". */
function deedCitations(mask: number): string[] {
  const out: string[] = []
  for (const d of DEEDS) if ((mask & d.bit) !== 0) out.push(d.cite)
  return out
}

/** Terse UI labels for a deed bitmask, e.g. "Cool under fire". */
function deedNames(mask: number): string[] {
  const out: string[] = []
  for (const d of DEEDS) if ((mask & d.bit) !== 0) out.push(d.name)
  return out
}

export class Game {
  // engine
  readonly renderer: GameRenderer
  readonly rig: CameraRig
  readonly input: Input
  readonly fpsMode: FpsMode
  readonly events = new EventBus()
  readonly audio: AudioEngine
  settings: GameSettings

  // world
  terrain!: Terrain
  terrainMesh!: TerrainMesh
  sky!: Sky
  weather!: Weather
  scenery!: Scenery
  effects!: EffectsSystem
  soldiers!: SoldierRenderer
  rounds!: RoundRenderer

  // sim — the runner owns the battle; the game renders it and submits commands.
  runner: SimRunner | null = null
  /** Live multiplayer session (null in singleplayer). Owns the runner when set. */
  net: LockstepSession | null = null
  /** Which commander this machine is. Always 'brit' outside multiplayer. */
  mySide: Team = 'brit'
  /** main.ts hooks this to reopen the signaling room so the peer can rejoin. */
  onNetPeerLost: (() => void) | null = null
  /** Watching a recorded battle: commands are history, input is camera-only. */
  replayMode = false
  static readonly REPLAY_KEY = 'ms-war-diary'
  /** The from-start AI persona of the CURRENT run (null in MP) — recorded
   *  into the replay so playback re-derives the same AI from the seed. */
  private runPersona: import('../sim/ai').AiPersona | null = null
  get theirSide(): Team { return this.mySide === 'brit' ? 'german' : 'brit' }
  /**
   * The LOCAL commander's purse. Everything the HUD prices, every affordability
   * check and every ghost reads this rather than `s.req`, so player two is
   * spending his own requisition instead of watching player one's.
   */
  get req(): number {
    return this.runner ? simReqOf(this.ctx.s, this.mySide) : 0
  }
  seedStr = ''
  difficulty: Difficulty = 'front'
  private runRand: Rand = Math.random
  /** Local command sink. All player actions route through here, stamped with
   *  the chair this machine occupies — never a hardcoded side. */
  private submit(cmds: Cmd[]): void {
    if (this.replayMode) return // the war diary is already written
    if (this.net) this.net.submit(cmds)
    else this.runner?.submit(this.mySide, cmds)
  }

  /** FPS embodiment enters/leaves through the command stream (#41 item 2). */
  possessCmd(unitId: number, soldierId: number): void {
    this.embodiedThisRun = true
    this.submit([{ t: 'possess', unitId, soldierId }])
  }
  releaseCmd(): void { this.submit([{ t: 'release' }]) }
  /** FpsMode's predicted pose, at most once per tick (heat only for heat weapons). */
  submitFpsPose(x: number, z: number, stance: Stance, facing: number, heat?: number, venting?: boolean): void {
    const cmd: Extract<Cmd, { t: 'fpspose' }> = { t: 'fpspose', x, z, stance, facing }
    if (heat !== undefined) { cmd.heat = heat; cmd.venting = venting }
    this.submit([cmd])
  }
  /** One trigger pull. Presentation already played; the ordnance spawns at the boundary. */
  submitFpsFire(p: FireParams): void {
    this.submit([{
      t: 'fpsfire', camPos: p.camPos, dir: p.dir, yaw: p.yaw, pitch: p.pitch,
      ads: p.ads, moving: p.moving, ground: p.ground, muzzle: p.muzzle,
    }])
  }
  /** A quantum of medic/sapper work — `amount` is seconds at the task. */
  submitFpsTool(tool: 'heal' | 'parapet' | 'wire', targetId: number, amount: number): void {
    this.submit([{ t: 'fpstool', tool, targetId, amount }])
  }
  /** True once the player embodied anyone this run. Since fpspose/fpsfire/
   *  fpstool ride the command stream, embodied diaries replay bit-exactly —
   *  the flag is now just diary metadata (embodied diaries grow ~30 cmds/s). */
  embodiedThisRun = false

  /** Sim context (undefined before the first startRun, like the old field). */
  get ctx(): Ctx {
    return this.runner?.ctx as unknown as Ctx
  }

  /**
   * Leave a multiplayer match cleanly: the bye tells the peer to adopt the
   * AI (or claim the walkover) instead of freezing at the gate. Called on
   * quit-to-title and on page unload.
   */
  leaveMatch(): void {
    if (!this.net) return
    this.net.close()
    this.net = null
    this.mySide = 'brit'
  }

  get endless(): boolean { return this.ctx?.s.endless ?? false }
  set endless(v: boolean) { if (this.ctx) this.ctx.s.endless = v }

  // run/UI state
  running = false
  paused = false
  speed: 0.5 | 1 | 2 | 4 = 1
  modalOpen = false
  hud: HudBridge | null = null
  regiment = ''

  // placement & selection
  buildSelection: BuildableId | null = null
  ghostPos = new THREE.Vector3()
  ghostValid = false
  wireAngle = 0
  private kbCursor = { active: false, x: 0, z: 60 }
  selectedUnitId = -1

  // per-wave letter context
  private waveKills = 0
  private waveCasualties: CasualtyRecord[] = []
  private sawTank = false
  private sawGas = false
  private battleNoise = 0
  private burnEmitters = new Map<number, EmitterHandle>()
  private ghost: THREE.Group
  private ghostRing: THREE.Mesh
  private rangeRing: THREE.LineLoop
  // Placement-zone visuals: brass ribbons along the fire steps for trench
  // cards, a translucent ground-hugging band for the rear / no-man's-land
  // zones. Terrain-specific, so rebuilt per run (torn down with the scene).
  private zoneRibbon: THREE.Mesh | null = null
  private zoneBand: THREE.Mesh | null = null
  private zoneBandKey = ''
  private chevrons!: THREE.InstancedMesh
  private rankMarkers!: THREE.InstancedMesh
  private flareSprites: THREE.Sprite[] = []
  private warnRings: Array<{ mesh: THREE.Mesh; t: number }> = []
  private gasBuf = new Float32Array(5 * 240)
  fps = 0
  onExitToTitle: (() => void) | null = null

  constructor(container: HTMLElement, audio: AudioEngine, settings: GameSettings) {
    this.audio = audio
    this.settings = settings
    this.renderer = new GameRenderer(container)
    // Terrain is created per-run; a placeholder exists so the rig has a sampler.
    this.terrain = new Terrain(1)
    this.rig = new CameraRig(this.renderer.camera, this.terrain)
    this.input = new Input(this.renderer.renderer.domElement, settings.keybinds)
    this.wireInput()
    // The camera lives in the scene so the first-person viewmodel can hang off it.
    this.renderer.scene.add(this.renderer.camera)
    this.fpsMode = new FpsMode(this)

    // Placement ghost.
    this.ghost = new THREE.Group()
    const ringGeo = new THREE.TorusGeometry(1.6, 0.12, 6, 24)
    ringGeo.rotateX(Math.PI / 2)
    this.ghostRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x7fae5a, transparent: true, opacity: 0.85 }))
    this.ghost.add(this.ghostRing)
    const rangePts: THREE.Vector3[] = []
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2
      rangePts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
    }
    this.rangeRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(rangePts),
      new THREE.LineBasicMaterial({ color: 0xd8cdb4, transparent: true, opacity: 0.35 }),
    )
    this.ghost.add(this.rangeRing)
    this.ghost.visible = false
    this.renderer.scene.add(this.ghost)

    // Flare stars: visible burning points under the parachutes.
    const flareCanvas = document.createElement('canvas')
    flareCanvas.width = flareCanvas.height = 64
    const fctx = flareCanvas.getContext('2d')
    if (fctx) {
      const grad = fctx.createRadialGradient(32, 32, 0, 32, 32, 32)
      grad.addColorStop(0, 'rgba(255,255,240,1)')
      grad.addColorStop(0.25, 'rgba(255,232,170,0.9)')
      grad.addColorStop(1, 'rgba(255,220,140,0)')
      fctx.fillStyle = grad
      fctx.fillRect(0, 0, 64, 64)
    }
    const flareTex = new THREE.CanvasTexture(flareCanvas)
    for (let i = 0; i < 4; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flareTex, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffeecc,
      }))
      sp.scale.setScalar(5)
      sp.visible = false
      this.flareSprites.push(sp)
      this.renderer.scene.add(sp)
    }

    // Colour-assist chevrons: high-contrast markers above enemy troops.
    const chevGeo = new THREE.ConeGeometry(0.45, 0.9, 4)
    chevGeo.rotateX(Math.PI) // point down
    this.chevrons = new THREE.InstancedMesh(chevGeo,
      new THREE.MeshBasicMaterial({ color: 0xe06030 }), 300)
    this.chevrons.count = 0
    this.chevrons.frustumCulled = false
    this.renderer.scene.add(this.chevrons)

    // Rank chevrons: brass stripes floating over a veteran's position — one
    // per rank level, stacked, so a Sergeant wears three. Cheap instanced bars.
    const rankGeo = new THREE.BoxGeometry(0.5, 0.07, 0.16)
    this.rankMarkers = new THREE.InstancedMesh(rankGeo,
      new THREE.MeshBasicMaterial({ color: 0xd8bf72 }), 180)
    this.rankMarkers.count = 0
    this.rankMarkers.frustumCulled = false
    this.renderer.scene.add(this.rankMarkers)
  }

  /** Show the zone the selected card may be planted in; hide when idle. */
  private refreshPlacementZones(): void {
    const id = this.buildSelection
    const placement = id
      ? (this.isUnitKind(id) ? UNIT_DEFS[id].placement : DEFENCE_DEFS[id as DefenceKindId].placement)
      : null
    this.showTrenchRibbon(placement === 'trench')
    const showBand = placement === 'pad' || (placement === 'field' && this.fieldBuildAllowed())
    this.showZoneBand(id && showBand ? this.zoneBoundsFor(id, placement as 'pad' | 'field') : null)
  }

  private zoneBoundsFor(id: BuildableId, placement: 'pad' | 'field'): { x0: number; x1: number; z0: number; z1: number } {
    const xLim = WORLD.width / 2 - 6
    if (placement === 'pad') {
      return { x0: -xLim, x1: xLim, z0: WORLD.frontTrenchZ + PLACEMENT.padMarginZ, z1: WORLD.depth / 2 - 10 }
    }
    return { x0: -xLim, x1: xLim, z0: id === 'flarepost' ? 20 : -60, z1: WORLD.frontTrenchZ - 5 }
  }

  /** Brass ribbons along every uncaptured section's fire step. */
  private showTrenchRibbon(show: boolean): void {
    if (!show) {
      if (this.zoneRibbon) this.zoneRibbon.visible = false
      return
    }
    // Rebuilt each time it is summoned — capture state may have changed.
    if (this.zoneRibbon) {
      this.renderer.scene.remove(this.zoneRibbon)
      this.zoneRibbon.geometry.dispose()
      ;(this.zoneRibbon.material as THREE.Material).dispose()
    }
    const pos: number[] = []
    const idx: number[] = []
    const HALF = 0.55
    for (const sec of this.ctx.s.sections) {
      if (sec.owner !== 'brit') continue
      const abx = sec.b.x - sec.a.x, abz = sec.b.z - sec.a.z
      const segLen = Math.hypot(abx, abz) || 1
      let nx = -abz / segLen, nz = abx / segLen
      if (nz * sec.facing > 0) { nx = -nx; nz = -nz }
      const steps = Math.max(2, Math.round(segLen / 2))
      const base = pos.length / 3
      for (let k = 0; k <= steps; k++) {
        const t = k / steps
        const cx = sec.a.x + abx * t + nx * TRENCH.fireStepSlot
        const cz = sec.a.z + abz * t + nz * TRENCH.fireStepSlot
        for (const side of [-HALF, HALF]) {
          const px = cx + nx * side, pz = cz + nz * side
          pos.push(px, this.terrain.heightAt(px, pz) + 0.12, pz)
        }
      }
      for (let k = 0; k < steps; k++) {
        const i0 = base + k * 2
        idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setIndex(idx)
    this.zoneRibbon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xc9b070, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
    }))
    this.zoneRibbon.frustumCulled = false
    this.renderer.scene.add(this.zoneRibbon)
  }

  /**
   * Translucent ground-hugging band over an open-ground zone. Vertex alpha
   * fades to nothing over carved trench so the corridors read as out of
   * bounds. Cached per bounds — pad and field selections swap cheaply.
   */
  private showZoneBand(bounds: { x0: number; x1: number; z0: number; z1: number } | null): void {
    if (!bounds) {
      if (this.zoneBand) this.zoneBand.visible = false
      return
    }
    const key = `${bounds.x0},${bounds.x1},${bounds.z0},${bounds.z1}`
    if (this.zoneBand && this.zoneBandKey === key) {
      this.zoneBand.visible = true
      return
    }
    if (this.zoneBand) {
      this.renderer.scene.remove(this.zoneBand)
      this.zoneBand.geometry.dispose()
      ;(this.zoneBand.material as THREE.Material).dispose()
    }
    const STEP = 3
    const cols = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / STEP))
    const rows = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / STEP))
    const pos: number[] = [], rgba: number[] = [], idx: number[] = []
    for (let r = 0; r <= rows; r++) {
      const z = bounds.z0 + (r / rows) * (bounds.z1 - bounds.z0)
      for (let c = 0; c <= cols; c++) {
        const x = bounds.x0 + (c / cols) * (bounds.x1 - bounds.x0)
        pos.push(x, this.terrain.heightAt(x, z) + 0.15, z)
        const open = this.terrain.trenchAt(x, z) < PLACEMENT.padMaxTrench ? 1 : 0
        rgba.push(0.5, 0.68, 0.35, open * 0.16)
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i0 = r * (cols + 1) + c
        idx.push(i0, i0 + cols + 1, i0 + 1, i0 + 1, i0 + cols + 1, i0 + cols + 2)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(rgba, 4))
    geo.setIndex(idx)
    this.zoneBand = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }))
    this.zoneBand.frustumCulled = false
    this.zoneBandKey = key
    this.renderer.scene.add(this.zoneBand)
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  startRun(seedStr: string, difficulty: Difficulty, resume: RunSave | null = null, mode: 'classic' | 'bigpush' = 'classic', bigpush?: { matchLen?: import('../core/types').MatchLength; persona?: import('../sim/ai').AiPersona; side?: Team; net?: { transport: Transport; side: Team; isCreator: boolean; catchUp?: boolean }; replay?: ReplayRecord }): void {
    this.seedStr = seedStr
    this.difficulty = difficulty
    // Presentation-only randomness (regiments, letters, epitaphs, intel fudge).
    // Kept OFF the sim streams so flavour can never move a battle.
    this.runRand = forkRand(hashString(seedStr), 'run')
    this.regiment = makeRegiment(this.runRand)

    // Tear down the previous battlefield properly: dispose GPU resources
    // before dropping references (scene.clear() alone leaks VRAM). Persistent
    // helper objects (ghost, markers, flare sprites) are detached first.
    this.fpsMode.exit()
    const oldScene = this.renderer.scene
    this.effects?.dispose()
    // The camera carries the FPS viewmodel — it must survive the teardown.
    const persistent = new Set<THREE.Object3D>([this.ghost, this.renderer.camera])
    if (this.chevrons) persistent.add(this.chevrons)
    if (this.rankMarkers) persistent.add(this.rankMarkers)
    for (const sp of this.flareSprites) persistent.add(sp)
    for (const p of persistent) oldScene.remove(p)
    oldScene.traverse((o) => {
      // Lights hold shadow-map render targets (the sun's is 16–67 MB).
      if ((o as THREE.Light).isLight) { (o as THREE.Light).dispose(); return }
      const mesh = o as THREE.Mesh
      const drawable = mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine
      if (!drawable) return
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose()
      mesh.geometry?.dispose()
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (!m) continue
        for (const v of Object.values(m)) {
          if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose()
        }
        m.dispose()
      }
    })
    oldScene.clear()
    // Zone visuals are terrain-specific; the traverse above disposed them.
    this.zoneRibbon = null
    this.zoneBand = null
    this.zoneBandKey = ''
    this.events.clear()
    // The runner builds the whole battle headlessly (terrain, weather, state,
    // starting wire / save restore); the game wires rendering onto it.
    // Multiplayer: the lockstep session owns the runner — commands route
    // through it, and there is NO from-start AI (a human holds each side;
    // the AI only ever steps in on peer loss).
    this.net?.close()
    this.net = null
    const netCfg = mode === 'bigpush' ? bigpush?.net : undefined
    if (netCfg) {
      this.mySide = netCfg.side
      this.net = new LockstepSession(
        seedStr, bigpush?.matchLen ?? 'battle', netCfg.side, netCfg.isCreator, netCfg.transport,
        {
          onStatus: (l) => this.hud?.toast(l, 'info'),
          onDesync: () => this.hud?.toast('Signals crossed — resynchronising with the other commander…', 'warn'),
          onResynced: () => this.hud?.toast('Back in step with the other commander.', 'info'),
          onPeerLost: () => {
            // Either chair can be taken over now, so a disconnect never ends
            // the battle by walkover — their staff pick up the telephone.
            this.hud?.toast('The other commander has gone silent — their staff (AI) assume command.', 'warn')
            this.onNetPeerLost?.()
          },
        },
        () => new SimRunner({ seedStr, difficulty, mode, events: this.events, matchLen: bigpush?.matchLen, aiPersona: null }),
      )
      this.runner = this.net.runner
    } else {
      // Singleplayer Big Push: take either chair. The AI commander sits in the
      // other one and plays the same game with the same roster.
      this.mySide = mode === 'bigpush' ? (bigpush?.replay?.side ?? bigpush?.side ?? 'brit') : 'brit'
      // Replays re-derive the from-start AI from the seed, so the persona
      // must match the recording exactly — including null for MP diaries
      // (their adopted-AI envelopes travel in the log instead).
      const persona = mode !== 'bigpush' ? null
        : bigpush?.replay ? bigpush.replay.persona
        : (bigpush?.persona ?? 'methodical')
      this.runPersona = persona
      this.runner = new SimRunner({
        seedStr, difficulty, mode, resume, events: this.events, matchLen: bigpush?.matchLen,
        aiPersona: persona, aiSide: this.theirSide,
      })
    }
    this.leashZ = this.mySide === 'german' ? -(WORLD.frontTrenchZ - 12) : WORLD.frontTrenchZ - 12
    this.terrain = this.runner.terrain
    ;(this.rig as unknown as { terrain: Terrain }).terrain = this.terrain
    this.terrainMesh = new TerrainMesh(this.terrain)
    oldScene.add(this.terrainMesh.mesh)
    this.sky = new Sky(oldScene)
    this.weather = this.runner.weather
    this.effects = new EffectsSystem(oldScene)
    this.effects.setQuality(this.settings.quality)
    this.effects.setParticleScale(this.settings.particleDensity)
    this.effects.setReduceFlashes(this.settings.reduceFlashes)
    this.soldiers = new SoldierRenderer(oldScene)
    this.rounds = new RoundRenderer(oldScene, this.effects, this.settings.quality)
    this.scenery = new Scenery(oldScene, this.terrain, hashString(seedStr))
    oldScene.add(this.ghost)
    oldScene.add(this.renderer.camera)
    if (this.chevrons) oldScene.add(this.chevrons)
    if (this.rankMarkers) oldScene.add(this.rankMarkers)
    for (const sp of this.flareSprites) oldScene.add(sp)

    this.subscribeEvents()
    this.running = true
    this.paused = false
    this.embodiedThisRun = false
    this.speed = 1
    this.selectedUnitId = -1
    this.buildSelection = null
    this.ghost.visible = false
    // No ghosts of the last battlefield: stale instance counts would render.
    this.chevrons.count = 0
    this.rankMarkers.count = 0
    this.embodyHintShown = false
    this.audio.setMuffled(this.ctx.s.masksOn ? 0.4 : 0)
    // The German commander starts over HIS parapet, looking back across no-man's-land.
    const camSign = this.mySide === 'german' ? -1 : 1
    this.rig.target.set(0, 0, camSign * (WORLD.frontTrenchZ + 30))
    this.rig.yaw = this.mySide === 'german' ? Math.PI : 0
    this.rig.pitch = 0.88
    this.rig.dist = 85
    this.applySettings(this.settings)
    // Plan the first wave (fires wavePrepared → intel paper via the handlers above).
    this.runner!.begin()
    // Rejoining a battle already in progress: ask the survivor for the log
    // and fast-forward (the same rebuild path desync recovery uses).
    if (this.net && netCfg?.catchUp) {
      this.hud?.toast('Rejoining the battle — the runners are bringing the war diary…', 'info')
      this.net.requestLog()
    }
    // War diary playback: the whole battle is in the envelopes. Speed keys
    // work; commands are refused at the submit() door.
    this.replayMode = Boolean(mode === 'bigpush' && bigpush?.replay)
    if (mode === 'bigpush' && bigpush?.replay) {
      for (const env of bigpush.replay.envs) {
        this.runner!.enqueue(JSON.parse(JSON.stringify(env)) as import('../sim/commands').Envelope)
      }
      this.hud?.toast('WAR DIARY — replaying the last battle. Speed keys work; the orders are history.', 'info')
    }
  }

  startReplay(rec: ReplayRecord): void {
    this.startRun(rec.seedStr, 'front', null, 'bigpush', { matchLen: rec.matchLen, replay: rec })
  }

  private subscribeEvents(): void {
    const ev = this.events
    ev.on('soldierDied', (p) => {
      // Both peers run the same sim and see every death; a commander mourns
      // only his own battalion.
      if (p.side !== this.mySide) return
      const cites = deedCitations(p.deeds)
      // The sim already recorded him (combat.ts pushes the roster entry —
      // #41 item 3); we only write the epitaph, which is presentation.
      const rec: CasualtyRecord = this.ctx.s.casualties[this.ctx.s.casualties.length - 1] ?? {
        name: { first: p.name.split(' ')[0] ?? '', last: p.name.split(' ')[1] ?? '' },
        rank: p.rank, kind: p.kind as UnitKindId, side: p.side, wave: p.wave,
        epitaph: '', deeds: p.deeds, wavesServed: p.wavesServed,
      }
      rec.epitaph = makeEpitaph(this.runRand, p.name, UNIT_DEFS[p.kind as UnitKindId]?.name ?? p.kind, p.wave, {
        deeds: cites, wavesServed: p.wavesServed,
      })
      this.waveCasualties.push(rec)
      // A long-serving or decorated man's fall is marked for the player.
      if (p.wavesServed >= 4 || p.deeds !== 0) {
        this.hud?.toast(`${p.rank} ${rec.name.last} has fallen — ${p.wavesServed} waves served`, 'warn')
      }
    })
    ev.on('unitLost', (p) => {
      // Record every man of the lost unit.
      void p
    })
    ev.on('unitPlaced', (p) => {
      if (p.side !== this.mySide) return
      // Big Push: the buy despatches a column — tell the commander when it lands.
      const u = this.ctx.s.units.find((x) => x.id === p.unitId)
      if (u?.march) {
        const eta = Math.round(marchPathLength(u.march.path) / MARCH_SPEED)
        this.hud?.toast(`${UNIT_DEFS[u.kind].name} column despatched — ETA ~${eta}s`, 'info')
      }
    })
    ev.on('tankSighted', () => {
      this.sawTank = true
      this.hud?.toast('Tank! Armour advancing on the line!', 'danger')
      this.audio.play('gas_gong', { gain: 0.5, rate: 1.4 })
    })
    ev.on('gasAlarm', (p) => {
      if (p.side !== this.mySide) return
      this.sawGas = true
      this.hud?.toast('GAS! GAS! Masks on!', 'danger')
    })
    // Capture flips change where trench cards may go — keep the ribbon honest.
    // These two events are phrased from the British chair (they predate the
    // Big Push); read from the German chair they mean the opposite.
    ev.on('sectionLost', () => {
      this.hud?.toast(this.mySide === 'brit'
        ? 'Trench section overrun!'
        : 'Their line has given — a section is ours.', this.mySide === 'brit' ? 'danger' : 'good')
      this.refreshPlacementZones()
    })
    ev.on('sectionRetaken', () => {
      this.hud?.toast(this.mySide === 'brit'
        ? 'Section retaken. Good work.'
        : 'They have taken that section back.', this.mySide === 'brit' ? 'good' : 'warn')
      this.refreshPlacementZones()
    })
    ev.on('sectionCaptured', (p) => {
      this.hud?.toast(p.by === this.mySide
        ? 'Section captured — get men onto it before they come back.'
        : 'They have taken a stretch of our line.', p.by === this.mySide ? 'good' : 'danger')
      this.refreshPlacementZones()
    })
    ev.on('barrageWarning', (p) => {
      // Only the side being shelled hears the whistles and gets the ring.
      const sign = this.mySide === 'brit' ? 1 : -1
      if (p.z * sign < 0) return
      this.hud?.toast('Incoming barrage — take cover!', 'warn')
      this.addWarnRing(p.x, p.z, p.seconds)
    })
    // A despatch with no addressee is for everyone; one addressed to the other
    // commander is his business, not ours.
    ev.on('toast', (p) => { if (!p.side || p.side === this.mySide) this.hud?.toast(p.text, p.kind) })
    ev.on('promoted', (p) => {
      const u = this.ctx.s.units.find((x) => x.id === p.unitId)
      const lead = u ? leadCrew(u) : null
      if (u && lead && u.side === this.mySide) {
        this.hud?.toast(`${lead.name.last} promoted — ${RANKS[u.vet]}`, 'good')
        this.audio.play('upgrade', { gain: 0.5 })
      }
    })
    ev.on('deed', (p) => {
      const u = this.ctx.s.units.find((x) => x.id === p.unitId)
      const lead = u ? leadCrew(u) : null
      if (lead && u!.side === this.mySide) {
        this.hud?.toast(`${RANKS[u!.vet]} ${lead.name.last} mentioned in despatches — ${p.cite}`, 'good')
        this.audio.play('upgrade', { gain: 0.35 })
      }
    })

    // -- wave lifecycle (the runner drives the sim; we present it) ----------
    ev.on('wavePrepared', () => {
      const s = this.ctx.s
      this.autosave()
      this.hud?.refreshShop()
      this.hud?.showIntel(this.intelFor(s.plan!), s.wave === 1 ? 'STAND TO' : 'CARRY ON', () => {
        this.modalOpen = false
        this.submit([{ t: 'beginwave' }])
      })
      this.modalOpen = true
    })
    ev.on('waveStart', (p) => {
      const s = this.ctx.s
      this.waveKills = s.stats.kills
      this.waveCasualties = []
      this.sawTank = false
      this.sawGas = false
      this.hud?.banner(`WAVE ${p.wave} — ${p.name}`)
      this.audio.play('whistle_attack', { gain: 0.6 })
    })
    ev.on('waveEnd', (p) => {
      this.hud?.toast(`Wave held. Requisition +${p.bonus}`, 'good')
      if (p.hospitalReturned > 0) this.hud?.toast(`${p.hospitalReturned} wounded returned from the CCS`, 'good')
      this.maybeWriteLetter(p.wave)
    })
    ev.on('gameOver', (p) => {
      const s = this.ctx.s
      this.modalOpen = true
      this.running = false
      // Every finished Big Push battle leaves a war diary: seed + envelope
      // log is the WHOLE battle (the replay contract). MP diaries carry the
      // adopted-AI envelopes in the log, so persona stays null for them.
      if (s.mode === 'bigpush' && !this.replayMode && this.runner) {
        try {
          const rec: ReplayRecord = {
            v: 1, seedStr: this.seedStr, matchLen: s.matchLen,
            persona: this.net ? null : this.runPersona,
            side: this.mySide,
            envs: this.runner.log,
            embodied: this.embodiedThisRun || undefined,
          }
          localStorage.setItem(Game.REPLAY_KEY, JSON.stringify(rec))
        } catch { /* storage full or blocked — the diary is a luxury */ }
      }
      if (s.mode === 'classic') {
        submitScore(s.stats.score)
        clearRun()
      } else if (p.draw) {
        this.hud?.toast('A draw — both armies spent, the line where it began.', 'warn')
      }
      // Verdicts are recorded brit-POV in the sim; present them from the
      // seat this machine actually occupies (the German human's win is
      // Britain's defeat). Draws stay draws.
      const won = p.draw ? false : (this.mySide === 'german' ? !p.victory : p.victory)
      this.audio.play(won ? 'bugle_victory' : 'drone_defeat', { gain: 0.8 })
      this.hud?.gameOver(won, s.mode === 'classic' && won)
    })
    ev.on('thunder', () => this.audio.play('thunder', { gain: 0.7 }))
    ev.on('orderIssued', (p) => { if (p.side === this.mySide) this.onOrderIssued(p.id as OrderId) })
    ev.on('assaultBegan', (p) => {
      if (p.side !== this.mySide) return
      const sec = this.ctx.s.sections.find((c) => c.id === p.targetSectionId)
      const where = sec ? `${sec.line === 'front' ? 'the front line' : 'the support line'} at ${Math.round(sec.mid.x)}` : 'the objective'
      this.hud?.toast(`OVER THE TOP — ${p.men} men away for ${where}.`, 'danger')
    })
    ev.on('assaultBroke', (p) => {
      if (p.side !== this.mySide) return
      this.audio.play('ui_error', { gain: 0.5 })
    })
    ev.on('upgradeBought', (p) => {
      // The other commander's stores are not your news.
      if (p.side !== this.mySide) return
      const def = UPGRADE_DEFS.find((u) => u.id === p.id)
      this.audio.play('upgrade', { gain: 0.7 })
      if (def) this.hud?.toast(`${def.name} — issued to all ranks`, 'good')
      this.hud?.refreshShop()
    })
  }

  /** Local acknowledgement of an applied order — sounds and toasts only. */
  private onOrderIssued(id: OrderId): void {
    const s = this.ctx.s
    switch (id) {
      case 'takecover': this.hud?.toast('Heads down!', 'info'); break
      case 'rapidfire': this.hud?.toast('Rapid fire! Give them the mad minute!', 'info'); break
      case 'bayonets':
        this.audio.play('whistle_attack', { gain: 0.9 })
        this.hud?.toast('OVER THE TOP!', 'danger')
        break
      case 'masks': {
        const on = this.mySide === 'brit' ? s.masksOn : s.germanMasksOn
        this.audio.setMuffled(on ? 0.4 : 0)
        this.hud?.toast(on ? 'Masks on.' : 'Masks off.', 'info')
        break
      }
      case 'marktank':
        this.hud?.toast('Mark IV moving up — it will crush wire in its path', 'warn')
        break
      case 'flare':
      case 'barrage':
        break // their own systems announce them
    }
  }

  /** Port of the old endWave letter block; runs game-side off waveEnd. */
  private maybeWriteLetter(wave: number): void {
    const s = this.ctx.s
    const author = s.units.filter((u) => !u.disbanded && u.crew.some((c) => c.hp > 0))
    if (author.length === 0 || (this.waveCasualties.length === 0 && wave % 3 !== 0)) return
    const u = author[Math.floor(this.runRand() * author.length)]
    const sol = leadCrew(u)
    if (!sol) return
    const w = this.weather.state
    // If the letter-writer has himself been mentioned in despatches, he may
    // (modestly) note it home. A lost mate who was decorated is honoured too.
    const cites = deedCitations(u.deeds)
    const lostRec = this.waveCasualties[0] ?? null
    const letter = writeLetterHome({
      authorFirst: sol.name.first, authorLast: sol.name.last,
      rank: RANKS[u.vet], regiment: this.regiment,
      wave, dateStr: fieldDate(wave),
      weather: w.night ? 'night' : w.rain > 0.4 ? 'rain' : w.fog > 0.4 ? 'fog' : 'clear',
      kills: s.stats.kills - this.waveKills,
      lostMate: lostRec ? `${lostRec.name.first} ${lostRec.name.last}` : null,
      sawTank: this.sawTank, sawGas: this.sawGas,
      mud: this.weather.state.wetness > 0.5,
      morale: this.waveCasualties.length > 2 ? 'shaken' : this.waveCasualties.length > 0 ? 'steady' : 'high',
      citedDeed: cites.length ? cites[Math.floor(this.runRand() * cites.length)] : null,
      wavesServed: u.wavesServed,
      lostMateDeed: lostRec && lostRec.deeds ? deedCitations(lostRec.deeds)[0] ?? null : null,
    }, this.runRand)
    this.hud?.showLetter(letter, `${RANKS[u.vet]} ${sol.name.first} ${sol.name.last}`)
  }

  // -------------------------------------------------------------------------
  // Wave presentation (the lifecycle itself lives in SimRunner)
  // -------------------------------------------------------------------------

  private intelFor(plan: WavePlan): IntelData {
    const s = this.ctx.s
    const rows: Array<{ icon: string; label: string; detail: string }> = []
    const counts = new Map<string, number>()
    for (const sp of plan.spawns) counts.set(sp.kind, (counts.get(sp.kind) ?? 0) + sp.count)
    if (this.ctx.mods.reconIntel) {
      for (const [kind, n] of counts) {
        const lbl = ENEMY_LABELS[kind]
        if (lbl) rows.push({ icon: lbl.icon, label: lbl.label, detail: `× ${n}` })
      }
      if (plan.barrages.length > 0) {
        rows.push({ icon: 'ART', label: 'Artillery preparation', detail: plan.barrages.some((b) => b.gas) ? 'incl. GAS shoots' : `${plan.barrages.length} shoot(s)` })
      }
    } else {
      let men = 0, machines = 0
      for (const [kind, n] of counts) {
        if (kind === 'ecar' || kind === 'etank') machines += n
        else men += n
      }
      const fudge = 0.75 + this.runRand() * 0.5
      rows.push({ icon: 'INF', label: 'Enemy strength (est.)', detail: `~${Math.max(5, Math.round(men * fudge / 5) * 5)} men` })
      if (machines > 0) rows.push({ icon: '???', label: 'Engine noise reported', detail: 'behind their line' })
      if (plan.barrages.length > 0) rows.push({ icon: 'ART', label: 'Their guns are registering', detail: 'expect shellfire' })
      rows.push({ icon: 'AIR', label: 'No aerial reconnaissance', detail: 'purchase Recon for full intel' })
    }
    // The director's adaptation, telegraphed plainly and up top — the men have
    // learned from the last engagement how the enemy means to answer them. This
    // shows with or without aerial recon: it is read from their preparations,
    // not their order of battle.
    if (plan.adaptation) {
      rows.unshift({ icon: 'ADAPT', label: 'Enemy has adapted', detail: plan.adaptation })
    }
    const w: string[] = []
    if (plan.night) w.push('night attack expected')
    if (plan.weatherBias === 'rain') w.push('barometer falling — rain')
    if (plan.weatherBias === 'fog') w.push('morning fog likely')
    if (w.length === 0) w.push('fair')
    return {
      wave: s.wave,
      date: fieldDate(s.wave),
      title: s.plan?.name ?? `Wave ${s.wave}`,
      rows,
      weatherLine: w.join('; '),
      adviceLine: intelFlavor(plan.intent, this.runRand),
    }
  }

  /** Victory screen "keep fighting" path. */
  continueEndless(): void {
    this.running = true
    this.modalOpen = false
    this.submit([{ t: 'continueendless' }])
  }

  private autosave(): void {
    const s = this.ctx.s
    if (s.mode !== 'classic' || this.net) return
    const save: RunSave = {
      version: 2,
      seed: this.seedStr,
      difficulty: this.difficulty,
      wave: s.wave,
      req: s.req,
      breach: s.breach,
      upgrades: [...s.upgrades],
      units: s.units.filter((u) => !u.disbanded).map((u) => ({
        kind: u.kind, x: u.pos.x, z: u.pos.z, xp: u.xp, vet: u.vet,
        deeds: u.deeds, wavesServed: u.wavesServed, targeting: u.targeting,
        heat: u.heat, ammo: u.ammo,
        crew: u.crew.map((c) => ({ first: c.name.first, last: c.name.last, hp: c.hp, kills: c.kills })),
      })),
      defences: s.defences.filter((d) => d.hp > 0).map((d) => ({
        kind: d.kind, x: d.pos.x, z: d.pos.z, hp: d.hp, maxHp: d.maxHp, wear: d.wear,
      })),
      craterOps: [...this.terrain.getCraterOps()],
      sectionState: s.sections.map((sec) => ({ parapetHp: sec.parapetHp, parapetMax: sec.parapetMax, captured: sec.captured })),
      weather: { tod: this.weather.state.tod, wetness: this.weather.state.wetness },
      stats: s.stats,
      casualties: s.casualties,
      masksOn: s.masksOn,
    }
    saveRun(save)
  }

  // -------------------------------------------------------------------------
  // Placement / economy
  // -------------------------------------------------------------------------

  // The HUD builds its panels before the first run exists — every UI-facing
  // query below must tolerate a null runner (the old fields did implicitly).
  private preRunMods = new Mods()

  costOf(id: BuildableId): number {
    return this.runner
      ? cmdCostOf(this.ctx, id, this.mySide)
      : cmdCostOf({ mods: this.preRunMods, modsGerman: this.preRunMods } as Ctx, id)
  }

  isUnitKind(id: BuildableId): id is UnitKindId { return simIsUnitKind(id) }

  fieldBuildAllowed(): boolean { return this.runner ? simFieldBuildAllowed(this.ctx.s) : true }

  setBuildSelection(id: BuildableId | null): void {
    this.buildSelection = id
    this.selectedUnitId = -1
    this.ghost.visible = id !== null
    this.refreshPlacementZones()
    if (id) this.audio.play('ui_click', { gain: 0.5 })
  }

  /**
   * Recompute ghost snap/validity for a world position. Mirrors the
   * authoritative `resolvePlacement` in sim/commands.ts (which re-validates at
   * apply time) but keeps the snapped-even-when-invalid red-ghost behaviour.
   */
  updateGhost(x: number, z: number): void {
    const id = this.buildSelection
    if (!id) return
    const s = this.ctx.s
    const placement = this.isUnitKind(id) ? UNIT_DEFS[id].placement : DEFENCE_DEFS[id as DefenceKindId].placement
    let valid = false
    let gx = x, gz = z

    if (id === 'sandbags') {
      const sec = sectionAt(s.sections, x, z)
      if (sec && sec.owner === this.mySide && sec.home === this.mySide) {
        gx = sec.mid.x; gz = sec.mid.z
        valid = !s.defences.some((d) => d.kind === 'sandbags' && Math.hypot(d.pos.x - gx, d.pos.z - gz) < 3)
      }
    } else if (placement === 'trench') {
      // Anywhere along an uncaptured fighting line: the cursor projects onto
      // the nearest fire step; a taken stretch shows the ghost there in red.
      const post = projectToFireStep(s.sections, x, z, PLACEMENT.trenchSnapDist, this.mySide)
      if (post) {
        gx = post.x; gz = post.z
        valid = simUnitClearance(s, gx, gz) >= PLACEMENT.trenchSpacing
      }
    } else if (placement === 'pad') {
      // Anywhere on open ground behind your OWN front line.
      valid = simPadSpotValid(this.ctx, x, z, this.mySide)
    } else {
      // Field placement: forward of your own front line, not in a trench,
      // build phase only. Read in the commander's own frame.
      const forward = z * (this.mySide === 'brit' ? 1 : -1)
      const zMin = id === 'flarepost' ? 20 : -60
      const zMax = WORLD.frontTrenchZ - 5
      valid = this.fieldBuildAllowed() &&
        forward > zMin && forward < zMax &&
        Math.abs(x) < WORLD.width / 2 - 6 &&
        this.terrain.trenchAt(x, z) < 0.25
    }

    const cost = this.costOf(id)
    if (this.req < cost) valid = false
    this.ghostValid = valid
    this.ghostPos.set(gx, this.terrain.heightAt(gx, gz) + 0.2, gz)
    this.ghost.position.copy(this.ghostPos)
    this.ghost.rotation.y = id === 'wire' ? this.wireAngle : 0
    ;(this.ghostRing.material as THREE.MeshBasicMaterial).color.set(valid ? 0x7fae5a : 0xa04a3a)
    const range = this.isUnitKind(id) ? UNIT_DEFS[id].range : 0
    this.rangeRing.visible = range > 4
    this.rangeRing.scale.setScalar(Math.max(0.01, range))
  }

  confirmPlace(): boolean {
    const id = this.buildSelection
    if (!id || !this.ghostValid) {
      if (id) this.audio.play('ui_error', { gain: 0.5 })
      return false
    }
    if (this.req < this.costOf(id)) return false

    // The buy is a command — the sim re-validates and spends at the next tick
    // boundary. Local sound is the instant acknowledgement.
    this.submit([{ t: 'buy', kind: id, x: this.ghostPos.x, z: this.ghostPos.z, angle: this.wireAngle }])
    this.audio.play('build', { x: this.ghostPos.x, y: this.ghostPos.y, z: this.ghostPos.z })
    // Keep selection for rapid wire-laying; drop it for expensive one-offs.
    if (id !== 'wire' && id !== 'mine') this.setBuildSelection(null)
    else this.updateGhost(this.ghostPos.x, this.ghostPos.z)
    return true
  }

  selectAt(x: number, z: number): void {
    const s = this.ctx.s
    // Big Push: clicks on trench sections drive the assault orders.
    if (s.mode === 'bigpush') {
      const sec = sectionAt(s.sections, x, z)
      if (sec) {
        // Side-symmetric: "mine" is whichever commander this machine is.
        if (sec.owner === this.mySide && sec.home === this.mySide && sec.line === 'front') {
          // Toggle this stretch into the selection.
          const i = this.selectedSections.indexOf(sec.id)
          if (i >= 0) this.selectedSections.splice(i, 1)
          else if (this.selectedSections.length < 6) this.selectedSections.push(sec.id)
          this.audio.play('ui_click', { gain: 0.5 })
          if (!this.assaultHintShown && this.selectedSections.length > 0) {
            this.assaultHintShown = true
            this.hud?.toast('Sections selected. Click an ENEMY section to send them over the top. B recalls.', 'info')
          }
          return
        }
        if (sec.owner === this.theirSide && this.selectedSections.length > 0) {
          this.submit([{ t: 'assault', sections: [...this.selectedSections], targetSection: sec.id }])
          this.selectedSections = []
          return
        }
        if (sec.owner === this.mySide && sec.home === this.theirSide && sec.facing !== (this.mySide === 'brit' ? 1 : -1)) {
          this.submit([{ t: 'consolidate', section: sec.id }])
          this.hud?.toast('Consolidating — reversing the fire step. Keep men on it.', 'info')
          return
        }
      }
    }
    let best = -1, bestD = 5 * 5
    for (const u of s.units) {
      if (u.disbanded || u.side !== this.mySide) continue
      const d = (u.pos.x - x) ** 2 + (u.pos.z - z) ** 2
      if (d < bestD) { bestD = d; best = u.id }
    }
    this.selectedUnitId = best
    if (best >= 0) {
      this.audio.play('ui_click', { gain: 0.4 })
      if (!this.embodyHintShown) {
        this.embodyHintShown = true
        this.hud?.toast('Press M (or double-click) to take this man\'s rifle yourself', 'info')
      }
    }
  }

  selectedInfo(): SelectedInfo | null {
    const u = this.ctx.s.units.find((x) => x.id === this.selectedUnitId && !x.disbanded)
    if (!u) return null
    const lead = leadCrew(u)
    const alive = u.crew.filter((c) => c.hp > 0)
    const hp = alive.reduce((a, c) => a + c.hp, 0)
    const hpMax = u.crew.reduce((a, c) => a + c.maxHp, 0)
    const morale = alive.length ? alive.reduce((a, c) => a + c.morale, 0) / alive.length : 0
    const suppression = alive.length ? alive.reduce((a, c) => a + c.suppression, 0) / alive.length : 0
    // Progress from the current rank's threshold to the next.
    let rankProgress: number | null = null
    const xpTable = VET_XP as readonly number[]
    if (u.vet < xpTable.length) {
      const floor = u.vet === 0 ? 0 : xpTable[u.vet - 1]
      const ceil = xpTable[u.vet]
      rankProgress = Math.max(0, Math.min(1, (u.xp - floor) / Math.max(1, ceil - floor)))
    }
    return {
      unitId: u.id, kind: u.kind,
      name: lead ? `${lead.name.first} ${lead.name.last}` : '—',
      rank: RANKS[u.vet], kills: lead?.kills ?? 0, vet: u.vet,
      deeds: deedNames(u.deeds), wavesServed: u.wavesServed, rankProgress,
      crewAlive: alive.length, crewMax: u.crew.length,
      hpFrac: hpMax > 0 ? hp / hpMax : 0,
      heat: u.heat,
      morale, suppression,
      ammo: u.ammo, ammoMax: u.kind === 'lewis' ? 6 : 0,
      targeting: u.targeting,
      sellValue: Math.round(this.costOf(u.kind) * ECONOMY.sellRefund),
      fallenBack: u.fallenBack,
    }
  }

  sellSelected(): void {
    const u = this.ctx.s.units.find((x) => x.id === this.selectedUnitId && !x.disbanded)
    if (!u || u.side !== this.mySide) return // those are the other fellow's men
    this.submit([{ t: 'sell', unitId: u.id }])
    this.audio.play('sell', { gain: 0.6 })
    this.selectedUnitId = -1
  }

  setTargeting(p: TargetPriority): void {
    if (this.selectedUnitId >= 0) this.submit([{ t: 'targeting', unitId: this.selectedUnitId, p }])
  }

  cycleSelection(): void {
    const live = this.ctx.s.units.filter((u) => !u.disbanded && u.side === this.mySide)
    if (live.length === 0) return
    const idx = live.findIndex((u) => u.id === this.selectedUnitId)
    const next = live[(idx + 1) % live.length]
    this.selectedUnitId = next.id
    this.rig.target.set(next.pos.x, 0, next.pos.z)
  }

  // -------------------------------------------------------------------------
  // Orders & upgrades
  // -------------------------------------------------------------------------

  orderReady(id: OrderId): boolean {
    return this.runner ? simOrderReady(this.ctx.s, id, this.mySide) : false
  }

  issueOrder(id: OrderId): void {
    if (!this.orderReady(id)) { this.audio.play('ui_error', { gain: 0.4 }); return }
    // Flare and barrage aim where the commander is looking; the sim clamps
    // both. A creeping barrage is a frontage, so its x is the whole aim.
    const cmd: Cmd = id === 'flare' || id === 'barrage'
      ? { t: 'order', id, x: this.rig.target.x, z: this.rig.target.z }
      : { t: 'order', id }
    this.submit([cmd])
  }

  upgradeAvailable(id: string): 'owned' | 'locked' | 'unaffordable' | 'buyable' {
    return this.runner ? simUpgradeAvailable(this.ctx.s, id, this.mySide) : 'locked'
  }

  buyUpgrade(id: string): void {
    if (this.upgradeAvailable(id) !== 'buyable') { this.audio.play('ui_error', { gain: 0.4 }); return }
    this.submit([{ t: 'upgrade', id }])
  }

  callWaveEarly(): void {
    if (this.mySide !== 'brit') return
    if (this.ctx.s.phase !== 'build') return
    this.submit([{ t: 'callwave' }])
  }

  // -------------------------------------------------------------------------
  // Input wiring
  // -------------------------------------------------------------------------

  private wireInput(): void {
    const input = this.input
    input.onWheelZoom = (d) => { if (!this.fpsMode?.active) this.rig.zoomBy(d) }
    input.onDrag = (dx, dy, button) => {
      if (this.fpsMode?.active) return // first person owns the mouse
      if (button === 2) this.rig.rotateBy(dx, dy) // free look: yaw + pitch
      else if (button === 1) this.rig.panByScreen(dx, dy)
    }
    input.onPointerMove = (nx, ny) => {
      if (!this.running || this.fpsMode?.active) return
      this.kbCursor.active = false
      const hit = new THREE.Vector3()
      if (rayGround(this.renderer.camera, nx, ny, this.terrain, hit)) {
        if (this.buildSelection) this.updateGhost(hit.x, hit.z)
      }
    }
    input.onClick = (nx, ny, button) => {
      if (!this.running || this.modalOpen || this.fpsMode?.active) return
      const hit = new THREE.Vector3()
      if (!rayGround(this.renderer.camera, nx, ny, this.terrain, hit)) return
      if (button === 0) {
        if (this.buildSelection) {
          this.updateGhost(hit.x, hit.z)
          this.confirmPlace()
        } else {
          const prev = this.selectedUnitId
          this.selectAt(hit.x, hit.z)
          // Double-click a unit: take that man's rifle yourself.
          const now = performance.now()
          if (
            this.selectedUnitId >= 0 && this.selectedUnitId === prev &&
            this.selectedUnitId === this.lastSelClick.id && now - this.lastSelClick.t < 380
          ) {
            this.possessSelected()
          }
          this.lastSelClick = { t: now, id: this.selectedUnitId }
        }
      } else if (button === 2 && !this.input.pointer.dragging) {
        this.setBuildSelection(null)
        this.selectedUnitId = -1
        this.selectedSections = []
      }
    }
  }

  private lastSelClick = { t: 0, id: -1 }
  private embodyHintShown = false
  /** Big Push: your selected front sections (the stretch going over the top). */
  selectedSections: number[] = []
  private assaultHintShown = false
  /** Per-soldier measured gait (see gaitOf) — render-only, never hashed. */
  private gait = new Map<number, { x: number; z: number; move: number; phase: number }>()
  private selRings: THREE.Mesh[] = []
  /** Pooled rings marking the objective of every push still out. */
  private objRings: THREE.Mesh[] = []
  /** Pooled rings marking posts that marching crews have claimed but not reached. */
  private destRings: THREE.Mesh[] = []

  /** Step into the boots of the selected unit's senior surviving man. */
  possessSelected(): void {
    if (this.replayMode) return // you can watch the war, not refight it
    if (this.net) {
      // Embodiment now rides the command stream (fpspose/fpsfire/fpstool), so
      // MP possession is determinism-SAFE — it stays off only until someone
      // playtests the 6-tick input delay on the possessed soldier's sim body.
      this.hud?.toast('No embodiment in multiplayer yet — command from the map.', 'info')
      return
    }
    const u = this.ctx.s.units.find((x) => x.id === this.selectedUnitId && !x.disbanded)
    if (!u || u.side !== this.mySide) return // your own men's rifles, not theirs
    const c = u.crew.find((s) => s.hp > 0)
    if (!c) return
    this.fpsMode.enter(u, c)
  }

  // -------------------------------------------------------------------------
  // FPS Lab hooks (see fpsLab.ts) — spawn any weapon and embody it on demand,
  // without pointer lock or the build → place → possess flow.
  // -------------------------------------------------------------------------

  /** Drop a fresh crew of `kind` at a representative post and step straight into it. */
  debugPossessKind(kind: UnitKindId): boolean {
    const s = this.ctx.s
    if (this.fpsMode.active) this.fpsMode.exit()
    // Sweep the field so nothing from a previous pick (or an HMR reload) stacks
    // in view — the lab only ever inhabits one unit at a time.
    for (const u of s.units) u.disbanded = true
    // A representative spot near the centre of the line: infantry on the front
    // fire step, emplacements on open ground just behind it (scanning outward
    // in x past the centre communication trench).
    let spot: { x: number; z: number } | null = null
    if (UNIT_DEFS[kind].placement === 'trench') {
      spot = projectToFireStep(s.sections, 0, WORLD.frontTrenchZ, 40)
    } else {
      for (let k = 0; k < 24 && !spot; k++) {
        const x = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 4
        const z = WORLD.frontTrenchZ + PLACEMENT.padMarginZ + 8
        if (simPadSpotValid(this.ctx, x, z)) spot = { x, z }
      }
    }
    if (!spot) return false
    const u = simCreateUnit(this.ctx, kind, spot.x, spot.z, false)
    const c = u.crew.find((cr) => cr.hp > 0)
    if (!c) return false
    this.fpsMode.debugUnlocked = true
    this.fpsMode.enter(u, c)
    return true
  }

  /** Line up a rank of German infantry downrange for live-fire testing. */
  debugSpawnTargets(count = 8, range = 70): void {
    const s = this.ctx.s
    const z = WORLD.frontTrenchZ - range
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * 6
      spawnEnemy(this.ctx, 'einf', x, z + (this.ctx.rand() - 0.5) * 8, -1)
    }
  }

  /** Keyboard-only placement cursor step. */
  moveKbCursor(dx: number, dz: number): void {
    if (!this.buildSelection) return
    if (!this.kbCursor.active) {
      this.kbCursor.active = true
      this.kbCursor.x = this.rig.target.x
      this.kbCursor.z = this.rig.target.z
    }
    this.kbCursor.x = Math.max(-WORLD.width / 2, Math.min(WORLD.width / 2, this.kbCursor.x + dx * 3))
    this.kbCursor.z = Math.max(-WORLD.depth / 2, Math.min(WORLD.depth / 2, this.kbCursor.z + dz * 3))
    this.updateGhost(this.kbCursor.x, this.kbCursor.z)
  }

  private addWarnRing(x: number, z: number, seconds: number): void {
    const geo = new THREE.TorusGeometry(14, 0.35, 6, 32)
    geo.rotateX(Math.PI / 2)
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xa04a3a, transparent: true, opacity: 0.5,
    }))
    mesh.position.set(x, this.terrain.heightAt(x, z) + 0.3, z)
    this.renderer.scene.add(mesh)
    this.warnRings.push({ mesh, t: seconds })
  }

  /**
   * Measured gait for one player soldier. Keeps his last drawn position and
   * a render-local stride clock, so `moveAmount` is ground actually covered
   * and the walk cycle advances only while he is covering it. Render-side by
   * design: the sim hash never sees it, and it stays truthful for every
   * behaviour — marching, rushing, crawling, pinned — without each of them
   * having to remember to say so.
   */
  private gaitOf(c: Soldier, dt: number): { move: number; phase: number } {
    let g = this.gait.get(c.id)
    if (!g) {
      g = { x: c.pos.x, z: c.pos.z, move: 0, phase: c.animPhase }
      this.gait.set(c.id, g)
      return g
    }
    if (dt > 0) {
      const speed = Math.hypot(c.pos.x - g.x, c.pos.z - g.z) / dt
      // Ease toward the measured speed so a 30 Hz sim read through a 60+ Hz
      // render does not strobe the stride between frames.
      const want = Math.min(1, speed / GAIT_FULL_SPEED)
      g.move += (want - g.move) * Math.min(1, dt * 12)
      g.phase += dt * (GAIT_IDLE_RATE + speed * GAIT_RATE_PER_SPEED)
    }
    g.x = c.pos.x; g.z = c.pos.z
    return g
  }

  /** Drop gait entries for men who are gone, so the map cannot grow forever. */
  private pruneGait(): void {
    if (this.gait.size < 256) return
    const live = new Set<number>()
    for (const u of this.ctx.s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) if (c.hp > 0) live.add(c.id)
    }
    for (const id of this.gait.keys()) if (!live.has(id)) this.gait.delete(id)
  }

  /** Big Push: sound the recall for every group still out. */
  recallAllAssaults(): void {
    const cmds: Cmd[] = this.ctx.s.assaults
      .filter((g) => g.side === this.mySide && g.state === 'advancing')
      .map((g) => ({ t: 'recall', groupId: g.id }))
    if (cmds.length === 0) return
    this.submit(cmds)
    this.hud?.toast('Recall! Fall back to the line!', 'warn')
  }

  /** Brass pulse rings over the selected front sections. */
  private syncSelectionRings(): void {
    const wanted = this.selectedSections
    while (this.selRings.length < wanted.length) {
      const geo = new THREE.TorusGeometry(7, 0.3, 6, 28)
      geo.rotateX(Math.PI / 2)
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xc9b070, transparent: true, opacity: 0.5, depthWrite: false,
      }))
      this.renderer.scene.add(mesh)
      this.selRings.push(mesh)
    }
    for (let i = 0; i < this.selRings.length; i++) {
      const ring = this.selRings[i]
      if (i >= wanted.length) { ring.visible = false; continue }
      const sec = this.ctx.s.sections.find((x) => x.id === wanted[i])
      if (!sec) { ring.visible = false; continue }
      ring.visible = true
      ring.position.set(sec.mid.x, this.terrain.heightAt(sec.mid.x, sec.mid.z) + 0.4, sec.mid.z)
      ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.abs(Math.sin(this.ctx.s.time * 4)) * 0.3
    }
  }

  /**
   * A claimed post reads as taken before the cursor ever reaches it: while a
   * crew is still marching up, a ring sits on the fire-step spot its purchase
   * reserved (the unit's pos IS the reservation — see unitClearance).
   */
  private syncDestinationRings(): void {
    let n = 0
    for (const u of this.ctx.s.units) {
      if (u.march === null || u.disbanded || u.side !== this.mySide) continue
      if (n >= this.destRings.length) {
        const geo = new THREE.TorusGeometry(1.6, 0.12, 6, 24)
        geo.rotateX(Math.PI / 2)
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0xa04a3a, transparent: true, opacity: 0.5, depthWrite: false,
        }))
        this.renderer.scene.add(mesh)
        this.destRings.push(mesh)
      }
      const ring = this.destRings[n++]
      ring.visible = true
      ring.position.set(u.pos.x, this.terrain.heightAt(u.pos.x, u.pos.z) + 0.25, u.pos.z)
      ;(ring.material as THREE.MeshBasicMaterial).opacity =
        0.35 + Math.abs(Math.sin(this.ctx.s.time * 3 + u.id)) * 0.25
    }
    for (let i = n; i < this.destRings.length; i++) this.destRings[i].visible = false
  }

  /**
   * Where each push still out is headed. Without this the only way to tell an
   * assault order took was to watch the men — and a stalled attack and a
   * working one look the same from the map.
   */
  private syncObjectiveRings(): void {
    const s = this.ctx.s
    let n = 0
    for (const g of s.assaults) {
      if (g.side !== this.mySide || g.state !== 'advancing') continue
      const sec = s.sections.find((c) => c.id === g.targetSectionId)
      if (!sec) continue
      if (n >= this.objRings.length) {
        const geo = new THREE.TorusGeometry(9, 0.4, 6, 32)
        geo.rotateX(Math.PI / 2)
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0xb8452f, transparent: true, opacity: 0.5, depthWrite: false,
        }))
        this.renderer.scene.add(mesh)
        this.objRings.push(mesh)
      }
      const ring = this.objRings[n++]
      ring.visible = true
      ring.position.set(sec.mid.x, this.terrain.heightAt(sec.mid.x, sec.mid.z) + 0.4, sec.mid.z)
      ;(ring.material as THREE.MeshBasicMaterial).opacity =
        0.3 + Math.abs(Math.sin(s.time * 2.5 + g.id)) * 0.35
    }
    for (let i = n; i < this.objRings.length; i++) this.objRings[i].visible = false
  }

  applySettings(st: GameSettings): void {
    this.settings = st
    this.renderer.setQuality(st.quality, st.postfx, st.shadows)
    this.sky?.setShadowQuality(st.quality)
    this.effects?.setQuality(st.quality)
    this.effects?.setParticleScale(st.particleDensity)
    this.effects?.setReduceFlashes(st.reduceFlashes)
    this.rounds?.setQuality(st.quality)
    this.rig.edgePan = st.edgePan
    this.rig.invertZoom = st.invertZoom
    this.rig.speedMul = st.cameraSpeed
    this.input.setBinds(st.keybinds)
    this.audio.setBusVolume('master', st.volMaster)
    this.audio.setBusVolume('sfx', st.volSfx)
    this.audio.setBusVolume('ambience', st.volAmbience)
    this.audio.setBusVolume('ui', st.volUi)
    document.documentElement.style.setProperty('--ui-scale', String(st.uiScale))
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private acc = 0
  private gateStallT = 0
  private gateStallWarned = false
  /** Eased Big Push camera-leash boundary (render-side smoothing of advanceZ-12). */
  private leashZ = WORLD.frontTrenchZ - 12
  frame(dt: number): void {
    if (!this.ctx) return
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05

    // A modal (intel paper, pause, letters) always pulls you out of the trench.
    if (this.fpsMode.active && this.modalOpen) this.fpsMode.exit()

    // Camera & input always run (even paused). While a modal owns the keys,
    // queued presses are DROPPED — they must not fire on the first free frame
    // (Esc that closed the pause menu would immediately reopen it).
    if (this.fpsMode.active) {
      this.input.clearPressed() // first person owns the keyboard
      this.fpsMode.update(dt)
    } else {
      if (this.running && !this.modalOpen) this.pollActions(dt)
      else this.input.clearPressed()
      this.rig.update(dt, this.input, {
        x: this.input.pointer.x, y: this.input.pointer.y, inside: this.input.pointer.inside,
      }, this.modalOpen)
    }

    // Fixed-step sim (the runner owns the tick; we own the accumulator).
    // Multiplayer: real time marches for BOTH commanders — speed is locked
    // to 1 and menus/modals do not freeze the battle (the other human is
    // still fighting it). Only the lockstep gate may hold a step back.
    const effSpeed = this.net
      ? (this.running ? 1 : 0)
      : (this.paused || this.modalOpen || !this.running ? 0 : this.speed)
    this.acc += dt * effSpeed
    let steps = 0
    const s = this.ctx.s
    while (this.acc >= SIM_DT && steps < 8) {
      if (this.net && !this.net.gate()) break
      this.runner!.step()
      this.net?.afterStep()
      // Battle intensity for the ambience bed (presentation, tick-paced).
      this.battleNoise = Math.max(0, this.battleNoise - SIM_DT * 0.2)
      if (s.enemies.length > 0) this.battleNoise = Math.min(1, this.battleNoise + s.enemies.length * 0.001)
      this.acc -= SIM_DT
      steps++
    }
    if (steps === 8) this.acc = 0
    // A gate-held MP battle must not bank unbounded catch-up time.
    if (this.net && this.acc > SIM_DT * 4) this.acc = SIM_DT * 4

    // Gate starvation has no event of its own — if the peer stops sealing
    // frames (hidden tab, dying link) tell the player what the freeze is.
    if (this.net && this.running && s.outcome === 'ongoing' && !this.net.peerGone && !this.net.gate()) {
      this.gateStallT += dt
      if (this.gateStallT > 3 && !this.gateStallWarned) {
        this.gateStallWarned = true
        this.hud?.toast('Waiting on the other commander — their line has gone quiet…', 'warn')
      }
    } else {
      this.gateStallT = 0
      this.gateStallWarned = false
    }

    // The Big Push camera leash: follow your men forward within ~0.5 s;
    // ease back over ~3 s when the forward men die (never yank the view).
    if (s.mode === 'bigpush' && this.running && s.outcome === 'ongoing' && !this.fpsMode.active && !this.replayMode) {
      if (this.mySide === 'brit') {
        const want = s.advance.brit - 12
        const tau = want < this.leashZ ? 0.15 : 1.0
        this.leashZ += (want - this.leashZ) * Math.min(1, dt / tau)
        this.rig.leashMinZ = this.leashZ
        this.rig.leashMaxZ = null
      } else {
        // Mirrored for the German commander: his men advance southward
        // (decreasing advance.german), so his leash is a MAX-z bound.
        const want = s.advance.german + 12
        const tau = want > this.leashZ ? 0.15 : 1.0
        this.leashZ += (want - this.leashZ) * Math.min(1, dt / tau)
        this.rig.leashMaxZ = this.leashZ
        this.rig.leashMinZ = null
      }
    } else {
      this.rig.leashMinZ = null
      this.rig.leashMaxZ = null
    }

    this.render(dt)
  }

  private arrowRepeat = 0
  private pollActions(dt: number): void {
    const input = this.input
    // Keyboard placement cursor: arrows step the ghost while a card is selected.
    input.arrowCursorMode = this.buildSelection !== null
    if (this.buildSelection) {
      const dir = input.arrowDir()
      this.arrowRepeat -= dt
      if ((dir.x !== 0 || dir.z !== 0) && this.arrowRepeat <= 0) {
        this.arrowRepeat = 0.13
        this.moveKbCursor(dir.x, dir.z)
      }
    }
    // Multiplayer: time belongs to both commanders — no pause, no speed.
    if (input.consume('pause')) { if (!this.net) this.paused = !this.paused }
    if (input.consume('speedDown')) { if (!this.net) this.speed = this.speed === 4 ? 2 : this.speed === 2 ? 1 : 0.5 }
    if (input.consume('speedUp')) { if (!this.net) this.speed = this.speed === 0.5 ? 1 : this.speed === 1 ? 2 : 4 }
    if (input.consume('cancel')) {
      if (this.buildSelection) this.setBuildSelection(null)
      else if (this.selectedSections.length > 0) this.selectedSections = []
      else if (this.selectedUnitId >= 0) this.selectedUnitId = -1
      else if (!this.hud?.hasOverlay()) this.hud?.openPause()
    }
    if (input.consume('help') && !this.hud?.hasOverlay()) this.hud?.openHelp()
    if (input.consume('confirm') && this.buildSelection) this.confirmPlace()
    if (input.consume('sell')) this.sellSelected()
    if (input.consume('cycleUnits')) this.cycleSelection()
    if (input.consume('embody')) this.possessSelected()
    if (input.consume('callWave')) this.callWaveEarly()
    if (input.consume('rotatePlacement')) this.wireAngle += Math.PI / 4
    // Orders.
    if (input.consume('orderCover')) this.issueOrder('takecover')
    if (input.consume('orderRapid')) this.issueOrder('rapidfire')
    if (input.consume('orderBayonets')) {
      if (this.ctx.s.mode === 'bigpush') this.recallAllAssaults()
      else this.issueOrder('bayonets')
    }
    if (input.consume('orderMasks')) this.issueOrder('masks')
    if (input.consume('orderFlare')) this.issueOrder('flare')
    if (input.consume('orderBarrage')) this.issueOrder('barrage')
    if (input.consume('orderTank')) this.issueOrder('marktank')
    // Build hotkeys — the same roster on the same keys for both commanders.
    for (let i = 0; i < BUILD_ORDER.length; i++) {
      const action = (i < 12 ? `build${i + 1}` : `buildD${i - 11}`) as import('../render/controls').Action
      if (input.consume(action)) {
        this.setBuildSelection(this.buildSelection === BUILD_ORDER[i] ? null : BUILD_ORDER[i])
      }
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private render(dt: number): void {
    const s = this.ctx.s
    const w = this.weather.state

    this.sky.setConditions(w.tod, w.fog, w.rain)
    // Fan the frame's darkness out to every night-aware consumer so the whole
    // frame moves on one number: muzzle/tracer fire-light strength, the
    // viewmodel's self-glow floor, and the dark-adaptation exposure lift.
    const nf = this.sky.nightFactor
    this.effects.setNight(nf)
    setViewmodelEmissive(nf)
    this.renderer.setNightExposure(nf)
    // Sharp shadows follow whatever the player is looking at.
    if (this.fpsMode.active) {
      this.sky.setFocus(this.renderer.camera.position.x, this.renderer.camera.position.z)
    } else {
      this.sky.setFocus(this.rig.target.x, this.rig.target.z)
    }
    this.terrainMesh.update(dt, w.wetness)

    // Drain FX queue.
    for (const e of s.fx) {
      switch (e.t) {
        case 'explosion': {
          this.effects.explosion(e.x, e.y, e.z, e.radius, { big: e.big, dirt: e.dirt })
          const d = this.renderer.camera.position.distanceTo(new THREE.Vector3(e.x, e.y, e.z))
          if (e.big && d < 120) {
            this.rig.addShake(Math.min(0.8, 40 / Math.max(20, d)))
            this.renderer.addShock(Math.min(0.5, 25 / Math.max(20, d)))
          }
          break
        }
        case 'muzzle': this.effects.muzzleFlash(e.x, e.y, e.z, e.dirX, e.dirZ, e.big); break
        case 'impact': this.effects.impact(e.surface, e.x, e.y, e.z, e.nx, e.ny, e.nz, e.spark); break
        case 'dirt': this.effects.dirtBurst(e.x, e.y, e.z, e.amount); break
        case 'debris': this.effects.debris(e.x, e.y, e.z); break
        case 'blood': this.effects.blood(e.x, e.y, e.z); break
        case 'flame': this.effects.flame(e.x, e.y, e.z, e.dirX, e.dirZ, e.length); break
        case 'smokepuff': this.effects.smokePuff(e.x, e.y, e.z, e.size); break
        case 'steam': this.effects.steam(e.x, e.y, e.z); break
        case 'flash': this.effects.flash(e.x, e.y, e.z, e.color, e.intensity, e.decay); break
        case 'wiresnap': this.effects.debris(e.x, e.y, e.z); break
      }
    }
    s.fx.length = 0

    // Drain sounds.
    for (const e of s.sounds) {
      if (e.name === 'shell_whistle' && e.dur) {
        this.audio.shellWhistle(e.dur, { x: e.x, y: e.y, z: e.z, gain: e.gain })
      } else {
        this.audio.play(e.name as SfxName, { x: e.x, y: e.y, z: e.z, gain: e.gain, rate: e.rate })
      }
    }
    s.sounds.length = 0

    // Soldiers. Men in trenches stand on the fire step so heads and rifles
    // show over the parapet. MUST match the sim-side standSurface — bullets
    // fly at the men you see.
    const standY = (x: number, z: number): number => standSurface(this.ctx, x, z)
    this.soldiers.begin()
    const pose: SoldierPose = {
      x: 0, y: 0, z: 0, facing: 0, stance: 'stand', moveAmount: 0, animPhase: 0,
      aiming: false, recoil: 0, deadT: 0, deadSeed: 0, masked: false, team: 'brit', tint: 0, mounted: false,
    }
    for (const u of s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) {
        if (c.hp <= 0) continue
        if (c.id === this.ctx.s.possessedSoldierId) continue // you can't see your own body
        pose.x = c.pos.x; pose.z = c.pos.z
        pose.y = standY(c.pos.x, c.pos.z)
        pose.facing = c.facing
        pose.stance = c.stance
        // The gait is measured, never declared. This used to be a flag —
        // anyone in an assault group rendered at a full run whether he was
        // sprinting, lying on overwatch or pinned flat, which is exactly how
        // a stalled attack came to look like a working one. Deriving both the
        // stride amplitude and the clock from real ground covered means the
        // animation cannot lie about the sim again.
        const gait = this.gaitOf(c, dt)
        pose.moveAmount = gait.move
        pose.animPhase = gait.phase
        // A man who has stopped moving is a man with the rifle up — the
        // renderer's own `move < 0.5` gate now does that work honestly.
        pose.aiming = s.phase === 'assault' && !u.fallenBack && u.march === null
        pose.recoil = Math.max(0, 1 - c.cooldown * 4)
        pose.deadT = 0
        pose.deadSeed = c.id * 0.37
        pose.masked = c.masked
        pose.team = u.side
        pose.tint = (c.id % 7) / 7
        pose.mounted = false
        this.soldiers.push(pose)
      }
    }
    for (const e of s.enemies) {
      if (e.hp <= 0) continue
      pose.x = e.pos.x; pose.z = e.pos.z
      pose.y = standY(e.pos.x, e.pos.z)
      pose.facing = e.facing
      pose.stance = e.stance
      pose.moveAmount = e.behavior === 'advance' || e.behavior === 'rush' || e.behavior === 'rout' || e.behavior === 'mopup' ? 1 : 0
      pose.animPhase = e.animPhase
      pose.aiming = e.behavior === 'firing' || e.behavior === 'takecover'
      pose.recoil = 0
      pose.deadT = 0
      pose.deadSeed = e.id * 0.37
      pose.masked = e.masked && s.clouds.length > 0
      pose.team = 'german'
      pose.tint = (e.id % 7) / 7
      pose.mounted = e.mounted
      this.soldiers.push(pose)
    }
    for (const c of s.corpses) {
      pose.x = c.x; pose.z = c.z; pose.y = c.y
      pose.facing = c.facing
      pose.stance = 'dead'
      pose.moveAmount = 0
      pose.animPhase = 0
      pose.aiming = false
      pose.recoil = 0
      pose.deadT = c.deadT
      pose.deadSeed = c.seed * 100
      pose.masked = false
      pose.team = c.team
      pose.tint = c.seed
      pose.mounted = false
      this.soldiers.push(pose)
    }
    this.soldiers.finish()

    // Scenery sync. Hide the possessed emplacement's world platform in first
    // person — the camera sits inside it, so its full-size mesh would wall the
    // view and hide the first-person viewmodel (see syncUnits).
    this.scenery.syncDefences(s.defences, w.night)
    this.scenery.syncUnits(s.units, this.fpsMode.active ? this.ctx.s.possessedUnitId : -1)
    this.scenery.syncVehicles(s.vehicles)

    // Burning wrecks.
    for (const v of s.vehicles) {
      if (v.dead && v.burnT > 0 && !this.burnEmitters.has(v.id)) {
        const y = this.terrain.heightAt(v.pos.x, v.pos.z)
        this.burnEmitters.set(v.id, this.effects.emitter(v.pos.x, y + 2, v.pos.z, 'fire', 14))
      }
    }
    for (const [id, h] of this.burnEmitters) {
      const v = s.vehicles.find((x) => x.id === id)
      if (!v || v.burnT <= 0) { h.stop(); this.burnEmitters.delete(id) }
    }

    // Colour-assist chevrons over whoever is hostile to THIS commander.
    if (this.settings.colorAssist) {
      const m = new THREE.Matrix4()
      let n = 0
      const bob = Math.sin(s.time * 4) * 0.15
      const mark = (px: number, pz: number) => {
        if (n >= 300) return
        m.setPosition(px, standY(px, pz) + 2.5 + bob, pz)
        this.chevrons.setMatrixAt(n++, m)
      }
      for (const e of s.enemies) {
        if (e.hp > 0 && this.mySide === 'brit') mark(e.pos.x, e.pos.z)
      }
      for (const u of s.units) {
        if (u.disbanded || u.side === this.mySide) continue
        for (const c of u.crew) if (c.hp > 0) mark(c.pos.x, c.pos.z)
      }
      this.chevrons.count = n
      this.chevrons.instanceMatrix.needsUpdate = true
    } else {
      this.chevrons.count = 0
    }

    // Rank chevrons over veterans: brass stripes floating above the senior man,
    // one per rank level. The player can read a position's experience at a glance
    // and knows whom he is about to lose. Hidden in first person (own line only).
    {
      const m = new THREE.Matrix4()
      let n = 0
      const cap = 180
      if (!this.fpsMode.active) {
        for (const u of s.units) {
          if (u.disbanded || u.vet <= 0 || u.side !== this.mySide) continue
          const lead = leadCrew(u)
          if (!lead || lead.hp <= 0) continue
          const baseY = standY(lead.pos.x, lead.pos.z) + 2.15
          for (let k = 0; k < u.vet && n < cap; k++) {
            m.setPosition(lead.pos.x, baseY + k * 0.17, lead.pos.z)
            this.rankMarkers.setMatrixAt(n++, m)
          }
          if (n >= cap) break
        }
      }
      this.rankMarkers.count = n
      this.rankMarkers.instanceMatrix.needsUpdate = true
    }

    // Bullets in flight. The renderer needs the camera's world position to
    // billboard each streak about its own flight axis and to drop rounds
    // sitting right on top of it (see RoundRenderer.sync).
    const roundCam = this.renderer.camera.position
    this.rounds.sync(s.bullets, roundCam.x, roundCam.y, roundCam.z, nf, dt)

    // Gas.
    const blobCount = collectGasBlobs(this.ctx, this.gasBuf)
    this.effects.setGasBlobs(this.gasBuf, blobCount)

    // Flares light the field.
    let flareIdx = 0
    for (const p of s.projectiles) {
      if (p.kind !== 'flare' || flareIdx >= this.sky.flarePool.length) continue
      const l = this.sky.flarePool[flareIdx]
      const star = this.flareSprites[flareIdx]
      flareIdx++
      const flicker = 0.85 + Math.sin(s.time * 13 + p.id) * 0.15
      l.visible = true
      l.position.set(p.pos.x, p.pos.y, p.pos.z)
      // Physical light units: ~1.5 lux on the ground from ~70 m up reads as flare-light.
      l.intensity = 6200 * flicker
      if (star) {
        star.visible = true
        star.position.set(p.pos.x, p.pos.y, p.pos.z)
        star.scale.setScalar(4 + flicker * 2)
      }
    }
    for (; flareIdx < this.sky.flarePool.length; flareIdx++) {
      this.sky.flarePool[flareIdx].visible = false
      if (this.flareSprites[flareIdx]) this.flareSprites[flareIdx].visible = false
    }

    if (s.mode === 'bigpush') { this.syncSelectionRings(); this.syncObjectiveRings() }
    this.syncDestinationRings()
    this.pruneGait()

    // Warning rings pulse and expire.
    for (let i = this.warnRings.length - 1; i >= 0; i--) {
      const r = this.warnRings[i]
      r.t -= dt
      const m = r.mesh.material as THREE.MeshBasicMaterial
      m.opacity = 0.25 + Math.abs(Math.sin(s.time * 6)) * 0.35
      if (r.t <= 0) {
        this.renderer.scene.remove(r.mesh)
        r.mesh.geometry.dispose()
        this.warnRings.splice(i, 1)
      }
    }

    // Keyboard cursor ghost stays live.
    if (this.kbCursor.active && this.buildSelection) this.updateGhost(this.kbCursor.x, this.kbCursor.z)
    this.ghost.visible = this.buildSelection !== null

    // Weather FX + ambience.
    this.effects.rain(w.rain)
    const cam = this.renderer.camera
    const lp = this.fpsMode.active
      ? { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: this.fpsMode.yaw }
      : this.rig.listenerPose()
    this.audio.setListener(lp.x, lp.y, lp.z, lp.yaw)
    this.audio.setAmbience({
      battle: this.battleNoise,
      rain: w.rain,
      wind: Math.min(1, Math.hypot(w.windX, w.windZ) / 6.5),
      nightFactor: nf,
      tod: w.tod,
    })

    this.effects.update(dt, this.renderer.camera, w.windX, w.windZ)
    this.renderer.render(dt)
  }
}
