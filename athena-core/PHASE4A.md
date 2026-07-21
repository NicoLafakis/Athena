# Athena — Phase 4a report: the terminal CLI surface

Wires the first **surface** onto the shared core (ADR 0001, Phase 4): the
`athena` terminal CLI. One `buildSession(...)` → SDK `query()` path, driven by a
zero-dependency arg parser, with a keyless `--dry-run` and a graceful
missing-key degrade so the whole surface is exercisable in the keyless authoring
container. Also lands the **required core fix** the CLI depends on: a
`rideAres` session no longer runs *inside* the Ares config dir. Everything lives
under `athena-core/`; nothing outside it was modified. Do-not-commit build.

## TL;DR

- **Builds clean, typechecks clean, 180 unit tests pass** (1 live smoke still
  skipped — no key). Phase 0/1/2/3's 151 tests stay green; **29 new** (CLI 25,
  buildSession +2, buildSessionAres +2).
- **CORE FIX (deliverable 1):** `buildSession` now takes `cwd?` defaulting to
  `process.cwd()` (the user's project). `rideAres` drives **only**
  `CLAUDE_CONFIG_DIR` + the `'user'` settingSource — it no longer sets `cwd` to
  the Ares home. A real session runs in the project you launched Athena from, with
  the Ares brain merged in as config. `buildAthenaOptions` is untouched
  (`cwd = FIXTURE_PROJECT_DIR`), so the Phase 0 fixture proofs stay green.
- **CLI (deliverable 2):** `athena` bin, built on Node's own `util.parseArgs`
  (zero new deps — build-don't-buy). A positional prompt runs one-shot; no prompt
  starts an interactive REPL. `--dry-run` resolves + prints the session config
  with **no model call**.
- **Keyless-safe by construction:** a live turn needs a credential; when the
  provider's secret env var is absent Athena prints `set <VAR> to run live (see
  .env.example)` and exits non-zero — it never crashes on a keyless launch.
  `--dry-run` is fully keyless.
- **Branding invariant enforced + unit-tested:** `--help`, `--version`, and the
  banner say **Athena**, never "claude" (asserted with a `not.toContain('claude')`
  check on the user-facing text). Provider/model names (anthropic, kimi,
  `claude-sonnet-5`, …) still appear where selected — that's transport detail, and
  the ADR permits it.
- **SDK APIs verified against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  (v0.3.216), not memory:** `query({prompt,options})` returns an
  `AsyncGenerator<SDKMessage>`; the final assistant text is read from the
  `type:'result', subtype:'success'` message's `.result` field (same contract the
  RSI Loop A `sdkModelCall` uses). The default live turn follows exactly that.

## Deliverable 1 — the `buildSession` cwd fix

**Before:** `rideAres` did `cwd = aresHome`, so a real ride-Ares session executed
inside `~/.claude` — reads/writes/tools would have been rooted in the config dir,
not the user's repo.

**After** (`src/config/loadConfig.ts`):

- `BuildSessionArgs` gains `cwd?: string`; `buildSession` computes
  `const cwd = cwdArg ?? process.cwd()`.
- The `rideAres` branch now sets **only** `sessionEnv[CLAUDE_CONFIG_DIR] = aresHome`
  and adds `'user'` to `settingSources`. It does **not** touch `cwd`.
- `buildAthenaOptions` (Phase 0) is unchanged and still uses the fixture project
  dir, so `config.test.ts` (`opts.cwd === FIXTURE_PROJECT_DIR`) stays green.

Tests updated/added: the old `buildSessionAres` assertion `cwd === aresHome` is
replaced by two — `rideAres` cwd is `process.cwd()` (NOT the Ares home) and an
injected `cwd` is honored while the config dir still points at the Ares home.
`buildSession.test.ts` gains the same default/injected-cwd coverage.

## Deliverable 2 — the `athena` CLI

### Flag reference

```
athena [options] [prompt]

  A prompt argument runs one-shot; no prompt starts an interactive REPL.

  --provider <name>   anthropic | kimi | minimax | openai   (default: anthropic)
  --model <id>        model id                               (default: provider default)
  --ride-ares         ride the live Ares brain (loads its config home natively)
  --ares-home <path>  Ares config home to ride               (default: the OS Ares home)
  --cwd <path>        working directory for the session      (default: current dir)
  --dry-run           resolve + print the session config; make no model call
  -h, --help          show help and exit
  -v, --version       show the Athena version and exit
```

### Behavior

| Invocation | Result |
|---|---|
| `athena --version` | `athena <version>` (from `package.json`), exit 0 |
| `athena --help` | branded help, exit 0 |
| `athena --dry-run` | prints provider / model / base_url / cwd / ride-ares / missing-key status, **no model call**, exit 0 |
| `athena "prompt"` (keyed) | one SDK `query()` turn, prints the reply, exit 0 |
| `athena "prompt"` (keyless) | `set <VAR> to run live (see .env.example)` to stderr, exit 1 |
| `athena` (keyed, no prompt) | interactive REPL (`/exit`, `/quit`, or Ctrl-D to quit) |
| `athena --provider bogus` | usage error listing valid providers, exit 2 |
| unknown flag | usage error (wrapped `parseArgs` message), exit 2 |
| unknown model for provider | `UnknownModelError` message, exit 1 |

Exit codes: **0** ok/help/version/dry-run · **1** build/run failure or keyless
live launch · **2** usage error (bad flag / unknown provider).

### Design

- **Pure, unit-tested pieces** (`src/cli/args.ts`, `src/cli/format.ts`):
  `parseCliArgs` (argv → `CliArgs`), `helpText`/`versionText`/`bannerText`,
  `dryRunConfig`/`formatDryRun`. No process, fs, network, or model turn — 25
  keyless tests.
- **Side-effecting glue** (`src/cli/index.ts`): `runCli(argv, deps)` returns an
  exit code and never calls `process.exit`, with injectable
  `log`/`errLog`/`env`/`version`/`runTurn`/`interactive` deps — so the one-shot
  and degrade paths are unit-tested with a mock `runTurn` and no key. The default
  live turn (`sdkRunTurn`) is the real SDK `query()`; the REPL uses `node:readline`.
- **The bin** (`package.json` `"bin": {"athena": "./dist/cli/index.js"}`) has a
  `#!/usr/bin/env node` shebang, preserved through `tsc`. A direct-execution
  guard runs `runCli(process.argv.slice(2))` only when launched (not when
  imported), mirroring the `reflectCli.ts` house pattern.

## Deliverable 3 — public API

`src/index.ts` already exported `buildSession`, `AthenaSession`,
`resolveProvider`, provider types, and the RSI entrypoints. Phase 4a adds the CLI
surface so a VS Code extension (Phase 4b) can reuse the exact pieces the bin uses:
`parseCliArgs`, `CliArgs`, `CliUsageError`, `PROVIDER_NAMES`, `DEFAULT_PROVIDER`,
`isProviderName`, `helpText`/`versionText`/`bannerText`, `dryRunConfig`/
`formatDryRun`/`DryRunConfig`, and `runCli`/`sdkRunTurn`/`packageVersion` +
`RunTurn`/`CliDeps`/`ReplContext` types.

## What is proven KEYLESS (in this container)

- `parseCliArgs` over every flag + defaults + positional-prompt joining; unknown
  provider and unknown flag both raise a clean `CliUsageError`.
- `--help`/`--version`/banner render the Athena identity and contain no "claude"
  substring (branding assertion).
- `--dry-run` resolves the real provider config (base_url, model, missing-key
  var) for anthropic and kimi, reports a present key as `present`, and surfaces
  the resolved `ares-home` under `--ride-ares` — all with no credential.
- `runCli` exit codes: version/help/dry-run → 0; keyless one-shot → 1 with the
  `set <VAR>` message and **no** `runTurn` call; unknown provider → 2; a
  key-present one-shot runs the injected turn and prints its reply → 0; a throwing
  turn is caught → 1.
- The **compiled bin** runs end-to-end keyless:
  `node dist/cli/index.js --dry-run`, `--provider kimi --dry-run`,
  `--ride-ares --dry-run`, a keyless one-shot (degrade, exit 1), and the error
  paths above.

## Deferred Windows/keyed live checklist

Run on the Windows host with the live Ares `~/.claude` and a real model key.

| Proof | Needs |
|---|---|
| A real one-shot: `athena "…"` runs one live `query()` turn and prints the model's reply | Windows/keyed host |
| A real interactive REPL turn: launch `athena` with no prompt, type a prompt, get a streamed reply, `/exit` cleanly | Windows/keyed host |
| Live provider switch: same prompt under `--provider anthropic` vs `--provider kimi` (and `minimax`) each hits the right endpoint and returns | keys for each provider |
| `--ride-ares` against the real `~/.claude`: session runs in the **project cwd** while the Ares `settings.json` (14 `py` hooks, permissions, model) merges in natively; confirm the fix — the turn does NOT execute inside the config dir | Windows host + live Ares + key |
| OpenAI via the pinned LiteLLM sidecar: `--provider openai --dry-run` points at the sidecar; a live turn round-trips once the sidecar is running | Windows host + `OPENAI_API_KEY` + sidecar (Phase 1) |
| `npm link` / global install exposes `athena` on PATH with the executable bit set (npm sets it from the `bin` field on install) | Windows host |
| Self-identity: a live turn self-identifies as Athena/Ares, never Claude (ties to the Phase 0 identity task #7) | Windows/keyed host |

## How to run

```bash
cd athena-core
npm install
npm run typecheck   # tsc --noEmit, exit 0
npm run build       # -> dist/ (emits dist/cli/index.js with the shebang)
npm test            # vitest: 180 passed, 1 skipped (live)
# keyless end-to-end smoke of the compiled CLI:
node dist/cli/index.js --version
node dist/cli/index.js --dry-run
node dist/cli/index.js --provider kimi --model kimi-k3 --dry-run
node dist/cli/index.js --ride-ares --dry-run     # cwd stays the project; config dir = Ares home
node dist/cli/index.js "hello"                    # keyless: prints the set-<VAR> notice, exit 1
```

## Layout (Phase 4a additions in **bold**)

```
athena-core/
  package.json    **bin: { athena: ./dist/cli/index.js }**
  src/cli/        **args.ts**    (pure: parseCliArgs + help/version/banner text)
                  **format.ts**  (pure: dryRunConfig + formatDryRun)
                  **index.ts**   (bin entry: runCli, sdkRunTurn, REPL, exec guard)
  src/config/     loadConfig.ts  (CORE FIX: buildSession cwd = process.cwd(); rideAres
                                  drives only CLAUDE_CONFIG_DIR + the 'user' source)
  src/index.ts    (+ CLI public surface re-exports for the future VS Code extension)
  test/           **cli.test.ts** (25) · buildSession (+2) · buildSessionAres (+2)
```
