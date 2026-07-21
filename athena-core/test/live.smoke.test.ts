import { describe, expect, it } from 'vitest';
import { hasAnthropicAuth, runLiveSmoke } from '../src/smoke/liveSmoke.js';

/**
 * The live proof (one real query() turn confirming the hook's additionalContext
 * is injected and the hello skill is discoverable) is gated on a credential.
 * In the keyless Linux authoring container the keyed block is skipped; it is
 * meant to run on the Windows host per the PHASE0 checklist.
 */
describe('live smoke gating', () => {
  it('exposes a boolean auth gate', () => {
    expect(typeof hasAnthropicAuth()).toBe('boolean');
  });
});

const keyed = hasAnthropicAuth() ? describe : describe.skip;

keyed('live smoke (keyed — one real turn)', () => {
  it('injects the hook marker in a single real query() turn', async () => {
    const result = await runLiveSmoke();
    expect(result.ran).toBe(true);
    expect(result.messageCount).toBeGreaterThan(0);
    expect(result.sawHookMarker).toBe(true);
  }, 120_000);
});
