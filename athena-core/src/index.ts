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

// Phase 3 — RSI Loops A + C.
// Seam 1: transcript adapter.
export {
  INTENT_MAX,
  MAX_FILES,
  MAX_COMMITS,
  TRANSCRIPT_MAX_BYTES,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MAX_SESSIONS,
  formatSnapshotDate,
  projectFromSlug,
  projectFromCwd,
  readSessionSnapshot,
  getSessions,
} from './rsi/sessions.js';
export type {
  SessionSnapshot,
  ReadSessionSnapshotOptions,
  GetSessionsOptions,
} from './rsi/sessions.js';
// Seam 4 / RSI Loop A: scheduled reflection.
export {
  DEFAULT_REFLECT_MODEL,
  PROMPT_HEADER,
  shortPath,
  buildDigest,
  buildPrompt,
  sdkModelCall,
  ymd,
  ymdhm,
  writeReflection,
  runReflection,
} from './rsi/reflect.js';
export type {
  ModelCall,
  ReflectionMeta,
  WriteReflectionOptions,
  WrittenReflection,
  RunReflectionOptions,
  ReflectionStatus,
  ReflectionResult,
} from './rsi/reflect.js';
export { parseReflectArgs, mainReflectCli } from './rsi/reflectCli.js';
export type { ReflectArgs, ReflectCliDeps } from './rsi/reflectCli.js';
// RSI Loop C: prompt-evolution telemetry.
export {
  parseAgentSignals,
  traceLogPath,
  appendTrace,
  agentTrace,
} from './hooks/agentTrace.js';
export type { TraceEntry, AgentSignals, AgentTraceOptions } from './hooks/agentTrace.js';

// Phase 4a — surfaces: the `athena` terminal CLI. Pure arg parsing + dry-run
// formatting + the runnable entry, re-exported so a VS Code extension (or any
// embedder) can reuse the exact same surface the bin uses.
export {
  CLI_NAME,
  PROVIDER_NAMES,
  DEFAULT_PROVIDER,
  CliUsageError,
  parseCliArgs,
  isProviderName,
  versionText,
  bannerText,
  helpText,
} from './cli/args.js';
export type { CliArgs } from './cli/args.js';
export { dryRunConfig, formatDryRun } from './cli/format.js';
export type { DryRunConfig } from './cli/format.js';
export { packageVersion, sdkRunTurn, runCli } from './cli/index.js';
export type { RunTurn, CliDeps, ReplContext } from './cli/index.js';
