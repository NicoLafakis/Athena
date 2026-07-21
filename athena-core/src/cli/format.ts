/**
 * Athena CLI — pure dry-run config formatting (ADR 0001, Phase 4a).
 *
 * `--dry-run` resolves the session with {@link buildSession} and prints what a
 * live run WOULD use, making no model call. Fully keyless: the resolved provider
 * config (base_url, model, missing-key status) is available with no credential,
 * so this renders the same on the keyless authoring container and the keyed host.
 *
 * Pure: takes an already-built {@link AthenaSession} + {@link CliArgs} and returns
 * a string. No process, no fs, no network.
 */

import { CLAUDE_CONFIG_DIR_ENV } from '../config/aresConfig.js';
import type { AthenaSession } from '../config/loadConfig.js';
import type { CliArgs } from './args.js';

/** The fields a dry-run reports, extracted for direct testing. */
export type DryRunConfig = {
  provider: string;
  model: string;
  baseUrl: string;
  cwd: string;
  rideAres: boolean;
  aresHome?: string;
  /** The env var whose VALUE is missing to run live, or undefined if a key is present. */
  missingKeyEnvVar?: string;
};

/** Extract the reportable config from a built session + parsed args. Pure. */
export function dryRunConfig(session: AthenaSession, args: CliArgs): DryRunConfig {
  const { resolved, options } = session;
  return {
    provider: resolved.descriptor.name,
    model: resolved.model,
    baseUrl: resolved.sessionEnv.ANTHROPIC_BASE_URL ?? resolved.descriptor.baseUrl,
    cwd: typeof options.cwd === 'string' ? options.cwd : String(options.cwd ?? ''),
    rideAres: args.rideAres,
    // The resolved Ares config dir buildSession injected (env var / default /
    // --ares-home all funnel here), so the dry-run shows what a live run WOULD ride.
    aresHome: args.rideAres
      ? (options.env?.[CLAUDE_CONFIG_DIR_ENV] ?? args.aresHome)
      : undefined,
    missingKeyEnvVar: resolved.missingKeyEnvVar,
  };
}

/**
 * Render the dry-run config as human-readable text. Reports provider, model,
 * base_url, cwd, rideAres, and the missing-key status. Branded Athena.
 */
export function formatDryRun(session: AthenaSession, args: CliArgs): string {
  const c = dryRunConfig(session, args);
  const keyLine = c.missingKeyEnvVar
    ? `missing (set ${c.missingKeyEnvVar} to run live — see .env.example)`
    : 'present';

  const lines = [
    'Athena session (dry run — no model call):',
    `  provider:  ${c.provider}`,
    `  model:     ${c.model}`,
    `  base_url:  ${c.baseUrl}`,
    `  cwd:       ${c.cwd}`,
    `  ride-ares: ${c.rideAres}`,
  ];
  if (c.rideAres && c.aresHome) {
    lines.push(`  ares-home: ${c.aresHome}`);
  }
  lines.push(`  api key:   ${keyLine}`);
  return lines.join('\n');
}
