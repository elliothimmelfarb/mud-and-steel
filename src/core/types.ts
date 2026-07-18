/**
 * MUD & STEEL — shared type spine.
 * Sim runs in 2D top-down coords (x: west→east, z: north→south).
 * The enemy advances from north (-z) toward the player trenches (+z).
 * y is height above sea level, always derived from terrain except for projectiles/flares.
 * Units: meters, seconds, radians. Sim ticks at a fixed 30 Hz.
 */

export interface Vec2 { x: number; z: number }
export interface Vec3 { x: number; y: number; z: number }

export type Team = 'brit' | 'german'

// ---------------------------------------------------------------------------
// Player buildables
// ---------------------------------------------------------------------------

export type UnitKindId =
  | 'rifleman' | 'lewis' | 'vickers' | 'sniper' | 'grenadier'
  | 'mortar' | 'fieldgun' | 'flamer' | 'medic' | 'officer'
  | 'engineer' | 'gasproj'

export type DefenceKindId =
  | 'wire' | 'mine' | 'sandbags' | 'tanktrap' | 'searchlight' | 'flarepost'

export type BuildableId = UnitKindId | DefenceKindId

/** Which zone a buildable may be planted in — anywhere within it. */
export type PlacementKind =
  | 'trench'   // anywhere along a fighting trench line, on the fire step (infantry)
  | 'pad'      // anywhere on open ground behind the front line (crewed weapons)
  | 'field'    // open ground in no-man's land / approaches (wire, mines...)

export type Stance = 'stand' | 'crouch' | 'prone' | 'dead'

export interface SoldierName { first: string; last: string }

/** One human being. Player soldiers live inside a Unit's crew; enemies stand alone. */
export interface Soldier {
  id: number
  team: Team
  pos: Vec2
  /** Facing in radians, 0 = looking north (-z), increases clockwise when viewed from above. */
  facing: number
  hp: number
  maxHp: number
  stance: Stance
  /** 0..1, decays; high suppression forces crouch/prone and ruins accuracy. */
  suppression: number
  /** 0..1; at ~0 the soldier breaks and routs. */
  morale: number
  masked: boolean
  /** Gas damage accumulator (for coughing sfx pacing etc). */
  gasExposure: number
  /** Animation phase accumulator (walk cycle, etc). */
  animPhase: number
  /** Seconds until this soldier may fire again. */
  cooldown: number
  name: SoldierName
  kills: number
}

export type VeterancyLevel = 0 | 1 | 2 | 3 // green, seasoned, veteran, elite

/**
 * A soldier's notable deeds, stored as a bitmask on his Unit. Each bit is one
 * citation the flavour generators can draw on for letters and epitaphs. See
 * DEEDS in core/config.ts for the flag values and their citations.
 */
export type DeedMask = number

export interface Unit {
  id: number
  kind: UnitKindId
  /** The unit's post: where it was placed and where the crew forms up. */
  pos: Vec2
  crew: Soldier[]
  /** Weapon heat 0..1 (vickers overheats; venting steam at ~1). */
  heat: number
  /** Vickers jacket venting: latched until heat drains back to ~0.35. */
  venting: boolean
  /** Shells in the ready rack for mortar/fieldgun/gasproj; -1 = not ammo-limited. */
  ammo: number
  /** Accumulated experience: kills, waves survived, and deeds all feed it. */
  xp: number
  vet: VeterancyLevel
  /** Bitmask of notable deeds this position's men have performed (DeedMask). */
  deeds: DeedMask
  /** How many waves this position has fought through and survived. */
  wavesServed: number
  targeting: TargetPriority
  /** True while the crew has abandoned the position (routed / taking cover). */
  fallenBack: boolean
  disbanded: boolean
  /**
   * Big Push: a reinforcement column still marching up from the rear edge.
   * `path` runs rear → comm-trench → post (the last point IS the post);
   * `idx[i]` is crew member i's next waypoint. null once the unit has formed
   * up (or always, in classic mode where crews appear at their post).
   */
  march: { path: Vec2[]; idx: number[] } | null
  /** Big Push: the assault group this unit is committed to (null = holding). */
  assaultGroupId: number | null
  /** Which bounding element of its group this unit belongs to. */
  assaultElement: 0 | 1
  /** Covering-fire focus: prioritise hostiles near this section (timed). */
  coverSectionId: number | null
  coverT: number
}

/**
 * Big Push: a body of units ordered over the top at one enemy section.
 * Groups bound by alternating elements; recall sends everyone home.
 */
export interface AssaultGroup {
  id: number
  side: Team
  unitIds: number[]
  targetSectionId: number
  state: 'advancing' | 'recalled'
  moveElement: 0 | 1
  boundT: number
}

export type TargetPriority = 'nearest' | 'strongest' | 'officers' | 'armour'

export interface Defence {
  id: number
  kind: DefenceKindId
  /** Whose works these are — wire only snags the OTHER side's infantry. */
  side: Team
  pos: Vec2
  /** Wire/sandbags degrade; mines are hp=1 until triggered. */
  hp: number
  maxHp: number
  /** For wire: how mangled it is visually, 0..1. */
  wear: number
  /** Searchlight/flarepost state. */
  active: boolean
  angle: number
}

// ---------------------------------------------------------------------------
// The enemy
// ---------------------------------------------------------------------------

export type EnemyKindId =
  | 'einf'      // line infantry
  | 'estorm'    // stormtrooper: fast, grenades, cuts wire
  | 'eofficer'  // buffs nearby morale/speed
  | 'emg'       // MG08 team: sets up in craters, suppresses
  | 'esniper'
  | 'eflamer'
  | 'ecav'      // uhlan cavalry, early waves
  | 'epioneer'  // wire-cutting/bridging party

export type VehicleKindId = 'ecar' | 'etank' | 'friendlytank'

export type EnemyBehavior =
  | 'advance'     // moving toward objective via flow field
  | 'rush'        // sprint (storm/cav)
  | 'takecover'   // in a crater / shell hole, popping up to fire
  | 'setup'       // MG deploying
  | 'firing'
  | 'cutting'     // cutting wire
  | 'melee'       // in the trench, close combat
  | 'rout'        // broken, fleeing north
  | 'mopup'       // pushing along a captured trench

export interface Enemy extends Soldier {
  kind: EnemyKindId
  squadId: number
  behavior: EnemyBehavior
  /** Seconds remaining in a timed behavior (setup, cutting...). */
  behaviorT: number
  /** Chosen shell-hole to bound toward, if any. */
  coverTarget: Vec2 | null
  speedMul: number
  bounty: number
  /** Cavalry: the horse dies separately; rider may continue on foot. */
  mounted: boolean
  /** Which of the squad's two leapfrog elements this man belongs to (0 or 1). */
  element: 0 | 1
  /** The squad NCO this man rallies on (an enemy id); -1 if none / leaderless. */
  leaderId: number
  /** Set each tick: the squad is in a bounding rhythm and this man is part of it. */
  bounding: boolean
  /** Set each tick: this element is the one holding in cover to fire (not moving). */
  overwatch: boolean
}

export interface Squad {
  id: number
  members: number[] // enemy ids
  /** Squad-level objective: which trench section to assault. */
  targetSectionId: number
  /** Bounding-overwatch rhythm: true while the squad is actively leapfrogging. */
  bounding: boolean
  routed: boolean
  /** The NCO the squad rallies on (enemy id); -1 once the last leader is down. */
  leaderId: number
  /** Which element (0/1) is currently the moving bound; the other is on overwatch. */
  moveElement: 0 | 1
  /** Seconds left in the current bound before the elements swap roles. */
  boundT: number
}

export interface Vehicle {
  id: number
  kind: VehicleKindId
  team: Team
  pos: Vec2
  facing: number
  hp: number
  maxHp: number
  /** Small-arms bounce off armour > 0; mortars/guns/mines penetrate. */
  armour: number
  speed: number
  /** Stuck in deep mud/crater. */
  bogged: boolean
  boggedT: number
  cooldownMain: number
  cooldownMG: number
  dead: boolean
  /** Burning wreck timer. */
  burnT: number
  /**
   * Phantom gunner so vehicle MGs can reuse the small-arms pipeline. Lives on
   * the vehicle (not module state) so twin sims in one process stay independent.
   * `gunner.pos` aliases `pos`.
   */
  gunner: Soldier
}

// ---------------------------------------------------------------------------
// Barrages (sim state — lives on SimState, never module-level)
// ---------------------------------------------------------------------------

export interface ActiveBarrage {
  x: number
  z: number
  shellsLeft: number
  gas: boolean
  t: number            // <0 during the warning
  interval: number
}

export interface CreepingBarrage {
  z: number
  t: number
  volleys: number
}

/** Terminal state of a run/match; sim stops advancing phase once decided. */
export type MatchOutcome = 'ongoing' | 'victory' | 'defeat' | 'draw'

/** Big Push match length, chosen at match creation (spec section 3). */
export type MatchLength = 'raid' | 'battle' | 'grand' | 'attrition'

// ---------------------------------------------------------------------------
// Ordnance / hazards
// ---------------------------------------------------------------------------

export type ProjectileKind =
  | 'shell'      // field gun / off-map artillery HE
  | 'mortarbomb'
  | 'grenade'
  | 'gasshell'
  | 'flare'
  | 'tankshell'

export interface Projectile {
  id: number
  kind: ProjectileKind
  team: Team
  pos: Vec3
  vel: Vec3
  /** Blast radius on impact. */
  radius: number
  damage: number
  /** For flares: burn time; for shells: fuse (airburst if > 0 when timer hits). */
  timer: number
  sourceUnitId: number
}

/**
 * A physically-simulated small-arms round. Unlike lobbed ordnance these are
 * fast, near-flat, and resolved by swept collision against terrain, men and
 * armour each tick — cover is real geometry, not a probability.
 */
export interface Bullet {
  id: number
  team: Team
  pos: Vec3
  /** Position at the previous tick (tracer rendering + swept collision). */
  prev: Vec3
  /**
   * Muzzle position at birth — never mutated after `fireBullet` sets it. The
   * tracer renderer clamps the drawn streak's length to the distance from
   * `spawn` to `pos`, so a round can never appear to trail back through (and
   * past) the camera on the render frame right after it leaves the barrel,
   * before the 30 Hz sim has had a chance to move it downrange.
   */
  spawn: Vec3
  /**
   * True barrel-tip position at birth, when it differs from `spawn`. Set only
   * for the first-person player's own rounds, whose ballistic `spawn` sits on
   * the boresight (`camPos + dir*0.7`, aim-true) while the *visible* muzzle is
   * ~0.5 m below and to the side of the eye. The tracer renderer reaches the
   * launch-frame streak back to THIS point so the round is seen leaving the
   * barrel (welded to the muzzle flash) instead of popping into existence
   * mid-flight — the boresight `spawn` would float the streak ~0.5 m above the
   * flash. Undefined for AI rounds, which already spawn at their own muzzle.
   */
  muzzle?: Vec3
  vel: Vec3
  damage: number
  /** Director bookkeeping ('rifle' | 'mg' | 'sniper' | 'enemy'...). */
  category: string
  shooterUnitId: number
  /** The soldier who fired it (never collides with them). */
  shooterId: number
  tracer: boolean
  /** Seconds of flight remaining before the round is discarded. */
  life: number
  /**
   * Cosmetic dedup flag for the first-person supersonic whiz-by (fps.ts):
   * set once a round has already cracked past the embodied camera, so a
   * round hanging in the air across several render frames only ever earns
   * one crack + flinch. Presentation-only — the sim never reads this, so
   * it is fine that only rounds the player actually embodies to see ever
   * get it set.
   */
  whizzed?: boolean
}

/** A drifting gas concentration blob. Clouds are sets of blobs advected by wind. */
export interface GasBlob {
  x: number; z: number
  r: number
  /** Concentration 0..1, decays with diffusion. */
  c: number
}

export interface GasCloud {
  id: number
  team: Team
  blobs: GasBlob[]
  age: number
}

// ---------------------------------------------------------------------------
// The trench system
// ---------------------------------------------------------------------------

export interface TrenchSection {
  id: number
  /** 'front' | 'support' — support sections are the last line. */
  line: 'front' | 'support'
  /**
   * Which way this section fights: +1 = British (enemy toward -z),
   * -1 = German (enemy toward +z). Decides the fire-step side for
   * projection, dressing and (Big Push) captured-trench cover. Flipped by
   * consolidation after a capture.
   */
  facing: 1 | -1
  /** Who dug it. Fixed for the match. */
  home: Team
  /** Who holds it now. `captured` is always `owner !== home`. */
  owner: Team
  a: Vec2
  b: Vec2
  mid: Vec2
  /** Parapet integrity: shells knock it down, engineers rebuild it. Cover scales with it. */
  parapetHp: number
  parapetMax: number
  captured: boolean
  /** Progress 0..1 of an enemy capture in progress. */
  captureT: number
  /** Big Push: consolidation ordered (reversing the fire step). */
  consolidating: boolean
  /** Progress 0..1 of the consolidation work. */
  consolidateT: number
}

// ---------------------------------------------------------------------------
// Weather & environment
// ---------------------------------------------------------------------------

export interface WeatherState {
  /** Wind vector, m/s. Meanders via noise. Gas cares deeply. */
  windX: number
  windZ: number
  /** 0..1 rainfall right now. */
  rain: number
  /** 0..1 fog density (cuts vision & render distance). */
  fog: number
  /** Ground wetness 0..1: craters flood, mud slows, weapons foul slightly. */
  wetness: number
  /** Time of day 0..1 (0 = midnight). Some waves happen at night. */
  tod: number
  night: boolean
  /** Storm cell timer for thunder. */
  thunderT: number
}

// ---------------------------------------------------------------------------
// Effects / sound queues (sim → presentation seam)
// ---------------------------------------------------------------------------

/**
 * What a physical round struck, so the presentation layer can pick the right
 * dust, spark, splinter or spray. Resolved at the point of impact in the sim's
 * swept collision, never guessed render-side.
 */
export type ImpactSurface = 'dirt' | 'mud' | 'sandbag' | 'steel' | 'flesh' | 'water'

export type FxEvent =
  | { t: 'explosion'; x: number; y: number; z: number; radius: number; big: boolean; dirt: boolean }
  | { t: 'muzzle'; x: number; y: number; z: number; dirX: number; dirZ: number; big?: boolean }
  | { t: 'impact'; x: number; y: number; z: number; nx: number; ny: number; nz: number; surface: ImpactSurface; spark: boolean }
  | { t: 'dirt'; x: number; y: number; z: number; amount: number }
  | { t: 'debris'; x: number; y: number; z: number }
  | { t: 'blood'; x: number; y: number; z: number }
  | { t: 'flame'; x: number; y: number; z: number; dirX: number; dirZ: number; length: number }
  | { t: 'smokepuff'; x: number; y: number; z: number; size: number }
  | { t: 'steam'; x: number; y: number; z: number }
  | { t: 'flash'; x: number; y: number; z: number; color: number; intensity: number; decay: number }
  | { t: 'wiresnap'; x: number; y: number; z: number }

export interface SoundEvent {
  name: string
  x?: number
  y?: number
  z?: number
  gain?: number
  rate?: number
  /** For shell whistles: seconds until impact. */
  dur?: number
}

/**
 * Transient first-person feedback for the embodied player — confirms that a
 * round the possessed soldier fired connected (and whether it killed), or
 * that an incoming round wounded him and from which world direction it came.
 * Pure presentation signalling: it never affects the sim and is never saved,
 * which is why it lives on `Ctx` rather than here alongside `FxEvent`/
 * `SoundEvent` in `SimState` — see `Ctx.fpsFeedback` in sim/sim.ts.
 */
export type FpsFeedbackEvent =
  | { t: 'hit'; kill: boolean }
  | { t: 'hurt'; fromX: number; fromZ: number }

// ---------------------------------------------------------------------------
// Waves & the adaptive director
// ---------------------------------------------------------------------------

export interface WaveSpawn {
  kind: EnemyKindId | VehicleKindId
  count: number
  /** Seconds after wave start. */
  at: number
  /** Spawn cluster center x (z is always the north edge). */
  x: number
}

export interface WavePlan {
  number: number
  name: string
  spawns: WaveSpawn[]
  /** Off-map artillery events during the wave. */
  barrages: Array<{ at: number; x: number; z: number; shells: number; gas: boolean }>
  night: boolean
  weatherBias: 'clear' | 'rain' | 'fog'
  /** What the director decided to punish. Shown in intel if recon purchased. */
  intent: string
  /**
   * If the director bought a counter this wave, a concrete one-line telegraph
   * of the adaptation ("They have brought up snipers to silence your machine
   * guns"). Null when nothing has been adapted to yet. Surfaced prominently in
   * the intelligence report so the counter is legible before it hits the field.
   */
  adaptation: string | null
}

/** Tracks how the player kills things so the director can adapt. */
export interface DirectorMemory {
  dmgByCategory: Record<string, number> // 'mg' | 'rifle' | 'artillery' | 'gas' | 'wire' | 'mine' | 'flame' | 'sniper'
  lossesLastWave: number
  playerLossesLastWave: number
  wireDensity: number
}

// ---------------------------------------------------------------------------
// Meta / run state
// ---------------------------------------------------------------------------

export type GamePhase = 'build' | 'assault' | 'debrief'

export type Difficulty = 'quiet' | 'front' | 'push'

export interface CasualtyRecord {
  name: SoldierName
  rank: string
  kind: UnitKindId
  wave: number
  epitaph: string
  /** Bitmask of the deeds he was cited for (DeedMask); 0 if none. */
  deeds: DeedMask
  /** Waves he fought through before he fell — a long-serving man is honoured apart. */
  wavesServed: number
}

export interface RunStats {
  kills: number
  losses: number
  shellsFired: number
  gasClouds: number
  sectionsLost: number
  reqEarned: number
  score: number
}

export interface OrderStateMap {
  takecover: number   // cooldown remaining (s), 0 = ready
  rapidfire: number
  bayonets: number
  masks: boolean      // toggle, not cooldown
  flare: number
  barrage: number     // creeping barrage (upgrade-gated)
  marktank: number    // Mark IV call-in (upgrade-gated)
}

// ---------------------------------------------------------------------------
// Terrain interface (implemented in world/terrain.ts; typed here so sim
// modules don't import the implementation)
// ---------------------------------------------------------------------------

export interface TerrainLike {
  readonly width: number   // world meters in x
  readonly depth: number   // world meters in z
  heightAt(x: number, z: number): number
  /** Depth below original ground level (>0 inside craters/trenches). */
  craterDepthAt(x: number, z: number): number
  /** 0..1 mud factor (wetness + churn); slows movement, bogs tanks. */
  mudAt(x: number, z: number): number
  /** True if standing water at this point (flooded crater). */
  floodedAt(x: number, z: number): boolean
  /** Carve a crater. Returns true if terrain actually changed. */
  crater(x: number, z: number, radius: number, depth: number): boolean
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface GameSettings {
  volMaster: number
  volSfx: number
  volAmbience: number
  volUi: number
  quality: 0 | 1 | 2          // low / medium / high
  shadows: boolean
  postfx: boolean
  particleDensity: number      // 0.25..1
  edgePan: boolean
  invertZoom: boolean
  cameraSpeed: number
  uiScale: number
  colorAssist: boolean         // enemy chevron markers
  autoMasks: boolean
  showFps: boolean
  reduceFlashes: boolean       // photosensitivity: dampen muzzle/explosion strobing
  keybinds: Record<string, string>
}
