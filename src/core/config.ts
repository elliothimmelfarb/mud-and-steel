/**
 * MUD & STEEL — all gameplay data and tuning constants.
 * One file so balance passes touch one place. Distances in meters, times in
 * seconds, damage in hit points (a healthy rifleman has 60 hp).
 */
import type {
  BuildableId, DefenceKindId, Difficulty, EnemyKindId, PlacementKind,
  TargetPriority, UnitKindId, VehicleKindId,
} from './types'

// ---------------------------------------------------------------------------
// World geometry
// ---------------------------------------------------------------------------

export const WORLD = {
  width: 300,           // x ∈ [-150, 150]
  depth: 440,           // z ∈ [-220, 220]
  cell: 2,              // terrain grid cell size (m)
  enemySpawnZ: -200,
  frontTrenchZ: 80,     // player front line
  supportTrenchZ: 150,
  breachZ: 200,         // enemies crossing this line drain the breach meter
  simHz: 30,
} as const

export const SIM_DT = 1 / WORLD.simHz

/** Front trench span and zigzag geometry (traverses every ~12 m). */
export const TRENCH = {
  frontSpanX: 112,      // front line x ∈ [-112, 112]
  supportSpanX: 78,
  sectionLen: 14,
  depth: 2.0,           // carved below grade
  width: 2.6,
  parapetH: 0.7,        // raised lip on the enemy side
  parapetHp: 220,
  commTrenchXs: [-56, 0, 56] as readonly number[], // communication trenches
} as const

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

export const ECONOMY = {
  startReq: { quiet: 460, front: 360, push: 290 } as Record<Difficulty, number>,
  waveBonusBase: 90,
  waveBonusPerWave: 18,
  sellRefund: 0.7,
  buildPhaseSeconds: 45,
  earlyCallBonusPerSecond: 1.5, // skip the build timer, pocket the difference
} as const

// ---------------------------------------------------------------------------
// Player units
// ---------------------------------------------------------------------------

export interface UnitDef {
  id: UnitKindId
  name: string
  cost: number
  crew: number
  hp: number
  range: number
  minRange: number
  /** Shots per second (per crewman where it makes sense). */
  rof: number
  damage: number
  /** Base chance to hit a standing man at half range. */
  accuracy: number
  placement: PlacementKind
  hotkey: string
  targeting: TargetPriority
  aoe: number
  /** Suppression applied per burst near the target. */
  suppress: number
  blurb: string
}

export const UNIT_DEFS: Record<UnitKindId, UnitDef> = {
  rifleman: {
    id: 'rifleman', name: 'Rifleman', cost: 30, crew: 1, hp: 60,
    range: 95, minRange: 0, rof: 0.4, damage: 22, accuracy: 0.55,
    placement: 'trench', hotkey: '1', targeting: 'nearest', aoe: 0, suppress: 0.05,
    blurb: 'Lee-Enfield SMLE. Trained regulars managed fifteen aimed rounds a minute — the "mad minute".',
  },
  lewis: {
    id: 'lewis', name: 'Lewis Gunner', cost: 70, crew: 1, hp: 60,
    range: 110, minRange: 0, rof: 3.2, damage: 14, accuracy: 0.38,
    placement: 'trench', hotkey: '2', targeting: 'nearest', aoe: 0, suppress: 0.09,
    blurb: 'The 13 kg "portable" machine gun. Its 47-round pan drums ran dry fast, but it moved with the men.',
  },
  vickers: {
    id: 'vickers', name: 'Vickers MG', cost: 130, crew: 2, hp: 55,
    range: 150, minRange: 4, rof: 9, damage: 13, accuracy: 0.3,
    placement: 'pad', hotkey: '3', targeting: 'nearest', aoe: 0, suppress: 0.14,
    blurb: 'Water-cooled and relentless. Watch the jacket — sustained fire boils it dry and the gun must vent.',
  },
  sniper: {
    id: 'sniper', name: 'Sniper', cost: 90, crew: 1, hp: 55,
    range: 175, minRange: 10, rof: 0.18, damage: 70, accuracy: 0.85,
    placement: 'trench', hotkey: '4', targeting: 'officers', aoe: 0, suppress: 0.2,
    blurb: 'A marksman behind a loophole plate. Officers and machine-gun crews learned to keep their heads down.',
  },
  grenadier: {
    id: 'grenadier', name: 'Bomber', cost: 50, crew: 1, hp: 60,
    range: 38, minRange: 10, rof: 0.22, damage: 45, accuracy: 0.6,
    placement: 'trench', hotkey: '5', targeting: 'nearest', aoe: 4, suppress: 0.25,
    blurb: 'Mills bomb specialist. The only answer to men gone to ground in shell holes.',
  },
  mortar: {
    id: 'mortar', name: 'Stokes Mortar', cost: 110, crew: 2, hp: 50,
    range: 190, minRange: 50, rof: 0.14, damage: 55, accuracy: 0.5,
    placement: 'pad', hotkey: '6', targeting: 'strongest', aoe: 7, suppress: 0.4,
    blurb: 'Drop the bomb down the tube and duck. Every burst re-digs the battlefield.',
  },
  fieldgun: {
    id: 'fieldgun', name: '18-Pounder', cost: 220, crew: 3, hp: 50,
    range: 240, minRange: 25, rof: 0.1, damage: 120, accuracy: 0.65,
    placement: 'pad', hotkey: '7', targeting: 'armour', aoe: 6, suppress: 0.6,
    blurb: 'Direct-fire field artillery. The only thing that reliably opens a tank like a tin of bully beef.',
  },
  flamer: {
    id: 'flamer', name: 'Flame Projector', cost: 95, crew: 1, hp: 65,
    range: 26, minRange: 0, rof: 1, damage: 12, accuracy: 1,
    placement: 'trench', hotkey: '8', targeting: 'nearest', aoe: 3, suppress: 0.5,
    blurb: 'Terrifying, indiscriminate, short-ranged. Nothing breaks a charge like a wall of burning fuel.',
  },
  medic: {
    id: 'medic', name: 'Stretcher Bearer', cost: 75, crew: 1, hp: 55,
    range: 12, minRange: 0, rof: 0, damage: 0, accuracy: 0,
    placement: 'trench', hotkey: '9', targeting: 'nearest', aoe: 0, suppress: 0,
    blurb: 'Patches wounds and steadies nerves. Men fight harder knowing someone will come for them.',
  },
  officer: {
    id: 'officer', name: 'Officer', cost: 100, crew: 1, hp: 60,
    range: 30, minRange: 0, rof: 0.3, damage: 20, accuracy: 0.5,
    placement: 'trench', hotkey: '0', targeting: 'nearest', aoe: 0, suppress: 0,
    blurb: 'Webley in hand, whistle in teeth. Nearby men fire faster, rally sooner, and hold when it matters.',
  },
  engineer: {
    id: 'engineer', name: 'Sapper', cost: 65, crew: 1, hp: 60,
    range: 10, minRange: 0, rof: 0, damage: 0, accuracy: 0,
    placement: 'trench', hotkey: 'minus', targeting: 'nearest', aoe: 0, suppress: 0,
    blurb: 'Rebuilds blown parapets and mends the wire under fire. The trench itself is his weapon.',
  },
  gasproj: {
    id: 'gasproj', name: 'Livens Projector', cost: 150, crew: 2, hp: 50,
    range: 200, minRange: 70, rof: 0.022, damage: 0, accuracy: 0.5,
    placement: 'pad', hotkey: 'equal', targeting: 'strongest', aoe: 14, suppress: 0.3,
    blurb: 'Electrically-fired drums of phosgene. Mind the wind — gas serves whichever side it drifts toward.',
  },
}

export interface DefenceDef {
  id: DefenceKindId
  name: string
  cost: number
  hp: number
  placement: PlacementKind
  hotkey: string
  blurb: string
}

export const DEFENCE_DEFS: Record<DefenceKindId, DefenceDef> = {
  wire: {
    id: 'wire', name: 'Barbed Wire', cost: 15, hp: 80, placement: 'field', hotkey: 'q',
    blurb: 'Slows and bleeds anything that touches it. Shellfire and wire-cutters chew it away.',
  },
  mine: {
    id: 'mine', name: 'Buried Mine', cost: 25, hp: 1, placement: 'field', hotkey: 'w',
    blurb: 'A shell fused under a board. One use, no warning, no sympathy. Cripples tank tracks.',
  },
  sandbags: {
    id: 'sandbags', name: 'Sandbag Parapet', cost: 35, hp: 0, placement: 'trench', hotkey: 'r',
    blurb: 'Reinforces a trench section: more cover, more parapet to lose before the section is exposed.',
  },
  tanktrap: {
    id: 'tanktrap', name: 'Tank Trap', cost: 45, hp: 200, placement: 'field', hotkey: 't',
    blurb: 'Steel and timber teeth. Armour must go around — into your killing ground.',
  },
  searchlight: {
    id: 'searchlight', name: 'Searchlight', cost: 90, hp: 60, placement: 'pad', hotkey: 'y',
    blurb: 'Sweeps no-man\'s-land at night. Men caught in the beam are lit for every rifle on the line.',
  },
  flarepost: {
    id: 'flarepost', name: 'Flare Post', cost: 55, hp: 40, placement: 'field', hotkey: 'u',
    blurb: 'Fires parachute flares when movement is heard at night. Twenty rockets, then it\'s spent.',
  },
}

export const WIRE_SEGMENT_LEN = 6
export const MINE_DAMAGE = 90
export const MINE_RADIUS = 3

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------

export interface EnemyDef {
  id: EnemyKindId
  name: string
  hp: number
  speed: number
  range: number
  rof: number
  damage: number
  accuracy: number
  bounty: number
  aoe: number
  suppress: number
  /** Budget cost for the wave director. */
  cost: number
  /** First wave this kind may appear (act gating). */
  fromWave: number
}

export const ENEMY_DEFS: Record<EnemyKindId, EnemyDef> = {
  einf:     { id: 'einf', name: 'Infanterist', hp: 60, speed: 1.5, range: 80, rof: 0.22, damage: 18, accuracy: 0.4, bounty: 6, aoe: 0, suppress: 0.05, cost: 4, fromWave: 1 },
  eofficer: { id: 'eofficer', name: 'Leutnant', hp: 65, speed: 1.6, range: 30, rof: 0.4, damage: 16, accuracy: 0.5, bounty: 20, aoe: 0, suppress: 0, cost: 12, fromWave: 1 },
  ecav:     { id: 'ecav', name: 'Uhlan', hp: 55, speed: 5.2, range: 3, rof: 1, damage: 40, accuracy: 0.8, bounty: 15, aoe: 0, suppress: 0.1, cost: 9, fromWave: 2 },
  estorm:   { id: 'estorm', name: 'Stosstruppen', hp: 70, speed: 2.4, range: 26, rof: 0.35, damage: 32, accuracy: 0.6, bounty: 14, aoe: 3, suppress: 0.2, cost: 10, fromWave: 5 },
  emg:      { id: 'emg', name: 'MG 08 Team', hp: 110, speed: 1.1, range: 150, rof: 8, damage: 12, accuracy: 0.28, bounty: 26, aoe: 0, suppress: 0.14, cost: 16, fromWave: 5 },
  esniper:  { id: 'esniper', name: 'Scharfschütze', hp: 55, speed: 1.4, range: 180, rof: 0.15, damage: 65, accuracy: 0.8, bounty: 22, aoe: 0, suppress: 0.25, cost: 14, fromWave: 6 },
  epioneer: { id: 'epioneer', name: 'Pionier', hp: 65, speed: 1.7, range: 20, rof: 0.3, damage: 20, accuracy: 0.5, bounty: 10, aoe: 0, suppress: 0, cost: 7, fromWave: 7 },
  eflamer:  { id: 'eflamer', name: 'Flammenwerfer', hp: 80, speed: 1.8, range: 24, rof: 1, damage: 12, accuracy: 1, bounty: 18, aoe: 3, suppress: 0.5, cost: 15, fromWave: 10 },
}

export interface VehicleDef {
  id: VehicleKindId
  name: string
  hp: number
  armour: number
  speed: number
  mainRange: number
  mainDamage: number
  mainRof: number
  mgRange: number
  mgDamage: number
  mgRof: number
  bounty: number
  cost: number
  fromWave: number
}

export const VEHICLE_DEFS: Record<VehicleKindId, VehicleDef> = {
  ecar: {
    id: 'ecar', name: 'Panzerwagen', hp: 220, armour: 1, speed: 3.0,
    mainRange: 0, mainDamage: 0, mainRof: 0, mgRange: 120, mgDamage: 12, mgRof: 6,
    bounty: 60, cost: 40, fromWave: 11,
  },
  etank: {
    id: 'etank', name: 'A7V Sturmpanzer', hp: 900, armour: 2, speed: 0.95,
    mainRange: 100, mainDamage: 80, mainRof: 0.12, mgRange: 80, mgDamage: 12, mgRof: 5,
    bounty: 200, cost: 130, fromWave: 15,
  },
  friendlytank: {
    id: 'friendlytank', name: 'Mark IV', hp: 700, armour: 2, speed: 1.15,
    mainRange: 90, mainDamage: 70, mainRof: 0.15, mgRange: 70, mgDamage: 12, mgRof: 5,
    bounty: 0, cost: 0, fromWave: 0,
  },
}

/** Small-arms damage multiplier vs armour level. */
export const ARMOUR_MULT = [1, 0.12, 0] as const

// ---------------------------------------------------------------------------
// Combat model
// ---------------------------------------------------------------------------

export const COMBAT = {
  bulletSpeed: 550,           // muzzle velocity (m/s) — rounds are real simulated bodies
  baseSpreadRad: 0.0045,      // shot-group sigma for a calm, competent shooter at accuracy 1
  bulletMaxLife: 1.6,         // seconds of flight before a round is discarded
  tracerFraction: 0.24,       // share of rounds that burn a visible tracer
  tracerStreakLen: 6.5,       // metres of hot streak drawn behind a tracer round
  ballStreakLen: 1.4,         // metres of faint streak for ordinary ball ammunition
  ricochetChance: 0.3,        // odds a round sparks off armour / a shallow hard hit
  tracerTrailChance: 0.14,    // per-round-per-frame odds of a drifting smoke wisp
  suppressDecay: 0.09,        // per second
  suppressCrouch: 0.5,        // above this: crouch, accuracy penalty
  suppressPin: 0.8,           // above this: pinned prone, cannot fire
  moraleBreak: 0.22,
  moraleRegen: 0.02,
  moraleHitPenalty: 0.08,     // per wound taken nearby / on self
  moraleDeathPenalty: 0.18,   // squadmate killed nearby
  coverTrench: 0.72,          // damage/hit-chance reduction in a healthy trench
  coverCrater: 0.45,          // reduction for a man gone to ground in a shell hole
  coverProne: 0.3,
  nightAccMult: 0.55,         // unlit targets at night
  fogRangeMult: 0.6,          // at fog = 1
  maskAccMult: 0.82,          // fighting in a respirator is miserable
  gasDps: 9,                  // unmasked, at concentration 1
  gasMaskedDps: 0.6,
  fireDangerRadius: 14,       // flow-field cost bump near recent deaths
  vickersHeatPerShot: 0.011,
  vickersCoolRate: 0.06,
  vickersVentTime: 6,
  meleeDps: 26,
  captureSeconds: 10,         // enemies holding an empty section flip it
  breachMax: 100,             // breach meter; leak past support line drains it
  breachPerEnemy: 4,          // per enemy crossing breachZ
} as const

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderDef {
  id: keyof typeof ORDER_DEFS
  name: string
  hotkey: string
  cooldown: number
  duration: number
  cost: number
  needsUpgrade: string | null
  blurb: string
}

export const ORDER_DEFS = {
  takecover: {
    id: 'takecover', name: 'Take Cover', hotkey: 'c', cooldown: 45, duration: 12, cost: 0, needsUpgrade: null,
    blurb: 'Everyone below the parapet. Casualties from shellfire drop sharply; nobody shoots back.',
  },
  rapidfire: {
    id: 'rapidfire', name: 'Rapid Fire', hotkey: 'f', cooldown: 60, duration: 10, cost: 0, needsUpgrade: null,
    blurb: 'The mad minute. Double rate of fire; guns run hot and nerves run thin.',
  },
  bayonets: {
    id: 'bayonets', name: 'Fix Bayonets', hotkey: 'b', cooldown: 90, duration: 15, cost: 0, needsUpgrade: null,
    blurb: 'Front-line infantry go over the top and clear the wire line with cold steel. Costly. Decisive.',
  },
  masks: {
    id: 'masks', name: 'Gas Masks', hotkey: 'g', cooldown: 0, duration: 0, cost: 0, needsUpgrade: null,
    blurb: 'Masks on: gas barely bites, but aiming through fogged eyepieces costs accuracy.',
  },
  flare: {
    id: 'flare', name: 'Flare', hotkey: 'v', cooldown: 20, duration: 0, cost: 5, needsUpgrade: null,
    blurb: 'A parachute flare over no-man\'s-land. Night attacks hate the light.',
  },
  barrage: {
    id: 'barrage', name: 'Creeping Barrage', hotkey: 'x', cooldown: 150, duration: 0, cost: 80, needsUpgrade: 'creepingdoctrine',
    blurb: 'A curtain of shellfire that walks north across the field. Timed right, nothing lives through it.',
  },
  marktank: {
    id: 'marktank', name: 'Mark IV', hotkey: 'm', cooldown: 300, duration: 0, cost: 120, needsUpgrade: 'markiv',
    blurb: 'A Mark IV crawls out from your lines, crushing wire and drawing every gun on the field.',
  },
} as const

// ---------------------------------------------------------------------------
// Upgrades (bought in the debrief/build phase)
// ---------------------------------------------------------------------------

export interface UpgradeDef {
  id: string
  name: string
  cost: number
  tier: 1 | 2 | 3
  requires: string | null
  blurb: string
}

export const UPGRADE_DEFS: readonly UpgradeDef[] = [
  { id: 'smle', name: 'Mk VII Ammunition', cost: 120, tier: 1, requires: null,
    blurb: 'Rifle and Lewis damage +15%.' },
  { id: 'maskph', name: 'PH Helmets', cost: 100, tier: 1, requires: null,
    blurb: 'Gas damage to your men −70% when masked. Masks toggle automatically on gas alarms.' },
  { id: 'salvage', name: 'Salvage Parties', cost: 140, tier: 1, requires: null,
    blurb: 'Requisition from kills +25%.' },
  { id: 'dressings', name: 'Field Dressings', cost: 90, tier: 1, requires: null,
    blurb: 'Stretcher bearers heal 50% faster and steady morale further.' },
  { id: 'mills', name: 'Mills Bomb No. 23', cost: 110, tier: 1, requires: null,
    blurb: 'Bomber damage +25%, blast radius +1 m.' },
  { id: 'spades', name: 'Entrenching Standard', cost: 100, tier: 1, requires: null,
    blurb: 'Parapet maximum +40%; sappers rebuild 50% faster.' },

  { id: 'boxrespirator', name: 'Small Box Respirators', cost: 180, tier: 2, requires: 'maskph',
    blurb: 'Near-immunity to gas; masked accuracy penalty halved.' },
  { id: 'mgdiscipline', name: 'MG Fire Discipline', cost: 160, tier: 2, requires: null,
    blurb: 'Vickers heat build-up −40%.' },
  { id: 'scopes', name: 'Periscopic Sights', cost: 150, tier: 2, requires: null,
    blurb: 'Sniper range +20 m; 15% chance of an instant kill on any hit.' },
  { id: 'recon', name: 'Aerial Reconnaissance', cost: 170, tier: 2, requires: null,
    blurb: 'Full enemy composition in the intelligence report; your indirect fire lands 20% tighter.' },
  { id: 'dugouts', name: 'Deep Dugouts', cost: 200, tier: 2, requires: null,
    blurb: 'Take Cover halves barrage casualties again.' },
  { id: 'depot', name: 'Forward Supply Depot', cost: 190, tier: 2, requires: null,
    blurb: '+40 requisition every wave.' },
  { id: 'creepingdoctrine', name: 'Creeping Barrage Doctrine', cost: 220, tier: 2, requires: null,
    blurb: 'Unlocks the Creeping Barrage order.' },

  { id: 'counterbattery', name: 'Counter-Battery Fire', cost: 260, tier: 3, requires: 'recon',
    blurb: 'Sound-ranging finds their guns: enemy barrages fire 40% fewer shells.' },
  { id: 'concrete', name: 'Concrete Emplacements', cost: 240, tier: 3, requires: null,
    blurb: 'Emplacement crews and parapets +60% durability.' },
  { id: 'hospital', name: 'Field Hospital', cost: 280, tier: 3, requires: 'dressings',
    blurb: '30% of your dead are recovered wounded and return after the wave.' },
  { id: 'rum', name: 'Rum Ration', cost: 150, tier: 3, requires: null,
    blurb: 'Morale floor raised; broken men rally twice as fast.' },
  { id: 'markiv', name: 'Tank Detachment', cost: 350, tier: 3, requires: null,
    blurb: 'Unlocks the Mark IV call-in order.' },
  { id: 'quartermaster', name: 'Quartermaster General', cost: 260, tier: 3, requires: 'depot',
    blurb: 'All unit and defence costs −10%.' },
] as const

export const UPGRADE_TIER_WAVE: Record<1 | 2 | 3, number> = { 1: 2, 2: 6, 3: 10 }

// ---------------------------------------------------------------------------
// Waves / director
// ---------------------------------------------------------------------------

export const DIRECTOR = {
  budgetBase: { quiet: 55, front: 78, push: 102 } as Record<Difficulty, number>,
  budgetGrowth: 0.34,          // per wave, compounding linearly
  victoryWave: 20,             // "relieved" — endless continues if the player wants
  nightWaves: [6, 9, 13, 17] as readonly number[],  // plus director-chosen ones later
  gasFromWave: 5,
  barrageFromWave: 4,
  /**
   * Categories the director tracks and its counters. `intent` is a lower-case
   * noun fragment that slots naturally into the dry staff-officer intel line
   * ("Corps expects <intent>"); `telegraph` is the full, concrete sentence that
   * heads the intelligence report — it names the adaptation and the weapon it
   * answers, so the counter is legible before the men who embody it reach the
   * field.
   */
  counters: {
    mg:        { intent: 'snipers and storm parties sent forward to silence your machine guns', telegraph: 'They have brought up snipers and storm parties to silence your machine guns.', spawns: { esniper: 2, estorm: 1.5 } },
    artillery: { intent: 'an advance in loose, dispersed order to blunt your artillery', telegraph: 'They are coming on in loose, dispersed order to blunt your artillery.', spawns: { estorm: 1.5, ecav: 1.3 } },
    wire:      { intent: 'pioneers pushed ahead of the assault to cut your wire', telegraph: 'Pioneers are moving up ahead of the assault to cut your wire.', spawns: { epioneer: 2.5 } },
    rifle:     { intent: 'a mass attack to swamp your rifle line by weight of numbers', telegraph: 'They mean to swamp your rifle line by sheer weight of numbers.', spawns: { einf: 1.5, emg: 1.4 } },
    gas:       { intent: 'assault troops issued new respirators against your gas', telegraph: 'Their assault troops have been issued new respirators against your gas.', spawns: { estorm: 1.4 } },
    mine:      { intent: 'pioneers probing ahead of the advance for your minefield', telegraph: 'Pioneers are probing ahead of the advance for your minefield.', spawns: { epioneer: 2 } },
    flame:     { intent: 'snipers detailed to hunt your flame projectors', telegraph: 'Snipers have been detailed to hunt your flame projectors.', spawns: { esniper: 1.8 } },
    sniper:    { intent: 'their officers keeping well to the rear, out of your sights', telegraph: 'Their officers are keeping well to the rear, out of your sights.', spawns: { emg: 1.3 } },
  } as Record<string, { intent: string; telegraph: string; spawns: Partial<Record<EnemyKindId, number>> }>,
} as const

// ---------------------------------------------------------------------------
// Squad tactics — bounding overwatch, cohesion, NCOs
// ---------------------------------------------------------------------------

/**
 * Assault parties advance by fire-and-movement: one element goes to ground in
 * cover and fires to suppress while the other sprints crater-to-crater, then
 * they swap. Men rally on a squad NCO; when he falls the section wavers.
 * All timings are in seconds / metres. Tuned to read at a glance, not to
 * simulate a real section attack to the letter.
 */
export const SQUAD = {
  /** Seconds one element rushes before the bound passes to the other (× a small rng jitter). */
  boundSeconds: 3.4,
  /** Start bounding once the squad's lead man is within this many metres of the front trench. */
  boundContactZ: 95,
  /** Moving element sprints this much faster than a plain advance during a bound. */
  rushSpeedMul: 1.4,
  /** Overwatch element moves this fraction of speed while settling into cover. */
  overwatchSpeedMul: 0.9,
  /** Men beyond this distance from their NCO feel the pull back toward him. */
  cohesionRadius: 15,
  /** Strength of the cohesion steer toward the NCO (relative to the flow vector). */
  cohesionPull: 0.6,
  /** A living NCO within this radius steadies a man (morale regen + suppression shed). */
  rallyRadius: 14,
  /** Extra morale lost by squadmates the instant their NCO is killed. */
  leaderMoraleShock: 0.3,
  /** Suppression spike (hesitation) on squadmates when the NCO falls. */
  leaderSuppressBump: 0.4,
} as const

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export const WEATHER = {
  windMin: 0.5, windMax: 6.5,       // m/s
  windMeanderScale: 0.013,          // noise time scale
  rainWetRate: 0.02,                // wetness gain per second at rain=1
  dryRate: 0.004,
  floodDepth: 0.55,                 // craters deeper than this (when wet) hold water
  mudSlowMax: 0.55,                 // speed multiplier floor in deep mud
  bogChance: 0.3,                   // tank entering a deep flooded crater
  todPerWave: 0.11,                 // day advances between waves
  // Day/night is governed in ELEVATION space, not clock-phase: d(elev)/d(tod)
  // peaks at the horizon (the pretty part), so a plain exponential chase whips
  // the sun through dawn/dusk. Instead the clock GLIDES at a capped rate that
  // slows near the horizon, so twilight lingers where it's beautiful.
  todGlide: 0.007,                  // max clock-units/sec during a forced transition (~40-60s night fall)
  todHorizonLinger: 0.7,            // how much the sun slows at the horizon (→ 0.3× rate there)
  todDrift: 0.0001,                 // ambient clock progression/sec (~166 real min per in-game day)
} as const

// ---------------------------------------------------------------------------
// Veterancy
// ---------------------------------------------------------------------------

export const VET_KILLS = [4, 10, 20] as const
export const VET_ACC_BONUS = 0.08
export const VET_ROF_BONUS = 0.1
export const RANKS = ['Pte.', 'L/Cpl.', 'Cpl.', 'Sjt.'] as const

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const SCORE = {
  perKill: 10,
  perWave: 400,
  perSectionHeld: 150,
  perReqRemaining: 1,
} as const

export const BOUNTY_SALVAGE_MULT = 1.25

/** Everything the player can put on the field, in build-bar order. */
export const BUILD_ORDER: readonly BuildableId[] = [
  'rifleman', 'lewis', 'vickers', 'sniper', 'grenadier', 'mortar',
  'fieldgun', 'flamer', 'medic', 'officer', 'engineer', 'gasproj',
  'wire', 'mine', 'sandbags', 'tanktrap', 'searchlight', 'flarepost',
]

export const TEAM_COLORS = { brit: 0x6b6446, german: 0x4e5346 } as const
