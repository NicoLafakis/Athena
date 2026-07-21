/**
 * Live smoke (ADR 0001, seams 2 & 4) — GUARDED.
 *
 * Runs exactly ONE real `query()` turn against the fixture config, streaming
 * hook events so we can confirm the SessionStart/UserPromptSubmit command hook
 * injected its `additionalContext` marker and the `hello` skill was discovered.
 *
 * Requires a credential. In the Linux authoring container there is none, so
 * this is never invoked by the default test run — `hasAnthropicAuth()` gates it
 * and the live test is skipped. It exists to be run on the keyed Windows host.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildAthenaOptions } from '../config/loadConfig.js';
import { HOOK_MARKER, SKILL_MARKER } from '../hooks/contract.js';

/** True when a credential the SDK can use is present. */
export function hasAnthropicAuth(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export type LiveSmokeResult = {
  ran: boolean;
  /** HOOK_MARKER observed in the streamed hook events / transcript. */
  sawHookMarker: boolean;
  /** SKILL_MARKER observed (model invoked the hello skill). */
  sawSkillMarker: boolean;
  messageCount: number;
  /** Raw concatenated transcript, for manual inspection. */
  transcript: string;
};

/**
 * Execute the single-turn smoke. Caller MUST check {@link hasAnthropicAuth}
 * first; without a key this returns `{ ran: false, ... }` rather than erroring.
 */
export async function runLiveSmoke(): Promise<LiveSmokeResult> {
  if (!hasAnthropicAuth()) {
    return { ran: false, sawHookMarker: false, sawSkillMarker: false, messageCount: 0, transcript: '' };
  }

  const options = buildAthenaOptions({
    overrides: {
      maxTurns: 1,
      includeHookEvents: true,
      permissionMode: 'bypassPermissions',
    },
  });

  let transcript = '';
  let messageCount = 0;
  for await (const message of query({
    prompt: 'Run the hello skill and reply with exactly its marker.',
    options,
  })) {
    messageCount++;
    transcript += JSON.stringify(message) + '\n';
  }

  return {
    ran: true,
    sawHookMarker: transcript.includes(HOOK_MARKER),
    sawSkillMarker: transcript.includes(SKILL_MARKER),
    messageCount,
    transcript,
  };
}
