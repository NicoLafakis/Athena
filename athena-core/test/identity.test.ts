import { describe, expect, it } from 'vitest';
import { PROMPT_HEADER } from '../src/rsi/reflect.js';
import { ATHENA_IDENTITY, buildAthenaOptions } from '../src/config/loadConfig.js';

describe('Athena identity & branding lockdown (task #7)', () => {
  it('the session systemPrompt appends the Athena identity override', () => {
    const sp = buildAthenaOptions().systemPrompt;
    expect(sp && typeof sp === 'object' && !Array.isArray(sp)).toBe(true);
    const append = (sp as { append?: string }).append ?? '';
    expect(append).toBe(ATHENA_IDENTITY);
    expect(append).toMatch(/Athena/);
    expect(append).toMatch(/never refer to yourself as Claude/i);
  });

  it('ATHENA_IDENTITY disowns the Claude Code / Codex identity', () => {
    expect(ATHENA_IDENTITY).toMatch(/not Claude Code/i);
    expect(ATHENA_IDENTITY).toMatch(/not Codex/i);
  });

  it('the reflection prompt identifies as Athena, not a "Claude Code agent"', () => {
    expect(PROMPT_HEADER).not.toMatch(/Claude Code/);
    expect(PROMPT_HEADER).toMatch(/Athena/);
  });
});
