# Conversational Continuity — Rollout and Runbook

> [Overview](00-overview.md) · [Tasks](tasks.md) · [Test strategy](test-strategy.md)

## Rollout principles

- Keep current memory and session behavior as the fallback.
- The index is derived and disposable; source session files are not rewritten.
- Do not enable automatic memory promotion or historical answer-prompt recall until
  source-link, deletion, privacy, and cross-project tests pass.
- Capture, indexing, and ranking remain local. The accepted Jev route may send the current
  secret-redacted user request to TypeSafe when `TYPESAFE_API_KEY` is present; no history
  enters that request. The call is synchronous and bounded, not a background task.

## Phases and exit gates

### Phase 0: source audit and contracts

Document stable session/message identity, timezone behavior, project scope, and source
delete/restore flows; freeze schemas and tests before indexing existing history.

**Exit:** accepted data contract and lifecycle tests; no ambiguity about transcript source
or linked-episode policy.

### Phase 1: local index and explicit timeline

Build an idempotent derived index and explicit search/timeline/show/rebuild commands.
Index existing sessions lazily or via an explicit rebuild; preserve all original files.

**Exit:** multi-project/date integration tests pass; privacy bounds and performance gates
pass; corrupt index is nonfatal.

### Phase 2: answer-time recall

Connect bounded retrieval to conversational turns; dogfood date/topic/project queries and
verify current source precedence, uncertainty, and no irrelevant context leakage.

**Exit:** acceptance criteria for source-backed answers and no-hit/conflict behavior pass.
Historical answer-time retrieval remains disabled until this gate and its separate
authorization are complete.

### Phase 3: semantic memory lifecycle

Add source-linked explicit memories, inferred candidates, correction/supersession, and
forgetting integrated with the existing memory tool/index. The initial schema/store and
the `Memory` tool's explicit remember, review, and correction/supersession paths are in
place. Explicit `athena memory candidates` / `/memory candidates` commands generate
review-only semantic candidates from repeated direct user claims in distinct,
source-digest-verified sessions; local bounded listings and `memory review` commands
allow explicit promotion or rejection. Repeated sensitive claims are excluded from inferred
semantic storage; a user-directed explicit remember request is a separate path. A
single-session repetition is insufficient; every inferred source is verified again at
promotion time. Forget/source deletion integration is still open pending the source-retention choice.
Semantic records remain local and are not injected into provider prompts.

**Exit:** tombstone/rebuild tests, correction tests, and sensitive-data review pass.

### Phase 4: hierarchical summaries

Deterministic local day/week/month/quarter/year rollups are implemented as on-demand views
over the complete episode index. They include all covered episode IDs and a digest of the
current source set; refresh is automatic because no rollup cache is persisted. Retrieval
ranking is implemented as a local-only preview across working, episodic, semantic, and
rollup layers. CLI and slash interfaces return bounded metadata and explanation labels;
they do not add historical excerpts to provider prompts. Calibration against representative
long histories remains.

**Rollup exit:** source coverage, complete-index gating, timezone boundaries, summary bounds,
and correction/deletion refresh are covered by unit and integration tests. **Ranking-preview
exit:** deterministic layer selection, source scope/validity filters, stale-rollup rejection,
bounded metadata, and local CLI/slash parity are tested. **Phase exit:** representative-history
relevance, false-positive/no-hit rates, latency budgets, and exact-detail source expansion
are calibrated. Automatic provider handoff remains separately blocked on explicit user
authorization and its privacy tests.

## Backfill and migration

- First use creates no mandatory data migration. `athena memory rebuild` constructs the
  index from existing session files.
- Rebuild writes to a temporary sibling, validates record counts and source refs, then
  atomically swaps the index. A failed rebuild preserves the last good index.
- Existing sessions and user memory files are not rewritten during indexing.
- Session deletion writes a versioned, content-free suppression tombstone before the
  source JSONL moves to the project’s `.trash` directory. Reads, rankings, rollups, and
  rebuilds suppress that source immediately; a rebuild cannot resurrect it.
- `athena session restore <session-id>` restores the most recent recoverable JSONL copy,
  or accepts an already-live source left by an interrupted delete; it then clears the
  tombstone and reindexes from the live source. A corrupt tombstone ledger fails closed;
  rebuild refuses to overwrite it, preserving the state for recovery.
- Semantic-memory forget and its source-retention behavior are separate and remain open.
  Restoring a deleted session does not override a separate forget decision.
- Schema upgrades rebuild derived data from source; they do not overwrite a working index
  before the replacement is verified.

## Recovery

- Inspect state: `athena memory status`.
- Rebuild optional index: `athena memory rebuild`.
- If source history is missing, mark dependent summaries unavailable. Do not reconstruct
  or silently restore a source from a summary.
- Jev route hints are enabled by the global default; if the TypeSafe key is absent, no
  call is made and normal prompt handling continues. When configured, one request classifies
  route and speech act. Eligible high-confidence speech-act labels are stored as
  content-free, source-digested local events; candidate generation still requires repeated
  independent evidence and explicit review. Set `jev.enabled` to `false` to disable future
  Jev calls; this does not remove existing labels or candidates, which remain subject to
  source verification and review.
  Automatic historical answer-time retrieval is not enabled. Explicit CLI/slash search and
  timeline remain available.

## Rollback

Set global `jev.enabled` to `false` to disable new Jev decisions, then remove the derived
continuity index only if its local state needs rebuilding. Existing content-free speech-act
events remain in canonical session JSONL and continue to inform local indexing while their
source lines verify. Session delete/restore tombstones remain governed by the local
continuity store. This does not touch RunTrace, credentials, or learning records. Managed
semantic memories retain their source links and currently support review and correction;
forget controls are unfinished. Historical answer-time retrieval remains outside this Jev
route and requires its own authorization and implementation.
