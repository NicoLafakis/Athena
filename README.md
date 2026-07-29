# Athena

Athena is a standalone terminal coding-agent harness with an Anthropic-compatible
model loop, interactive Ink TUI, bounded headless execution, project trust,
permissions and sandbox policy, durable sessions and child agents, managed
extensions, immutable traces, and governed recursive learning.

The strict parity position and deliberate exclusions are documented in the
[implementation report](docs/athena-harness-parity-implementation-report-2026-07-24.md).

## Quickstart

```sh
pnpm install
pnpm build
npm link
cd path/to/your/project
athena
```

On first interactive run, Athena asks for a provider and API key. It supports
Anthropic, Kimi/Moonshot, and Kimi Code. Keys are validated, stored in the
platform credential vault when available, and otherwise kept in an owner-only
local credential file.

```sh
athena auth
athena auth status
athena doctor
```

## Interactive and headless use

```sh
athena                         # new interactive session
athena --continue              # latest session in this project
athena --resume                # pick a saved session
athena --accessibility screen-reader  # append-only line presentation for this invocation
athena exec "fix the tests"    # bounded non-interactive run
echo "review this repo" | athena exec --output json
athena exec "return JSON" \
  --output jsonl \
  --output-schema result.schema.json \
  --max-turns 20 \
  --max-tool-calls 80 \
  --max-tokens 200000 \
  --max-cost-usd 2 \
  --timeout-ms 600000
```

`athena exec` accepts text, JSON, or JSONL output; prompt arguments or stdin;
optional durable sessions/resume; output-schema validation; permission and
sandbox selection; and explicit model-call, tool-call, concurrency, token, cost,
and wall-clock limits. It uses stable exit codes and the same Engine as the TUI.

In-session commands include `/help`, `/status`, `/repeat`, `/details`, `/verbosity`,
`/clear`, `/resume`, `/compact`, `/model`, `/effort`, `/provider`, `/mode`, `/tui`,
`/memory`, `/skills`, `/agents`, and `/quit`. Esc cancels an active Ink turn; SIGINT
cancels an active screen-reader turn with an explicit acknowledgement.

The standard Ink TUI remains the default. Set global
`accessibility.presentation` to `screen-reader`, or use the invocation override above,
for serialized append-only input/output that preserves native terminal scrollback and
does not mount Ink.

## Optional Athena voice

Windows voice mode listens through the local `System.Speech` recognizer. An utterance is
ignored unless the locally recognized text begins with **Athena**, so ambient microphone
audio is not sent to OpenAI. The post-wake command goes to the OpenAI Realtime conductor,
which returns 24 kHz spoken audio. Coding work is proposed through `delegate`, requires a
separate `Athena confirm`, and then runs through Athena's existing engine and permission
policy. `Athena cancel` discards a pending delegation.

```sh
athena voice auth       # hidden key entry; validates and saves to the OS vault
athena voice probe      # speaks a sentinel, asks for “Athena voice probe”, checks Realtime
athena voice            # microphone input; say “Athena” followed by a command
athena voice --keyboard # stable text/Braille equivalent; type confirm/cancel/exit
```

The default is the lower-cost `gpt-realtime-2.1-mini`; select the quality model with
`--model gpt-realtime-2.1`. `OPENAI_API_KEY` is the zero-file alternative to
`athena voice auth`. No raw recordings or voiceprints are retained; per-response usage
objects are appended to `~/.athena/voice-usage.jsonl`. Ordinary `athena` and
`athena exec` dynamically avoid loading or probing the optional voice stack.

Full keyboard shortcuts for editing, popups, and transcript scrolling are listed in
[`.wiki/reference/tui-keybindings.md`](.wiki/reference/tui-keybindings.md).

## Project trust and sandboxing

Project `.athena` configuration is ignored until the canonical project path is
trusted. Project hook and MCP definitions require separate approvals bound to
their exact configuration digest, so an edit invalidates the old approval.

```sh
athena trust
athena trust --hooks
athena trust --mcp
athena trust --all
athena trust --revoke
```

Filesystem tools authorize real paths at use time and reject symlink escapes.
Web brokers reject local/private destinations and unsafe redirects and cap
responses while streaming. MCP subprocesses receive an allowlisted environment.

Sandbox modes are:

- `read-only`: workspace reads only; no writes.
- `workspace-write`: writes are limited to the workspace.
- `unrestricted`: explicit dangerous host access.

Shell calls in restricted modes additionally require an OS process sandbox:
bubblewrap on Linux or `sandbox-exec` on supported macOS hosts. Athena currently
has no native Windows process-sandbox adapter, so restricted Windows shell calls
fail closed. Select `unrestricted` explicitly only when host execution is intended.

## Sessions and agents

Sessions use collision-safe append-only event logs with locking and support list,
search, checkpoints, rewind, fork, rename, and recoverable delete:

```sh
athena session list
athena session checkpoints <id>
athena session rewind <id> <checkpoint>
athena session fork <id> [checkpoint]
athena session rename <id> <title>
athena session search <query>
athena session delete <id>
```

Child agents have durable run records, status events, budgets, cancellation,
follow-up/resume, and bounded concurrency. Agent frontmatter may set
`isolation: worktree`; mutating work then runs off-tree and merges only after the
generated patch passes Git's applicability and whitespace checks.

## Extensions

- Skills load progressively from `SKILL.md` and can read referenced support files.
- Hooks support command, HTTP, MCP-tool, prompt, and agent adapters across a
  versioned lifecycle contract.
- MCP supports stdio and Streamable HTTP servers, bounded tools/resources/prompts,
  static/bearer headers, and client-credentials OAuth.
- Managed plugins can contribute namespaced skills, agents, commands, hooks, MCP,
  and app metadata.

```sh
athena plugin install <directory-or-git-url> [--require-signature]
athena plugin list
athena plugin update <id>
athena plugin enable|disable <id>
athena plugin verify <id>
athena plugin remove <id>
```

Plugin manifests are versioned and dependency-checked. Installed content records
its source, digest, and optional Ed25519 signature status.

## Governed learning

Athena's learning plane does not grant an unrestricted self-edit mechanism.
Immutable traces can produce low-confidence typed candidates. Candidates are
evaluated in isolated baseline/candidate worktrees against protected held-out
cases and safety, cost, latency, and tool-use budgets. Code or policy promotion
requires human approval, a signed lineage, a measured canary, and rollback.

```sh
athena learn traces
athena learn reflect <run-id> [run-id...]
athena learn add <candidate.json>
athena learn candidates
athena learn evaluate <candidate-id> <suite.json>
athena learn promote <candidate-id> --approve
athena learn canary <candidate-id> <suite.json>
athena learn finalize <candidate-id> <canary-run-id>
athena learn rollback <candidate-id>
athena learn consolidate
athena learn lineage
```

The implementation is L4-capable, but L5 recursive-improvement status remains
unclaimed until repeated real tasks show a durable measured gain.

## Configuration and credentials

Global `~/.athena/settings.json` is overlaid by trusted project settings. Settings
select model, effort, permission/sandbox modes, allow/deny rules, hooks, MCP,
limits, and extension configuration.

Environment variables override stored provider keys:

- `ANTHROPIC_API_KEY`
- `MOONSHOT_API_KEY`
- `KIMI_CODE_API_KEY`

`athena doctor --json` reports installation, trust, credential-vault, provider,
dependency, process-sandbox, and update status without printing secrets. Athena
is currently a source-installed private package and has no silent self-updater;
updates are reviewed source revisions followed by locked install, verification,
and rebuild.

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

CI runs those gates on Node 20 and 22 across Linux, Windows, and macOS. The
protected deterministic suite lives at `evals/heldout/athena-parity-v1.json`;
the live canary is manual/weekly and skips paid calls unless its dedicated
repository secret is configured.
