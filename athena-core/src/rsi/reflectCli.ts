/**
 * RSI Loop A entrypoint (ADR 0001, Phase 3, deliverable 4).
 *
 * Runs {@link runReflection} once. This is the command Windows Task Scheduler
 * invokes 4×/day, replacing the Ares `AresReflect` job that shelled out to
 * `claude -p`. The exact schtasks wiring is documented in PHASE3.md (this file
 * does NOT create a scheduled task — scheduler wiring is a Windows-host step).
 *
 * Invoked as: `node dist/rsi/reflectCli.js [--days N] [--model NAME]
 *   [--exclude SUBSTR ...] [--root DIR] [--max-sessions N]
 *   [--harvest-only] [--dry-run]`
 *
 * Arg parsing + orchestration are separated from process side-effects so both are
 * unit-testable: {@link parseReflectArgs} is pure, and {@link mainReflectCli}
 * takes injectable deps (modelCall / clock / output streams) and returns an exit
 * code instead of calling `process.exit`.
 */

import { resolveAresHome } from '../config/aresConfig.js';
import { DEFAULT_MAX_SESSIONS, DEFAULT_WINDOW_DAYS } from './sessions.js';
import {
  DEFAULT_REFLECT_MODEL,
  runReflection,
  type ModelCall,
  type RunReflectionOptions,
} from './reflect.js';

/** Parsed CLI args for the reflect entrypoint. */
export type ReflectArgs = {
  days: number;
  model: string;
  maxSessions: number;
  exclude: string[];
  /** Ares home override (default {@link resolveAresHome}). */
  root?: string;
  harvestOnly: boolean;
  dryRun: boolean;
};

/**
 * Parse the reflect CLI argv (mirrors `cross_project_reflect.py`'s argparse, plus
 * a `--root` for pointing at a specific `.claude` home — used by tests and by the
 * Windows scheduler entry). Pure; unknown flags are ignored. Bad numbers fall back
 * to defaults.
 */
export function parseReflectArgs(argv: string[]): ReflectArgs {
  const args: ReflectArgs = {
    days: DEFAULT_WINDOW_DAYS,
    model: DEFAULT_REFLECT_MODEL,
    maxSessions: DEFAULT_MAX_SESSIONS,
    exclude: [],
    harvestOnly: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--days': {
        const n = Number(next());
        if (Number.isFinite(n) && n > 0) args.days = n;
        break;
      }
      case '--model': {
        const v = next();
        if (v) args.model = v;
        break;
      }
      case '--max-sessions': {
        const n = Number(next());
        if (Number.isFinite(n) && n > 0) args.maxSessions = n;
        break;
      }
      case '--exclude': {
        const v = next();
        if (v) args.exclude.push(v);
        break;
      }
      case '--root': {
        const v = next();
        if (v) args.root = v;
        break;
      }
      case '--harvest-only':
        args.harvestOnly = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        break; // ignore unknown
    }
  }
  return args;
}

export type ReflectCliDeps = {
  /** Injectable Stage-2 model call (default: the SDK single-turn call). */
  modelCall?: ModelCall;
  /** Injectable clock (default real `new Date()`). */
  now?: Date;
  /** stdout sink (default `console.log`). */
  log?: (s: string) => void;
  /** stderr sink (default `console.error`). */
  errLog?: (s: string) => void;
};

/**
 * Run Loop A once from parsed argv. Returns a process exit code:
 *   0 — reflection written, quiet window (no sessions), harvest-only, or dry-run.
 *   1 — the model call failed (only reachable when a real/injected model runs).
 *
 * The `--harvest-only` and `--dry-run` paths are fully KEYLESS (no model call),
 * which is what the in-container unit test exercises.
 */
export async function mainReflectCli(argv: string[], deps: ReflectCliDeps = {}): Promise<number> {
  const parsed = parseReflectArgs(argv);
  const log = deps.log ?? ((s: string) => console.log(s));
  const errLog = deps.errLog ?? ((s: string) => console.error(s));
  const root = parsed.root ?? resolveAresHome();

  const runOpts: RunReflectionOptions = {
    root,
    days: parsed.days,
    model: parsed.model,
    maxSessions: parsed.maxSessions,
    exclude: parsed.exclude,
    harvestOnly: parsed.harvestOnly,
    dryRun: parsed.dryRun,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.modelCall ? { modelCall: deps.modelCall } : {}),
  };

  const res = await runReflection(runOpts);

  switch (res.status) {
    case 'harvest-only':
      log(`# Harvest: ${res.sessions} sessions over ${parsed.days}d\n\n${res.digest}`);
      return 0;
    case 'dry-run':
      log(res.prompt ?? res.digest);
      return 0;
    case 'no-sessions':
      errLog('No sessions in the window -- nothing to reflect on.');
      return 0;
    case 'model-failed':
      errLog('FATAL: reflection model call returned no text.');
      return 1;
    case 'ok':
      errLog(`Reflected over ${res.sessions} sessions (${parsed.days}d) [${parsed.model}].`);
      log(`wrote ${res.written?.dated}\nalso updated ${res.written?.latest}`);
      return 0;
    default:
      return 0;
  }
}

/**
 * Direct-execution guard: when run as `node dist/rsi/reflectCli.js ...` this
 * invokes {@link mainReflectCli} with the real argv and sets the exit code. When
 * imported (tests), nothing runs. Uses the argv[1] basename check so it fires for
 * the compiled `.js` without importing `node:process`-specific ESM helpers.
 */
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /reflectCli\.(js|ts|mjs)$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  mainReflectCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`reflectCli failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
