/**
 * The conductor. Owns the run lifecycle (build → assault → debrief), the
 * economy, placement, orders, upgrades, saves, and the seam between the
 * 30 Hz sim and the render/audio layers.
 */
import * as THREE from 'three'
import type {
  BuildableId, CasualtyRecord, DefenceKindId, Difficulty, GameSettings,
  TargetPriority, Unit, UnitKindId, WavePlan,
} from '../core/types'
import {
  BUILD_ORDER, COMBAT, DEEDS, DEFENCE_DEFS, ECONOMY, DIRECTOR, ORDER_DEFS, PLACEMENT, RANKS, SCORE,
  SIM_DT, TRENCH, UNIT_DEFS, UPGRADE_DEFS, UPGRADE_TIER_WAVE, VET_XP, WIRE_SEGMENT_LEN, WORLD, XP_PER_WAVE,
} from '../core/config'
import { EventBus } from '../core/events'
import { forkRand, hashString, type Rand } from '../core/rng'
import {
  fieldDate, intelFlavor, makeEpitaph, makeRegiment, makeSoldierName, waveName, writeLetterHome,
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
import { FlowField } from '../sim/pathfind'
import { Mods } from '../sim/mods'
import {
  makeDirector, makeOrders, makeStats, type Ctx, type SimState,
} from '../sim/sim'
import { buildSections, projectToFireStep, sectionAt } from '../sim/trench'
import { awardXp, leadCrew } from '../sim/veterancy'
import { updateUnits } from '../sim/soldiers'
import { updateEnemies, spawnEnemy } from '../sim/enemies'
import { updateVehicles, spawnVehicle } from '../sim/vehicles'
import { updateProjectiles, spawnFlare } from '../sim/projectiles'
import { updateBullets, standSurface } from '../sim/ballistics'
import { updateGas, collectGasBlobs, resetGas } from '../sim/gas'
import { updateCapture } from '../sim/trench'
import { planWave, updateWaveSpawns, noteWireDensity } from '../sim/waves'
import { updateBarrages, startCreepingBarrage, resetBarrages } from '../sim/barrage'
import { rebuildFlow } from '../sim/flow'
import { FpsMode } from './fps'
import { setViewmodelEmissive } from './weapons'

export type OrderId = keyof typeof ORDER_DEFS

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

  // sim
  ctx!: Ctx
  seedStr = ''
  difficulty: Difficulty = 'front'
  mods = new Mods()
  private waveRand: Rand = Math.random
  private runRand: Rand = Math.random

  // run/UI state
  running = false
  paused = false
  speed: 0.5 | 1 | 2 | 4 = 1
  modalOpen = false
  hud: HudBridge | null = null
  endless = false
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
  private earlyCallBonus = 0
  private battleNoise = 0
  private lastFlowRebuild = 0
  private wetnessTimer = 0
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
      if (sec.captured) continue
      const abx = sec.b.x - sec.a.x, abz = sec.b.z - sec.a.z
      const segLen = Math.hypot(abx, abz) || 1
      let nx = -abz / segLen, nz = abx / segLen
      if (nz > 0) { nx = -nx; nz = -nz }
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

  startRun(seedStr: string, difficulty: Difficulty, resume: RunSave | null = null): void {
    const seed = hashString(seedStr)
    this.seedStr = seedStr
    this.difficulty = difficulty
    this.runRand = forkRand(seed, 'run')
    this.waveRand = forkRand(seed, 'waves')
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
    this.terrain = new Terrain(seed)
    ;(this.rig as unknown as { terrain: Terrain }).terrain = this.terrain
    this.terrainMesh = new TerrainMesh(this.terrain)
    oldScene.add(this.terrainMesh.mesh)
    this.sky = new Sky(oldScene)
    this.weather = new Weather(seed)
    this.effects = new EffectsSystem(oldScene)
    this.effects.setQuality(this.settings.quality)
    this.effects.setParticleScale(this.settings.particleDensity)
    this.effects.setReduceFlashes(this.settings.reduceFlashes)
    this.soldiers = new SoldierRenderer(oldScene)
    this.rounds = new RoundRenderer(oldScene, this.effects, this.settings.quality)
    this.scenery = new Scenery(oldScene, this.terrain, seed)
    oldScene.add(this.ghost)
    oldScene.add(this.renderer.camera)
    if (this.chevrons) oldScene.add(this.chevrons)
    if (this.rankMarkers) oldScene.add(this.rankMarkers)
    for (const sp of this.flareSprites) oldScene.add(sp)

    this.mods = new Mods()
    const upgrades = new Set<string>(resume?.upgrades ?? [])
    this.mods.recompute(upgrades)

    const sections = buildSections(this.terrain, this.mods.parapetMult)
    const s: SimState = {
      seed,
      time: 0,
      wave: resume?.wave ?? 1,
      phase: 'debrief',
      buildTimer: 0,
      req: resume?.req ?? Math.round(ECONOMY.startReq[difficulty]),
      breach: resume?.breach ?? COMBAT.breachMax,
      masksOn: resume?.masksOn ?? false,
      units: [], enemies: [], squads: [], vehicles: [], projectiles: [], bullets: [],
      clouds: [], defences: [], corpses: [],
      sections,
      fx: [], sounds: [],
      orders: makeOrders(),
      upgrades,
      director: makeDirector(),
      stats: resume?.stats ?? makeStats(),
      casualties: resume?.casualties ?? [],
      plan: null, planCursor: 0, planBarrageCursor: 0, waveStartTime: 0,
      nextId: 1,
    }

    const flowInf = new FlowField({
      cols: Math.floor(WORLD.width / (WORLD.cell * 2)),
      rows: Math.floor(WORLD.depth / (WORLD.cell * 2)),
      originX: -WORLD.width / 2, originZ: -WORLD.depth / 2, cellSize: WORLD.cell * 2,
    })
    const flowVeh = new FlowField({
      cols: flowInf.cols, rows: flowInf.rows,
      originX: -WORLD.width / 2, originZ: -WORLD.depth / 2, cellSize: WORLD.cell * 2,
    })

    this.ctx = {
      s, terrain: this.terrain, weather: this.weather,
      flowInf, flowVeh,
      events: this.events, rand: forkRand(seed, 'combat'),
      mods: this.mods, flowDirty: true, night: false,
      possessedSoldierId: -1, possessedUnitId: -1,
      fpsInvincible: false,
      fpsFeedback: [],
    }

    // Restore a saved position. Order matters: defences first (sandbags bump
    // parapetMax as a side effect), THEN the authoritative saved section state
    // overwrites — otherwise the sandbag bonus compounds on every load.
    if (resume) {
      this.terrain.replayCraterOps(resume.craterOps)
      for (const su of resume.units) this.restoreUnit(su)
      for (const sd of resume.defences) {
        this.createDefence(sd.kind as DefenceKindId, sd.x, sd.z, 0, false)
        const d = s.defences[s.defences.length - 1]
        if (d) { d.hp = sd.hp; d.maxHp = sd.maxHp; d.wear = sd.wear }
      }
      resume.sectionState.forEach((st, i) => {
        if (s.sections[i]) {
          s.sections[i].parapetHp = st.parapetHp
          s.sections[i].parapetMax = st.parapetMax
          s.sections[i].captured = st.captured
        }
      })
      this.weather.state.tod = resume.weather.tod
      this.weather.state.wetness = resume.weather.wetness
      this.terrain.setWetness(resume.weather.wetness)
    }

    rebuildFlow(this.ctx)
    resetGas()
    this.subscribeEvents()
    this.running = true
    this.paused = false
    this.speed = 1
    this.endless = resume ? resume.wave > DIRECTOR.victoryWave : false
    this.earlyCallBonus = 0
    this.selectedUnitId = -1
    this.buildSelection = null
    this.ghost.visible = false
    // No ghosts of the last battlefield: stale instance counts would render.
    this.chevrons.count = 0
    this.rankMarkers.count = 0
    this.embodyHintShown = false
    this.audio.setMuffled(s.masksOn ? 0.4 : 0)
    this.rig.target.set(0, 0, WORLD.frontTrenchZ + 30)
    this.rig.yaw = 0
    this.rig.pitch = 0.88
    this.rig.dist = 85
    this.applySettings(this.settings)
    this.prepareNextWave()
  }

  private restoreUnit(su: RunSave['units'][number]): void {
    const kind = su.kind as UnitKindId
    if (!UNIT_DEFS[kind]) return
    // Pads dug for emplacements were already re-carved by the craterOps replay.
    const u = this.createUnit(kind, su.x, su.z, false)
    u.xp = su.xp
    u.vet = su.vet as Unit['vet']
    u.deeds = su.deeds ?? 0
    u.wavesServed = su.wavesServed ?? 0
    u.targeting = su.targeting
    u.heat = su.heat
    u.ammo = su.ammo
    su.crew.forEach((c, i) => {
      if (u.crew[i]) {
        u.crew[i].name = { first: c.first, last: c.last }
        u.crew[i].hp = c.hp
        u.crew[i].kills = c.kills ?? 0
        if (c.hp <= 0) u.crew[i].stance = 'dead'
      }
    })
  }

  private subscribeEvents(): void {
    const ev = this.events
    ev.on('soldierDied', (p) => {
      const cites = deedCitations(p.deeds)
      const rec: CasualtyRecord = {
        name: { first: p.name.split(' ')[0] ?? '', last: p.name.split(' ')[1] ?? '' },
        rank: p.rank, kind: p.kind as UnitKindId, wave: p.wave,
        epitaph: makeEpitaph(this.runRand, p.name, UNIT_DEFS[p.kind as UnitKindId]?.name ?? p.kind, p.wave, {
          deeds: cites, wavesServed: p.wavesServed,
        }),
        deeds: p.deeds, wavesServed: p.wavesServed,
      }
      this.ctx.s.casualties.push(rec)
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
    ev.on('tankSighted', () => {
      this.sawTank = true
      this.hud?.toast('Tank! Armour advancing on the line!', 'danger')
      this.audio.play('gas_gong', { gain: 0.5, rate: 1.4 })
    })
    ev.on('gasAlarm', () => {
      this.sawGas = true
      this.hud?.toast('GAS! GAS! Masks on!', 'danger')
    })
    // Capture flips change where trench cards may go — keep the ribbon honest.
    ev.on('sectionLost', () => {
      this.hud?.toast('Trench section overrun!', 'danger')
      this.refreshPlacementZones()
    })
    ev.on('sectionRetaken', () => {
      this.hud?.toast('Section retaken. Good work.', 'good')
      this.refreshPlacementZones()
    })
    ev.on('barrageWarning', (p) => {
      this.hud?.toast('Incoming barrage — take cover!', 'warn')
      this.addWarnRing(p.x, p.z, p.seconds)
    })
    ev.on('toast', (p) => this.hud?.toast(p.text, p.kind))
    ev.on('promoted', (p) => {
      const u = this.ctx.s.units.find((x) => x.id === p.unitId)
      const lead = u ? leadCrew(u) : null
      if (u && lead) {
        this.hud?.toast(`${lead.name.last} promoted — ${RANKS[u.vet]}`, 'good')
        this.audio.play('upgrade', { gain: 0.5 })
      }
    })
    ev.on('deed', (p) => {
      const u = this.ctx.s.units.find((x) => x.id === p.unitId)
      const lead = u ? leadCrew(u) : null
      if (lead) {
        this.hud?.toast(`${RANKS[u!.vet]} ${lead.name.last} mentioned in despatches — ${p.cite}`, 'good')
        this.audio.play('upgrade', { gain: 0.35 })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Wave lifecycle
  // -------------------------------------------------------------------------

  private prepareNextWave(): void {
    const s = this.ctx.s
    s.phase = 'debrief'
    resetBarrages()
    noteWireDensity(this.ctx)
    const plan = planWave(this.ctx, s.wave, this.difficulty, this.waveRand)
    plan.name = waveName(s.wave, plan.name || 'probe', this.waveRand)
    s.plan = plan
    s.planCursor = 0
    s.planBarrageCursor = 0
    this.weather.advanceWave(plan.night, plan.weatherBias)
    this.autosave()
    this.hud?.refreshShop()
    this.hud?.showIntel(this.intelFor(plan), s.wave === 1 ? 'STAND TO' : 'CARRY ON', () => {
      this.modalOpen = false
      s.phase = 'build'
      s.buildTimer = ECONOMY.buildPhaseSeconds
    })
    this.modalOpen = true
  }

  private intelFor(plan: WavePlan): IntelData {
    const s = this.ctx.s
    const rows: Array<{ icon: string; label: string; detail: string }> = []
    const counts = new Map<string, number>()
    for (const sp of plan.spawns) counts.set(sp.kind, (counts.get(sp.kind) ?? 0) + sp.count)
    if (this.mods.reconIntel) {
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
      const fudge = 0.75 + this.waveRand() * 0.5
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
      adviceLine: intelFlavor(plan.intent, this.waveRand),
    }
  }

  private startAssault(): void {
    const s = this.ctx.s
    s.phase = 'assault'
    s.waveStartTime = s.time
    this.waveKills = s.stats.kills
    this.waveCasualties = []
    this.sawTank = false
    this.sawGas = false
    rebuildFlow(this.ctx)
    this.events.emit('waveStart', { wave: s.wave, name: s.plan?.name ?? '' })
    this.hud?.banner(`WAVE ${s.wave} — ${s.plan?.name ?? ''}`)
    this.audio.play('whistle_attack', { gain: 0.6 })
  }

  private endWave(): void {
    const s = this.ctx.s
    const bonus = ECONOMY.waveBonusBase + ECONOMY.waveBonusPerWave * s.wave +
      this.mods.waveIncome + Math.round(this.earlyCallBonus)
    this.earlyCallBonus = 0
    s.req += bonus
    s.stats.reqEarned += bonus
    this.events.emit('waveEnd', { wave: s.wave, bonus })
    this.hud?.toast(`Wave held. Requisition +${bonus}`, 'good')

    // Field hospital: some of the fallen come back.
    if (this.mods.hospitalReturn > 0) {
      let returned = 0
      for (const u of s.units) {
        if (u.disbanded) continue
        for (const c of u.crew) {
          if (c.hp <= 0 && this.runRand() < this.mods.hospitalReturn) {
            c.hp = c.maxHp * 0.5
            c.stance = 'stand'
            c.morale = 0.6
            returned++
            const idx = s.casualties.findIndex((r) => r.name.last === c.name.last && r.name.first === c.name.first)
            if (idx >= 0) s.casualties.splice(idx, 1)
          }
        }
      }
      if (returned > 0) this.hud?.toast(`${returned} wounded returned from the CCS`, 'good')
    }

    // Weapons cool, morale settles, orders reset between waves. Every position
    // that came through the assault with a living man earns a wave's experience
    // and a notch on its service — longevity, not just kills, makes veterans.
    for (const u of s.units) {
      u.heat = 0
      u.fallenBack = false
      const survived = u.crew.some((c) => c.hp > 0)
      for (const c of u.crew) {
        if (c.hp > 0) { c.suppression = 0; c.morale = Math.max(c.morale, 0.75) }
      }
      if (survived && !u.disbanded) {
        u.wavesServed++
        awardXp(this.ctx, u, XP_PER_WAVE)
      }
    }
    s.clouds.length = 0
    s.projectiles.length = 0
    s.bullets.length = 0

    // The director broods on recent lessons more than old ones.
    for (const k of Object.keys(s.director.dmgByCategory)) {
      s.director.dmgByCategory[k] *= 0.55
    }

    // A letter home.
    const author = s.units.filter((u) => !u.disbanded && u.crew.some((c) => c.hp > 0))
    if (author.length > 0 && (this.waveCasualties.length > 0 || s.wave % 3 === 0)) {
      const u = author[Math.floor(this.runRand() * author.length)]
      const sol = leadCrew(u)
      if (sol) {
        const w = this.weather.state
        // If the letter-writer has himself been mentioned in despatches, he may
        // (modestly) note it home. A lost mate who was decorated is honoured too.
        const cites = deedCitations(u.deeds)
        const lostRec = this.waveCasualties[0] ?? null
        const letter = writeLetterHome({
          authorFirst: sol.name.first, authorLast: sol.name.last,
          rank: RANKS[u.vet], regiment: this.regiment,
          wave: s.wave, dateStr: fieldDate(s.wave),
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
    }

    s.wave++
    if (s.wave > DIRECTOR.victoryWave && !this.endless) {
      this.gameOver(true)
      return
    }
    this.prepareNextWave()
  }

  private gameOver(victory: boolean): void {
    const s = this.ctx.s
    s.phase = 'debrief'
    this.modalOpen = true
    this.running = false
    let score = s.stats.kills * SCORE.perKill + (s.wave - 1) * SCORE.perWave + Math.round(s.req * SCORE.perReqRemaining)
    for (const sec of s.sections) if (!sec.captured) score += SCORE.perSectionHeld
    s.stats.score = score
    submitScore(score)
    clearRun()
    this.audio.play(victory ? 'bugle_victory' : 'drone_defeat', { gain: 0.8 })
    this.hud?.gameOver(victory, victory)
  }

  /** Victory screen "keep fighting" path. */
  continueEndless(): void {
    this.endless = true
    this.running = true
    this.modalOpen = false
    this.prepareNextWave()
  }

  private autosave(): void {
    const s = this.ctx.s
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

  costOf(id: BuildableId): number {
    const base = (UNIT_DEFS as Record<string, { cost: number }>)[id]?.cost ?? DEFENCE_DEFS[id as DefenceKindId].cost
    return Math.round(base * this.mods.costMult)
  }

  isUnitKind(id: BuildableId): id is UnitKindId { return id in UNIT_DEFS }

  fieldBuildAllowed(): boolean { return this.ctx.s.phase !== 'assault' }

  setBuildSelection(id: BuildableId | null): void {
    this.buildSelection = id
    this.selectedUnitId = -1
    this.ghost.visible = id !== null
    this.refreshPlacementZones()
    if (id) this.audio.play('ui_click', { gain: 0.5 })
  }

  /** Distance from (x,z) to the nearest live unit's post (Infinity when none). */
  private unitClearance(x: number, z: number): number {
    let best = Infinity
    for (const u of this.ctx.s.units) {
      if (u.disbanded) continue
      const d = (u.pos.x - x) ** 2 + (u.pos.z - z) ** 2
      if (d < best) best = d
    }
    return Math.sqrt(best)
  }

  /** Open ground behind the front line, off the trenches, clear of other units. */
  private padSpotValid(x: number, z: number): boolean {
    if (Math.abs(x) > WORLD.width / 2 - 6) return false
    if (z < WORLD.frontTrenchZ + PLACEMENT.padMarginZ || z > WORLD.depth / 2 - 10) return false
    if (this.unitClearance(x, z) < PLACEMENT.padSpacing) return false
    // The whole pad must be open ground — the dig skips trench cells, so a
    // gun straddling a corridor would hang over the void.
    if (this.terrain.trenchAt(x, z) > PLACEMENT.padMaxTrench) return false
    const r = PLACEMENT.padRadius * 0.8
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2
      if (this.terrain.trenchAt(x + Math.cos(a) * r, z + Math.sin(a) * r) > PLACEMENT.padMaxTrench) return false
    }
    return true
  }

  /** Recompute ghost snap/validity for a world position. */
  updateGhost(x: number, z: number): void {
    const id = this.buildSelection
    if (!id) return
    const s = this.ctx.s
    const placement = this.isUnitKind(id) ? UNIT_DEFS[id].placement : DEFENCE_DEFS[id as DefenceKindId].placement
    let valid = false
    let gx = x, gz = z

    if (id === 'sandbags') {
      const sec = sectionAt(s.sections, x, z)
      if (sec && !sec.captured) {
        gx = sec.mid.x; gz = sec.mid.z
        valid = !s.defences.some((d) => d.kind === 'sandbags' && Math.hypot(d.pos.x - gx, d.pos.z - gz) < 3)
      }
    } else if (placement === 'trench') {
      // Anywhere along an uncaptured fighting line: the cursor projects onto
      // the nearest fire step; a taken stretch shows the ghost there in red.
      const post = projectToFireStep(s.sections, x, z, PLACEMENT.trenchSnapDist)
      if (post) {
        gx = post.x; gz = post.z
        valid = this.unitClearance(gx, gz) >= PLACEMENT.trenchSpacing
      }
    } else if (placement === 'pad') {
      // Anywhere on open ground behind the front line.
      valid = this.padSpotValid(x, z)
    } else {
      // Field placement: forward of the front line, not in a trench, build phase only.
      const zMin = id === 'flarepost' ? 20 : -60
      const zMax = WORLD.frontTrenchZ - 5
      valid = this.fieldBuildAllowed() &&
        z > zMin && z < zMax &&
        Math.abs(x) < WORLD.width / 2 - 6 &&
        this.terrain.trenchAt(x, z) < 0.25
    }

    const cost = this.costOf(id)
    if (s.req < cost) valid = false
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
    const s = this.ctx.s
    const cost = this.costOf(id)
    if (s.req < cost) return false

    if (this.isUnitKind(id)) {
      // An emplacement crew digs in: level a pad under the gun first so it
      // sits true (recorded in the ops history — saves replay the dig).
      if (UNIT_DEFS[id].placement === 'pad') {
        this.terrain.digPad(this.ghostPos.x, this.ghostPos.z, PLACEMENT.padRadius)
      }
      this.createUnit(id, this.ghostPos.x, this.ghostPos.z, true)
    } else {
      this.createDefence(id as DefenceKindId, this.ghostPos.x, this.ghostPos.z, this.wireAngle, true)
    }
    s.req -= cost
    this.events.emit('reqChanged', { req: s.req })
    this.audio.play('build', { x: this.ghostPos.x, y: this.ghostPos.y, z: this.ghostPos.z })
    this.ctx.flowDirty = true
    // Keep selection for rapid wire-laying; drop it for expensive one-offs.
    if (id !== 'wire' && id !== 'mine') this.setBuildSelection(null)
    else this.updateGhost(this.ghostPos.x, this.ghostPos.z)
    return true
  }

  private createUnit(kind: UnitKindId, x: number, z: number, announce: boolean): Unit {
    const s = this.ctx.s
    const def = UNIT_DEFS[kind]
    const u: Unit = {
      id: s.nextId++, kind, pos: { x, z },
      crew: [], heat: 0, venting: false, ammo: kind === 'lewis' ? 6 : -1,
      xp: 0, vet: 0, deeds: 0, wavesServed: 0,
      targeting: def.targeting, fallenBack: false, disbanded: false,
    }
    const hpMult = def.placement === 'pad' ? this.mods.emplacementHp : 1
    for (let i = 0; i < def.crew; i++) {
      u.crew.push({
        id: s.nextId++, team: 'brit',
        pos: { x: x + (i % 2) * 1.1 - 0.5, z: z + Math.floor(i / 2) },
        facing: 0, hp: def.hp * hpMult, maxHp: def.hp * hpMult,
        stance: 'stand', suppression: 0, morale: 1, masked: s.masksOn, gasExposure: 0,
        animPhase: this.runRand() * 10, cooldown: this.runRand(),
        name: makeSoldierName(this.runRand), kills: 0,
      })
    }
    s.units.push(u)
    if (announce) this.events.emit('unitPlaced', { unitId: u.id })
    return u
  }

  private createDefence(kind: DefenceKindId, x: number, z: number, angle: number, announce: boolean): void {
    const s = this.ctx.s
    const def = DEFENCE_DEFS[kind]
    const hp = kind === 'flarepost' ? 40 : def.hp
    s.defences.push({
      id: s.nextId++, kind, pos: { x, z }, hp: Math.max(1, hp), maxHp: Math.max(1, hp),
      wear: 0, active: false, angle: kind === 'wire' ? angle : 0,
    })
    if (kind === 'sandbags') {
      const sec = sectionAt(s.sections, x, z)
      if (sec) {
        sec.parapetMax += 80 * this.mods.parapetMult
        sec.parapetHp += 80 * this.mods.parapetMult
      }
    }
    if (announce) void 0
  }

  selectAt(x: number, z: number): void {
    const s = this.ctx.s
    let best = -1, bestD = 5 * 5
    for (const u of s.units) {
      if (u.disbanded) continue
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
    const s = this.ctx.s
    const u = s.units.find((x) => x.id === this.selectedUnitId && !x.disbanded)
    if (!u) return
    u.disbanded = true
    s.req += Math.round(this.costOf(u.kind) * ECONOMY.sellRefund)
    this.events.emit('reqChanged', { req: s.req })
    this.audio.play('sell', { gain: 0.6 })
    this.selectedUnitId = -1
  }

  setTargeting(p: TargetPriority): void {
    const u = this.ctx.s.units.find((x) => x.id === this.selectedUnitId)
    if (u) u.targeting = p
  }

  cycleSelection(): void {
    const live = this.ctx.s.units.filter((u) => !u.disbanded)
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
    const s = this.ctx.s
    const def = ORDER_DEFS[id]
    if (def.needsUpgrade && !s.upgrades.has(def.needsUpgrade)) return false
    if (id === 'masks') return true
    const cd = s.orders.cooldowns[id as keyof typeof s.orders.cooldowns]
    return cd <= 0 && s.req >= def.cost
  }

  issueOrder(id: OrderId): void {
    const s = this.ctx.s
    if (!this.orderReady(id)) { this.audio.play('ui_error', { gain: 0.4 }); return }
    const def = ORDER_DEFS[id]
    s.req -= def.cost
    switch (id) {
      case 'takecover':
        s.orders.coverT = def.duration
        s.orders.cooldowns.takecover = def.cooldown
        this.hud?.toast('Heads down!', 'info')
        break
      case 'rapidfire':
        s.orders.rapidT = def.duration
        s.orders.cooldowns.rapidfire = def.cooldown
        this.hud?.toast('Rapid fire! Give them the mad minute!', 'info')
        break
      case 'bayonets':
        s.orders.bayonetT = def.duration
        s.orders.cooldowns.bayonets = def.cooldown
        this.audio.play('whistle_attack', { gain: 0.9 })
        this.hud?.toast('OVER THE TOP!', 'danger')
        break
      case 'masks':
        s.masksOn = !s.masksOn
        this.audio.setMuffled(s.masksOn ? 0.4 : 0)
        this.hud?.toast(s.masksOn ? 'Masks on.' : 'Masks off.', 'info')
        break
      case 'flare': {
        s.orders.cooldowns.flare = def.cooldown
        const x = this.rig.target.x
        const z = Math.min(60, Math.max(-40, this.rig.target.z - 60))
        spawnFlare(this.ctx, x, z)
        break
      }
      case 'barrage':
        s.orders.cooldowns.barrage = def.cooldown
        startCreepingBarrage(this.ctx)
        break
      case 'marktank': {
        s.orders.cooldowns.marktank = def.cooldown
        spawnVehicle(this.ctx, 'friendlytank', (this.runRand() - 0.5) * 60, WORLD.supportTrenchZ + 25)
        this.hud?.toast('Mark IV moving up — it will crush wire in its path', 'warn')
        break
      }
    }
    this.events.emit('reqChanged', { req: s.req })
  }

  upgradeAvailable(id: string): 'owned' | 'locked' | 'unaffordable' | 'buyable' {
    const s = this.ctx.s
    const def = UPGRADE_DEFS.find((u) => u.id === id)
    if (!def) return 'locked'
    if (s.upgrades.has(id)) return 'owned'
    if (s.wave < UPGRADE_TIER_WAVE[def.tier]) return 'locked'
    if (def.requires && !s.upgrades.has(def.requires)) return 'locked'
    if (s.req < def.cost) return 'unaffordable'
    return 'buyable'
  }

  buyUpgrade(id: string): void {
    if (this.upgradeAvailable(id) !== 'buyable') { this.audio.play('ui_error', { gain: 0.4 }); return }
    const s = this.ctx.s
    const def = UPGRADE_DEFS.find((u) => u.id === id)
    if (!def) return
    s.req -= def.cost
    s.upgrades.add(id)
    const oldParapet = this.mods.parapetMult
    this.mods.recompute(s.upgrades)
    if (this.mods.parapetMult !== oldParapet) {
      const scale = this.mods.parapetMult / oldParapet
      for (const sec of s.sections) {
        sec.parapetMax *= scale
        sec.parapetHp *= scale
      }
    }
    this.events.emit('reqChanged', { req: s.req })
    this.audio.play('upgrade', { gain: 0.7 })
    this.hud?.toast(`${def.name} — issued to all ranks`, 'good')
    this.hud?.refreshShop()
  }

  callWaveEarly(): void {
    const s = this.ctx.s
    if (s.phase !== 'build') return
    this.earlyCallBonus = s.buildTimer * ECONOMY.earlyCallBonusPerSecond
    s.buildTimer = 0
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
      }
    }
  }

  private lastSelClick = { t: 0, id: -1 }
  private embodyHintShown = false

  /** Step into the boots of the selected unit's senior surviving man. */
  possessSelected(): void {
    const u = this.ctx.s.units.find((x) => x.id === this.selectedUnitId && !x.disbanded)
    if (!u) return
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
        if (this.padSpotValid(x, z)) spot = { x, z }
      }
    }
    if (!spot) return false
    const u = this.createUnit(kind, spot.x, spot.z, false)
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
      spawnEnemy(this.ctx, 'einf', x, z + (this.runRand() - 0.5) * 8, -1)
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

    // Fixed-step sim.
    const effSpeed = this.paused || this.modalOpen || !this.running ? 0 : this.speed
    this.acc += dt * effSpeed
    let steps = 0
    while (this.acc >= SIM_DT && steps < 8) {
      this.step(SIM_DT)
      this.acc -= SIM_DT
      steps++
    }
    if (steps === 8) this.acc = 0

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
    if (input.consume('pause')) this.paused = !this.paused
    if (input.consume('speedDown')) this.speed = this.speed === 4 ? 2 : this.speed === 2 ? 1 : 0.5
    if (input.consume('speedUp')) this.speed = this.speed === 0.5 ? 1 : this.speed === 1 ? 2 : 4
    if (input.consume('cancel')) {
      if (this.buildSelection) this.setBuildSelection(null)
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
    if (input.consume('orderBayonets')) this.issueOrder('bayonets')
    if (input.consume('orderMasks')) this.issueOrder('masks')
    if (input.consume('orderFlare')) this.issueOrder('flare')
    if (input.consume('orderBarrage')) this.issueOrder('barrage')
    if (input.consume('orderTank')) this.issueOrder('marktank')
    // Build hotkeys.
    for (let i = 0; i < BUILD_ORDER.length; i++) {
      const action = (i < 12 ? `build${i + 1}` : `buildD${i - 11}`) as import('../render/controls').Action
      if (input.consume(action)) {
        this.setBuildSelection(this.buildSelection === BUILD_ORDER[i] ? null : BUILD_ORDER[i])
      }
    }
  }

  private step(dt: number): void {
    const s = this.ctx.s
    s.time += dt

    // Weather & terrain wetness.
    const { thunder } = this.weather.update(dt)
    if (thunder) this.audio.play('thunder', { gain: 0.7 })
    this.wetnessTimer += dt
    if (this.wetnessTimer > 4) {
      this.wetnessTimer = 0
      this.terrain.setWetness(this.weather.state.wetness)
    }

    // Orders tick.
    const o = s.orders
    o.coverT = Math.max(0, o.coverT - dt)
    o.rapidT = Math.max(0, o.rapidT - dt)
    o.bayonetT = Math.max(0, o.bayonetT - dt)
    for (const k of Object.keys(o.cooldowns) as Array<keyof typeof o.cooldowns>) {
      o.cooldowns[k] = Math.max(0, o.cooldowns[k] - dt)
    }

    if (s.phase === 'build') {
      s.buildTimer -= dt
      if (s.buildTimer <= 0) this.startAssault()
    } else if (s.phase === 'assault') {
      const elapsed = s.time - s.waveStartTime
      const active = updateWaveSpawns(this.ctx, elapsed)
      updateBarrages(this.ctx, dt, elapsed)
      if (!active) { this.endWave(); return }
    }

    updateUnits(this.ctx, dt)
    updateEnemies(this.ctx, dt)
    updateVehicles(this.ctx, dt)
    updateProjectiles(this.ctx, dt)
    updateBullets(this.ctx, dt)
    updateGas(this.ctx, dt)
    updateCapture(this.ctx, dt)

    for (const c of s.corpses) c.deadT += dt

    // Battle intensity for the ambience bed.
    this.battleNoise = Math.max(0, this.battleNoise - dt * 0.2)
    if (s.enemies.length > 0) this.battleNoise = Math.min(1, this.battleNoise + s.enemies.length * 0.001)

    // Flow rebuild cadence.
    if (this.ctx.flowDirty && s.time - this.lastFlowRebuild > 2.5) {
      this.lastFlowRebuild = s.time
      rebuildFlow(this.ctx)
    }

    if (s.breach <= 0 && this.running) this.gameOver(false)
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
    const charging = s.orders.bayonetT > 0
    for (const u of s.units) {
      if (u.disbanded) continue
      for (const c of u.crew) {
        if (c.hp <= 0) continue
        if (c.id === this.ctx.possessedSoldierId) continue // you can't see your own body
        pose.x = c.pos.x; pose.z = c.pos.z
        pose.y = standY(c.pos.x, c.pos.z)
        pose.facing = c.facing
        pose.stance = c.stance
        pose.moveAmount = u.fallenBack || charging ? 1 : 0
        pose.animPhase = c.animPhase
        pose.aiming = s.phase === 'assault' && !u.fallenBack
        pose.recoil = Math.max(0, 1 - c.cooldown * 4)
        pose.deadT = 0
        pose.deadSeed = c.id * 0.37
        pose.masked = c.masked
        pose.team = 'brit'
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
    this.scenery.syncUnits(s.units, this.fpsMode.active ? this.ctx.possessedUnitId : -1)
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

    // Colour-assist chevrons.
    if (this.settings.colorAssist && s.enemies.length > 0) {
      const m = new THREE.Matrix4()
      let n = 0
      const bob = Math.sin(s.time * 4) * 0.15
      for (const e of s.enemies) {
        if (e.hp <= 0 || n >= 300) continue
        m.setPosition(e.pos.x, standY(e.pos.x, e.pos.z) + 2.5 + bob, e.pos.z)
        this.chevrons.setMatrixAt(n++, m)
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
          if (u.disbanded || u.vet <= 0) continue
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
