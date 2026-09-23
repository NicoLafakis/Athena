# Conversational Continuity — Test Strategy

> [Overview](00-overview.md) · [Requirements](requirements.md) · [Tasks](tasks.md)

## Requirements-to-test map

| Requirement | Level | Required evidence |
|---|---|---|
| FR-001 / AC-009 source identity | Unit + integration | Canonical messages indexed once; checkpoint copies excluded; fork lineage and rewind branches resolve |
| FR-002 / AC-001, AC-008 cross-project scope | Integration | Local CLI/slash recall across two projects works; project filters exclude unrelated sources. Prompt isolation remains pending provider-handoff authorization |
| FR-003 / AC-002 temporal parsing | Unit + property | Relative/absolute windows, DST, timezone fallback, month/quarter/year edges |
| FR-004 context reconstruction | Integration | Adjacent turns and source roles reconstruct tentative/decision/correction context |
| FR-005 / FR-010 / AC-004 layers/rollups | Unit + integration | Day/week/month/quarter/year boundaries and timezone behavior; complete-index gate; bounded summaries with full source-ID coverage; source digest changes after correction; rollups empty after deletion; exact detail still resolves through episodes |
| FR-006 / AC-003 speech acts | Unit | Hypothetical, question, preference, decision, promise, correction, retraction fixtures |
| FR-007 / AC-005 promotion | Unit + integration | Explicit remember; one-episode inference remains candidate; contradiction blocks promotion |
| FR-008 conflict lifecycle | Unit | Supersession preserves prior value/date/source; direct correction ranks correctly |
| FR-011 controls/accessibility | CLI + presentation integration | Search/show/review/correct/forget parity and bounded plain text output |
| FR-012 / AC-006 deletion | Integration | Delete/restore/forget; derived invalidation; rebuild does not resurrect tombstoned sources |
| FR-013 privacy | Security fixtures | Secret-shaped strings, PII patterns, path escapes, unsafe model output, no raw transcript copy |
| FR-014 / AC-010 budgets | Performance + prompt integration | Result count/characters capped; no background model calls; prompt has only relevant context |
| FR-015 / AC-007 rebuild/failure | Integration | Truncated JSONL, corrupt index, missing project, permission error, atomic-write failure |

## Implemented evidence at this checkpoint

- Rollup tests cover IANA local calendar boundaries, repeated DST hours, bounded on-demand
  summaries with complete source coverage, deterministic source digests, complete-index gating,
  and refreshed results after source correction or deletion.
- Schema and temporal unit tests cover bounded identities, duplicate/cross-scope refs,
  calendar boundaries, DST, and explicit/inferred timezone behavior.
- Session/catalog tests cover stable legacy IDs, canonical-line deduplication, nested
  fork boundaries, missing parents, and cycle detection.
- Store/retrieval tests cover idempotent rebuild, interrupted turns, incremental updates
  to one session, cross-project search, source-digest validation, and malformed JSONL/time
  records. Source text is shown only after every linked line verifies.
- CLI/slash/controller tests cover local status, rebuild, timeline, search, show, and
  indexing after persisted turns. A non-persisted session does not create an index entry.
- Semantic-memory tests cover strict metadata validation, explicit persisted-message
  source resolution, candidate support thresholds, sensitive-inference promotion guards,
  review, correction/supersession links, body preservation, and isolation from the
  prompt-injected memory index.
- No answer-time provider handoff is implemented. Requirements that depend on retrieved
  history entering a model prompt remain future integration tests and are not claimed as
  covered by these local retrieval tests.

## Critical end-to-end scenarios

1. Write messages in projects A and B on multiple dates; from B, use local memory
   timeline/search for project A’s “earlier today” episode and inspect exact source
   context. After provider handoff is authorized, add the automatic-answer variant.
2. Fork a session and rewind another; verify inherited checkpoint messages are linked once
   to their original source and branch-only conversation remains historically attributable.
3. Record a tentative idea, a later decision, then a correction. Query current and
   historical state and ensure no summary turns “maybe” into “decided.”
4. Build a week/month/year rollup; ask for a precise detail; verify answer evidence comes
   from linked episodes, not rollup prose alone.
5. Forget an episode, rebuild all indexes, and prove its summary/derived claim is no
   longer retrievable. The original source session follows the selected forget policy;
   any recovery must be explicit and must not silently undo the suppression tombstone.
6. Corrupt one session line and the derived index; confirm valid neighbors remain usable,
   warning names `athena memory rebuild`, and boot/ordinary project work continue.
7. Ask a current-repository question after memory describes an older implementation;
   verify current file/tool evidence takes precedence.

## Test-quality rules

- Use fake dates/timezones and deterministic source IDs. No current wall-clock dependency
  in pure ranking tests.
- Assert both the answer-context payload and its source references; ranking tests alone do
  not prove correct context reconstruction.
- Assert negative behavior: no irrelevant project content, no promotion from one
  ambiguous utterance, no resurrected forgotten item, no unsupported recollection.
- Ensure every acceptance criterion maps to a test and that tests cover interactive and
  noninteractive paths.
- Do not treat local CLI/slash source display as evidence that provider prompt transfer,
  automatic relevance routing, or prompt-isolation behavior is implemented.
- Live dogfood is required for subjective recall usefulness, but it supplements rather
  than replaces deterministic correctness and privacy tests.
