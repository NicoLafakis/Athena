#!/usr/bin/env node
/**
 * Athena terminal CLI (ADR 0001, Phase 4a — surfaces).
 *
 * The `athena` bin. Wires the pure arg parser ({@link parseCliArgs}) + dry-run
 * formatter ({@link formatDryRun}) to a real session ({@link buildSession}) and,
 * for a live turn, the SDK {@link query}. Keyless-safe by construction:
 *
 *   - `--dry-run` resolves + prints the config with NO model call (works with no
 *     credential — the whole point of the keyless authoring container).
 *   - A live turn needs a key. If the provider's secret env var is absent,
 *     Athena prints a clear "set <VAR> to run live" message and exits non-zero
 *     instead of crashing on a keyless launch.
 *
 * BRANDING: `--help`, `--version`, and the banner say "Athena", never "claude".
 * The underlying provider/model names are transport detail and may be shown.
 *
 * Side-effecting glue lives here; the pure, unit-tested pieces are in
 * `args.ts` / `format.ts`. {@link runCli} takes injectable deps (log/err/env/
 * version/runTurn/interactive) and RETURNS an exit code — it never calls
 * `process.exit`, so it is testable keyless.
 */

import { readFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { buildSession, type AthenaSession } from '../config/loadConfig.js';
import {
  CLI_NAME,
  CliUsageError,
  bannerText,
  helpText,
  parseCliArgs,
  versionText,
  type CliArgs,
} from './args.js';
import { formatDryRun } from './format.js';

/** Read the package version from package.json (works compiled and from source). */
export function packageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** A single live turn: prompt + SDK options in, the assistant's final text out. */
export type RunTurn = (prompt: string, options: Options) => Promise<string>;

/**
 * Default live turn: one headless SDK `query()`, reading the final assistant
 * text from the `result` message (the contract verified against sdk.d.ts in the
 * RSI Loop A work). Requires a credential — only reached after the missing-key
 * gate in {@link runCli} passes.
 */
export const sdkRunTurn: RunTurn = async (prompt, options) => {
  let text = '';
  for await (const msg of query({ prompt, options })) {
    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        if (msg.result) text = msg.result;
      } else {
        text = text || `[Athena: run ended without a reply: ${msg.subtype}]`;
      }
    }
  }
  return text;
};

/** Injectable dependencies for {@link runCli} (all default to real I/O). */
export type CliDeps = {
  log?: (s: string) => void;
  errLog?: (s: string) => void;
  /** Env to resolve secrets + build the session from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Version string (default: read from package.json). */
  version?: string;
  /** Live-turn runner (default {@link sdkRunTurn}). Injected in tests. */
  runTurn?: RunTurn;
  /** Interactive REPL driver (default {@link defaultRepl}). Injected in tests. */
  interactive?: (ctx: ReplContext) => Promise<number>;
};

/** Context handed to the REPL driver. */
export type ReplContext = {
  session: AthenaSession;
  args: CliArgs;
  version: string;
  log: (s: string) => void;
  errLog: (s: string) => void;
  runTurn: RunTurn;
};

/**
 * Run the Athena CLI once. Returns a process exit code (never calls
 * `process.exit`): 0 ok / help / version / dry-run, 1 build or run failure or a
 * keyless live launch, 2 usage error (bad flag / unknown provider).
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const errLog = deps.errLog ?? ((s: string) => console.error(s));
  const env = deps.env ?? process.env;
  const version = deps.version ?? packageVersion();
  const runTurn = deps.runTurn ?? sdkRunTurn;

  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      errLog(err.message);
      errLog(`Run '${CLI_NAME} --help' for usage.`);
      return 2;
    }
    throw err;
  }

  if (args.help) {
    log(helpText(version));
    return 0;
  }
  if (args.version) {
    log(versionText(version));
    return 0;
  }

  let session: AthenaSession;
  try {
    session = buildSession({
      provider: args.provider,
      model: args.model,
      rideAres: args.rideAres,
      aresHome: args.aresHome,
      cwd: args.cwd,
      env,
    });
  } catch (err) {
    // e.g. an unknown model id for the provider (UnknownModelError).
    errLog(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (args.dryRun) {
    log(formatDryRun(session, args));
    return 0;
  }

  // A live turn needs a credential. Degrade gracefully when keyless.
  if (session.resolved.missingKeyEnvVar) {
    errLog(
      `No API key for provider '${args.provider}'. ` +
        `Set ${session.resolved.missingKeyEnvVar} to run live (see .env.example).`,
    );
    errLog(`Tip: '${CLI_NAME} --dry-run' resolves the config with no key.`);
    return 1;
  }

  // One-shot: a positional prompt runs a single turn and exits.
  if (args.prompt !== undefined) {
    try {
      const text = await runTurn(args.prompt, session.options);
      if (text) log(text);
      return 0;
    } catch (err) {
      errLog(`Athena run failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // No prompt: interactive REPL.
  const interactive = deps.interactive ?? defaultRepl;
  return interactive({ session, args, version, log, errLog, runTurn });
}

/**
 * Default interactive REPL over stdin/stdout (impure; deferred to the keyed host
 * for a real turn). Reads a prompt per line, runs one turn, prints the reply.
 * `/exit`, `/quit`, or EOF (Ctrl-D) ends the loop.
 */
async function defaultRepl(ctx: ReplContext): Promise<number> {
  const { session, version, log, errLog, runTurn } = ctx;
  log(bannerText(version));
  log("Type a prompt and press Enter. '/exit' or Ctrl-D to quit.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'athena> ',
  });
  rl.prompt();

  for await (const line of rl) {
    const prompt = line.trim();
    if (prompt === '/exit' || prompt === '/quit') break;
    if (prompt) {
      try {
        const text = await runTurn(prompt, session.options);
        if (text) log(text);
      } catch (err) {
        errLog(`Athena run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    rl.prompt();
  }
  rl.close();
  return 0;
}

/**
 * Direct-execution guard: when launched as `athena` / `node dist/cli/index.js`,
 * run the CLI with the real argv and set the exit code. When imported (tests),
 * nothing runs. Mirrors the `reflectCli.ts` house pattern.
 */
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /[\\/]cli[\\/]index\.(js|mjs|ts)$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`athena failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
