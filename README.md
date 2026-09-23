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

## Vibe Monitor Plus cost reporting

Athena can report its own model usage to Vibe Monitor Plus (VMP). Usage is recorded at
the provider response boundary, stored locally in `~/.athena/vmp-ledger.jsonl`, and
exposed through a read-only authenticated report endpoint. No prompts, completions,
headers, or raw API keys are transmitted.

```sh
athena vmp status                                   # show connector state
athena vmp report                                   # print the current report JSON
athena vmp configure --url <report-url> --key-hash <sha256-hash>
athena vmp server                                   # serve GET /api/vmp/report
```

Configure the connector once in VMP Settings, copy the generated key, and paste its
SHA-256 hash into Athena with `athena vmp configure`. VMP pulls the report on its
schedule; `athena vmp server` must be running when a pull occurs. Provider
organization/admin keys are optional reconciliation tools and are not required.

## Optional Athena voice

Windows voice mode listens through the local `System.Speech` recognizer. An utterance is
ignored unless the locally recognized text begins with **Athena**, so ambient microphone
audio is not sent to OpenAI. Only the post-wake utterance goes to the OpenAI Realtime
session, which returns 24 kHz spoken audio.

You are talking to Athena, not to something standing in front of her. Realtime is a
bounded audio adapter: it understands what you said, hands it to one ordinary Athena
session as normal input, and speaks back that session's real result. It cannot run tools,
answer a question about your repository from its own knowledge, or decide whether a tool
is allowed. When Athena needs permission she asks out loud, and your spoken answer is
matched against the canonical request. A reply that arrives in the same turn as the
question, names an unknown or already-settled request, or is ambiguous is refused rather
than guessed at, and a spoken approval grants exactly one action. There is no spoken
equivalent of "allow always"; widening the session gate stays a keyboard decision.

```sh
athena voice            # microphone input; say “Athena” followed by a command
athena voice probe      # drives the real wake listener, then checks Realtime and playback
athena voice auth       # replace the saved per-machine OpenAI voice key
athena voice --keyboard # stable text/Braille equivalent; type answers, `exit` to leave
```

You do not need `athena voice auth` to start. If no key is saved, `athena voice` asks for
one inline and saves it to the OS vault, so a missing key never dead-ends into a second
command. `OPENAI_API_KEY` is the zero-file alternative.

`athena voice probe` is the command every wake failure names, so it drives the same
persistent listener that real sessions use: process spawn, readiness handshake, wake
gating, then Realtime understanding and Marin playback. A failure tells you which of those
stages broke.

The default is the lower-cost `gpt-realtime-2.1-mini`; select the quality model with
`--model gpt-realtime-2.1`. No raw recordings or voiceprints are retained. Lifecycle and
usage counters are appended to `~/.athena/voice-usage.jsonl`, and that file has no
free-text field by construction: every value is a fixed enum, a bounded number, or a
generated ID, so what you said cannot land there. Ordinary `athena` and `athena exec`
dynamically avoid loading or probing the optional voice stack.

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
select model, effort, permission/sandbox modes, allow/deny rules, additional
protected paths, hooks, MCP, limits, and extension configuration.
The optional global `timeZone` field accepts an IANA timezone (for example,
`"timeZone": "America/New_York"`) for conversational timeline queries; project settings
cannot override it.

Jev recall-intent routing is enabled in global settings by default following the product
decision. It makes no network call unless `TYPESAFE_API_KEY` is set. When configured,
TypeSafe receives only the current user request after Athena's shared secret redactor,
with a 12,000-character limit; it receives no prior conversation, memory text, source IDs,
or project paths. That redactor handles known credentials, not general personal
information. Set `"jev": {"enabled": false}` in the global settings file to disable
routing. The route adds a temporary instruction to avoid inventing missing cross-session
details; it does not retrieve or send historical context to the answer provider.

Athena's local conversation catalog can be inspected across projects:

```sh
athena memory status
athena memory rebuild
athena memory timeline last week
athena memory search "what did we decide" --project <project-id>
athena memory rank "what did we decide"
athena memory candidates
athena memory review <memory-id> <promote|reject>
athena memory show <episode-id>
athena memory rollup [day|week|month|quarter|year]
```

The catalog stores bounded, redacted summaries with links to local session lines. It does
not copy transcripts. A full archive index requires `athena memory rebuild`; new persisted
turns update their own session entries. The equivalent `/memory status`, `/memory rebuild`,
`/memory timeline`, `/memory search`, `/memory rank`, `/memory candidates`,
`/memory review <memory-id> <promote|reject>`, `/memory show`, and `/memory rollup [granularity]`
controls work in both interactive presentations. Show includes bounded same-session turns
around an episode with its source line IDs. Rollups are computed on demand from a
complete local catalog, using the configured IANA timezone (or a labeled OS-timezone
inference). Each rollup retains every covered episode ID and a digest of the current source
set. Output lists up to five episode IDs per rollup; use `athena memory show <episode-id>`
to inspect a listed source. Complete coverage stays in the linked index. Rollup summaries contain
only episode summaries, with no separate transcript copy or persisted cache. A correction or
source deletion is reflected after the session index is refreshed; an incomplete catalog
asks for a rebuild.
`memory rank` locally previews selected working, episodic, semantic, and rollup layers with
bounded IDs, scope, time, scores, and reason labels. `/memory rank` also considers text in
the active in-memory conversation. The preview does not show query/source text and does
not add historical excerpts to provider prompts. Jev's intent route is separate from
historical retrieval; automatic historical excerpts to the answer provider remain pending
explicit authorization.

The `Memory` tool can also save an explicitly requested durable fact as a semantic-memory
record tied to the current persisted user message. A clear user correction can supersede
that record while preserving the earlier statement and its source link. `memory candidates`
generates review-only records only when the same direct user preference, decision, or
promise appears in at least two distinct, source-digest-verified sessions. Candidate
generation is local and explicit; tentative, question, assistant-authored, stale, or
incomplete or credential-bearing evidence is skipped. Cross-project support broadens a
candidate to global scope; sensitive claims are not copied into inferred semantic
candidates. Review is an explicit local
`promote` or `reject` command; promotion verifies every source again at decision time, and
rejected/terminal decisions suppress recreation. Semantic records are not added to the
prompt-injected `MEMORY.md` index. Forget and source-session
deletion controls remain under implementation; automatic historical context in provider
prompts remains pending explicit authorization.

Independent of every mode above, a write fence covers operating-system directories
(`%SystemRoot%`, the Program Files trees, `%ProgramData%`, and the boot/recovery
roots; `/boot`, `/proc`, `/sys`, `/System` on POSIX). It refuses writes only —
reads there still work — and no permission mode, sandbox mode, allow rule, or
session grant opens it. `protectedPaths` adds directories to it and can never
remove one. Everywhere else, including every project root outside the current
one, stays fully writable. See
[`.wiki/architecture/permissions-trust.md`](.wiki/architecture/permissions-trust.md),
which also states plainly where the shell-command scan can be defeated.

Environment variables override stored provider keys:

- `ANTHROPIC_API_KEY`
- `MOONSHOT_API_KEY`
- `KIMI_CODE_API_KEY`

`TYPESAFE_API_KEY` is a separate environment-only credential for Jev; it is not an answer
model provider key and is not stored in `credentials.json`.

`athena doctor --json` reports installation, trust, credential-vault, provider,
dependency, process-sandbox, permission-posture, protected-paths, and update
status without printing secrets. Athena
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
