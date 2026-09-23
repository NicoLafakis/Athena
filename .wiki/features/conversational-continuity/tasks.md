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

Progress (2026-09-23): the versioned semantic record schema, local lifecycle store, and
`Memory` tool paths for explicit remember, candidate review, and correction/supersession
are implemented. The record store does not inject semantic items into provider prompts.
Candidate generation from episode evidence, a user-facing review surface, forget/source
deletion integration, and full Phase 3 verification remain open. The forget source-retention
choice is still awaiting the product owner's answer.

- [ ] 3.1 Extend `Memory` records/tool with source references, observed/valid time, scope,
  speech act, sensitivity, confidence, candidate/active/flagged/superseded/rejected/tombstoned
  state, and correction links. Reuse memory-hygiene's canonical write/index path.
- [ ] 3.2 Implement explicit remember, candidate review, correct/supersede, and forget.
  Prevent inferred single-episode facts from becoming active durable facts.
- [ ] 3.3 Integrate user deletion and session delete/restore with continuity tombstones and
  rollup invalidation. Prove rebuild cannot resurrect forgotten material.

## Phase 4 — hierarchical time views and calibration

- [x] 4.1 Add day/week/month/quarter/year derived rollups with coverage refs, source
  digest, timezone, and generation version. Rollups are computed on demand from a complete
  index, with no cache; source correction/deletion is reflected after that session is reindexed.
- [ ] 4.2 Add retrieval ranking across working, episodic, semantic, and rollup layers;
  log only privacy-safe counts/timing/source IDs.
- [ ] 4.3 Dogfood across realistic multi-project histories; calibrate candidate promotion,
  relevance, time interpretation, latency, and correction rates without relaxing evidence
  requirements to chase recall volume.
- [ ] 4.4 Complete threat/privacy review, update all linked memory docs, and run the full
  repository gates on the exact implementation state.
