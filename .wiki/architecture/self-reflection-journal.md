# Athena's self-reflection journal

A first-class, append-only record of Athena's operational life — commits, retries, tool
failures, and, most importantly, predictions made before their outcome was known — kept
so continuity across sessions is built from specifics, not self-description. This page
specifies the journal alone. Where it feeds memory curation/promotion, only the interface
seam is noted; the consuming system is scoped separately.

## Why this and not a diary

Two things are already grounded to reuse: `RunTraceWriter` (`src/harness/traces.ts`)
hash-chains every engine event per run, and the existing per-session event log
(`Session.appendEvent`, wired in `HarnessSessionController.create`,
`src/harness/controller.ts`) already listens on the
`EngineEventBus` for `error`/`turn-done`/`compaction` and appends best-effort. The
journal is a third listener on that same bus, at that same seam — not a new capture
mechanism. What's new is: (a) treating *divergence from expectation* as the interesting
unit, not "turn completed", and (b) a model-authored channel for predictions,
resolutions, and surprises that plain event capture cannot produce on its own.

The consumer and the broader user-facing continuity policy are specified in
[Conversational Continuity](../features/conversational-continuity/00-overview.md). The
journal remains an operational evidence stream, not a transcript archive or a replacement
for source-linked conversational episodes.

`src/brain/paths.ts` already reserves `journalDir` (`~/.athena/journal`) and
`ensureBrainScaffold` (`src/harness/bootstrap.ts:96`) already creates it — the directory
exists today and is unused. This spec fills it in.

## Entry taxonomy

One append-only stream, one Zod-discriminated schema (`JournalEntrySchema`, mirroring the
`LearningCandidateSchema`/`EvalCaseSchema` convention in `src/learning/types.ts`). Common
envelope:

```ts
interface JournalEntryBase {
  schemaVersion: 1
  id: string            // uuid
  timestamp: string      // ISO, set server-side, never model-supplied
  type: 'trace' | 'prediction' | 'resolution' | 'surprise' | 'reflection'
  project: string | null // projectSlug(cwd) from src/harness/sessions.ts, or null
  runId: string | null   // RunTraceWriter.runId this entry is about, if any
  traceHash: string | null // a specific RunTraceEnvelope.hash cited as evidence
  author: 'system' | 'model'
  subjective: boolean    // computed server-side — see Guard, below. Never model-set.
}
```

**1. `trace` — auto-captured, system-authored, zero model tokens.**
```ts
{ event: string; summary: string /* <=280 chars, templated */; attempts?: number; toolName?: string }
```
Written by an `EngineEventBus` subscriber, installed next to the existing session
listener in `src/harness/controller.ts`. It does NOT log every event — an explicit allowlist,
because "fixed it, tests passed" teaches nothing:
- `error` where `fatal: true` (uncaught failure)
- a `tool-result` transitioning `isError: true → false` for the same
  `(runId, toolName, input-hash)` after ≥2 consecutive prior failures — the "took four
  attempts" case. Requires an in-memory `Map<string, number>` inside the listener keyed
  by `${runId}:${toolName}:${hash(input)}`, reset on success; no engine changes needed,
  pure listener-side aggregation.
- `run-limit` (hit a hard budget)
- `child-status` with `status: 'failed' | 'aborted'`
- a `git commit` observed in a `tool-result` for `Bash`/`PowerShell`

`summary` is a template string interpolated from the event's own fields — never an LLM
call. This is what keeps trace-entry cost at ~0 tokens and ~0 added latency: a
synchronous filter plus an async `fs.appendFile`, fire-and-forget, same risk profile as
the existing best-effort session journal.

**2. `prediction` — model-authored, first-class.**
```ts
{ statement: string; basis: string; falsifiableBy: string }
```
Recorded via a new `Journal` tool BEFORE the outcome is known. `runId`/`traceHash`
optional at write time (the outcome hasn't happened yet) but strongly encouraged when the
prediction is about an in-flight run.

**3. `resolution` — scores a prior prediction. Never edits it.**
```ts
{ predictionId: string; outcome: 'confirmed' | 'refuted' | 'partial' | 'unresolved'; evidence: string; generalizable?: string }
```
`runId`/`traceHash` REQUIRED — a resolution without an evidence anchor is rejected by the
tool. This is the calibration record: "what is Athena systematically wrong about" is
answered by aggregating `resolution` entries by pattern (a read-side reporting concern,
out of scope for v1).

**4. `surprise` — model-authored, evidence-anchored, no pre-registered prediction
required.** For the case where nobody predicts a false negative in a test they haven't
written yet.
```ts
{ expected: string; observed: string; whyItMatters: string }
```
`runId`/`traceHash` REQUIRED (same rejection rule as `resolution`) — a surprise is a
claim about what actually happened, so it must cite what happened.

**5. `reflection` — model-authored, freeform, deliberately the weakest citizen.**
```ts
{ note: string }
```
Always `subjective: true`, unconditionally. Rate-capped. No evidence requirement, because
by definition there is none — this is where "I found this session harder than usual"
goes, and it is walled off structurally, not by asking the model to remember to caveat
it.

## The guard: subjective entries can never be retrieved as evidence

Not a convention — three mechanical enforcement points, all in code the model does not
control:

1. **Write-time, in the `Journal` tool** (`src/tools/journal.ts`, new): `subjective` is
   computed by the tool, never accepted as model input. Rule: `type === 'reflection'` →
   `true`, always. `type === 'prediction' | 'surprise' | 'resolution'` → `true` unless
   the entry carries a `runId` that resolves via `TraceWarehouse.get(runId)`
   (`src/learning/warehouse.ts`) — i.e. the cited run actually exists and has a valid
   hash-chain. An unanchored "prediction" is stored as subjective, silently downgraded,
   not rejected. `type === 'trace'` → always `false`.
2. **Read-time, in the single loader function** (`loadJournalReadback`, new in
   `src/brain/loader.ts`, same module as `loadMemoryIndex`): the default ambient
   read-back filters `subjective === true` out entirely — reflections never appear in the
   default context at all. The `Journal` tool's `read` op can still fetch them on-demand,
   but only inside a clearly delimited block titled *"your own prior narration — not
   verified, not evidence"* that the prompt-assembly layer (`src/engine/prompt.ts`) never
   merges into the continuity section.
3. **Seam-time, for the (separately scoped) memory/promotion system**: anything that
   system pulls from the journal as candidate material MUST require
   `subjective === false` AND a `traceHash` that verifies against the trace file it
   names.

## Confabulation guard

The `Journal` tool's `write` op for `resolution`/`surprise` calls
`TraceWarehouse.get(runId)` (throws `Unknown run ${runId}` if it doesn't exist) — exactly
the check `requireEvidence` already performs for learning candidates
(`src/learning/warehouse.ts:115`). A resolution/surprise citing a run that isn't on disk
is rejected outright, not silently downgraded — these two types make a factual claim
about what happened, so an unverifiable one is an error, not a lesser entry.

## Privacy and safety (enforced, not hoped)

- Every payload passes through `redactSessionValue` (`src/harness/sessions.ts:53`,
  already exported) before serialization — the same secret-pattern/key-name redaction
  `Session.appendLine` and `RunTraceWriter.append` already apply.
- Payload string fields are schema-bounded (e.g. `note`/`summary`/`evidence` capped at
  2,000 chars).
- The `write` op rejects (not truncates — truncation can leak a slice) any payload field
  matching diff/file-body shape (`^--- |^\+\+\+ |^@@ ` or a run of >20 lines that looks
  like source), asking for a prose summary instead. Journal entries never carry raw file
  contents or diffs.
- Storage lives under `~/.athena/journal/`, already covered by the blanket `.athena/` /
  `**/.athena/` gitignore — no new ignore rule needed.

## Storage format, location, rotation

```
<brainDir>/journal/
  entries/
    2026-07.jsonl     # one JSON line per entry, this calendar month, ALL projects
    2026-08.jsonl
  index.jsonl          # one line per entry ever written: {id, timestamp, type, project, subjective, predictionId?}
```

- **Global, not per-project.** Traces and sessions are per-project; the journal
  deliberately is not, because "Athena as a persistent someone" is a cross-project
  identity claim. Each entry still carries `project` for filtering.
- **Rotation = the calendar month is the file boundary.** No rotation job, no size
  triggers. Old months are kept (append-only, cheap text) with no auto-deletion in v1.
- **`index.jsonl` keeps months of history queryable without loading them wholesale.** It
  never carries free text. "List pending predictions" = filter the index for
  `type === 'prediction'` with no later `resolution` line carrying that `predictionId` —
  a scan over small lines, no mutation, so the append-only invariant holds even for
  something that reads as "prediction state." Fetching a full entry means opening one
  bounded monthly shard and linear-scanning it — the same access pattern
  `TraceWarehouse`/`CandidateStore` already use at this scale.
- **Predictions never resolved** stay pending forever in v1 — deliberately not
  auto-expired, because an old unresolved prediction is itself a mild signal about
  follow-through. Flagged as a v2 candidate: a sweep converting predictions unresolved
  after ~90 days into a synthetic `resolution` with `outcome: 'unresolved'`, so
  calibration stats are not silently biased by survivorship of only the predictions
  someone bothered to close.

## Triggers and cost

| Entry type | Trigger | Author | Cost |
|---|---|---|---|
| `trace` | `EngineEventBus` listener, allowlisted event types | system | 1 fs append, async, fire-and-forget; 0 model tokens; 0 added turn latency |
| `prediction`/`surprise`/`reflection` | model calls `Journal` tool | model | 1 tool call — same cost class as today's `Memory` tool writes |
| `resolution` | model calls `Journal` tool, explicit only in v1 | model | same as above |
| ambient read-back | once per session, at prompt assembly | system | bounded string injection, no extra model call |

No background LLM sweep in v1 — the only cost path touching the user's turn is the
model's own choice to call the tool.

## Read path: what Athena reads back and when

- `loadJournalReadback(paths, { project })` (new, `src/brain/loader.ts`), wired into
  `PromptParts`/`assembleSystemPrompt` (`src/engine/prompt.ts`) as a new `# Journal`
  section, after `# Memory` and before project context files.
- **Hard budget: ~3,000 chars (~750 tokens), never the whole journal.** Index-first
  (cheap), then selective full-entry fetch:
  1. Last 5 `trace` entries for the current project since the prior session.
  2. Any `prediction` with no matching `resolution`, older than the current session —
     surfaced as a nudge so the model has a reason to close the loop, at zero extra
     model-call cost.
  3. The 2-3 most recent `surprise` entries, across projects — cross-session pattern
     signal, deliberately not project-scoped.
  4. `reflection` entries are excluded from this section entirely, structurally.
- On-demand: `Journal` tool `read` op (`{ op: 'read', type?, project?, query? }`) for
  deeper calibration questions.
- Framing text states plainly that this is background context, not an instruction — the
  framing that stops a model treating episodic read-back as a command.

## Failure modes and how this design answers them

- **Journal bloat** — monthly rotation, hard read-back cap, reflection write rate cap.
- **Self-reinforcing narrative** — the three-point mechanical guard; ambient read-back
  structurally never contains `subjective: true` text.
- **Confabulated entries** — `resolution`/`surprise` writes rejected if their cited
  `runId` does not verify.
- **Noise drowning signal** — `trace` capture is an explicit allowlist of high-signal
  event shapes, not "log every tool call."
- **Reflection spam** — the tool tracks a per-session counter and caps `reflection`
  writes (proposed: 2 per session), returning an error past the cap rather than silently
  dropping, so the model gets a clear signal it is over-narrating.
- **Write-only journal** — read-back is mandatory in phase 1, not deferred; a journal
  nobody reads is the failure this spec argues against building.

## Interface seam to memory/promotion (not designed here)

The parallel memory-hygiene feature may want to promote a recurring pattern across
several `resolution`/`surprise` entries into long-term memory. This spec's only
commitment: such a consumer can rely on `subjective === false` plus a verifiable
`traceHash`/`runId` as the admission criterion, and can scan `index.jsonl` cheaply to
find candidates before opening full entries. What counts as "recurring", how promotion is
triggered, and what it writes are out of scope here.

## Explicitly out of scope for v1

- Scheduled cross-session synthesis (an LLM digest pass over a month of entries) — real
  value, real LLM cost, a genuinely separate scheduled job. The natural v2.
- Automatic prediction resolution via a background LLM sweep at session end.
- Promotion into long-term memory (the other feature's job; only the seam above is
  specified).
- Cross-machine sync — per-machine only, same as credentials and sessions today.
- Any TUI viewer. A `/journal` slash command is a cheap fast-follow once the tool exists.
- Full-text search — the index gives type/project/date/resolved filtering; free-text
  search is "grep the relevant month file."

## Build sequence

**Phase 1 — trace capture + read-back only (no model-authored writes yet).** Even before
a single prediction exists, Athena can be shown a factual account of what happened while
nobody was watching.
- `src/brain/journal.ts` (new): `JournalEntrySchema`, `JournalWriter` (append +
  index-append, atomic, redaction applied), monthly file resolution.
- Wire an `EngineEventBus` listener in `src/harness/controller.ts`, alongside the existing
  `bus.on(...)` session-journal block — same seam, same best-effort/never-throw
  discipline. Wiring it there reaches every surface at once; the controller is the one
  session composition.
- `loadJournalReadback` in `src/brain/loader.ts`; wire into
  `PromptParts`/`assembleSystemPrompt`.
- Extend `ensureBrainScaffold` only if `journal/entries/` needs pre-creating;
  `journalDir` already exists.

**Phase 2 — the `Journal` tool: predictions, resolutions, surprises.**
- `src/tools/journal.ts` (new), pattern-matched on `src/tools/memory.ts`: ops `predict`,
  `resolve`, `surprise`, `read`. Server-computed `subjective`, `TraceWarehouse`-backed
  evidence validation, redaction reuse.
- Register in `src/tools/index.ts` and `src/tools/registry.ts`.
- A couple of lines of tool guidance telling the model when to use it.

**Phase 3 — reflections + rate cap + on-demand read.**
- Add the `reflection` op with the per-session cap.
- Add the on-demand `read` query shape.
- `/journal` slash command for a human-facing recent-entries view.

**Phase 4 — future, not part of this spec.**
- Scheduled synthesis pass.
- Auto-expiry of long-unresolved predictions.
- Whatever the memory feature builds on the seam above.

## Opinion: what is not worth building

Full-text search and a background LLM resolution sweep are the two temptations worth
resisting explicitly. Full-text search over a few hundred KB per month of JSONL is solved
well enough by grep on one bounded file. A background LLM sweep to auto-resolve
predictions sounds like it closes the "unresolved forever" gap, but it reintroduces
exactly the risk the subjective-entry guard exists for — a model narrating about its own
past state, unsupervised, on a timer. Leaving resolution explicit and model-chosen in v1
is the correct trade: slower to close loops, but every closed loop is one the model
actually looked at evidence for.
