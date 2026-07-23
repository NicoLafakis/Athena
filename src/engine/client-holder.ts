// src/engine/client-holder.ts — one mutable indirection over ModelClient. The engine,
// the orchestrator's clientFactory, and the compactor's complete() all hold THIS object,
// so a /provider swap reaches every call site at once — sub-agents and compaction can
// never be left on the old provider's client.
import type { ModelClient, StreamCallbacks, StreamResult } from './client.js'

export class ClientHolder implements ModelClient {
  private current: ModelClient

  constructor(initial: ModelClient) {
    this.current = initial
  }

  swap(next: ModelClient): void {
    this.current = next
  }

  get(): ModelClient {
    return this.current
  }

  stream(
    params: Parameters<ModelClient['stream']>[0],
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    return this.current.stream(params, callbacks)
  }

  complete(params: { model: string; prompt: string; maxTokens: number }): Promise<string> {
    return this.current.complete(params)
  }
}
