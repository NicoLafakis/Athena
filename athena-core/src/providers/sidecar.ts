/**
 * OpenAI sidecar adapter SEAM (ADR 0001, seam-adjacent to the provider layer).
 *
 * OpenAI is the only shape mismatch. Per the ADR it is bridged by a LiteLLM
 * sidecar: local, pinned to a known-clean version, OpenAI-scoped, never a
 * network dependency. Phase 0 ships ONLY the seam — an interface + a stub. No
 * LiteLLM is installed or bundled. A hand-rolled translator can later replace
 * the stub behind this same interface with zero churn upstream.
 *
 * SECURITY (ADR): LiteLLM shipped credential-stealing malware in 1.82.7 /
 * 1.82.8. Whatever fills this seam MUST pin & vendor a known-clean version and
 * never auto-update.
 */

import type { ShapedRequest } from './types.js';

export type SidecarDispatchResult = {
  /** Identifier of the adapter that handled (or would handle) the request. */
  handledBy: string;
  /** Whether the local sidecar is actually reachable. Phase 0 stub: always false. */
  reachable: boolean;
  /** Standing reminder that the real sidecar must pin a known-clean LiteLLM. */
  pinnedVersionRequired: true;
  /** Downstream call the sidecar would make. */
  target: string;
  note: string;
};

/** The seam. A future local translator/LiteLLM sidecar implements this. */
export interface OpenAISidecarAdapter {
  readonly kind: string;
  /** Is the local sidecar bundled & reachable? Phase 0: false. */
  available(): boolean;
  /**
   * Translate an already-dialect-corrected, Anthropic-shaped request into the
   * OpenAI call the sidecar will make, returning a dispatch descriptor. The
   * Phase 0 stub performs NO network I/O.
   */
  handle(req: ShapedRequest): SidecarDispatchResult;
}

/** Phase 0 stub. Represents the future local LiteLLM sidecar; does nothing over the wire. */
export class LiteLLMSidecarStub implements OpenAISidecarAdapter {
  readonly kind = 'litellm-sidecar-stub';

  available(): boolean {
    // Not bundled in Phase 0. The real adapter flips this once a pinned,
    // known-clean LiteLLM (or hand-rolled translator) is vendored locally.
    return false;
  }

  handle(req: ShapedRequest): SidecarDispatchResult {
    return {
      handledBy: this.kind,
      reachable: this.available(),
      pinnedVersionRequired: true,
      target: 'openai:chat.completions',
      note:
        `Phase 0 seam only — LiteLLM not installed/bundled. Would proxy model '${req.body.model}' ` +
        `via a local sidecar at ${req.baseUrl}. Pin a known-clean LiteLLM (never 1.82.7 / 1.82.8).`,
    };
  }
}

/** Default adapter instance for the seam. */
export const defaultSidecar: OpenAISidecarAdapter = new LiteLLMSidecarStub();

/**
 * Route a shaped request through the sidecar seam. Throws if the request was
 * not marked for sidecar dispatch — a direct-dispatch provider must never
 * silently fall through to OpenAI translation.
 */
export function routeToSidecar(
  req: ShapedRequest,
  sidecar: OpenAISidecarAdapter = defaultSidecar,
): SidecarDispatchResult {
  if (req.dispatch !== 'sidecar') {
    throw new Error(`routeToSidecar called on a '${req.dispatch}' request for provider '${req.provider}'`);
  }
  return sidecar.handle(req);
}
