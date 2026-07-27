/** Minimal typed event bus for cross-cutting notifications (UI ← sim). */
import type { Team } from './types'

export interface GameEvents {
  waveStart: { wave: number; name: string }
  waveEnd: { wave: number; bonus: number; hospitalReturned: number }
  /** A new wave plan is ready; classic mode shows the intel paper on this. */
  wavePrepared: { wave: number }
  thunder: Record<string, never>
  /** A command of kind 'order' was applied by the sim (toast/sfx hooks). */
  orderIssued: { id: string; side: Team }
  upgradeBought: { id: string; side: Team }
  sectionLost: { sectionId: number }
  sectionRetaken: { sectionId: number }
  /** A GERMAN-home section changed hands (Big Push). */
  sectionCaptured: { sectionId: number; by: Team }
  /** Big Push: a push went over the top / lost its nerve and came back. */
  assaultBegan: { groupId: number; side: Team; men: number; targetSectionId: number }
  assaultBroke: { groupId: number; side: Team; men: number }
  unitPlaced: { unitId: number }
  unitLost: { unitId: number; kind: string }
  soldierDied: { name: string; rank: string; kind: string; wave: number; deeds: number; wavesServed: number }
  gasAlarm: { incoming: boolean }
  barrageWarning: { x: number; z: number; seconds: number }
  tankSighted: Record<string, never>
  promoted: { unitId: number; vet: number }
  deed: { unitId: number; deed: string; cite: string }
  reqChanged: { req: number }
  gameOver: { victory: boolean; draw?: boolean }
  toast: { text: string; kind: 'info' | 'warn' | 'danger' | 'good' }
}

type Handler<T> = (payload: T) => void

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>()

  on<K extends keyof GameEvents>(name: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(name)
    if (!set) { set = new Set(); this.handlers.set(name, set) }
    set.add(fn as Handler<never>)
    return () => set.delete(fn as Handler<never>)
  }

  emit<K extends keyof GameEvents>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name)
    if (!set) return
    for (const fn of set) (fn as Handler<GameEvents[K]>)(payload)
  }

  clear(): void {
    this.handlers.clear()
  }
}
