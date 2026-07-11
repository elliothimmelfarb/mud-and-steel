/**
 * Persistence: settings, the between-waves run save, and the high score.
 * Saves are written at the start of each build phase.
 */
import type { CasualtyRecord, Difficulty, GameSettings, RunStats, TargetPriority } from './types'

const SETTINGS_KEY = 'mudsteel.settings.v1'
const SAVE_KEY = 'mudsteel.save.v1'
const HS_KEY = 'mudsteel.highscore.v1'

export function defaultSettings(): GameSettings {
  return {
    volMaster: 0.8, volSfx: 0.9, volAmbience: 0.7, volUi: 0.6,
    quality: 2, shadows: true, postfx: true, particleDensity: 1,
    edgePan: false, invertZoom: false, cameraSpeed: 1, uiScale: 1,
    colorAssist: false, autoMasks: false, showFps: false, reduceFlashes: false,
    keybinds: {},
  }
}

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaultSettings()
    return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<GameSettings>) }
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(s: GameSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------

export interface SavedUnit {
  kind: string
  slotId: number
  xp: number
  vet: number
  targeting: TargetPriority
  crew: Array<{ first: string; last: string; hp: number }>
  heat: number
  ammo: number
}

export interface SavedDefence {
  kind: string
  x: number
  z: number
  hp: number
  maxHp: number
  wear: number
}

export interface RunSave {
  version: 1
  seed: string
  difficulty: Difficulty
  wave: number             // the NEXT wave to fight
  req: number
  breach: number
  upgrades: string[]
  units: SavedUnit[]
  defences: SavedDefence[]
  craterOps: Array<{ x: number; z: number; r: number; d: number }>
  sectionState: Array<{ parapetHp: number; parapetMax: number; captured: boolean }>
  weather: { tod: number; wetness: number }
  stats: RunStats
  casualties: CasualtyRecord[]
  masksOn: boolean
}

export function loadRun(): RunSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const save = JSON.parse(raw) as RunSave
    if (save.version !== 1) return null
    return save
  } catch {
    return null
  }
}

export function saveRun(save: RunSave): void {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)) } catch { /* full/private */ }
}

export function clearRun(): void {
  try { localStorage.removeItem(SAVE_KEY) } catch { /* noop */ }
}

export function highScore(): number {
  try { return Number(localStorage.getItem(HS_KEY) ?? 0) } catch { return 0 }
}

export function submitScore(score: number): boolean {
  const hs = highScore()
  if (score > hs) {
    try { localStorage.setItem(HS_KEY, String(score)) } catch { /* noop */ }
    return true
  }
  return false
}
