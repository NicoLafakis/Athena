import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentTrace,
  appendTrace,
  parseAgentSignals,
  traceLogPath,
  type TraceEntry,
} from '../src/hooks/agentTrace.js';

const OPTS = { signal: new AbortController().signal };
const FIXED = () => new Date('2026-07-21T12:00:00.000Z');

/** Minimal SubagentStop hook input. */
function subagentStopInput(over: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'SubagentStop',
    session_id: 's1',
    stop_hook_active: false,
    agent_id: 'agent-123',
    agent_type: 'security-sentinel',
    agent_transcript_path: '/x.jsonl',
    cwd: 'C:\\code\\athena',
    ...over,
  } as never;
}

describe('parseAgentSignals — mines confidence + escalation from the last message', () => {
  it('numeric confidence (decimal)', () => {
    expect(parseAgentSignals('Done. confidence: 0.82').confidence).toBeCloseTo(0.82);
  });
  it('percentage confidence', () => {
    expect(parseAgentSignals('confidence 80%').confidence).toBeCloseTo(0.8);
  });
  it('worded confidence', () => {
    expect(parseAgentSignals('Overall confidence: high').confidence).toBeCloseTo(0.9);
    expect(parseAgentSignals('low confidence in this result').confidence).toBeCloseTo(0.3);
  });
  it('counts escalation signals', () => {
    expect(parseAgentSignals('I escalated this; it is blocked').escalations).toBe(2);
  });
  it('no signal -> empty', () => {
    expect(parseAgentSignals('all good')).toEqual({});
    expect(parseAgentSignals(undefined)).toEqual({});
  });
});

describe('traceLogPath / appendTrace', () => {
  it('resolves <aresHome>/agents/trace-log.jsonl by default', () => {
    expect(traceLogPath('/home/x/.claude').endsWith(join('agents', 'trace-log.jsonl'))).toBe(true);
  });
  it('appends a JSONL line, creating the parent dir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'athena-trace-'));
    try {
      const path = join(tmp, 'nested', 'trace-log.jsonl');
      const entry: TraceEntry = { timestamp: 'T', agent: 'a', cwd: 'c' };
      appendTrace(entry, path);
      appendTrace({ ...entry, agent: 'b' }, path);
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).agent).toBe('a');
      expect(JSON.parse(lines[1]).agent).toBe('b');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('agentTrace — SubagentStop telemetry hook (RSI Loop C)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'athena-agenttrace-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('appends a trace row with agent/cwd/timestamp + mined signals, returns {} (no injection)', async () => {
    const cb = agentTrace('/unused', { traceDir: tmp, now: FIXED });
    const out = await cb(
      subagentStopInput({ last_assistant_message: 'confidence: 0.4; I escalated to Ares' }),
      undefined,
      OPTS,
    );
    expect(out).toEqual({}); // never perturb the subagent

    const line = readFileSync(join(tmp, 'trace-log.jsonl'), 'utf8').trim();
    const entry = JSON.parse(line) as TraceEntry;
    expect(entry.agent).toBe('security-sentinel');
    expect(entry.cwd).toBe('C:\\code\\athena');
    expect(entry.timestamp).toBe('2026-07-21T12:00:00.000Z');
    expect(entry.confidence).toBeCloseTo(0.4);
    expect(entry.escalations).toBe(1);
  });

  it('falls back to agent_id, omits absent signals', async () => {
    const cb = agentTrace('/unused', { traceDir: tmp, now: FIXED });
    await cb(subagentStopInput({ agent_type: undefined, last_assistant_message: 'all done' }), undefined, OPTS);
    const entry = JSON.parse(readFileSync(join(tmp, 'trace-log.jsonl'), 'utf8').trim()) as TraceEntry;
    expect(entry.agent).toBe('agent-123');
    expect(entry.confidence).toBeUndefined();
    expect(entry.escalations).toBeUndefined();
  });

  it('fail-open: bad input never throws', async () => {
    const cb = agentTrace('/unused', { traceDir: tmp, now: FIXED });
    await expect(cb(null as never, undefined, OPTS)).resolves.toEqual({});
  });
});
