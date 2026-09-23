# Conversational Continuity — Rollout and Runbook

> [Overview](00-overview.md) · [Tasks](tasks.md) · [Test strategy](test-strategy.md)

## Rollout principles

- Keep current memory and session behavior as the fallback.
- The index is derived and disposable; source session files are not rewritten.
- Do not enable automatic memory promotion or broad prompt recall until source-link,
  deletion, privacy, and cross-project tests pass.
- No network access, new credential, background model call, or cross-machine sync.

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
Automatic recall stays opt-in until this gate.

### Phase 3: semantic memory lifecycle

Add source-linked explicit memories, inferred candidates, correction/supersession, and
forgetting integrated with the existing memory tool/index. The initial schema/store and
the `Memory` tool's explicit remember, review, and correction/supersession paths are in
place. Candidate generation, a user-facing review surface, and forget/source deletion
integration are still open. Semantic records remain local and are not injected into
provider prompts.

**Exit:** tombstone/rebuild tests, correction tests, and sensitive-data review pass.

### Phase 4: hierarchical summaries

Add time rollups and calibrate retrieval/promotion against representative long histories.

**Exit:** every rollup is source-linked, invalidates correctly, meets latency/context
budgets, and preserves exact details through source expansion.

## Backfill and migration

- First use creates no mandatory data migration. `athena memory rebuild` constructs the
  index from existing session files.
- Rebuild writes to a temporary sibling, validates record counts and source refs, then
  atomically swaps the index. A failed rebuild preserves the last good index.
- Existing sessions and user memory files are not rewritten during indexing.
- Target behavior: deleted/forgotten source IDs must be checked before indexing and
  represented by suppression tombstones so future scans cannot resurrect them. This
  integration is not implemented yet.
- Existing `athena session delete` moves source JSONL to the project’s `.trash` directory;
  the continuity index must stop returning it. There is no user-facing session restore
  command today, so do not document or assume one. Add restore integration only with an
  explicit implementation and tests.
- Schema upgrades rebuild derived data from source; they do not overwrite a working index
  before the replacement is verified.

## Recovery

- Inspect state: `athena memory status`.
- Rebuild optional index: `athena memory rebuild`.
- If source history is missing, mark dependent summaries unavailable. Do not reconstruct
  or silently restore a source from a summary.
- Automatic answer-time recall is not enabled. Explicit CLI/slash search and timeline
  remain available.

## Rollback

Disable automatic recall and remove the derived continuity index. This does not touch
session JSONL, RunTrace, user memory files, credentials, or learning records. Managed
semantic memories retain their source links and currently support review and correction;
forget controls and source-session integration are unfinished. Re-enable only after
repairing or rebuilding derived data.
