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
- [ ] 0.2 Add versioned Zod contracts and property/test fixtures for source references,
  episodes, speech-act labels, timezone metadata, temporal windows, and rollup
  invalidation. Add source-local IANA timezone to new session-line metadata without
  rewriting old lines. Done when malformed, duplicated, stale, and cross-project
  references fail safely.
- [ ] 0.3 Implement the accepted query-time timezone fallback and calendar-window rules;
  keep CLI spelling aligned with current command conventions. Inferred promotion stays
  candidate-only through the early phases; calibrate thresholds during Phase 4 dogfood.

## Phase 1 — cross-project local episode catalog

- [ ] 1.1 Add a safe all-project session enumerator on the existing session root; preserve
  project-specific session APIs. Skip trash/locks/temp files, dedupe checkpoint copies,
  and resolve inherited fork context through source lineage.
- [ ] 1.2 Add `ContinuityStore` and an idempotent indexer keyed by source line ID, with
  atomic writes, schema version, bounded summaries, topic/date/scope metadata, and
  rebuild support. No full transcript duplication.
- [ ] 1.3 Add timezone-aware date parsing/window utilities and deterministic timeline
  search over all projects, with exact-date, today, week, month, quarter, and year cases.
- [ ] 1.4 Add `athena memory rebuild`/`status` and noninteractive timeline/search/show
  commands. Corrupt index warns and rebuilds; startup remains nonfatal.
- [ ] 1.5 Add integration tests proving the same episode can be found from another project
  and opens the correct adjacent source messages.

## Phase 2 — answer-time recall and user controls

- [ ] 2.1 Wire a read-only continuity retrieval interface into the agent turn path and
  prompt contract. Require source-backed retrieval for historical conversational claims;
  keep results bounded and out of unrelated turns.
- [ ] 2.2 Add inspectable `/memory` actions for recall/timeline/show and accessible
  equivalents in line mode. Maintain parity with CLI.
- [ ] 2.3 Verify no-hit, ambiguous-time, same-topic multi-project, stale source, and source
  retrieval failures produce honest, useful answers without claiming unsupported recall.

## Phase 3 — durable semantic memory and lifecycle

- [ ] 3.1 Extend `Memory` records/tool with source references, observed/valid time, scope,
  speech act, sensitivity, confidence, candidate/active/flagged/superseded/rejected/tombstoned
  state, and correction links. Reuse memory-hygiene's canonical write/index path.
- [ ] 3.2 Implement explicit remember, candidate review, correct/supersede, and forget.
  Prevent inferred single-episode facts from becoming active durable facts.
- [ ] 3.3 Integrate user deletion and session delete/restore with continuity tombstones and
  rollup invalidation. Prove rebuild cannot resurrect forgotten material.

## Phase 4 — hierarchical time views and calibration

- [ ] 4.1 Add day/week/month/quarter/year derived rollups with coverage refs, source
  digest, timezone, and generation version. Rebuild on source correction/deletion.
- [ ] 4.2 Add retrieval ranking across working, episodic, semantic, and rollup layers;
  log only privacy-safe counts/timing/source IDs.
- [ ] 4.3 Dogfood across realistic multi-project histories; calibrate candidate promotion,
  relevance, time interpretation, latency, and correction rates without relaxing evidence
  requirements to chase recall volume.
- [ ] 4.4 Complete threat/privacy review, update all linked memory docs, and run the full
  repository gates on the exact implementation state.
