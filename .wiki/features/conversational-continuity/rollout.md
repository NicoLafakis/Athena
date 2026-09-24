# Conversational Continuity — Rollout and Runbook

> [Overview](00-overview.md) · [Tasks](tasks.md) · [Test strategy](test-strategy.md)

## Rollout principles

- Keep current memory and session behavior as the fallback.
- The index is derived and disposable; source session files are not rewritten.
- Keep automatic memory promotion review-only. Scoped historical answer-prompt recall is
  authorized and may run after its source-link, deletion, privacy, and cross-project tests
  pass; retrieval remains read-only and request-triggered.
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
verify current source precedence, uncertainty, and no irrelevant context leakage. The
answer-time path now applies Jev route confidence, explicit project/time scope, source
verification, tombstones, adjacent-turn reconstruction, shared secret redaction, and the
five-episode/4,000-character payload limit.

**Exit:** acceptance criteria for source-backed answers, no-hit/conflict behavior,
prompt isolation, and the bounded provider payload pass. The user separately authorized
scoped recall on 2026-09-23. Representative live-history dogfood remains a Phase 4.3 gate.

### Phase 3: semantic memory lifecycle

The versioned semantic schema/store, explicit remember, review, correction/supersession,
and forget controls are implemented through the existing memory tool/index. Explicit
`athena memory candidates` / `/memory candidates` commands generate review-only candidates
from repeated direct user claims in distinct, source-digest-verified sessions; local
bounded listings and review commands allow explicit promotion or rejection. Repeated
sensitive claims are excluded from inferred storage; explicit remember is a separate
user-directed path. Promotion re-verifies every source. `athena memory forget <id>` and
`/memory forget <id>` erase the derived body/description and keep source IDs only to prevent
re-derivation from those exact lines; the canonical session remains available for explicit
historical recall. Source-session deletion remains a distinct action. Semantic records are
local and are not injected into provider prompts.

**Exit:** tombstone/rebuild tests, correction tests, and sensitive-data review pass.

### Phase 4: hierarchical summaries

Deterministic local day/week/month/quarter/year rollups are implemented as on-demand views
over the complete episode index. They include all covered episode IDs and a digest of the
current source set; refresh is automatic because no rollup cache is persisted. Retrieval
ranking is implemented as a local-only preview across working, episodic, semantic, and
rollup layers. Automatic answer-time retrieval expands selected episode sources; semantic
content and rollup summaries remain navigation-only. Calibration against representative
long histories remains.

**Rollup exit:** source coverage, complete-index gating, timezone boundaries, summary bounds,
and correction/deletion refresh are covered by unit and integration tests. **Ranking-preview
exit:** deterministic layer selection, source scope/validity filters, stale-rollup rejection,
bounded metadata, and local CLI/slash parity are tested. **Phase exit:** representative-history
relevance, false-positive/no-hit rates, latency budgets, and exact-detail source expansion
are calibrated. Automatic provider handoff is authorized and implemented; keep monitoring
its scoped payload and false-positive/no-hit rate during dogfood.

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
- Semantic forget keeps a durable source-line suppression marker. Restoring a deleted
  session does not override a separate semantic forget decision.
- Schema upgrades rebuild derived data from source; they do not overwrite a working index
  before the replacement is verified.

## Recovery

- Inspect state: `athena memory status`.
- Rebuild optional index: `athena memory rebuild`.
- If source history is missing, mark dependent summaries unavailable. Do not reconstruct
  or silently restore a source from a summary.
- Jev route hints are enabled by the global default; if the TypeSafe key is absent, no
  call is made and normal prompt handling continues. When configured, one request classifies
  route and speech act. Only speech-act labels at confidence >= 0.98 are stored as
  content-free, source-digested local events; candidate generation still requires repeated
  independent evidence and explicit review. Set `jev.enabled` to `false` to disable future
  Jev calls; this does not remove existing labels or candidates, which remain subject to
  source verification and review.
  Routed, explicitly requested historical recall uses bounded source-verified context in
  the active answer call. If integrity checks fail, it attaches no history; explicit
  CLI/slash search and timeline remain available for local inspection.

## Rollback

Set global `jev.enabled` to `false` to disable new Jev decisions, then remove the derived
continuity index only if its local state needs rebuilding. Existing content-free speech-act
events remain in canonical session JSONL and continue to inform local indexing while their
source lines verify. Session delete/restore tombstones remain governed by the local
continuity store. This does not touch RunTrace, credentials, or learning records. Managed
semantic memories retain their source links and support review, correction, and forget.
Forget scrubs derived text while retaining the original session for historical recall. A recall-scope incident requires reverting or correcting
the answer-time callback and rerunning the privacy and prompt-isolation gates before
release; disabling Jev alone does not disable the explicit deterministic fallback.
