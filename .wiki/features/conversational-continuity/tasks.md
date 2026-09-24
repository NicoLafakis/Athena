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

- [x] 2.1 Wire read-only continuity retrieval into the agent turn path and prompt
  contract. The user authorized scoped recall on 2026-09-23. Jev high-confidence history
  routes (>= 0.98) or a clear deterministic explicit-recall fallback can select local
  history. Source text is reverified, redacted, and limited to five episodes/4,000
  characters; only user/Athena text is sent to the configured answer model. Project
  filters, semantic/rollup navigation, time scope, tombstones, and adjacent-turn labels are
  handled locally. Jev, hooks, persisted messages, and logs receive no retrieved excerpts.
- [x] 2.2 Add inspectable `/memory` status/rebuild/search/timeline/show actions and
  accessible equivalents in line mode. Maintain parity with CLI.
- [x] 2.3 Verify answer-time no-hit, ambiguous-time, same-topic multi-project, explicit
  and ambiguous project scope, stale source, source retrieval, tombstone suppression,
  redaction, tool-block exclusion, and payload caps. Engine/controller tests also confirm
  that retrieved context is transient and isolated to the active answer call.

## Phase 3 — durable semantic memory and lifecycle

Progress (2026-09-23): the versioned semantic record schema and lifecycle store, explicit
remember/review/correction/forget paths, conservative source-verified candidate generation,
and local CLI/slash/Memory-tool controls are implemented. Forget atomically replaces the
derived body and description with a generic tombstone, drops source digests, timezones,
support episode IDs, original observation/validity dates, and project scope, and retains
typed source identity fields only as needed to suppress candidate regeneration from those
exact lines. The canonical source session remains available for explicit history recall.
Inferred candidates still require repeated
direct user claims in distinct, digest-verified sessions and explicit review. Sensitive
claims remain excluded from inferred semantic storage. All four repository gates and the
full test suite pass on this implementation state; cross-platform CI is pending after push.

- [x] 3.1 Extend `Memory` records/tool with source references, observed/valid time, scope,
  speech act, sensitivity, confidence, candidate/active/flagged/superseded/rejected/tombstoned
  state, and correction links. Reuse memory-hygiene's canonical write/index path.
- [x] 3.2 Implement explicit remember, candidate review, correct/supersede, and forget.
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
    timestamp, exact persisted-line digest, or kind mismatches, or the source message is
    not user-authored. UUID-backed legacy citations without a digest fail closed; ID-less
    legacy citations remain protected by their content-derived stable identity.
  - [x] Keep candidate, flagged, rejected, and tombstoned semantic content out of the
    model-facing `Memory.read`; those states remain available through local review.
  - [x] Forget erases derived body/description and suppresses repeat inference from the
    exact original source lines while preserving those canonical sessions for history.
- [x] 3.3 Integrate user deletion and session delete/restore with continuity tombstones and
  rollup invalidation. Prove rebuild cannot resurrect forgotten material.
  - [x] `athena session delete` writes a versioned content-free tombstone before moving the
    canonical JSONL to `.trash`; episodes, linked semantic records, and dependent rollups
    are suppressed immediately, and rebuild skips tombstoned sources.
  - [x] `athena session restore <id>` restores the recoverable source (or accepts a still-live
    source after an interrupted delete), then clears its tombstone and reindexes it. Corrupt
    tombstone state fails closed and is preserved for recovery rather than overwritten.
  - [x] Add semantic-memory forget with source preservation; session restore does not
    silently undo its durable source-line suppression.

## Phase 4 — hierarchical time views and calibration

- [x] 4.1 Add day/week/month/quarter/year derived rollups with coverage refs, source
  digest, timezone, and generation version. Rollups are computed on demand from a complete
  index, with no cache; source correction is reflected after reindexing, while deletion
  tombstones immediately suppress the source and its derived rollups.
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
  - [x] Run a bounded read-only spot-check against the available local archive. A query
    with a specific model name had no direct source match, but the initial ranking preview
    selected unrelated episodes because “model” counted as topical evidence. Ranking now
    strips generic recall/intent cues before subject matching; regression coverage requires
    a subject match or bounded time window. No session text or IDs are recorded in the
    calibration snapshot.
  - [ ] Dogfood representative live histories and review usefulness, correction rates, and
    index-size ratio before tuning recall beyond the exact repeated-claim policy. The
    available local archive is too small to close this gate.
- [x] 4.4 Complete threat/privacy review, update all linked memory docs, and run the full
  repository gates on the exact implementation state.
  - [x] Exclude inferred sensitive claims and credential-bearing source messages from
    semantic candidates; explicit sensitive storage uses the separate remember path.
  - [x] Review the session delete/restore tombstone lifecycle: the ledger stores only
    project/session IDs and deletion time, fails closed on corruption, and cannot be
    cleared until the source is live again.
  - [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` on commit
    `72e2833`; all passed. The follow-up CI run passed on Node 20 and 22 across Linux,
    macOS, and Windows.
  - [x] Re-run all four repository gates after semantic-memory forget; typecheck, lint,
    150 test files / 1,420 tests, and build pass. Follow-up CI passed on commit `949b3e9`
    across all six Node/OS matrix jobs.
  - [x] Complete semantic-forget threat/privacy review: semantic text and description are
    removed, source IDs and minimal lifecycle metadata remain for suppression, and the
    source session remains available for explicitly requested historical recall.
  - [x] Review the automatic answer-provider boundary: scoped user request only, local
    source verification, ordinary active semantic records as navigation-only, rollups as
    navigation-only, adjacent turn labels, shared secret redaction, five-episode/4,000-
    character cap, no tools/paths/IDs/hooks/Jev/history persistence, and prompt-isolation
    coverage. General PII and sensitive-prose detection remain outside the shared redactor.
  - [x] Reconcile route precedence and synthetic calibration/holdout results across the
    linked continuity design, requirements, calibration, task, test, and NFR documents;
    update the affected pages and run all four repository gates after this update. The
    representative real-history gate remains tracked separately under 4.3.

## Phase 5 — Jev decision model (accepted; recall routing and speech-act intake implemented)

The product owner selected Jev for recall routing and explicitly approved speech-act
intake on 2026-09-23. Scoped answer-provider history retrieval was also authorized on
2026-09-23. The TypeSafe adapter and engine path are implemented. Each current
user request is classified for route and speech act in one request; only a route hint is
added to the answer-model prompt. High-confidence speech acts are stored locally as
content-free events linked to the exact persisted user line. Verified labels support
review-only candidate generation and contextual correction/retraction retrieval. Historical
text does not enter Jev prompts; scoped, source-verified excerpts enter the answer-model
prompt only for an explicit history request.
See [ADR 0003](adr/0003-jev-decision-model.md).

- [x] 5.1 Build labeled synthetic recall-intent corpora and measure the current local
  routing baseline. The balanced calibration, phrasing holdout, three boundary corpora,
  fresh audit, deterministic ranker-intent proxy, and live Jev comparison are measured in
  [calibration.md](calibration.md). Across 238 synthetic requests, raw accuracy was
  236/238 (99.2%); at the production 0.98 threshold, 170/170 eligible decisions were exact
  (100% precision) at 71.4% coverage, with no no-recall false positives. These do not
  measure real-history quality.
- [x] 5.2 Define an optional `DecisionClient` separate from streaming `ModelClient`; test
  typed output validation, fallback, timeout/rate-limit handling, zero calls while disabled,
  and content-free telemetry with a fake transport.
- [x] 5.3 Add the pinned TypeSafe adapter and route it through the harness. The global
  `jev.enabled` setting defaults to `true` following the product decision; project
  settings cannot override it. `TYPESAFE_API_KEY` is required for a network call. Each
  call sends only the shared-secret-redacted current user request (maximum 12,000
  characters), two fixed `Choice` questions, and pinned model `jev-1.13.0`. It sends no hook
  context, conversation history, episode text, summaries, memory text, IDs, or project
  paths. SDK request logging and retries are disabled; a two-second outer decision timeout
  with a 1.9-second SDK attempt timeout,
  invalid output, missing key, provider error, or explicit setting disable falls through
  without blocking normal work. The selected route is added only to the active model call;
  speech-act labels are handled as described in 5.4.
- [x] 5.4 Implement the approved Jev speech-act intake in the same decision request. Store
  only `preferred`, `decided`, `promised`, `corrected`, or `retracted` labels at confidence
  >= 0.98, as content-free local session events linked to the exact user-message digest.
  Index and retrieval revalidate each event against its persisted user line. Verified
  `preferred`/`decided`/`promised` labels can support inferred candidates only after matching
  content appears in at least two independent sessions; candidates remain review-only and
  the promotion path rechecks every source. Corrections and retractions are indexed as
  context labels and never silently overwrite or delete memory. The latest calibration and
  phrasing holdout scored 89/90 raw decisions exact; all 30 calibration and 5 holdout labels
  meeting the 0.98 persistence threshold were correct (35/35, 38.9% combined coverage).
  These are synthetic results, not real-user language quality claims.
- [x] 5.5 Pin `jev-1.13.0`, make global enablement the default as selected by the product
  owner, record content-free latency/token telemetry in local run traces, and add
  `bench/jev-recall-evaluation.ts` for a synthetic live comparison. The evaluator reports
  coverage, raw and confidence-gated route precision/recall, misclassified synthetic IDs,
  no-recall false positives, Brier score, latency, token volume, and estimated input cost.
  - [x] Run and record the balanced calibration, phrasing holdout, boundary corpora, and
    fresh boundary audit. Pinned `jev-1.13.0` scored 236/238 raw exact across 238 synthetic
    requests. At confidence >= 0.98, it made 170/170 exact decisions (71.4% coverage) with
    no no-recall false positives. Both raw errors were below the gate. These results do not
    measure real-user histories.
  - [x] Refine the `none` versus `asked` contract so generic new-work commands do not
    count as memory questions; expand calibration to eight cases per label and add an
    independent two-case-per-label phrasing holdout. The latest run scored 89/90 raw
    decisions exact with zero fallbacks. At the 0.98 persistence threshold, persisted-label
    precision was 30/30 (41.7% coverage) and 5/5 (27.8%). The all-label >= 0.98 frontier
    was 49/49 (68.1%) and 10/10 (55.6%). The evaluator reports coverage, confidence
    frontiers, fallback reasons, and misclassified synthetic IDs.
  - [x] Increase the Jev request budget from one to two seconds after a one-second run
    produced 12 provider-error fallbacks; fix the SDK timeout classification path and
    verify zero fallback in the repeated 72-case calibration and 18-case holdout runs.
