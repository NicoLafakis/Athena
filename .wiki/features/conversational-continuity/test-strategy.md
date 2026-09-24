# Conversational Continuity — Test Strategy

> [Overview](00-overview.md) · [Requirements](requirements.md) · [Tasks](tasks.md)

## Requirements-to-test map

| Requirement | Level | Required evidence |
|---|---|---|
| FR-001 / AC-009 source identity | Unit + integration | Canonical messages indexed once; checkpoint copies excluded; fork lineage and rewind branches resolve |
| FR-002 / AC-001, AC-008, AC-012 cross-project scope | Integration | Local CLI/slash recall and automatic answer-time retrieval across projects; named-project filter excludes unrelated sources and ambiguous/unknown names clarify |
| FR-003 / AC-002 temporal parsing | Unit + property | Relative/absolute windows, DST, timezone fallback, month/quarter/year edges |
| FR-004 context reconstruction | Integration | Adjacent turns and source roles reconstruct tentative/decision/correction context |
| FR-005 / FR-010 / AC-004 layers/rollups | Unit + integration | Day/week/month/quarter/year boundaries and timezone behavior; complete-index gate; bounded summaries with full source-ID coverage; source digest changes after correction; rollups empty after deletion; exact detail still resolves through episodes |
| FR-006 / AC-003 speech acts | Unit | Hypothetical, question, preference, decision, promise, correction, retraction fixtures |
| FR-007 / AC-005 promotion | Unit + integration | Explicit remember; repeated direct user claim across two digest-verified sessions creates a candidate only; same-session repetition, tentative/question/assistant/stale/truncated evidence is excluded; sensitive claims are excluded from inferred semantic records; rejection/explicit memory suppress duplicate inference |
| FR-008 conflict lifecycle | Unit | Supersession preserves prior value/date/source; direct correction ranks correctly |
| FR-011 controls/accessibility | CLI + presentation integration | Search/show/rank/candidate generation and promote/reject review parity with bounded plain text output; correct/forget parity remains planned |
| FR-012 / AC-006 deletion | Integration | Session delete/restore tombstones suppress episodes, linked semantic records, and derived rollups; rebuild does not resurrect trashed sources. Semantic-memory forget remains pending its source-retention choice. |
| FR-013 privacy | Security fixtures | Secret-shaped strings in episode and candidate data, path escapes, unsafe model output, no raw transcript copy; broad PII classification remains outside the current redactor |
| FR-014 / AC-010 budgets | Ranking + performance + prompt integration | Local candidate caps and privacy-safe metrics; automatic handoff is request-triggered, capped at five episodes/4,000 characters, and absent from Jev, hooks, persisted messages, and logs |
| FR-015 / AC-007 rebuild/failure | Integration | Truncated JSONL, corrupt index, missing project, permission error, atomic-write failure |
| Live-source presentation | Integration | Move a source session into `.trash` without rebuilding; ranking, linked semantic memory, direct `Memory.read`, and rollup text disappear immediately |
| Jev recall routing (accepted and integrated) | Decision unit + fake SDK transport + engine integration + synthetic live evaluation | Verify disabled/missing-key zero calls, exact secret-redacted request fields, fixed model and labels, strict output shape, usage-only telemetry, timeout/rate-limit/oversized-input fallback, and transient prompt guidance. Run the 49-case synthetic live comparison when a TypeSafe key is available. |
| Jev speech-act intake (accepted and integrated) | Fake SDK transport + engine/controller integration + source-index/retrieval/candidate tests + synthetic live evaluation | Verify one current-request call returns both typed decisions; only high-confidence labels are stored after the user line is written; the stored event is content-free and digest-linked; edited sources invalidate labels; indirect preference/decision/commitment candidates remain review-only and require independent sessions; corrections/retractions are contextual labels only. Run the balanced 36-case live comparison when a TypeSafe key is available. |

## Implemented evidence at this checkpoint

- Rollup tests cover IANA local calendar boundaries, repeated DST hours, bounded on-demand
  summaries with complete source coverage, deterministic source digests, complete-index gating,
  and refreshed results after source correction or deletion.
- Session lifecycle tests cover restoration of the most recent recoverable JSONL source,
  tombstone suppression across store restart and rebuild, refusal to reindex a tombstoned
  source, rollup invalidation, explicit restore and reindex, and fail-closed preservation of
  a corrupt tombstone ledger.
- Schema and temporal unit tests cover bounded identities, duplicate/cross-scope refs,
  calendar boundaries, DST, and explicit/inferred timezone behavior.
- Session/catalog tests cover stable legacy IDs, canonical-line deduplication, nested
  fork boundaries, missing parents, and cycle detection.
- Store/retrieval tests cover idempotent rebuild, interrupted turns, incremental updates
  to one session, cross-project search, source-digest validation, and malformed JSONL/time
  records. Source text is shown only after every linked line verifies.
- CLI/slash/controller tests cover local status, rebuild, timeline, search, show, and
  indexing after persisted turns. A non-persisted session does not create an index entry.
- Answer-time recall tests cover Jev confidence/routing, deterministic explicit-request
  fallback, no-recall requests, no-hit and ambiguous-time behavior, cross-project matches,
  named-project filtering and ambiguity, semantic navigation to source episodes, bounded
  adjacent turns, tombstones, stale digests, credential redaction, fake-delimiter/speaker
  neutralization, tool-block exclusion,
  and the five-episode/4,000-character cap. Engine/controller tests assert the history
  bundle is transient and reaches only the active answer-model request.
- Semantic-memory tests cover strict metadata validation, explicit persisted-message
  source resolution, candidate support thresholds, exclusion of repeated sensitive claims
  and credential-bearing sources from inferred records, explicit sensitive memory through
  the separate user-requested path, review, correction/supersession links, body preservation,
  and isolation from the prompt-injected memory index.
- Candidate-generation tests cover direct repeated claims across independent sessions,
  project-to-global scope, digest verification, conservative sensitive handling,
  idempotent support merging, incomplete-catalog and truncated-source rejection, and
  suppression by existing explicit/rejected records. CLI process and slash integration
  tests generate a candidate locally and apply an explicit promotion without a model call.
  The Memory tool and review service also prove that a source changed after listing, or
  scope/time/sensitivity metadata no longer matches its sources, blocks promotion and leaves
  the record in candidate state.
- Ranking tests cover working/episodic/semantic/rollup selection, intent and speech-act
  boosts, hard project/time windows, semantic validity and sensitivity, historical
  supersession, stale-rollup rejection, deterministic top-five bounds, explanation
  reasons, and metrics containing only counts/timing/source IDs. CLI/slash integration
  checks rank available local layers while withholding query and source text.
- The rollup integration test trashes a synthetic source without rebuilding and verifies
  its episode ID, linked semantic memory ID, and derived rollup summary disappear from
  rank/rollup presentations immediately.
- Memory-tool tests verify the source line and user role before returning managed
  semantic content, then trash that session and assert `Memory.read` no longer returns it.
  An unreviewed inferred candidate is also tested to ensure model-facing reads cannot
  return its claim text.
- Jev routing uses a balanced, 49-case synthetic recall-intent corpus. Its baseline
  regression locks the current local ranker's proxy confusion matrix, including the
  absence of a `none` class and the resulting proxy false positives. The local baseline
  remains ranking metadata and does not represent the Jev route now wired to turn handling.
  A separate
  `bench/jev-recall-evaluation.ts` sends only those synthetic request strings to the
  pinned Jev model and reports route quality, coverage, no-recall false positives, Brier
  score, latency, token volume, and estimated cost. It has not been run because
  `TYPESAFE_API_KEY` was unavailable; no live quality result is claimed.
- The optional `DecisionClient` seam is separate from streaming `ModelClient`. Fake-
  transport tests cover typed response validation, disabled/unavailable fallback, timeout
  abort, rate-limit fallback, content-free outcome/latency/token telemetry, and isolation
  from telemetry sink failures. The TypeSafe adapter test uses an injected fake HTTP fetch
  to verify the exact request body and output mapping. Engine tests verify route guidance
  exists only in the active answer call and is absent from persisted messages.
- Jev speech-act tests cover all nine typed labels in the balanced synthetic fixture,
  confidence-gated persistence precision metrics, exact current-message source digests,
  retrieval/index propagation, repeated indirect claim candidates, and correction/retraction
  labels that do not create inferred memory. The live evaluator sends synthetic text only
  and has not been run because `TYPESAFE_API_KEY` is unavailable.
- [`calibration.md`](calibration.md) records deterministic synthetic quality measures and
  a 10,000-episode/10,000-session-file local performance sample, including the shared
  search presenter and verified source expansion. These measurements do not claim TUI
  rendering costs or subjective live-dogfood quality.

## Critical end-to-end scenarios

1. Write messages in projects A and B on multiple dates; from B, retrieve project A’s
   “earlier today” episode through both local search and the automatic answer path. Verify
   exact source text, adjacent-turn relationship, project/date labels, and the provider
   boundary cap.
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
- Keep local source-display tests distinct from provider-boundary tests; both are required
  to establish source verification, automatic relevance routing, and prompt isolation.
- Jev is the selected intent provider. Adapter tests use a fake HTTP fetch; evaluation
  requests use synthetic text only. Verify that the request contains no historical source
  or project identifiers, and that Jev output cannot bypass local source, scope,
  sensitivity, permission, or memory-review gates. Jev sees only the redacted current
  request. Separately authorized answer-provider recall is limited to verified and
  redacted user/Athena episode text for that request; no historical text is sent to Jev.
- Live dogfood is required for subjective recall usefulness, but it supplements rather
  than replaces deterministic correctness and privacy tests.
