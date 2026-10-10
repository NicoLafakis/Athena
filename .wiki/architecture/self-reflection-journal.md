# Athena's self-reflection journal

Implemented in the shared harness: optional operational capture, a daily bounded
consolidation pass, evidence-linked notes, and durable provisional memory. Capture
uses the existing hash-chained run traces. `HarnessSessionController` owns
`JournalRuntime`; the CLI, screen reader, and Ink share that lifecycle.

The approved implementation replaces the earlier manual-only journal proposal.
It does not implement the full [Conversational Continuity](../features/conversational-continuity/00-overview.md)
planning package or the legacy free-text hygiene plan in
[Memory hygiene](memory-hygiene.md). The
[source investigation](source-investigation.md) completion contract remains
separate: a reflection cannot make an investigation pass.

## Human controls and schedule

The journal is disabled by default. These commands operate on the global brain;
project settings and model tools cannot enable it or change its schedule.

```sh
athena journal enable
athena journal enable --time 09:00 --timezone America/New_York
athena journal enable --no-model
athena journal status
athena journal run
athena journal entries
athena journal memory
athena journal memory --global
athena journal reject <memory-sha256-id>
athena journal disable
```

Enablement defaults to daily consolidation at **09:00 America/New_York** with
model synthesis enabled. `--no-model` retains capture and deterministic
relationships/memory without synthesis. Enablement sets a capture cutoff;
re-enabling advances it, excluding the disabled interval while keeping history.

The in-app timer checks once per minute and performs at most one eligible local
date on startup. It does not replay every missed date. Day keys handle DST gaps
and repeated hours without repeating a completed pass. `run` requests today's
pass immediately; a completed day remains idempotent. A scheduled pass can run
only while Athena is open; after closure, the next startup performs one bounded
catch-up. No OS task, background service, system file or credential change is
involved.

Each day has at most **two persisted one-shot provider attempts**, one per timer
invocation, with at most 1,400 requested output tokens and a 30-second deadline
per attempt. The reservation is durable before the call; restart does not reset
it. The existing Anthropic and OpenAI clients disable hidden retries for this
explicit budget. A failed first attempt may retry on the next check. A second
failure produces a metadata-only checkpoint with an explicit budget limitation.
Disablement/shutdown is rechecked after asynchronous capture and before call
reservation; an in-flight call is aborted on shutdown.

## Capture and the result contract

`RunTraceWriter.onPersisted` observes events only after their original record was
written. Terminal events queue capture; explicit flush and bounded startup
recovery cover interrupted runs. Sources include user prompts, matched tool
results, turn completion, fatal errors, run limits, and failed/aborted children.
Interesting trace entries describe recovery after two or more consecutive
same-run/tool/input failures, fatal failures, limits, failed children, and a shell
report of a git commit. A shell success does not verify repository state.

Capture records templated metadata rather than file bodies or tool output.
`Journal` tool results and generated memory files are excluded as source inputs.
Source records preserve:

- canonical project scope, run and sequence, original file location and revision;
- distinct record identity and assertion origin identity;
- observed/derived/inferred evidence kind, extractor version, provider and model;
- capture window, tool name/input hash/reported error state when applicable;
- limitations, including the original execution tool's unknown version.

Source checks reconstruct identity, summary, operation and other metadata from
the actual canonical trace or current manual-memory content. A valid envelope
with altered ledger fields fails validation. Trace chain integrity establishes
what was recorded, **not that its content or interpretation is true**. Manual
memory remains an authored assertion; changed content is stale, missing content
is missing, and malformed or mismatched records are invalid.

Versioned strict Zod contracts live in `src/journal/types.ts`. Entry IDs are
SHA-256 identities, not UUIDs. Server code owns time, scope, author, evidence
kind, subjectivity and status. The model cannot supply those fields.

| Entry | Capture or tool operation | Meaning |
|---|---|---|
| `trace` | automatic metadata or daily checkpoint | observed recording/process metadata; no behavioral proof |
| `prediction` | model supplies text, basis and falsifiableBy | pre-outcome subjective hypothesis |
| `resolution` | existing prediction plus later original trace hash | subjective interpretation of an outcome, including unresolved |
| `surprise` | expected result, explanation and original trace hash | subjective interpretation of a discrepancy |
| `reflection` | explicit tool note or daily synthesis | subjective, inferred narration |

All model-authored entries remain `subjective: true` and `evidenceKind: inferred`,
even when the cited trace hash is valid. A resolution never turns its prediction
into an observed fact. Resolution/surprise requires an eligible trace source in
the executing run; a resolution's source must follow its prediction. Predictions
are not automatically resolved or expired. Explicit reflections are capped at
two per run, with identical repeated requests returning the existing entry.
Manual notes currently belong to the controller's own run; child-run note
authoring is not supported.

## Durable memory and relationships

Daily consolidation consumes at most 24 original sources from **one scope**.
Whole records are removed from the model input until it fits 16,000 characters;
remaining sources wait for another day. A restarted attempt uses its frozen
source list. Current-project trace recovery and the top-level manual `*.md`
memory catalog each inspect at most 32 files per recovery pass (startup or a new
eligible date within that runtime). Persisted cursors advance across restarts. The catalog
excludes `MEMORY.md`, `LEARNED.md`, generated memory and nested directories.
Global authored files are never implicitly assigned to a project.

Deterministic processing links repeated origins, tool retry recovery and changed
memory-file revisions. It can derive tentative memories from reported recovery
or safe authored-memory excerpts without a provider. Optional synthesis has no
tools and may propose at most eight memories and eight source-linked
relationships. Only supplied valid original sources are admissible citations;
sources are revalidated after the call before committing model content.

Memories retain statement/topic, scope, versions, original citations, independent
origin IDs, limitations, contradictions and review state. They are always
subjective and provisional (or contradicted/rejected), with fixed confidence
**0.25**. Repeated assertions share an origin and never raise confidence.
Updates merge limitations even when citations are unchanged; exceeding a
provenance or uncertainty bound rejects the update instead of dropping evidence.

Contradictory interpretations preserve both memories and their links; neither is
automatically chosen as true. Human rejection creates a durable tombstone and
excludes the memory from retrieval. Matching statement, topic or original origin
cannot silently recreate it within the same scope. There is no automatic
promotion into governed-learning active claims, `MEMORY.md`, `LEARNED.md`,
permissions, policy, credentials or system instructions.

## Storage and retrieval

```text
<brainDir>/journal/
  config.json          # human controls only
  ledger.jsonl         # canonical versioned transactions and checkpoints
  write.lock
  consolidate.lock
<brainDir>/memory/journal/
  INDEX.md             # rebuildable view of provisional memory
  <memory-id>.json      # rebuildable latest version with provenance
```

The global ledger retains project scopes. Transactions atomically commit sources,
entries, memory versions, relationships, consumed inputs and the daily checkpoint.
History is logically append-only; each write replaces the bounded ledger through
a read-verified temporary file. Hash chaining detects accidental changes, not
truth. Exclusive locks coordinate runtimes; only a proven dead owner can be
recovered. Invalid/live-owner locks fail closed. Redirected/protected storage is
refused. The existing `Memory` tool cannot write/delete the reserved `journal`
namespace, and generated views are never future consolidation sources.

The controller's engine retrieves at most four relevant provisional memories,
within 4,000 rendered characters including escaped JSON and framing, for the
current project. It validates original
sources for **every logical engine request**, including after tool calls. Provider
transport retries reuse that request's input. Missing,
stale, invalid, contradicted or rejected memory is excluded. The temporary
`<journal-memory>` bundle is untrusted user-role data; it never enters the system
prompt, saved messages, raw user-prompt traces or compaction. Reloaded sessions
therefore do not carry an old bundle back into context. Global memory is available
through explicit human inspection, not automatic project retrieval.

`status` reads configuration and validates the actual ledger. `memory` and tool
readback expose source availability. Provider-unavailable, filtered/malformed
synthesis and exhausted budgets have explicit job modes/limitations. A completed
daily pass describes processed records; it does not certify inferred claims.

## Bounds, failures and remaining scope

- Ledger: 8 MB and 4,096 transactions; source trace: 2 MB and 4,096 events.
- Capture: 64 new sources/entries per batch; directory: 2,048 entries.
- Source provenance: 24 identities per memory; limitations: eight per memory.
- Model output: 12,000 characters plus the stricter structured-array limits.
- Retrieval considers at most 16 ranked candidates and returns at most four.

All loops, reads and output schemas are finite. Reaching a cap preserves the
working artifact and reports failure; this version has no ledger rotation or
unbounded maintenance sweep. Optional storage/provider failures warn once with
the artifact and `athena journal status` recovery command and leave ordinary
turns available. Capture uses zero model tokens but does perform bounded local
I/O; it is not a zero-latency promise.

Shared redaction and prose filters reject recognizable credentials, identifiers,
code/diff bodies and instruction-changing text; cleaned values are stored rather
than the unfiltered inputs. These are bounded filters, not a guarantee that every
possible sensitive string or adversarial statement will be recognized.

Deferred: closed-app scheduling, cross-machine synchronization, a unified
conversation index, legacy memory frontmatter repair/flag/supersede/expiry,
automatic prediction resolution, runtime/binary investigation providers, active
claim promotion, semantic truth verification, and a TUI journal viewer.

## Verification coverage

`tests/harness/journal-lifecycle.test.ts` exercises the real shared controller and
registered Read tool: timer consolidation, reload/materialization, ephemeral
retrieval on direct engine paths, repetition, rejection, contradictory versions,
retry recovery, manual-source staleness/missingness, concurrent runtimes, a
persisted crash reservation with a real exited subprocess, cancellation,
malformed synthesis, missing provider, and optional-storage degradation.

`tests/tools/journal.test.ts` covers human controls, DST, evidence-linked note
contracts, idempotency, redaction, original-source metadata reconstruction,
uncertainty preservation, malformed transactions, protected/redirected storage
and re-enable cutoffs. `tests/engine/journal-budget.test.ts` checks one physical
attempt and requested token bounds through the actual provider client adapters.
Providers are scripted fixtures; these tests do not establish live-provider
availability or model interpretation quality.
