/** Provider dialect layer — public surface. */

import { anthropic, kimi, minimax, openai } from './descriptors.js';
import { shapeRequest } from './shapeRequest.js';
import type { MessagesRequest, Provider, ProviderCapabilities, ProviderName, ShapedRequest } from './types.js';

export * from './types.js';
export * from './descriptors.js';
export * from './shapeRequest.js';
export * from './sidecar.js';
export * from './resolveProvider.js';
export * from './fetchModels.js';

/** A Provider backed by a capability descriptor + the pure {@link shapeRequest}. */
export class CapabilityProvider implements Provider {
  constructor(public readonly capabilities: ProviderCapabilities) {}
  shape(baseRequest: MessagesRequest): ShapedRequest {
    return shapeRequest(this.capabilities, baseRequest);
  }
}

/** The four Phase 1 providers, keyed by name. */
export const providers: Record<ProviderName, Provider> = {
  anthropic: new CapabilityProvider(anthropic),
  kimi: new CapabilityProvider(kimi),
  minimax: new CapabilityProvider(minimax),
  openai: new CapabilityProvider(openai),
};

export function getProvider(name: ProviderName): Provider {
  const p = providers[name];
  if (!p) throw new Error(`unknown provider '${name}'`);
  return p;
}
