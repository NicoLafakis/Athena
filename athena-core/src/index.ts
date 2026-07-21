/**
 * Athena core — Phase 0 de-risk spike public surface.
 *
 * Provider dialect layer + SDK config/hook seams. See PHASE0.md for what is
 * proven in-container vs. deferred to the keyed / Windows checklist.
 */

export * from './providers/index.js';
export * from './hooks/contract.js';
export {
  ATHENA_CORE_ROOT,
  FIXTURE_PROJECT_DIR,
  FIXTURE_CLAUDE_DIR,
  FIXTURE_HOOK_PATH,
  FIXTURE_SKILL_PATH,
  buildAthenaOptions,
  resolveAthenaSettings,
  sessionStartInjector,
} from './config/loadConfig.js';
export type { BuildOptions } from './config/loadConfig.js';
export { hasAnthropicAuth, runLiveSmoke } from './smoke/liveSmoke.js';
export type { LiveSmokeResult } from './smoke/liveSmoke.js';
