/**
 * Athena CLI — pure argument parsing + help/version text (ADR 0001, Phase 4a).
 *
 * Zero new dependencies: parsing is built on Node's own {@link parseArgs}
 * (`node:util`) — the build-don't-buy default. Everything here is PURE (no
 * process, no fs, no network, no model turn) so it is fully unit-testable
 * keyless: {@link parseCliArgs} maps argv → {@link CliArgs}, and
 * {@link helpText}/{@link versionText} render the branded strings.
 *
 * BRANDING invariant: user-facing identity is "Athena", never "claude". It is
 * fine to name the underlying provider/model (they are the transport, not the
 * tool identity).
 */

import { parseArgs } from 'node:util';
import { descriptors } from '../providers/descriptors.js';
import type { ProviderName } from '../providers/types.js';

/** The tool's user-facing name. NEVER "claude" (ADR 0001 branding acceptance). */
export const CLI_NAME = 'athena';

/** Runtime list of selectable provider names (derived from the descriptor registry). */
export const PROVIDER_NAMES = Object.keys(descriptors) as ProviderName[];

/** The default provider when `--provider` is omitted. */
export const DEFAULT_PROVIDER: ProviderName = 'anthropic';

/**
 * Thrown for any usage error (unknown flag, unknown provider, missing flag
 * value). The CLI entrypoint catches this, prints the message to stderr, and
 * exits with a non-zero usage code — it is never a stack-trace crash.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Parsed, validated CLI arguments. */
export type CliArgs = {
  /** Selected provider (validated ∈ {@link PROVIDER_NAMES}). Default `anthropic`. */
  provider: ProviderName;
  /** Optional model id override (validated later, by the provider layer). */
  model?: string;
  /** Ride the live Ares brain (points CLAUDE_CONFIG_DIR at the Ares home). */
  rideAres: boolean;
  /** Explicit Ares home override (else the resolver default). */
  aresHome?: string;
  /** Explicit working directory (else `process.cwd()`). */
  cwd?: string;
  /** Resolve + print the session config; make no model call. */
  dryRun: boolean;
  /** Print help and exit. */
  help: boolean;
  /** Print version and exit. */
  version: boolean;
  /**
   * The one-shot prompt (all positionals joined). Undefined => interactive REPL.
   */
  prompt?: string;
};

/**
 * Parse Athena CLI argv (the args AFTER `node script`, i.e. `process.argv.slice(2)`).
 *
 * Pure. Throws {@link CliUsageError} on an unknown flag, a missing flag value, or
 * an unknown `--provider`. A positional (or several) becomes the one-shot
 * `prompt`; none => `prompt` undefined (REPL).
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgvOrThrow(argv);

  const providerRaw = values.provider ?? DEFAULT_PROVIDER;
  if (!isProviderName(providerRaw)) {
    throw new CliUsageError(
      `unknown provider '${providerRaw}'. Valid providers: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }

  const prompt = positionals.length > 0 ? positionals.join(' ') : undefined;

  return {
    provider: providerRaw,
    model: values.model,
    rideAres: Boolean(values['ride-ares']),
    aresHome: values['ares-home'],
    cwd: values.cwd,
    dryRun: Boolean(values['dry-run']),
    help: Boolean(values.help),
    version: Boolean(values.version),
    prompt,
  };
}

/** The `parseArgs` option schema (single source of truth for flags + help text). */
const CLI_OPTIONS = {
  provider: { type: 'string' },
  model: { type: 'string' },
  'ride-ares': { type: 'boolean' },
  'ares-home': { type: 'string' },
  cwd: { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/**
 * Run node's {@link parseArgs} over the schema, re-wrapping its `TypeError`
 * (unknown flag / missing value) as a {@link CliUsageError}. Return type is
 * inferred from the schema so callers get the typed `values`/`positionals`.
 */
function parseArgvOrThrow(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, strict: true, options: CLI_OPTIONS });
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Runtime narrowing to {@link ProviderName}. */
export function isProviderName(name: string): name is ProviderName {
  return (PROVIDER_NAMES as string[]).includes(name);
}

/** `athena <version>` — the `--version` output. Branded Athena, never claude. */
export function versionText(version: string): string {
  return `${CLI_NAME} ${version}`;
}

/**
 * The banner printed at the top of the REPL / a live run. Identity-forward:
 * says "Athena", never "claude" (the tool identity invariant). The underlying
 * SDK/provider is transport detail, kept out of the identity line.
 */
export function bannerText(version: string): string {
  return `Athena v${version} — a multi-provider coding tool, riding the Ares brain`;
}

/** `--help` output. Pure; branded Athena. */
export function helpText(version: string): string {
  return [
    bannerText(version),
    '',
    `Usage: ${CLI_NAME} [options] [prompt]`,
    '',
    '  A prompt argument runs one-shot; with no prompt, Athena starts an',
    '  interactive REPL.',
    '',
    'Options:',
    `  --provider <name>   Model provider: ${PROVIDER_NAMES.join(' | ')} (default: ${DEFAULT_PROVIDER})`,
    '  --model <id>        Model id (default: the provider default)',
    '  --ride-ares         Ride the live Ares brain (loads its config home natively)',
    '  --ares-home <path>  Ares config home to ride (default: the OS Ares home)',
    '  --cwd <path>        Working directory for the session (default: current dir)',
    '  --dry-run           Resolve + print the session config; make no model call',
    '  -h, --help          Show this help and exit',
    '  -v, --version       Show the Athena version and exit',
    '',
    'Examples:',
    `  ${CLI_NAME} "explain this repo"`,
    `  ${CLI_NAME} --provider kimi --model kimi-k3 "write a test"`,
    `  ${CLI_NAME} --ride-ares --dry-run`,
  ].join('\n');
}
