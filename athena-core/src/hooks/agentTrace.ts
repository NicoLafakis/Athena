/**
 * RSI Loop C — prompt-evolution telemetry (ADR 0001, Phase 3).
 *
 * A `SubagentStop` `HookCallback` that appends one line to
 * `<aresHome>/agents/trace-log.jsonl` every time a subagent finishes. Ports the
 * intent of the Ares `agent-trace.py` Loop-C telemetry: accumulate a cheap,
 * factual record of every subagent run so `/evolve-prompts` (the prompt-evolution
 * skill) has data to mine. That skill's own trigger is literally "after 20+ agent
 * invocations have accumulated in trace-log.jsonl", and it looks for agents with
 * frequent LOW-confidence / escalation entries — so the fields below are chosen to
 * feed exactly that consumer.
 *
 * Entry shape (one JSON object per line):
 *   { timestamp, agent, confidence?, escalations?, cwd }
 *
 * Mechanics verified against `sdk.d.ts` (see PHASE3.md step 0):
 *   - `SubagentStopHookInput` carries `agent_type`, `agent_id`,
 *     `agent_transcript_path`, `cwd`, and `last_assistant_message?`. We label the
 *     row by `agent_type` (falling back to `agent_id`), and mine the optional
 *     confidence/escalation signals from `last_assistant_message` when present —
 *     no transcript parse required.
 *   - `SubagentStopHookSpecificOutput.additionalContext` would be delivered back
 *     to the SUBAGENT; telemetry must not perturb the run, so we emit nothing.
 *
 * FAIL-OPEN, ALWAYS: any error (unwritable dir, malformed input) is swallowed and
 * the hook returns `{}` — it must never throw into the turn. Timestamp is
 * injectable for deterministic tests.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { resolveAresHome } from '../config/aresConfig.js';

/** One appended telemetry row. Optional fields are omitted when absent (keeps the log lean). */
export type TraceEntry = {
  /** ISO-8601 instant the subagent stopped. */
  timestamp: string;
  /** Agent label — `agent_type`, else `agent_id`, else `unknown`. */
  agent: string;
  /** Self-reported confidence in [0,1], if the last message stated one. */
  confidence?: number;
  /** Count of escalation signals in the last message, if any (> 0). */
  escalations?: number;
  /** Working dir the subagent ran in. */
  cwd: string;
};

/** Signals mined from a subagent's final message: confidence + escalation count. */
export type AgentSignals = {
  confidence?: number;
  escalations?: number;
};

const CONFIDENCE_WORDS: Record<string, number> = {
  high: 0.9,
  medium: 0.6,
  moderate: 0.6,
  low: 0.3,
  none: 0.0,
};

/**
 * Mine confidence + escalation signals from a subagent's last message. Pure and
 * defensive — returns `{}` when nothing is found. Deliberately conservative: it
 * only reports a confidence when the agent explicitly labels one (a numeric
 * `confidence: 0.8` / `confidence 80%`, or a worded `confidence: high`), matching
 * how the prompt-evolution skill keys off self-reported confidence rather than
 * guessing it.
 */
export function parseAgentSignals(text: string | undefined): AgentSignals {
  const out: AgentSignals = {};
  if (!text) return out;

  // numeric: "confidence: 0.82", "confidence = .7", "confidence 80%"
  const num = /confidence\b\s*[:=]?\s*(\d{1,3}(?:\.\d+)?%|0?\.\d+|[01](?:\.0+)?)/i.exec(text);
  if (num) {
    const raw = num[1];
    let v: number;
    if (raw.endsWith('%')) v = parseFloat(raw) / 100;
    else v = parseFloat(raw);
    if (Number.isFinite(v)) out.confidence = Math.min(1, Math.max(0, v));
  } else {
    // worded: "confidence: high" / "high confidence"
    const worded =
      /confidence\b\s*[:=]?\s*(high|medium|moderate|low|none)\b/i.exec(text) ??
      /\b(high|medium|moderate|low|none)\s+confidence\b/i.exec(text);
    if (worded) out.confidence = CONFIDENCE_WORDS[worded[1].toLowerCase()];
  }

  // escalation signals — count distinct mentions of escalate/escalation/blocked/hand off
  const esc = text.match(/\b(escalat\w+|blocked|hand(?:ed)?[ -]?off|impasse)\b/gi);
  if (esc && esc.length > 0) out.escalations = esc.length;

  return out;
}

export type AgentTraceOptions = {
  /** Explicit trace directory (default `<aresHome>/agents`). Overridable for tests. */
  traceDir?: string;
  /** Injectable clock (default `() => new Date()`) for a deterministic timestamp. */
  now?: () => Date;
};

/** Resolve the trace-log path for an Ares home / explicit dir. */
export function traceLogPath(aresHome: string, traceDir?: string): string {
  return join(traceDir ?? join(aresHome, 'agents'), 'trace-log.jsonl');
}

/**
 * Append one {@link TraceEntry} as a JSONL line. Creates the parent dir if needed.
 * Never throws (fail-open) — telemetry loss must never break the run.
 */
export function appendTrace(entry: TraceEntry, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // swallow — telemetry is best-effort
  }
}

/**
 * Build the RSI Loop C `SubagentStop` telemetry hook. On every subagent stop it
 * appends a trace row and returns `{}` (no injection — never perturb the
 * subagent). Fail-open throughout.
 *
 * @param aresHome  Ares home (default {@link resolveAresHome}); trace goes to
 *                  `<aresHome>/agents/trace-log.jsonl`.
 * @param opts      `traceDir` override / injectable clock.
 */
export function agentTrace(
  aresHome: string = resolveAresHome(),
  opts: AgentTraceOptions = {},
): HookCallback {
  const now = opts.now ?? (() => new Date());
  const path = traceLogPath(aresHome, opts.traceDir);

  return async (input) => {
    try {
      const i = input as {
        agent_type?: string;
        agent_id?: string;
        cwd?: string;
        last_assistant_message?: string;
      };
      const signals = parseAgentSignals(i.last_assistant_message);
      const entry: TraceEntry = {
        timestamp: now().toISOString(),
        agent: i.agent_type || i.agent_id || 'unknown',
        cwd: i.cwd ?? process.cwd(),
        ...(signals.confidence !== undefined ? { confidence: signals.confidence } : {}),
        ...(signals.escalations !== undefined ? { escalations: signals.escalations } : {}),
      };
      appendTrace(entry, path);
    } catch {
      // never throw into the turn
    }
    return {};
  };
}
