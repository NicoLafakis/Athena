// src/engine/events.ts
import type { EngineEvent } from './types.js'

export type EngineEventListener = (event: EngineEvent) => void

export class EngineEventBus {
  private listeners = new Set<EngineEventListener>()

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(event: EngineEvent): void {
    // Snapshot so listeners added mid-emit do not receive the in-flight event.
    for (const listener of [...this.listeners]) listener(event)
  }
}
