# PRD: Conversational Continuity Across Time and Projects

> [Objective overview](00-overview.md) · [Requirements](requirements.md) ·
> [Technical design](design.md) · [Tasks](tasks.md)

**Status:** Proposed; linked-episode approach selected
**Priority:** P1 — core product direction
**Owner surface:** local sessions, `src/brain/`, prompt/tool integration, CLI memory controls
**Migration:** additive derived index; no session transcript migration or rewrite
**Related:** [ADR 0001](adr/0001-source-linked-episodes.md),
[ADR 0002](adr/0002-layered-memory-promotion.md)

## 1. Overview, problem, goal

Athena persists sessions, but their project-scoped organization makes conversational
recall depend on knowing which project/session contains the answer. She also lacks an
explicit distinction between temporary working context, dated episodes, and durable
personal facts. Build local, source-linked cross-project recall that can answer across
time horizons without flattening tentative speech, losing context, or duplicating the
conversation archive.

## 2. Load-bearing invariant

Every memory used to make a factual claim about the user or their history must retain a
resolvable source and the context needed to interpret it. A derived summary without
adequate source evidence cannot be presented as remembered fact.

## 3. Goals

1. Retrieve relevant past conversation across projects and temporal windows.
2. Keep the distinction between current/open state, historical episode, and enduring
   semantic memory explicit in storage and retrieval.
3. Preserve speaker, speech act, time, scope, uncertainty, and source relationships.
4. Allow inspection, correction, supersession, and forgetting without resurrection from
   index rebuilds.
5. Keep operation local, bounded, auditable, and optional at boot.

## 4. Non-goals

See [requirements](requirements.md). In particular, this does not add cross-machine
replication, a cloud vector database, an always-on listener, or a second copy of raw
conversation history.

## 5. Persona and user stories

Nico uses Athena across coding projects and ordinary conversation. He wants Athena to
remember what happened earlier today or months ago, understand which prior context a
question refers to, and keep an enduring preference or decision tied to its source and
date. The full stories are in [requirements](requirements.md).

## 6. Functional requirements

FR-001 through FR-015 and acceptance criteria AC-001 through AC-010 in
[requirements](requirements.md) are normative. Implementation must not narrow cross-
project recall to the current `cwd`.

## 7. Data model and schema

Implement versioned Zod-validated source references, episode records, memory candidates,
active semantic memories, and time rollups as described in [technical design](design.md).
Source identity uses project slug, session ID, source line ID, and source timestamp, not
an absolute path embedded in a memory claim. Generated summaries are bounded and always
carry source IDs. Dates are stored in UTC plus captured timezone context; resolved query
windows retain the timezone used.

Storage is additive under the per-user Athena brain. Existing session files remain
untouched. Index versions support rebuild and can be discarded without destroying source
history. Memory-file changes reuse the existing `Memory` tool/index discipline and its
planned metadata extension; they do not create an independent durable fact store.

## 8. Surfaces and experience

- **Automatic recall:** the assistant consults a read-only continuity interface when a
  request depends on earlier conversation, chronology, a remembered preference, or an
  unresolved conversational commitment. Source-backed results are clearly distinguished
  from the model’s inference.
- **Direct controls:** `athena memory search`, `athena memory timeline`,
  `athena memory show`, `athena memory review`, and `athena memory forget`, with
  equivalent in-session `/memory` commands and append-only presentation wording.
- **Common path:** one conversational question; no user-selected project/session when
  the request is unambiguous. Inspect/correct/forget actions require a clear target before
  mutation.
- **Empty/error:** no matches returns a plain no-match result; corrupt index leaves normal
  Athena use intact and names the rebuild command; ambiguous time/scope is stated or
  clarified.

Exact command syntax may follow current CLI parser conventions, but all five operations
and their noninteractive forms are required before claiming parity.

## 9. Interface contract

Use a bounded read-only retrieval operation for automatic recall and explicit query
surfaces for timeline/search. Inputs include query, time range, scope, and result budget;
outputs include summaries, classifications, confidence, dates, and source references.
Mutating operations (remember, correct, forget, review) validate IDs and source links and
go through one local store API. No raw absolute path or model-provided timestamp is
trusted as an identifier. The exact TypeScript contracts are in the design doc.

## 10. Security, privacy, and access control

All data remains under the local per-user brain. No project configuration can widen
global memory retrieval or trigger external transmission. Prompts, assistant text, traces,
and generated summaries are untrusted inputs to parsing. Reuse secret redaction, cap all
fields, avoid copying raw transcripts, and do not infer sensitive attributes. Retrieval
must not expose another project’s detail unless relevant to the user’s request. See the
[threat model](threat-model.md).

## 11. Data integrity and write path

Session JSONL remains canonical. Derived indexes are rebuildable and versioned. Index
updates and tombstones use atomic writes; each source event is idempotently indexed by
stable source identity. Correction writes a new value plus supersession relation; it
never edits the historical source. Forgetting writes a suppression/tombstone before
derived data is removed, so rebuild cannot resurrect it. Existing session delete-to-trash
semantics and any explicitly implemented restore path must be tested with continuity
data.

## 12. Testing

Follow the [test strategy](test-strategy.md): deterministic parser/window tests, source
link and context reconstruction tests, promotion/supersession lifecycle tests, multi-
project retrieval integration, deletion/rebuild tests, privacy fixtures, and end-to-end
tool-to-prompt behavior. Verify against acceptance criteria and the invariant.

## 13. Observability

Local diagnostics record counts, duration, index version, and source IDs only. Do not log
query text, memory content, summaries, personal values, or full paths. `/memory status`
reports indexed-source count, last successful scan, stale/missing index condition, and
recovery guidance without printing content.

## 14. Error handling and user feedback

Index and rollup failures are nonfatal. Stale source refs return an explicit unavailable
source marker and schedule/allow rebuild; they do not silently fall back to a summary as
fact. Mutating a memory without resolving ambiguity is rejected with a specific
instruction. Corrupt optional data reports the artifact and `athena memory rebuild`.

## 15. Performance and cost

Local recall adds no provider call by itself and is bounded by the NFR budgets. If the
current response model summarizes retrieved evidence, that is the ordinary user-request
call, never an automatic boot/session-end call. Relevance ranking is local and
deterministic. Candidate and prompt budgets are explicit.

## 16. Accessibility

CLI, TUI, screen-reader line mode, and in-session controls expose the same list/show/
review/forget capabilities. Lists are windowed and bounded, actions are named in text,
and no memory identity depends on color, position, or animation.

## 17. Phases and rollout

1. Cross-project source catalog and date-scoped episode retrieval.
2. Context reconstruction, automatic recall integration, and inspectable controls.
3. Long-term memory provenance, explicit promotion, corrections, and forgetting.
4. Day/week/month/quarter/year rollups and calibration from dogfood.

Every phase is local-first and reversible. The derived index is rebuilt rather than
backfilled destructively. See [rollout](rollout.md).

## 18. Reuse, do not fork

- Extend `SessionStore`/session JSONL identity and `projectSlug`; do not create a second
  transcript archive.
- Reuse `redactSessionValue`, `atomicWriteFileSync`, Zod schemas, `BrainPaths`, and local
  JSONL storage patterns.
- Extend the existing `Memory` tool and memory index for source-linked durable user
  memories; do not duplicate `LearningMemoryStore` or `ExperienceStore`.
- Keep RunTrace/`self-reflection-journal.md` as operational evidence and
  `ExperienceStore` as prior task outcome advice. Continuity may retrieve/link these but
  does not own them.
- Keep current engine events authoritative for live state; historical memory cannot
  override current runtime, permission, or repository evidence.

## 19. Acceptance criteria

The implementation must pass AC-001 through AC-010 and preserve the load-bearing
invariant. Each criterion maps to at least one automated test in the test strategy.

## 20. Dependencies and integration points

No external service or paid dependency. Main integration points: `SessionStore`,
`BrainPaths`, memory loader/tool, prompt assembly or read-only memory tool, and CLI
composition. The implementation tasks identify exact boundaries after inspecting the
current call path. No feature flag is necessary for local read-only indexing; automatic
prompt use is opt-in during rollout.

## 21. Open questions

- Linked episodes are confirmed. Existing session retention remains the policy; this
  feature introduces no automatic deletion.
- Recommended default for “forget this memory”: suppress its derived content from recall
  while preserving the source session. The separate question of whether forgetting a
  memory should also erase its source conversation is awaiting user preference and blocks
  finalizing Phase 3 deletion semantics.
- The minimum independent evidence threshold for inferred long-term promotion must be
  calibrated during dogfood and kept configurable/testable. The first release may keep
  inferred items as review candidates only.
- Calendar query windows use the user's configured IANA timezone (OS local IANA timezone
  fallback, labeled as an inference); an explicitly named zone overrides it. Source
  events retain UTC timestamps and any captured source-local date/zone. Legacy events
  without a zone are displayed in the query timezone and labeled as inferred; the index
  does not bake in a guessed local date.
  Calendar intervals are start-inclusive/end-exclusive, weeks use ISO Monday-Sunday, and
  “past N days” means an elapsed rolling interval. See [temporal normalization in the
  design](design.md#retrieval-and-routing).

## 22. Companion ADRs

- [ADR 0001: source-linked local episodes](adr/0001-source-linked-episodes.md) — accepted.
- [ADR 0002: layered memory promotion](adr/0002-layered-memory-promotion.md) — accepted
  policy direction; promotion thresholds remain configurable.
