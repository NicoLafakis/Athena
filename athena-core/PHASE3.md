# Athena — Phase 3 report: RSI Loops A + C

Wires the last two recursive-self-improvement loops onto the Claude Agent SDK
engine (ADR 0001, Phase 3): **Seam 1** (transcript adapter), **Seam 4** (RSI
Loop A — scheduled cross-project reflection via an injectable headless sub-call),
and **RSI Loop C** (prompt-evolution telemetry via a `SubagentStop` hook), plus
the reflect entrypoint the Windows scheduler invokes. Everything lives under
`athena-core/`; nothing outside it was modified. **Keyless throughout** — no model
turns, no `py`-hook execution, no live Ares `~/.claude` (that tree isn't in this
Linux container). The live model reflection and the real Task Scheduler job are
deferred to the Windows/keyed checklist below.

## TL;DR

- **Builds clean, typechecks clean, 144 unit tests pass** (1 live smoke still
  skipped — no key). Phase 0/1/2's 108 tests stay green; **36 new tests** added
  (sessions 11, reflect 10, reflectCli 5, agentTrace 10).
- **STEP 0 verified against the installed `sdk.d.ts` (v0.3.216), not memory:** the
  `SubagentStop` I/O shape, the `query({maxTurns:1})` single-turn contract and how
  to read its final text, and the transcript JSONL event shape. Findings below.
- **RSI Loop A is PROPOSE-ONLY by construction** — the model call is a pure
  function (digest in → text out) and the SCRIPT, not the model, writes the
  reflection to disk. The reflection's `## Proposed promotions` section is never
  auto-applied to memory. This is the anti-self-corruption guarantee, kept
  explicit in code + the written file's header.
- The compiled CLI runs end-to-end keyless: `node dist/rsi/reflectCli.js
  --harvest-only --root fixtures/rsi-home` harvests the fixture sessions and prints
  the grouped digest (files + commits parsed) with exit 0.

## STEP 0 (verified against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`)

Method: read the installed type bundle directly (grep + read of the exact
declarations). No answers from memory. Line references are into that `.d.ts`.

### (a) `SubagentStop` hook I/O shape (Loop C telemetry)

`SubagentStopHookInput = BaseHookInput & { ... }` (sdk.d.ts:6747) carries:

| Field | Source | Used for |
|---|---|---|
| `agent_type` | subagent type name (e.g. `security-sentinel`) | the trace row's `agent` label |
| `agent_id` | subagent id | fallback label |
| `agent_transcript_path` | the subagent's own transcript | (available; not needed — see below) |
| `cwd`, `session_id`, `transcript_path` | `BaseHookInput` (sdk.d.ts:164) | `cwd` in the row |
| `stop_hook_active` | loop guard | (n/a for append-only telemetry) |
| `last_assistant_message?` | "Text content of the last assistant message before stopping. **Avoids the need to read and parse the transcript file.**" | mine confidence/escalation signals cheaply |

Output: `SubagentStopHookSpecificOutput.additionalContext` (sdk.d.ts:6772) is
documented as "non-error feedback delivered **to the subagent**; the subagent
continues so it can act on it." Telemetry must not perturb the run, so the hook
**returns `{}`** (no injection) and only writes to disk. The programmatic
`HookCallback` signature is `(input, toolUseID, {signal}) => Promise<HookJSONOutput>`
(same as the Phase 2 ports).

Consequence: we read the confidence/escalation signals from `last_assistant_message`
directly — the SDK explicitly provides it to avoid a transcript parse.

### (b) `query({prompt, options:{maxTurns:1}})` — the `claude -p` replacement

`query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`
(sdk.d.ts:2560), and `Query extends AsyncGenerator<SDKMessage, void>` (sdk.d.ts:2252).
`Options.maxTurns?: number` (sdk.d.ts:1651) — "Maximum number of conversation turns
before the query stops." So a headless single-turn text call is:

```ts
const q = query({ prompt, options: { maxTurns: 1, settingSources: [] } });
let text: string | null = null;
for await (const msg of q) {
  if (msg.type === 'result' && msg.subtype === 'success') text = msg.result;
}
```

**Reading the final text:** iterate to the terminal `type:'result'` message.
`SDKResultSuccess` (sdk.d.ts:4252) has `subtype:'success'` and **`result: string`**
(the final assistant text). `SDKResultError` (sdk.d.ts:4230) has `subtype` in
`error_max_turns | error_during_execution | ...` and **no `result`** field — so
gating on `subtype === 'success'` is the correct, type-safe read. This is exactly
what `sdkModelCall` in `reflect.ts` does. `settingSources: []` keeps the sub-call
clean (it must not re-load the Ares hooks, or the reflection call would itself fire
journal-capture / the reflection nudge) — a deliberate improvement over the bare
`claude -p` shell-out, which had no such isolation.

### (c) transcript JSONL event shape (Seam 1)

Confirmed against the SDK message types and the existing fixtures. Each line is one
event; the fields the adapter relies on:

- `type: 'user' | 'assistant'` — the discriminant (`SDKUserMessage` /
  `SDKAssistantMessage`, sdk.d.ts:2825). The first `user` event whose text does not
  start with `<` is the session **intent**.
- `message.content[]` — a block array. `assistant` blocks include
  `{ type:'tool_use', name, input }`; edit tools (`Write|Edit|MultiEdit|NotebookEdit`)
  carry `input.file_path` (or `input.notebook_path`); `Bash` carries `input.command`.
- top-level `cwd` on events — the working dir (mirrors what `BaseHookInput.cwd`
  and the CLI writes into the log); the first one seen fixes the project label.
- `message.usage` — present on assistant events for cost accounting; not needed by
  the Phase-3 loops, noted for completeness (the Phase-2 `reflectionNudge`
  tool-call counter and this adapter both key off `tool_use` blocks, not `usage`).

This matches `journal_capture._scan_transcript` exactly, which is what the port
targets.

## Deliverable 1 — Seam 1 transcript adapter (`src/rsi/sessions.ts`)

A `getSessions()` / `readSessionSnapshot()` layer over the
`~/.claude/projects/<slug>/*.jsonl` format, so the RSI loops depend on a stable
shape, not the raw log. Ports `journal_capture._scan_transcript` intent.

- **`readSessionSnapshot(path, opts)`** — streams one transcript (readline; never
  loads it whole) into `{ sessionId, project, date, intent, toolCalls, files,
  commits, lastActive, cwd }`. `intent` = first real user message (capped
  `INTENT_MAX=140`); `files` = deduped edit-tool inputs (cap `MAX_FILES=60`);
  `commits` = `git commit -m` messages parsed with the ported `_COMMIT_RE`, first
  line only, dropping `$()`/heredoc/backtick noise (cap `MAX_COMMITS=40`). Scale
  guard ported: above `TRANSCRIPT_MAX_BYTES=25MB` the scan stays shallow (counts
  tool calls, skips file/commit extraction). Never throws.
- **`getSessions(opts)`** — enumerates `<root>/projects/<slug>/*.jsonl`, filters by
  the `days` window (transcript mtime vs an **injectable `now`**), drops trivial
  sessions (no intent AND 0 tool calls), applies `exclude` substrings, returns
  most-recent-first capped at `maxSessions`. Root is injectable (default
  `resolveAresHome()`); slug/path handling reuses the Phase-2 `aresConfig`
  conventions.
- Project label: `projectFromCwd` (basename, `.claude` → `hub`) when the transcript
  carries a cwd, else `projectFromSlug` (ported `_project_from_slug`). Git-root
  probing is intentionally dropped — the authoring container can't see Windows
  repos, and the slug/cwd basename is sufficient and cross-platform.

## Deliverable 2 — Seam 4 / RSI Loop A reflection (`src/rsi/reflect.ts`)

Port of `cross_project_reflect.py`, two-stage.

- **Stage 1 (mechanical, keyless):** `getSessions` → `buildDigest(snapshots)`.
  `buildDigest` groups by project (projects ordered by most-recent activity), one
  `## project (N sessions)` block each, `- [date] intent` rows + a
  `tool calls | files: … | commits: …` meta line (`shortPath` trims file paths).
  Pure and deterministic given deterministic snapshots. `buildPrompt` wraps it in
  the ported `PROMPT_HEADER`, whose section 4 **requires** the
  `## Proposed promotions (for Nico to approve)` heading and forbids tool use.
- **Stage 2 (injectable model call):** `ModelCall = (prompt, {model?,signal?}) =>
  Promise<string|null>`. Default `sdkModelCall` is the headless single-turn SDK
  call from STEP 0(b). Tests inject a mock, so Stage 1 + the write path are proven
  keyless.
- **The write path (`writeReflection`)** — the SCRIPT writes
  `<root>/journal/reflections/<date>.md` **and** `latest.md`, with a header
  blockquote restating "READ-ONLY toward long-term memory: promotions below are
  PROPOSALS for Nico to approve." The **date is injectable** (`now?: Date`, default
  real clock), driving both the harvest window and the filename/timestamps —
  mirroring how the py script derives the date from `datetime.now()` inside
  `write_output`, but threaded for deterministic tests.
- **`runReflection(opts)`** — orchestrates harvest → digest → (optional) reflect →
  write. `harvestOnly` / `dryRun` short-circuit before the model call; a quiet
  window (no sessions) returns `no-sessions` with **no write** (not an error, so
  scheduled runs don't log false failures), matching the py script's exit-0 quiet
  path.

**Propose-only / human-applied safety model (explicit):** the model never receives
the memory store to edit; it emits text. The reflection file is machine-written
narrative + *proposed* promotions; promoting anything into long-term memory is a
human action. This is the anti-self-corruption guarantee — the loop can reflect on
itself but cannot rewrite its own rules unsupervised.

## Deliverable 3 — RSI Loop C telemetry (`src/hooks/agentTrace.ts`)

A `SubagentStop` `HookCallback` that appends one JSONL row to
`<aresHome>/agents/trace-log.jsonl` per subagent stop, so `/evolve-prompts` (the
prompt-evolution skill) has data. The skill's own trigger is literally "after 20+
agent invocations have accumulated in `trace-log.jsonl`" and it looks for agents
with frequent LOW-confidence / escalation entries — the row shape feeds exactly
that consumer.

- Row: `{ timestamp, agent, confidence?, escalations?, cwd }`. `agent` =
  `agent_type` (fallback `agent_id`, else `unknown`). `timestamp` is injectable
  (`now?: () => Date`).
- `parseAgentSignals(last_assistant_message)` — pure, conservative: reports a
  `confidence` only when the message explicitly states one (numeric `0.82`,
  `80%`, or worded `high|medium|low|none`), and counts escalation signals
  (`escalat*`, `blocked`, `hand off`, `impasse`). Absent signals are omitted from
  the row (keeps the log lean).
- **Fail-open, no injection:** any error is swallowed; the hook returns `{}` so it
  never perturbs the subagent or throws into the turn.

## Deliverable 4 — reflect entrypoint (`src/rsi/reflectCli.ts`)

Runs Loop A once — the command Windows Task Scheduler invokes, replacing the
`AresReflect` `claude -p` job. `parseReflectArgs` (pure) mirrors the py argparse
(`--days --model --exclude --max-sessions --harvest-only --dry-run`) plus a
`--root` for pointing at a specific `.claude` home. `mainReflectCli(argv, deps)`
takes injectable deps (modelCall / clock / stdout+stderr sinks) and **returns an
exit code** instead of calling `process.exit`, so both the arg parser and the
keyless (`--harvest-only`, `--dry-run`) paths are unit-tested. A direct-execution
guard runs it when invoked as `node dist/rsi/reflectCli.js …`.

### Windows Task Scheduler wiring (document only — NOT created here)

The ADR calls for a 4×/day reflection. On the Windows host, replace the old
`AresReflect` job with (verify on the host as part of the deferred checklist):

```bat
:: every 6 hours = 4x/day; adjust the node path + --root to the real install.
schtasks /Create /TN "AthenaReflect" ^
  /TR "node C:\code\athena\athena-core\dist\rsi\reflectCli.js --days 7 --root C:\Users\<user>\.claude" ^
  /SC HOURLY /MO 6 /ST 06:00 /RL LIMITED /F
```

Notes for the host step: `--root` should point at the live Ares `~/.claude`
(default `resolveAresHome()` already resolves there, so it can be omitted on the
host; it's shown for clarity). The task needs `node` on PATH (or use its absolute
path, as the py script's `_find_claude` did for `claude`). Confirm the model key is
present in the task's environment (the sub-call needs it). Delete the prior
`AresReflect` task if it still exists (`schtasks /Delete /TN "AresReflect" /F`).

## What is PROVEN keyless (no key, no model turn, no `py`, no live `~/.claude`)

1. **STEP-0 findings** — SubagentStop I/O, `query({maxTurns:1})` result read, and
   the transcript event shape, read straight from the installed `sdk.d.ts`.
2. **Seam 1 (`sessions.ts`)** — `readSessionSnapshot` distills the fixture
   transcript (intent, cwd, 6 tool calls, 2 deduped edited files, 1 clean commit
   with the `$()` noise commit dropped); `getSessions` enumerates the fixture
   `projects/` tree, filters the trivial session, honors the window / exclude /
   maxSessions, and returns `[]` for a missing home. Never throws.
3. **RSI Loop A (`reflect.ts`)** — `buildDigest` grouping/ordering/meta + empty
   sentinel; `buildPrompt` carries the required propose-only section;
   `writeReflection` writes `<date>.md` + `latest.md` with the propose-only header;
   `runReflection` harvest-only / dry-run / no-sessions / ok(mock model) /
   model-failed paths, with the mock proving the write path without a key.
4. **reflect entrypoint (`reflectCli.ts`)** — `parseReflectArgs` flags + defaults;
   `mainReflectCli` `--harvest-only` and `--dry-run` print keyless, and the ok
   path via an injected mock reports the written file. The **compiled** CLI runs
   end-to-end (`node dist/rsi/reflectCli.js --harvest-only --root fixtures/rsi-home`).
5. **RSI Loop C (`agentTrace.ts`)** — `parseAgentSignals` numeric/percent/worded
   confidence + escalation counting; `agentTrace` appends a correct row (agent,
   cwd, injected timestamp, mined confidence+escalations), returns `{}`, falls back
   to `agent_id`, omits absent signals, and never throws on bad input.

## Deferred Windows/keyed live checklist

Run on the Windows host with the live Ares `~/.claude` and a real model key.

| Proof | Needs |
|---|---|
| One real scheduled reflection: `reflectCli.js` fires under Task Scheduler, `sdkModelCall` runs a live single turn over the real digest, and `<~/.claude>/journal/reflections/<date>.md` + `latest.md` are written with a genuine reflection incl. the `## Proposed promotions` section | Windows host + key + the `schtasks` job above |
| Confirm the reflection is read back on the next hub session (Phase-2 `memoryInjector` / the native journal read-back surfaces `latest.md`), closing the loop | Windows host + key |
| Real `trace-log.jsonl` accumulation: wire `agentTrace` as a `SubagentStop` hook, run live subagents, confirm rows accrue with real `agent_type` + mined confidence/escalations | Windows host + key + live subagents |
| An `/evolve-prompts` run over ≥20 accumulated trace rows produces evidence-backed prompt-mutation proposals (propose-only; user approves) | Windows host + key + ≥20 trace rows |
| Verify the exact `schtasks` syntax + that `node`/the key are present in the task's environment; delete the old `AresReflect` task | Windows host |
| Confirm `getSessions` reads the real `projects/<slug>` slugs and `sanitizeCwd` matches the live dirs (Phase-2 verified the hub slug; confirm for active project cwds) | Windows host |

**Phase 5 ratchet note:** `harness-fixtures/cases.jsonl` is the release ratchet
guard (ADR Phase 5) — the fixture/eval gate wired as the distribution ratchet.
These Phase-3 unit tests + fixtures (`fixtures/rsi-home/…`) are the per-loop
regression net; the Phase-5 `cases.jsonl` is the cross-cutting behavioral ratchet
that gates a release. Not built here; flagged so the RSI loops feed it later.

## How to run

```bash
cd athena-core
npm install
npm run typecheck   # tsc --noEmit, exit 0
npm run build       # -> dist/
npm test            # vitest: 144 passed, 1 skipped (live)
# keyless end-to-end smoke of the compiled Loop-A entrypoint:
node dist/rsi/reflectCli.js --harvest-only --root fixtures/rsi-home --days 36500
```

## Layout (Phase 3 additions in **bold**)

```
athena-core/
  src/rsi/      **sessions.ts**    (Seam 1: getSessions / readSessionSnapshot)
                **reflect.ts**     (Seam 4 / RSI Loop A: digest + injectable model call + write)
                **reflectCli.ts**  (Loop A entrypoint — the Task Scheduler command)
  src/hooks/    **agentTrace.ts**  (RSI Loop C: SubagentStop trace-log telemetry)
  fixtures/     **rsi-home/projects/C--code--athena/**   (cwd + edits + clean & noise commits)
                **rsi-home/projects/C--Users-nico--claude/**  (hub session)
                **rsi-home/projects/C--code--empty/**    (trivial session — filtered)
  test/         **sessions · reflect · reflectCli · agentTrace**
```
