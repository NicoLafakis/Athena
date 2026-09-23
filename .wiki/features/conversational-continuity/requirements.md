# Conversational Continuity — Requirements

> [Objective overview](00-overview.md) · [PRD](prd.md) · [Technical design](design.md)

## Problem and goal

Athena’s history is durable but fragmented by project-scoped session stores. A user can
resume or search a session in its project, but Athena has no bounded, evidence-linked way
to answer conversational questions across projects and long time ranges. The goal is
fast, accurate recall with the originating context intact.

## User stories

- As Nico, I want to ask what happened earlier today, this week, or months ago from any
  project, so the current project does not determine what Athena can remember.
- As Nico, I want Athena to distinguish a thought, question, preference, promise, and
  final decision, so tentative conversation is not turned into false biography.
- As Nico, I want durable preferences and important facts to remain connected to their
  source episodes, so I can correct or inspect them later.
- As Nico, I want to find, correct, or forget remembered material, so continuity remains
  under my control.

## Functional requirements

### FR-001 — Canonical source and linked episode index

Session records remain the source of conversational text. A derived episode contains
bounded metadata/summary and stable references to source session and message-line IDs;
it does not duplicate full transcripts.

### FR-002 — Cross-project recall

When the user asks about earlier conversation without naming a project, retrieval searches
all locally indexed project sessions. An explicit project or scope narrows candidates.
Project-local facts are not silently injected into unrelated work.

### FR-003 — Temporal recall

Athena resolves relative and absolute time expressions using the timestamp and captured
timezone context of source events. Calendar query windows use the user's configured IANA
timezone (OS local IANA timezone fallback, labeled as inferred), with explicitly named
zones taking precedence. Weeks use ISO Monday-Sunday; “past N days” is an elapsed rolling
interval; intervals are start-inclusive/end-exclusive. Queries such as “earlier today,”
“last week,” “in August,” “this quarter,” and “last year” retrieve the matching window
and its context. Ambiguous boundaries are stated or clarified rather than silently guessed.

### FR-004 — Context-preserving source references

Every episode, rollup, and promoted semantic fact records its source references, source
speaker/type, project/conversation scope, observed time, and applicable/valid time when
known. Retrieval can load adjacent turns from the source session before answering.

### FR-005 — Memory classes

The system distinguishes active working context, episodic history, and durable semantic
memory. Time-window rollups are derived navigation aids, not another class of truth and
not substitutes for episodes.

### FR-006 — Speech-act and uncertainty preservation

Capture preserves distinctions such as asked, considered, preferred, decided, promised,
corrected, and retracted. A tentative or hypothetical statement cannot become an active
fact or commitment solely because it appears in a summary.

### FR-007 — Promotion policy

An explicit user request to remember may create a durable memory with a source link. An
inferred preference or recurring fact remains a candidate until it has independent
support and passes contradiction, sensitivity, and scope checks. The current conservative
generator recognizes repeated, directly authored preferences, decisions, and promises only
when their source sessions and digests verify; it never auto-promotes. Promotion never
erases the source episodes.

### FR-008 — Conflict and change

Conflicting memories remain individually traceable and are versioned/superseded rather
than silently merged. A newer direct correction is surfaced as the current state while
older state remains available as history.

### FR-009 — Query routing

Recall selection considers query intent, requested time, entities/topics, active
conversation, scope, evidence quality, confidence, and freshness. Current repository
facts continue to come from current files/runtime evidence, not a stale conversational
summary.

### FR-010 — Time rollups

Day, week, month, quarter, and year rollups identify their covered time range, source
episodes, generation version, and source freshness. A rollup is invalidated or rebuilt
when a source is forgotten or corrected. Exact recall loads source episodes as needed.

### FR-011 — Inspect and correct

The user can list/search/timeline memories, inspect a source episode, review semantic
candidates, correct a memory, mark a tentative inference as wrong, and see whether a result
is direct or inferred. Equivalent CLI and interactive presentation paths are provided.

### FR-012 — Forget and deletion integrity

Forgetting an episode or semantic fact removes it from retrieval and invalidates dependent
rollups. Rebuilds honor deletion tombstones and cannot silently resurrect forgotten
derived content. Forgetting a memory is distinct from deleting its source session.
Existing `athena session delete` moves the source file to per-project `.trash`; this
feature must integrate with that soft-delete path. It must not imply a user-facing restore
command exists until one is implemented.

### FR-013 — Privacy and locality

Continuity indexes and summaries are local to the OS user. No new cloud sync, external
service, raw transcript duplication, or background provider call is introduced. Existing
secret redaction is reused and expanded where needed for generated summaries.

### FR-014 — Bounded retrieval

Only a small, deterministic, relevance-ranked set of episodes/facts enters an active
model context. A retrieval miss is normal. Corrupt optional continuity data warns and
degrades to no memory without preventing startup or ordinary work.

### FR-015 — Rebuildability

The derived index can be rebuilt idempotently from available session sources. A rebuild
is additive/atomic, reports malformed or missing sources, preserves user decisions, and
does not make optional continuity a boot precondition.

## Acceptance criteria

- **AC-001:** Given matching sessions in two project directories, when the user asks in
  either project what happened on a specified date, then the same relevant episodes and
  source links are available.
- **AC-002:** Given a date-specific query, when candidate events fall outside its
  resolved local-time window, then they are excluded unless included as clearly labeled
  surrounding context.
- **AC-003:** Given “I might switch providers” followed later by “I decided to keep the
  current provider,” when memory is queried, then the first remains a consideration and
  the second is the active decision with both sources linked.
- **AC-004:** Given a month rollup, when a specific detail is asked, then Athena opens
  supporting episodes rather than treating the rollup as independent evidence.
- **AC-005:** A repeated claim can become only a review candidate when it is directly
  user-authored in at least two distinct sessions and every source digest verifies. A
  repeated line within one session, a question, tentative wording, assistant-authored text,
  or stale/incomplete source creates no inferred candidate. Same-project evidence remains
  project-scoped; cross-project evidence is global-scoped. Sensitive claims stay in their
  source sessions and are not copied into inferred candidates. An explicit “remember this”
  request may create an active memory immediately, subject to the explicit-memory policy.
- **AC-006:** Given a correction or forget request, when retrieval and rebuild run, then
  the corrected/forgotten value is not returned as current memory and source history is
  handled according to the user’s deletion choice.
- **AC-007:** Given missing, malformed, or corrupt index data, when Athena starts or
  answers a recall request, then normal work remains available and a recovery action is
  reported.
- **AC-008:** Given a candidate matching another project, when no relevant recall is
  requested, then unrelated project-specific episode text is not added to that project’s
  prompt.
- **AC-009:** Every returned episode or promoted memory includes machine-readable source
  references that resolve to the expected original message/trace.
- **AC-010:** The recall path adds no background model call and stays within the latency,
  context, and privacy budgets in [NFR budgets](nfr-budgets.md).

## Non-goals

- Replacing or changing normal session persistence/resume semantics.
- Automatically inferring identity, health, sensitive traits, or relationship facts.
- Treating assistant statements, model summaries, or tool output as user-confirmed facts.
- Syncing conversational memory across machines or accounts.
- Automatically retaining every retrieved fact in the active prompt.
- Replacing `ExperienceStore`, `LearningMemoryStore`, RunTrace, or the operational journal.

## Open questions

- The linked-episode approach is confirmed. The exact default retention duration for
  source sessions remains the existing Athena session policy; this feature adds no
  automatic purge. Any future retention setting must apply coherently to source and
  derived data.
- Initial inferred-memory promotion should be conservative and reviewable. Thresholds
  may be calibrated during dogfood; they must not be silently weakened to increase hit
  rate.
