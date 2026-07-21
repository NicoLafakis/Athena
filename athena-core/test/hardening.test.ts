import { describe, expect, it } from 'vitest';
import { REFLECT_DISALLOWED_TOOLS, reflectQueryOptions } from '../src/rsi/reflect.js';
import { buildAresProgrammaticHooks } from '../src/config/loadConfig.js';

describe('reflection sub-call is hard-blocked from tools (Phase 3 safety)', () => {
  it('reflectQueryOptions disallows the mutating/exec tools and isolates settings', () => {
    const o = reflectQueryOptions();
    expect(o.settingSources).toEqual([]);
    expect(o.disallowedTools).toEqual(REFLECT_DISALLOWED_TOOLS);
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      expect(o.disallowedTools).toContain(t);
    }
    expect(o.maxTurns).toBe(1);
  });

  it('passes the model through when provided', () => {
    expect(reflectQueryOptions({ model: 'sonnet' }).model).toBe('sonnet');
  });
});

describe('Loop C agentTrace is wired into SubagentStop', () => {
  it('buildAresProgrammaticHooks({trace:true}) registers exactly one SubagentStop hook', () => {
    const hooks = buildAresProgrammaticHooks({ trace: true }, '/tmp/ares');
    expect(hooks.SubagentStop).toBeTruthy();
    expect(hooks.SubagentStop?.length).toBe(1);
  });

  it('registers no SubagentStop hook when the trace flag is off', () => {
    const hooks = buildAresProgrammaticHooks({ memory: true }, '/tmp/ares');
    expect(hooks.SubagentStop).toBeUndefined();
  });
});
