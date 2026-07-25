// src/engine/client-holder.ts — one mutable indirection over ModelClient. The engine,
// the orchestrator's clientFactory, and the compactor's complete() all hold THIS object,
// so a /provider swap reaches every call site at once — sub-agents and compaction can
// never be left on the old provider's client. A swap does not affect requests already started;
// they finish on the old client via the call-time read of `current`.
import type {
  CompletionResult,
  ModelClient,
  StreamCallbacks,
  StreamResult,
} from './client.js'

export class ClientHolder implements ModelClient {
  private current: ModelClient

  constructor(initial: ModelClient) {
    this.current = initial
  }

  swap(next: ModelClient): void {
    this.current = next
  }

  stream(
    params: Parameters<ModelClient['stream']>[0],
    callbacks: StreamCallbacks,
  ): Promise<StreamResult> {
    return this.current.stream(params, callbacks)
  }

  complete(params: Parameters<ModelClient['complete']>[0]): Promise<string> {
    return this.current.complete(params)
  }

  async completeDetailed(
    params: Parameters<ModelClient['complete']>[0],
  ): Promise<CompletionResult> {
    return this.current.completeDetailed
      ? this.current.completeDetailed(params)
      : { text: await this.current.complete(params) }
  }
}
