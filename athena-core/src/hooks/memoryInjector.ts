/**
 * Seam 3 — native memory injection (ADR 0001, Phase 2).
 *
 * STEP-0 finding decides scope (see PHASE2.md): the `claude_code` preset +
 * `settingSources:['user','project']` auto-loads CLAUDE.md (identity + rules) for
 * FREE, and Claude Code's native auto-memory directory even defaults to the Ares
 * memory path (`<home>/projects/<slug>/memory/`). What it does NOT do
 * deterministically is inject the ARES-AUTHORED `MEMORY.md` INDEX: the literal
 * file "MEMORY.md" is unknown to the SDK, native auto-memory can be disabled, and
 * its recall is model-driven / not verifiable keyless. So the index injection is
 * the real gap, and THIS hook fills it — a SessionStart `HookCallback` that reads
 * `<memoryDir>/MEMORY.md` and returns it as `additionalContext`.
 *
 * Ports the intent of the Ares memory doctrine faithfully:
 *   - MEMORY.md is the procedural-memory INDEX (one line per memory, recalled on
 *     relevance) — inject it so the session opens knowing what it can recall.
 *   - "The files win / verify on recall": every recalled/handed-forward memory is
 *     a lead, not gospel. The freshness helper stamps the index's age and tells
 *     the model to verify against disk before asserting state
 *     (cf. `feedback_verify_state_against_disk`).
 *
 * Fail-open, always: any error (missing dir, unreadable file) yields no injection
 * and never breaks session start — mirrors the Ares `py` hook convention.
 */

import { readFileSync, statSync } from 'node:fs';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { resolveAresHome, resolveMemoryDir } from '../config/aresConfig.js';

/** Default cap on injected index size (chars). The index is one line per memory; large stores are truncated. */
export const MEMORY_INDEX_MAX_CHARS = 20000;

/** ms per day, for age computation. */
const MS_PER_DAY = 86_400_000;

/** Whole-day age of a file from its mtime. */
export function memoryAgeDays(mtimeMs: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - mtimeMs) / MS_PER_DAY));
}

/**
 * The "files win / verify on recall" freshness reminder, stamped with the index's
 * age. Ported from the Ares doctrine: a recalled memory is a point-in-time lead,
 * not ground truth — open the live artifact before asserting state.
 */
export function freshnessNote(ageDays: number): string {
  const age =
    ageDays <= 0 ? 'refreshed today' : `${ageDays} day${ageDays === 1 ? '' : 's'} old`;
  return (
    `This memory index is ${age}. The files win: a recalled or handed-forward ` +
    `memory is a LEAD, not gospel — verify against the live artifact on disk ` +
    `before asserting current state, especially if challenged.`
  );
}

/** Result of {@link readMemoryIndex}: the index body + its resolved path/age, or a miss. */
export type MemoryIndexRead = {
  found: boolean;
  /** Absolute path that was checked. */
  path: string;
  /** Raw MEMORY.md contents (possibly truncated to `maxChars`). Empty on a miss. */
  content: string;
  /** Whole-day age of the file (0 when missing). */
  ageDays: number;
  /** True when the content was truncated to `maxChars`. */
  truncated: boolean;
};

export type ReadMemoryIndexOptions = {
  /** Explicit memory dir (wins over deriving `<aresHome>/projects/<slug>/memory`). */
  memoryDir?: string;
  /** Clock injection for deterministic age tests. */
  now?: number;
  /** Max chars of the index to read (default {@link MEMORY_INDEX_MAX_CHARS}). */
  maxChars?: number;
};

/**
 * Read the Ares `MEMORY.md` index for a working dir. Pure filesystem read; never
 * throws (returns `found:false` on any error).
 */
export function readMemoryIndex(
  aresHome: string,
  cwd: string,
  opts: ReadMemoryIndexOptions = {},
): MemoryIndexRead {
  const maxChars = opts.maxChars ?? MEMORY_INDEX_MAX_CHARS;
  const now = opts.now ?? Date.now();
  const dir = resolveMemoryDir(aresHome, cwd, opts.memoryDir);
  const path = `${dir}/MEMORY.md`;
  try {
    const raw = readFileSync(path, 'utf8');
    const mtimeMs = statSync(path).mtimeMs;
    const truncated = raw.length > maxChars;
    return {
      found: true,
      path,
      content: truncated ? `${raw.slice(0, maxChars).trimEnd()}\n[...truncated]` : raw,
      ageDays: memoryAgeDays(mtimeMs, now),
      truncated,
    };
  } catch {
    return { found: false, path, content: '', ageDays: 0, truncated: false };
  }
}

/**
 * Compose the full SessionStart `additionalContext` payload (freshness header +
 * the index body). Exposed for unit tests and for callers wiring their own hook.
 */
export function buildMemoryContext(read: MemoryIndexRead): string {
  return (
    `ARES MEMORY INDEX (procedural memory — recall entries on relevance). ` +
    `${freshnessNote(read.ageDays)}\n\n${read.content.trimEnd()}`
  );
}

export type MemoryInjectorOptions = ReadMemoryIndexOptions;

/**
 * Build the seam-3 SessionStart `HookCallback`. On session start it reads the
 * Ares `MEMORY.md` index for the session's cwd and injects it (plus the freshness
 * reminder) as `additionalContext`. No index → no injection (fail-open).
 *
 * @param aresHome  Ares config home (default: resolved via {@link resolveAresHome}).
 * @param opts      `memoryDir` override / clock / size cap.
 */
export function memoryInjector(
  aresHome: string = resolveAresHome(),
  opts: MemoryInjectorOptions = {},
): HookCallback {
  return async (input) => {
    try {
      const cwd = (input as { cwd?: string }).cwd ?? process.cwd();
      const read = readMemoryIndex(aresHome, cwd, opts);
      if (!read.found || !read.content.trim()) {
        return {}; // fail-open: nothing to inject
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: buildMemoryContext(read),
        },
      };
    } catch {
      return {}; // never break session start
    }
  };
}
