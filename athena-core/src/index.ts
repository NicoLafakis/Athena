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
  buildSession,
  buildAresProgrammaticHooks,
  resolveAthenaSettings,
  sessionStartInjector,
} from './config/loadConfig.js';
export type {
  BuildOptions,
  BuildSessionArgs,
  AthenaSession,
  AresHookFlags,
} from './config/loadConfig.js';
export { hasAnthropicAuth, runLiveSmoke } from './smoke/liveSmoke.js';
export type { LiveSmokeResult } from './smoke/liveSmoke.js';

// Phase 2 — Ares brain port: config discovery + native-injection hook ports.
export {
  ARES_HOME_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  resolveAresHome,
  sanitizeCwd,
  resolveMemoryDir,
  discoverAresConfig,
} from './config/aresConfig.js';
export type {
  AresConfig,
  DiscoveredHook,
  DiscoverAresConfigOptions,
} from './config/aresConfig.js';
export {
  MEMORY_INDEX_MAX_CHARS,
  memoryAgeDays,
  freshnessNote,
  readMemoryIndex,
  buildMemoryContext,
  memoryInjector,
} from './hooks/memoryInjector.js';
export type {
  MemoryIndexRead,
  ReadMemoryIndexOptions,
  MemoryInjectorOptions,
} from './hooks/memoryInjector.js';
export {
  REFLECTION_THRESHOLD,
  reflectionNudgeText,
  resetReflectionState,
  countToolUseBlocks,
  reflectionNudge,
} from './hooks/reflectionNudge.js';
export type { ReflectionNudgeOptions } from './hooks/reflectionNudge.js';
export {
  ARES_IDENTITY,
  ARES_RULES,
  MIN_PROMPT_CHARS,
  readIdentityCommission,
  buildReinjectContext,
  rulesReinject,
} from './hooks/rulesReinject.js';
export type { RulesReinjectOptions } from './hooks/rulesReinject.js';
