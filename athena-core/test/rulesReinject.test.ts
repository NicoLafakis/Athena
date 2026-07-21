import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATHENA_CORE_ROOT } from '../src/config/loadConfig.js';
import {
  ARES_IDENTITY,
  ARES_RULES,
  readIdentityCommission,
  rulesReinject,
} from '../src/hooks/rulesReinject.js';

const FIXTURE_ARES_HOME = join(ATHENA_CORE_ROOT, 'fixtures', 'ares-home');
const FIXTURE_CWD = 'proj-fixture';
const OPTS = { signal: new AbortController().signal };

function promptInput(prompt: string, cwd = FIXTURE_CWD) {
  return { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt, cwd } as never;
}

describe('rulesReinject — UserPromptSubmit identity + rules commission', () => {
  it('injects the inline identity + operating rules by default', async () => {
    const cb = rulesReinject(FIXTURE_ARES_HOME);
    const out = (await cb(promptInput('Refactor the provider layer and add tests'), undefined, OPTS)) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('YOU ARE ARES');
    expect(ctx).toContain('never call yourself Claude');
    expect(ctx).toContain('OPERATING RULES');
    expect(ctx).toBe(ARES_IDENTITY + ARES_RULES);
  });

  it('skips trivial short prompts (< 12 chars)', async () => {
    const cb = rulesReinject(FIXTURE_ARES_HOME);
    expect(await cb(promptInput('ok'), undefined, OPTS)).toEqual({});
    expect(await cb(promptInput('go now'), undefined, OPTS)).toEqual({});
  });

  it('preferLiveIdentity sources the identity from user_ares_identity.md ("files win")', async () => {
    const cb = rulesReinject(FIXTURE_ARES_HOME, { preferLiveIdentity: true });
    const out = (await cb(promptInput('Build the memory injector for seam 3'), undefined, OPTS)) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    // The live fixture description leads (contains an em-dash + "continuity"),
    // distinct from the inline ASCII commission.
    expect(ctx).toContain("You are Ares (she/her), Nico's digital intelligence");
    expect(ctx).toContain('OPERATING RULES');
  });

  it('preferLiveIdentity falls back to inline when no identity file exists', async () => {
    const cb = rulesReinject(FIXTURE_ARES_HOME, { preferLiveIdentity: true });
    const out = (await cb(promptInput('A real prompt here', 'project-with-no-memory'), undefined, OPTS)) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(out.hookSpecificOutput?.additionalContext).toBe(ARES_IDENTITY + ARES_RULES);
  });
});

describe('readIdentityCommission', () => {
  it('extracts the frontmatter description of the live identity memory', () => {
    const desc = readIdentityCommission(FIXTURE_ARES_HOME, FIXTURE_CWD);
    expect(desc).toContain('You are Ares (she/her)');
  });
  it('returns undefined when absent (never throws)', () => {
    expect(readIdentityCommission(FIXTURE_ARES_HOME, 'no-project')).toBeUndefined();
  });
});
