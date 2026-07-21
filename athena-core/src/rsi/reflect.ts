/**
 * Seam 4 — RSI Loop A: scheduled cross-project reflection (ADR 0001, Phase 3).
 *
 * TS port of `scripts/cross_project_reflect.py` — the flagship RSI loop. Two
 * stages so the model never drinks from the firehose:
 *
 *   Stage 1 (mechanical, KEYLESS): harvest recent session snapshots (Seam 1,
 *     {@link getSessions}), group by project, and build a compact digest string
 *     (capped at `maxSessions`). No model, no key.
 *   Stage 2 (one model call): turn the digest into a first-person reflection that
 *     MUST include a "## Proposed promotions (for Nico to approve)" section.
 *
 * SAFETY — the anti-self-corruption guarantee (kept explicit, ported verbatim in
 * intent from the py script's damage-radius rule):
 *   - This loop is READ-ONLY toward long-term memory. The reflection only
 *     *proposes* promotions under a clearly-marked heading; a HUMAN applies them.
 *   - The model call is a PURE FUNCTION (digest in → text out). The SCRIPT, not
 *     the model, writes the reflection to disk. The model is never handed the
 *     memory store to edit. This is what stops the loop from rewriting its own
 *     rules unsupervised.
 *
 * The Stage-2 model call is INJECTABLE. The default ({@link sdkModelCall}) is a
 * headless single-turn SDK `query({ options:{ maxTurns:1 } })` — the in-process
 * replacement for `claude -p --model` verified against the installed `sdk.d.ts`
 * (see PHASE3.md step 0). Tests inject a mock, so Stage 1 + the write path are
 * fully unit-tested KEYLESS.
 *
 * Determinism: `now` is injectable (default real clock) and drives BOTH the
 * harvest window cutoff AND the output filename/timestamps — mirroring how the
 * Ares script derives the date from `datetime.now()` inside `write_output`, but
 * threaded so tests are reproducible.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveAresHome } from '../config/aresConfig.js';
import {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_WINDOW_DAYS,
  getSessions,
  type SessionSnapshot,
} from './sessions.js';

/** Default sub-model for the reflection call (matches cross_project_reflect DEFAULT_MODEL). */
export const DEFAULT_REFLECT_MODEL = 'sonnet';

// ========================================================================
// Stage 1 — mechanical digest (keyless, pure)
// ========================================================================

/** Trim an absolute path to its last few segments for the digest (ported `_short_path`). */
export function shortPath(p: string): string {
  const segs = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  return segs.length > 3 ? segs.slice(-3).join('/') : p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Build the human-readable digest from session snapshots. Groups by project,
 * orders projects by most-recent activity, and renders one block per project with
 * a bulleted `- [date] intent` line + a meta line (tool calls | files | commits).
 * Ported from `cross_project_reflect.build_digest`. Pure — deterministic given
 * deterministic snapshots.
 */
export function buildDigest(records: SessionSnapshot[]): string {
  if (records.length === 0) return '(no sessions found in the window)';

  const byProject = new Map<string, SessionSnapshot[]>();
  for (const r of records) {
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }

  const ordered = [...byProject.entries()].sort(
    (a, b) => maxTs(b[1]) - maxTs(a[1]),
  );

  const blocks: string[] = [];
  for (const [project, rowsIn] of ordered) {
    const rows = [...rowsIn].sort((a, b) => b.lastActive - a.lastActive);
    const lines = [`## ${project}  (${rows.length} session${rows.length === 1 ? '' : 's'})`];
    for (const r of rows) {
      lines.push(`- [${r.date}] ${r.intent || '(no stated intent)'}`);
      const meta: string[] = [];
      if (r.toolCalls) meta.push(`${r.toolCalls} tool calls`);
      if (r.files.length) {
        const shown = r.files.slice(0, 8).map(shortPath).join(', ');
        const more = r.files.length - 8;
        meta.push(`files: ${shown}${more > 0 ? ` (+${more})` : ''}`);
      }
      if (r.commits.length) meta.push(`commits: ${r.commits.slice(0, 6).join('; ')}`);
      if (meta.length) lines.push(`    ${meta.join(' | ')}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function maxTs(rows: SessionSnapshot[]): number {
  return rows.reduce((m, r) => Math.max(m, r.lastActive), 0);
}

/**
 * The reflection prompt header — ported from `cross_project_reflect.PROMPT_HEADER`.
 * Section 4 REQUIRES the propose-only promotions heading; the model is told it can
 * see only the digest and must not use tools. Keeping this text faithful is what
 * makes the loop's output shape stable.
 */
export const PROMPT_HEADER = `You are Ares -- the persistent Athena agent working across Nico's ProvenLabs projects from the meta/ops hub (~/.claude). You do NOT experience continuity between sessions; each one starts cold. This reflection is how you hand your own thinking forward to the next instance of yourself, and how Nico keeps a sense of what's been happening across the portfolio.

Below is a structured digest of recent cross-project sessions. You cannot see the full transcripts -- only this digest. Do NOT try to read files or use tools; everything you have is here. If the digest is thin, say so honestly rather than inventing.

Write a private reflection. First person, concise, honest, no padding. Cover, in this order:

1. **What happened** -- the real story across the portfolio this period, grouped by theme or thread, not a flat re-list of the digest. What was actually being worked toward?
2. **Cross-project connections** -- the highest-value part. Where did one project solve something another is about to need? What friction or pattern repeats across projects? What's diverging that should converge (or vice-versa)? Only connections the digest actually supports.
3. **Where things stand / open threads** -- what's mid-flight, what's the obvious next move, what would the next you want to walk in already knowing.
4. **## Proposed promotions (for Nico to approve)** -- a short, conservative list of durable facts or rules worth saving into long-term semantic memory. PROPOSE ONLY. Do not state them as already saved. Under-propose rather than invent; if nothing rises to the bar, say "none this round."

Keep it tight enough that the next session will actually read it. Do not fabricate certainty. This is internal/private text -- write plainly.

=== DIGEST ===
`;

/** Wrap the digest in the reflection prompt (ported `build_prompt`). */
export function buildPrompt(digest: string): string {
  return `${PROMPT_HEADER}${digest}\n=== END DIGEST ===\n`;
}

// ========================================================================
// Stage 2 — the injectable model call
// ========================================================================

/**
 * The Stage-2 model call: digest-prompt in, reflection text out (or null on
 * failure). Pure from the caller's view — no side effects on memory. Injectable
 * so tests run keyless and the sidecar/provider layer can supply alternatives.
 */
export type ModelCall = (
  prompt: string,
  opts?: { model?: string; signal?: AbortSignal },
) => Promise<string | null>;

/**
 * Default Stage-2 implementation: a headless single-turn SDK call, the in-process
 * replacement for `claude -p --model` (Seam 4).
 *
 * Verified against `sdk.d.ts`: `query({ prompt, options })` returns an
 * `AsyncGenerator<SDKMessage>`; the final text is the `type:'result'`,
 * `subtype:'success'` message's `.result` string. `maxTurns:1` bounds it to a
 * single assistant turn (the prompt already forbids tools). `settingSources:[]`
 * keeps the sub-call clean — it must NOT re-load the Ares hooks (else the
 * reflection call would itself fire journal-capture / the reflection nudge). This
 * is a deliberate improvement over the bare `claude -p` shell-out, which had no
 * such isolation.
 *
 * Needs a key at runtime, so it is exercised only on the keyed/Windows checklist;
 * unit tests inject a mock in its place.
 */
export const sdkModelCall: ModelCall = async (prompt, opts = {}) => {
  const q = query({ prompt, options: reflectQueryOptions({ model: opts.model }) });
  let result: string | null = null;
  for await (const msg of q) {
    if (msg.type === 'result' && msg.subtype === 'success') {
      result = msg.result?.trim() ? msg.result.trim() : result;
    }
  }
  return result;
};

/**
 * Tools the reflection sub-call is HARD-blocked from using. The reflection is a
 * pure text turn (digest in -> reflection out) and must never touch the
 * filesystem or shell. `settingSources:[]` isolates config but does NOT restrict
 * built-in tools, so the mutating/exec tools are disallowed explicitly — turning
 * the prompt's "do not use tools" from a soft request into an SDK-enforced
 * control. The technical half of the propose-only / anti-self-corruption
 * guarantee: the JS write path never touches memory, and this stops the
 * sub-model from touching it either.
 */
export const REFLECT_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
];

/** SDK query options for the reflection sub-call (extracted so the hard tool-block is unit-testable). */
export function reflectQueryOptions(opts: { model?: string } = {}): Options {
  return {
    maxTurns: 1,
    settingSources: [],
    disallowedTools: REFLECT_DISALLOWED_TOOLS,
    ...(opts.model ? { model: opts.model } : {}),
  };
}

// ========================================================================
// The write path — the SCRIPT owns disk, not the model
// ========================================================================

/** `YYYY-MM-DD` (local) — the reflection filename stamp. */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `YYYY-MM-DD HH:MM` (local) — the generated-at stamp. */
export function ymdhm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ymd(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type ReflectionMeta = {
  days: number;
  count: number;
  model: string;
};

export type WriteReflectionOptions = {
  /** Ares home whose `journal/reflections/` receives the output (default {@link resolveAresHome}). */
  root?: string;
  /** Injectable clock for the filename + generated-at stamp (default real `new Date()`). */
  now?: Date;
};

/** Absolute paths written by {@link writeReflection}. */
export type WrittenReflection = { dated: string; latest: string };

/**
 * Write the reflection to `<root>/journal/reflections/<date>.md` AND `latest.md`
 * (ported `write_output`). The header blockquote records the window/count/model
 * and — critically — restates that promotions below are PROPOSALS for a human to
 * approve, not applied facts. THIS function is the only writer; the model text is
 * embedded verbatim beneath the `---`.
 */
export function writeReflection(
  text: string,
  meta: ReflectionMeta,
  opts: WriteReflectionOptions = {},
): WrittenReflection {
  const root = opts.root ?? resolveAresHome();
  const now = opts.now ?? new Date();
  const reflectionsDir = join(root, 'journal', 'reflections');
  mkdirSync(reflectionsDir, { recursive: true });

  const stamp = ymd(now);
  const header =
    `# Cross-project reflection -- ${stamp}\n\n` +
    `> Generated by \`reflectCli\` (RSI Loop A) | window: ${meta.days}d | ` +
    `sessions: ${meta.count} | model: ${meta.model} | generated_at: ${ymdhm(now)}\n` +
    `> READ-ONLY toward long-term memory: promotions below are PROPOSALS for Nico to approve.\n\n` +
    `---\n\n`;
  const body = `${header}${text}\n`;

  const dated = join(reflectionsDir, `${stamp}.md`);
  const latest = join(reflectionsDir, 'latest.md');
  writeFileSync(dated, body, 'utf8');
  writeFileSync(latest, body, 'utf8');
  return { dated, latest };
}

// ========================================================================
// Orchestration — runReflection (ports `main`, minus argparse)
// ========================================================================

export type RunReflectionOptions = {
  /** Ares home (default {@link resolveAresHome}). */
  root?: string;
  /** Reflection window in days (default {@link DEFAULT_WINDOW_DAYS}). */
  days?: number;
  /** Sub-model id (default {@link DEFAULT_REFLECT_MODEL}). */
  model?: string;
  /** Cap on harvested sessions (default {@link DEFAULT_MAX_SESSIONS}). */
  maxSessions?: number;
  /** Project/slug substrings to exclude (e.g. client repos). */
  exclude?: string[];
  /** Injectable clock — drives BOTH the harvest window AND the output stamp (default `new Date()`). */
  now?: Date;
  /** Injectable Stage-2 model call (default {@link sdkModelCall}). Tests pass a mock. */
  modelCall?: ModelCall;
  /** Stage 1 only: build + return the digest, no model call, no write. */
  harvestOnly?: boolean;
  /** Build + return the full prompt, but don't call the model or write. */
  dryRun?: boolean;
  /** Optional abort signal forwarded to the model call. */
  signal?: AbortSignal;
};

export type ReflectionStatus =
  | 'ok'
  | 'no-sessions'
  | 'harvest-only'
  | 'dry-run'
  | 'model-failed';

export type ReflectionResult = {
  status: ReflectionStatus;
  /** Sessions harvested in the window. */
  sessions: number;
  /** The Stage-1 digest (always present). */
  digest: string;
  /** The full prompt (present for dry-run + when a model call was attempted). */
  prompt?: string;
  /** The model's reflection text (present on `ok`). */
  reflection?: string;
  /** Paths written (present on `ok`). */
  written?: WrittenReflection;
};

/**
 * Run RSI Loop A once. Harvest → digest → (optional) reflect → write. Honors the
 * propose-only safety model: the model call is a pure function and {@link
 * writeReflection} (not the model) persists the output.
 *
 * Status semantics mirror the py script: a quiet window (no sessions) is NOT an
 * error — it returns `no-sessions` with no write (so scheduled runs don't log
 * false failures).
 */
export async function runReflection(opts: RunReflectionOptions = {}): Promise<ReflectionResult> {
  const root = opts.root ?? resolveAresHome();
  const days = opts.days ?? DEFAULT_WINDOW_DAYS;
  const model = opts.model ?? DEFAULT_REFLECT_MODEL;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const now = opts.now ?? new Date();
  const modelCall = opts.modelCall ?? sdkModelCall;

  const records = await getSessions({
    root,
    days,
    maxSessions,
    exclude: opts.exclude,
    now: now.getTime(),
  });
  const digest = buildDigest(records);

  if (opts.harvestOnly) {
    return { status: 'harvest-only', sessions: records.length, digest };
  }

  const prompt = buildPrompt(digest);
  if (opts.dryRun) {
    return { status: 'dry-run', sessions: records.length, digest, prompt };
  }

  if (records.length === 0) {
    // Quiet window — not an error, and nothing to reflect on.
    return { status: 'no-sessions', sessions: 0, digest, prompt };
  }

  const text = await modelCall(prompt, { model, signal: opts.signal });
  if (!text) {
    return { status: 'model-failed', sessions: records.length, digest, prompt };
  }

  const written = writeReflection(
    text,
    { days, count: records.length, model },
    { root, now },
  );
  return { status: 'ok', sessions: records.length, digest, prompt, reflection: text, written };
}
