# Conversational Continuity — Implementation Plan

> [Overview](00-overview.md) · [Requirements](requirements.md) ·
> [Design](design.md) · [Test strategy](test-strategy.md)

Implement the phases in order. Keep all new continuity state optional at boot and
rebuildable. Phase 0 is the first implementation task; no phase may bypass the source-link
invariant.

## Phase 0 — source and identity audit

- [x] 0.1 Trace session message, checkpoint, trace, memory, experience, and journal source
  lifecycles, including fork lineage and rewind branch semantics; identify stable IDs and
  delete/restore hooks. Current behavior, the path-derived local project partition
  limitation, and the legacy-line identity fallback are recorded in the design's source
  lifecycle table. The index stores no absolute path in a record.
- [x] 0.2 Add versioned Zod contracts and unit/integration fixtures for source references,
  episodes, speech-act labels, timezone metadata, temporal windows, and rollup
  invalidation contracts. Add source-local IANA timezone to new session-line metadata
  without rewriting old lines. Malformed, duplicated, stale-digest, and cross-project
  references are rejected by schemas/source verification. Rollup source-change behavior is
  covered by Phase 4.1 tests.
- [x] 0.3 Implement the accepted query-time timezone fallback and calendar-window rules;
  keep CLI spelling aligned with current command conventions. Inferred promotion stays
  candidate-only through the early phases; calibrate thresholds during Phase 4 dogfood.
  The global `timeZone` setting is validated and project settings cannot override it.

## Phase 1 — cross-project local episode catalog

- [x] 1.1 Add a safe all-project session enumerator on the existing session root; preserve
  project-specific session APIs. Skip trash/locks/temp files, dedupe checkpoint copies,
  and resolve inherited fork context through immutable source-line boundaries, including
  nested forks. Checkpoint and rewind snapshots are excluded from canonical episodes.
- [x] 1.2 Add `ContinuityStore` and an idempotent indexer keyed by source line ID, with
  atomic writes, schema version, bounded summaries, topic/date/scope metadata, and
  rebuild support. New session turns update only their owning session's index entries;
  explicit rebuild scans the local archive. The index contains no full transcript copy.
- [x] 1.3 Add timezone-aware date parsing/window utilities and deterministic timeline
  search over all projects, including exact date, today/yesterday, ISO week, weekday,
  month, quarter, year, rolling days, and explicit timezone cases.
- [x] 1.4 Add `athena memory rebuild`/`status` and noninteractive timeline/search/show
  commands. Corrupt index warns, returns no unvalidated records, and explicit rebuild
  replaces it; optional indexing does not block startup or completed turns.
- [x] 1.5 Add integration tests proving an episode is searchable from another project
  and its message text resolves to the expected source session and adjacent turns.

## Phase 2 — answer-time recall and user controls

- [ ] 2.1 Wire a read-only continuity retrieval interface into the agent turn path and
  prompt contract. This requires explicit user authorization for sending relevant,
  source-verified history from other projects to the configured model provider. The local
  catalog, CLI, and slash retrieval surfaces do not send episode text to a provider.
- [x] 2.2 Add inspectable `/memory` status/rebuild/search/timeline/show actions and
  accessible equivalents in line mode. Maintain parity with CLI.
- [ ] 2.3 Verify automatic answer-time no-hit, ambiguous-time, same-topic multi-project,
  stale source, and source retrieval behavior after the prompt handoff is authorized.
  Local CLI/slash no-hit, ambiguous-time, stale-source, and source-read failures are
  covered independently.

## Phase 3 — durable semantic memory and lifecycle

Progress (2026-09-23): the versioned semantic record schema and lifecycle store, explicit
remember/review/correction paths, conservative source-verified candidate generation, and
local CLI/slash review commands are implemented. Inferred candidates are generated only
from the same direct user claim in at least two distinct, digest-verified sessions; they
remain candidates until an explicit review. Sensitive claims are not copied into inferred
semantic storage; explicit memory remains a separate user-directed path.
Forget/source-deletion integration and full Phase 3 verification remain open. The
forget source-retention choice is still awaiting the product owner's answer.

- [x] 3.1 Extend `Memory` records/tool with source references, observed/valid time, scope,
  speech act, sensitivity, confidence, candidate/active/flagged/superseded/rejected/tombstoned
  state, and correction links. Reuse memory-hygiene's canonical write/index path.
- [ ] 3.2 Implement explicit remember, candidate review, correct/supersede, and forget.
  Prevent inferred single-episode facts from becoming active durable facts.
  - [x] Explicit remember, candidate review, and correct/supersede use the semantic
    lifecycle store; inferred records cannot be promoted from one source.
  - [x] Generate candidates only from repeated, direct user preferences/decisions/promises
    across distinct, source-digest-verified sessions; reject tentative, interrogative,
    assistant-authored, stale, incomplete, truncated, and credential-bearing evidence.
    Scope stays project-local
    until evidence spans projects; sensitive claims are excluded from inferred semantic
    storage.
  - [x] Add explicit `athena memory candidates` / `/memory candidates` generation and
    bounded local review listings, plus `athena memory review <id> <promote|reject>` /
    `/memory review <id> <promote|reject>`. Never auto-promote or send candidate text to a
    provider. Reverify every inferred source at promotion time, including role, claim,
    observation time, project scope, and sensitive wording; changed evidence leaves the
    record a candidate. Existing explicit/rejected/terminal decisions suppress duplicates.
  - [x] Verify session-backed semantic source lines before `Memory.read` returns managed
    memory text; suppress reads when the session or source line is missing or trashed, its
    timestamp or kind mismatches, or the source message is not user-authored.
  - [x] Keep candidate, flagged, rejected, and tombstoned semantic content out of the
    model-facing `Memory.read`; those states remain available through local review.
  - [ ] Implement forget and derived-record suppression after the source-retention choice
    is answered.
- [ ] 3.3 Integrate user deletion and session delete/restore with continuity tombstones and
  rollup invalidation. Prove rebuild cannot resurrect forgotten material.

## Phase 4 — hierarchical time views and calibration

- [x] 4.1 Add day/week/month/quarter/year derived rollups with coverage refs, source
  digest, timezone, and generation version. Rollups are computed on demand from a complete
  index, with no cache; source correction/deletion is reflected after that session is reindexed.
- [x] 4.2 Add deterministic ranking across working, episodic, semantic, and rollup
  layers. `athena memory rank <query>` and `/memory rank <query>` provide a local-only,
  explainable preview: explicit time/project bounds, source/status/sensitivity filters,
  live-session availability checks, layer/intent and lexical ranking, rollup digest
  validation, top-five results, and only
  identifiers/metadata/reasons. The in-session command includes bounded current working
  text as a ranking input but never returns it; outputs expose counts, timing, and source
  IDs only. Trashing a source session suppresses its indexed episodes, linked semantic
  memories, and dependent rollups from ranking immediately, without waiting for rebuild.
  This is not wired into model prompts.
- [ ] 4.3 Dogfood across realistic multi-project histories; calibrate candidate promotion,
  relevance, time interpretation, latency, and correction rates without relaxing evidence
  requirements to chase recall volume.
  - [x] Add a deterministic synthetic gold corpus for candidate precision, scoped/time
    relevance, temporal interpretation, and current-versus-historical correction behavior;
    see [calibration snapshot](calibration.md).
  - [x] Profile a synthetic 10,000-episode index and cache only fully validated, immutable
    index/episode values by exact file digest. Warm indexed search measured 34.77–54.96 ms
    across 10 samples; see the checked-in benchmark script and report.
  - [x] Measure grouped source expansion and the shared CLI/slash search presenter against
    a synthetic 10,000-file session catalog; see [calibration snapshot](calibration.md).
  - [ ] Dogfood representative live histories and review usefulness, correction rates, and
    index-size ratio before tuning recall beyond the exact repeated-claim policy.
- [ ] 4.4 Complete threat/privacy review, update all linked memory docs, and run the full
  repository gates on the exact implementation state.
  - [x] Exclude inferred sensitive claims and credential-bearing source messages from
    semantic candidates; explicit sensitive storage uses the separate remember path.
  - [ ] Complete delete/restore/tombstone review after the source-retention choice and
    provider-prompt privacy review after handoff authorization.

## Optional Phase 5 — Jev decision model (integration proposed)

Jev is a TypeSafe System One model that returns structured judgments; it is not Athena's
conversation or answer model. The researched integration boundary and vendor-data review
are in [ADR 0003](adr/0003-jev-decision-model.md). The optional typed decision-client seam
is implemented, but no TypeSafe adapter or live call exists. A product question about
which first slice to pursue is still pending; recommendation is staged work with recall
routing first.

- [x] 5.1 Build a labeled synthetic recall-intent corpus and measure the current local
  routing baseline before selecting Jev thresholds or an adoption bar. The 49-case
  corpus and deterministic ranker-intent proxy are measured in
  [calibration.md](calibration.md); answer-time automatic history routing remains absent.
- [x] 5.2 Define an optional `DecisionClient` separate from streaming `ModelClient`; test
  typed output validation, fallback, timeout/rate-limit handling, zero calls while disabled,
  and content-free telemetry with a fake transport. The implementation is a dependency-
  injected seam only; it has no TypeSafe SDK, credentials, network transport, or harness
  call site.
- [ ] 5.3 If recall routing is selected, add the TypeSafe adapter behind an explicit
  opt-in. Send only the redacted current user request for the first slice; no source
  excerpts, summaries, memory text, IDs, or project paths. Keep local time, project,
  sensitivity, availability, and ranking rules authoritative.
- [ ] 5.4 Consider Jev-assisted speech-act/correction/commitment candidate detection only
  after the routing evaluation and a separate labeled precision study. Persisted source
  verification and explicit review remain required; no Jev decision promotes memory.
- [ ] 5.5 Pin the evaluated model version and document observed quality, latency, input
  volume, cost, and privacy limits before enabling a release default. `jev-latest` can
  change independently and is not suitable for calibrated rollout without reevaluation.
