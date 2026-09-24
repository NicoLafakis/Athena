# PRD: Conversational Continuity Across Time and Projects

> [Objective overview](00-overview.md) · [Requirements](requirements.md) ·
> [Technical design](design.md) · [Tasks](tasks.md)

- **Status:** Implementation in progress; linked-episode approach selected
- **Priority:** P1 — core product direction
- **Owner surface:** local sessions, `src/brain/`, prompt/tool integration, CLI memory controls
- **Migration:** additive derived index; no session transcript migration or rewrite
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
- **Direct controls:** local `athena memory status|rebuild|search|timeline|show|rollup|rank`,
  `athena memory candidates`, and `athena memory review <memory-id> <promote|reject>`
  commands, with equivalent in-session `/memory` commands. Candidate generation is an
  explicit local action that requires repeated direct user claims in distinct,
  source-verified sessions; review never happens automatically. Session delete/restore is
  integrated with continuity tombstones. Semantic-memory forget will suppress derived
  content while preserving its original session source; source deletion remains the
  separate session-delete action.
- **Common path:** one conversational question; no user-selected project/session when
  the request is unambiguous. Inspect/correct/forget actions require a clear target before
  mutation.
- **Empty/error:** no matches returns a plain no-match result; corrupt index leaves normal
  Athena use intact and names the rebuild command; ambiguous time/scope is stated or
  clarified.

Exact command syntax follows the current CLI parser. Local episode search, inspection,
ranking, candidate generation, and candidate review have CLI/slash parity. Session
delete/restore is implemented through `athena session delete|restore` and persistent
tombstones. Scoped automatic answer-time retrieval is implemented; semantic-memory forget
remains open.

## 9. Interface contract

Use a bounded read-only retrieval operation for automatic recall and explicit query
surfaces for timeline/search/ranking. Inputs include query, time range, project scope, and
result budget. Answer-time retrieval returns source-verified user/Athena messages with
speaker, date, timezone, coarse project label, and adjacent-turn relation; it does not
send summaries, semantic-memory bodies, rollup text, source IDs, or paths. The payload is
capped at five episodes/4,000 characters and exists only in the active answer-model call.
The implemented `athena memory rank` and `/memory rank` surfaces remain local previews
that show bounded identifiers and ranking explanations but no source text.
Mutating operations (remember, correct, and review) validate IDs and source links and go
through one local store API. Candidate generation writes only review-state records after
verifying source identities and digests. No raw absolute path or model-provided timestamp
is trusted as an identifier. Forget remains unimplemented; it will preserve the source
session while suppressing the derived semantic record. The exact TypeScript contracts are
in the design doc.

## 10. Security, privacy, and access control

Continuity indexes and summaries remain under the local per-user brain. Project
configuration cannot widen global memory retrieval or control the user-wide Jev setting.
The selected Jev decision call classifies route and speech act using only the current user
request after shared secret redaction when a TypeSafe key is configured. A high-confidence
speech-act label is stored locally against its exact message digest; its source text is not
duplicated. Prompts, assistant text, traces, and generated
summaries are untrusted inputs to parsing. Cap fields, avoid copying raw transcripts, and
do not infer sensitive attributes. The user authorized scoped answer-provider recall on
2026-09-23. Only redacted source-verified user/Athena text for the current history request
may cross that boundary; local project filters, tombstones, and source checks remain
authoritative. The shared redactor does not classify general PII or arbitrary sensitive
prose. See the [threat model](threat-model.md).

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

Local diagnostics record counts, duration, index version, and source IDs only. Decision
traces may record provider/model, outcome, duration, and token counts; they never record
request or response content. Do not log query text, memory content, summaries, personal
values, or full paths. `/memory status` reports indexed-source count, last successful
scan, stale/missing index condition, and recovery guidance without printing content.

## 14. Error handling and user feedback

Index and rollup failures are nonfatal. Stale source refs return an explicit unavailable
source marker and schedule/allow rebuild; they do not silently fall back to a summary as
fact. Mutating a memory without resolving ambiguity is rejected with a specific
instruction. Corrupt optional data reports the artifact and `athena memory rebuild`.

## 15. Performance and cost

Indexing and local recall search make no provider call. Jev may make one synchronous,
one-second-bounded call per user turn when a TypeSafe key is configured; its input and
cost are measured by the synthetic evaluator and token trace. Jev receives no historical
context. The answer provider may receive the bounded source excerpts described in FR-013
for a current history request; this is the ordinary user-request call, never an automatic
boot/session-end call. Candidate and prompt budgets are explicit.

## 16. Accessibility

CLI, TUI, screen-reader line mode, and in-session controls expose the same list/show/
review/forget capabilities. Lists are windowed and bounded, actions are named in text,
and no memory identity depends on color, position, or animation.

## 17. Phases and rollout

1. Cross-project source catalog and date-scoped episode retrieval.
2. Context reconstruction, automatic recall integration, and inspectable controls.
3. Long-term memory provenance, explicit promotion, corrections, and forgetting.
4. Day/week/month/quarter/year rollups and calibration from dogfood.
5. Jev recall routing and source-linked speech-act intake, accepted and integrated; live
   synthetic quality evaluation remains pending a TypeSafe credential.

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

No external service or paid dependency is added. Main integration points: `SessionStore`,
`BrainPaths`, memory loader/tool, prompt assembly or read-only memory tool, and CLI
composition. Local indexing is optional at boot; automatic recall is limited to routed
history requests and the documented source/payload checks.

## 21. Open questions

- Linked episodes are confirmed. Existing session retention remains the policy; this
  feature introduces no automatic deletion.
- Forgetting a semantic record suppresses its derived content while preserving the source
  session. Source deletion remains an independent, explicit `athena session delete` action.
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
