# Conversational Continuity — Technical Design

> [Objective overview](00-overview.md) · [PRD](prd.md) ·
> [Requirements](requirements.md) · [Tasks](tasks.md)

## Approach

Treat continuity as an evidence-linked retrieval and curation layer over Athena’s
existing local records. Keep one source of truth for each kind of information:

| Record | Authority | Continuity’s role |
|---|---|---|
| Session messages/checkpoints | Conversation as persisted by Athena | Reconstruct what was said and surrounding turns |
| Run trace / operational journal | What Athena’s runtime did and observed | Ground historical operational claims |
| Memory files | User-level durable context and explicit remembered items | Add source/validity metadata and retrieve relevant facts |
| Experience records | Prior project-scoped task outcomes | Advisory “similar work” retrieval |
| Governed learning claims | Evaluated task-method hypotheses | Reuse only under their existing lifecycle |
| Continuity episode/rollup index | Derived navigation and summaries | Find sources quickly; never supersede them |

The index is global to the local OS user and catalogs all project session directories.
Project scope remains metadata for relevance and disclosure controls, not a hard boundary
for a user’s explicit conversational recall. Automatic history retrieval runs only when
Jev confidently selects a history route or the local explicit-recall fallback recognizes
the request. It resolves time and named-project scope locally, ranks linked episodes plus
eligible semantic/rollup navigation records, then expands only verified episode sources.
The user authorized this scoped handoff on 2026-09-23.

## Memory layers and lifecycle

```text
active exchange
  -> working state / open conversational loops
  -> source-linked episode in the session timeline
  -> optional time-window rollups (day -> week -> month -> quarter -> year)
  -> optional semantic memory candidate
  -> explicit or evidence-qualified durable memory
```

- **Working:** current topic, references, unresolved questions, promises, and recent
  context needed to answer the next turn. It stays active until resolved, corrected, or
  explicitly abandoned; age alone does not clear a commitment.
- **Episodic:** a dated interaction or event, with the nearby turns and source message
  references that preserve what the statement meant. Episodes remain historical even if
  a current memory supersedes them.
- **Semantic:** a reusable fact, preference, relationship context, or decision. It records
  scope, validity, confidence, speech act, and all supporting episodes. Direct user
  instruction can promote immediately; inferred items remain candidates until corroborated
  and reviewable.
- **Rollup:** derived summary for a time window. It records coverage bounds, source IDs,
  generation method/version, and build time. It is a navigation shortcut and is
  invalidated when its source changes or is forgotten.

These are behavior/authority classes, not exclusive retention durations. A current
commitment may outlive a day; an old preference may stay relevant; a month summary does
not delete daily episodes.

## Retrieval and routing

### Current local ranking preview

`rankContinuityLayers` provides a deterministic, bounded policy preview through
`athena memory rank <query>` and `/memory rank <query>`. The interactive command ranks the
bounded text currently held by the active engine as working state; both interfaces rank
the linked episode catalog, validated semantic records, and fresh on-demand rollups. The
standalone CLI has no active working layer. Neither command returns source text or sends
history to a model.

- A named project or resolved temporal window is a hard filter for applicable candidates.
  Without an explicit project, the catalog can span projects; current-project matches get
  only a small tie-breaking preference. Global semantic memories remain eligible.
- Episodes are filtered by observed time. Semantic records must be active and valid now,
  or superseded with an overlapping historical window. Rejected, candidate, tombstoned,
  future, expired, and (by default) sensitive semantic records do not rank.
- Rollups must overlap the requested local-calendar window, cover only eligible episodes,
  and match the digest recomputed from current episode records. Partial catalogs produce no
  rollups.
- Search, ranking, and rollup reads reuse only immutable episode objects validated from a
  complete index. `ContinuityStore` caches that validated snapshot for the store instance
  by SHA-256 of the exact index bytes; a changed or corrupt file invalidates the cache.
  Source-session digests are still checked independently before source text is displayed
  or an inferred candidate is promoted.
- Scoring combines phrase/token relevance, inferred intent, layer preference, explicit
  versus corroborated source authority, speech-act/correction labels, a small current-
  project preference, and bounded recency. Time and project filters happen before score.
- The preview returns at most five candidates by default (hard maximum eight), each with
  at most twelve source IDs; aggregate ranking metrics cap source IDs at 64. It displays
  the selected IDs, scope/status/time, confidence when present, score, and reason labels.
  It does not display query text, memory content, summaries, or file paths.
- `/memory rank` includes an in-memory working candidate from textual active-session
  messages, capped at 32,000 characters and tagged only with the active session ID. This
  ephemeral candidate is not written to the continuity index. Sensitive filtering for
  semantic records is on by default and there is no CLI/slash override.
- Rank and rollup presentation also checks the current session catalog. Episodes whose
  source session has moved to `.trash` are suppressed immediately, along with semantic
  records linked to those episodes and rollups that cover them. The versioned
  `tombstones.json` ledger persists the suppression across restart and rebuild; it contains
  only project/session IDs and deletion time. Rebuild and incremental indexing cannot
  resurrect a tombstoned session. `athena session restore` clears the tombstone only after
  the original source is live again (including recovery from an interrupted delete), then
  reindexes from that source. Corrupt ledger
  state fails closed and rebuild preserves it for recovery. Semantic-memory forget clears
  the derived content and retains typed source identities plus minimal lifecycle metadata
  in a terminal record so the same source lines cannot regenerate it. Source digests,
  timezones, supporting episode IDs, original observation/validity dates, and project scope
  are removed; the canonical session remains available for explicit historical recall.
- `Memory.read` for managed semantic records verifies each cited session file, stable line
  ID, timestamp, source kind, and user-authored message role before returning the memory
  text as tool output. A trashed or missing session, missing source line, mismatched
  timestamp or source kind, or non-user message source suppresses the read. This keeps
  direct tool reads consistent with the ranker's live-source filter. Candidate, flagged,
  rejected, and tombstoned records return no semantic text through the model-facing tool;
  local review controls retain those states.
- A successful `Memory.read` returns semantic content as a tool result in the active
  model conversation. Prompt assembly does not inject the semantic directory; this
  read-tool path is an existing, call-triggered provider handoff and must be included in
  the privacy review. It does not authorize automatic episodic history retrieval.

Automatic answer-time retrieval reuses the same filters and ranking policy. It reloads
selected source sessions, checks line and episode digests, checks session suppression,
keeps a named project as a hard local filter, and includes up to eight exact/adjacent
source messages per episode. A bounded bundle of at most five episodes and 4,000
characters is added only to the active answer-model system prompt. The bundle includes
speaker, time, timezone, and a non-path project label. Ambiguous named projects and
temporal expressions ask for clarification; misses and corrupt indexes attach no source
text. Each excerpt is JSON-quoted on one line and angle-bracket delimiters are neutralized
so historical text cannot forge a speaker line or close the evidence envelope. It is not
written to session messages, hook context, Jev input, logs, or persistent memory.
Recall-intent terms such as “decision,” “preference,” and “model” are not topic evidence
on their own; if removing those cues leaves neither a searchable subject nor a bounded
time range, Athena asks for clarification instead of ranking unrelated episodes.

Semantic records and rollup summaries are navigation/ranking metadata only: neither body
is sent through automatic recall. Only ordinary, active, in-validity semantic records
whose session citations still resolve to unchanged user-authored lines may point to source
episodes. Sensitive, candidate, flagged, rejected, superseded, expired, future, and
tombstoned records cannot trigger current semantic navigation. Time rollups rank only
bounded time requests and expand back into their covered episodes. Every returned text
excerpt comes from a digest-verified user or Athena message; tool calls, tool results,
paths, source IDs, and project IDs are excluded. The shared credential redactor runs at
the provider boundary; it catches known secret patterns but is not a general PII or
sensitive-prose classifier.

### Jev recall-intent routing (integrated)

Jev is TypeSafe's System One decision model. It accepts natural language or structured
state and returns typed `Choice`, `Score`, or `Noul` answers; Athena's `ModelClient`
remains responsible for conversational replies and tools. The pinned adapter and route
classification live in `src/decision/jev.ts`; the shared harness builds it in
`src/harness/controller.ts`, and `src/engine/loop.ts` uses the result for the current turn.
See [ADR 0003](adr/0003-jev-decision-model.md).

The current `Choice` labels are `none`, `continue-current`, `temporal-recall`,
`topic-recall`, `preference-or-fact`, `historical-decision`, and `similar-work`. The
adapter sends the original inbound user request after the shared secret redactor. It does
not include hook-added context, active session history, episode or semantic text, source
IDs, or project paths. The shared redactor catches known credential fields and secret
patterns; it is not a general personal-information scrubber. The request is capped at
12,000 characters.

The route prompt applies specificity before time: a specific preference, fact, or decision
keeps its own route while the date narrows its search; a broad period overview uses
`temporal-recall`. A request to find a conversation by identifiable subject uses
`topic-recall`, including when the subject was named or labeled. Vague backward references
without a target do not start retrieval, quoted recall text is classified by the outer
request, and immediate context before an interruption stays in `continue-current`.

For a high-confidence route (`>= 0.98`), the engine may invoke the local answer-time
retriever for one of the five historical routes. `none` and `continue-current` never
trigger it. Below the threshold, only a clear deterministic explicit-recall phrase can
trigger the local fallback. The route stays an intent hint: it cannot certify a source,
change scope, or override local source/tombstone checks. Route guidance and any retrieved
context are transient system-prompt additions and never enter persisted session messages.
The production threshold is 0.98. On the 2026-09-24 run, all 266 synthetic route requests
across seven corpora were exact. The gate accepted 197/266 decisions (74.1%), all exact,
with no `none` example triggering retrieval or provider fallbacks. The separate 21-case
independent holdout scored 21/21 exact. These generated examples do not replace
representative live-history dogfood.

Global `jev.enabled` defaults to `true`; a project cannot override the user's setting.
The network path requires `TYPESAFE_API_KEY`. Without the key, the adapter makes no call
and the engine falls back to ordinary prompt handling. A user may disable the route with
`jev.enabled: false`. The TypeSafe JavaScript SDK is pinned at `0.6.0`, model `jev-1.13.0`;
SDK logging and retries are disabled, with a 1.9-second per-attempt timeout and two-second
outer decision deadline. Content-free
outcome, elapsed-time, and token-count telemetry is written to the local run trace.
Jev never receives retrieved history. The user separately authorized scoped,
source-verified excerpts to the configured answer model for a current request that asks
for history; the Jev route itself does not grant source access.

TypeSafe states that customer inputs are not used for model training; its privacy policy
also describes retention for service purposes, processing by service providers, and U.S.
hosting. Recheck current terms before material changes to the provider path. Source links
and the research snapshot are in ADR 0003.

### Jev speech-act intake (integrated)

The same current-request Jev call classifies both recall route and speech act. A
high-confidence (`>= 0.98`) `preferred`, `decided`, `promised`, `corrected`, or `retracted`
label is stored as a content-free local session event only after the user message has been
written. Athena resolves its source ID, timestamp, and SHA-256 line digest locally. Episode
indexing and retrieval attach the label only while the event still points to the exact
user-authored line and its current digest.
The event schema enforces the same 0.98 floor during indexing, so older lower-confidence
labels remain unchanged in source journals but are omitted from the current continuity
index and candidate intake.

Verified `preferred`, `decided`, and `promised` labels can broaden candidate detection to
indirect wording. A candidate still requires the same normalized user text across at least
two independent sessions, local sensitivity and redaction checks, a complete catalog,
source-digest verification, and explicit user review. Promotion repeats source checks.
Correction and retraction labels stay attached to episode context for retrieval and never
automatically overwrite or remove existing memory. Jev cannot promote memory, alter source
history, or bypass scope, sensitivity, review, or permission gates. It is not the memory
store or the authority for what actually happened. On 2026-09-24, the calibration, phrasing
regression, and independent holdout scored 126/126 raw decisions exact. At the 0.98
persistence gate, 53/53 eligible persisted-label decisions were exact (42.1% corpus
coverage); the independent holdout scored 27/27 raw exact, with 12/12 persisted-label exact.
These small synthetic sets do not establish equivalent accuracy on real-user language. See
[ADR 0003](adr/0003-jev-decision-model.md) for complete results and limits.

### Answer-time retrieval routing (implemented)

1. Classify the current request with Jev; if Jev is unavailable or below threshold, use
   only the deterministic explicit-history-request fallback. Do not query history for
   `none`, `continue-current`, ordinary implementation requests, or a topic-free request.
2. Parse explicit temporal language into a bounded interval in the user's configured
   IANA timezone (falling back to the OS local IANA timezone and labeling the inference).
   Preserve UTC event timestamps and any captured source-local date/zone; compare UTC
   instants against the resolved interval.
3. Resolve an explicitly named project against local session partitions. One match is a
   hard filter; unknown or multiply matched names clarify rather than widening to all
   projects. With no project named, topical recall can search all local project sources.
4. Rank complete episodes and eligible active semantic records; add validated time
   rollups as navigation only for bounded time requests. Apply time, project,
   sensitivity, validity, and tombstone filters locally.
5. Rank deterministically using time, source/subject match, lexical/topic relevance,
   layer/intent, source authority, confidence, and recency. A recency boost
   never overrides an explicit date or direct correction.
6. Load selected episode messages and bounded adjacent source turns, verifying exact
   persisted lines and digests again. Semantic text and rollup summaries remain local;
   they only guide source selection.
7. Send up to five episodes and 4,000 characters of redacted user/Athena text to the
   configured answer provider. Include dates, timezone, speaker, coarse project labels,
   and preceding/following relationship. Never send tool blocks, paths, IDs, or hook
   context. The answer model treats the delimited text as untrusted evidence and must not
   claim unsupported details.
8. If no candidates meet the evidence threshold, say local recall found no verified
   match. If the scope is ambiguous or sources conflict, ask a focused question or present
   both with dates.

Temporal normalization is deterministic: calendar terms (`today`, `yesterday`, a named
month, quarter, or year) use calendar boundaries in the query timezone; weeks are ISO
weeks from Monday through Sunday; “past N days” is a rolling interval of N elapsed days.
All intervals are start-inclusive and end-exclusive. Explicitly named timezones override
the configured timezone. A legacy event without a captured timezone is displayed in the
query timezone and marked as timezone-inferred; the index keeps its UTC timestamp rather
than baking in a guessed local date. If the phrase cannot resolve to one bounded interval,
ask rather than silently choosing a window.

Suggested retrieval intent mapping:

| User asks | First sources | Secondary sources |
|---|---|---|
| “What happened just now?” | Working state/current session | Latest episode |
| “What did we discuss Tuesday?” | Episodes in Tuesday’s local-time window | That day’s rollup, if available |
| “What changed this month?” | Month rollup and dated change/decision episodes | Original sessions for specifics |
| “What did we decide about X?” | Current semantic decision and supersession chain | Supporting episodes in date order |
| “What do I usually prefer?” | Active preference memories with independent support | Supporting episodes and counterexamples |
| “How did similar work go?” | Existing `ExperienceStore` scoped by project/task | Relevant run traces |
| “What is true in this repo now?” | Current files/runtime tools | Historical decisions only as context |

The scoring implementation remains a baseline, not calibrated relevance quality. Phase
4.3 requires representative multi-project dogfood and false-positive/no-hit review; until
then the small deterministic budgets and strict source/project filters favor precision.

The answer should naturally identify time and context when that avoids ambiguity. A
source citation is available on request and in machine-readable results; the conversation
should not become a citation dump by default.

## Data model

The implemented contracts below are strict, versioned Zod schemas in
`src/continuity/schemas.ts`. Source-linked semantic-memory storage and explicit remember,
review, and correction paths are implemented foundations; deterministic on-demand time
rollups are also implemented. Scoped automatic answer-time handoff is authorized and
implemented with a five-episode/4,000-character cap; live dogfood and privacy review remain.

```ts
interface SourceRef {
  kind: 'session-message' | 'session-event' | 'run-event' | 'memory-file' | 'experience'
  projectId: string | null
  sessionId?: string
  recordId: string
  timestamp: string // UTC ISO timestamp
  timeZone?: string // source-local IANA timezone captured when written
}

interface ContinuityEpisode {
  schemaVersion: 1
  id: string // deterministic from primary source identity
  sourceRefs: SourceRef[]
  projectId: string | null
  sessionId: string
  observedAt: string
  localDate?: string // source-local calendar date when captured with a source timezone
  timeZone?: string // captured source timezone; absent on legacy messages
  participants: Array<'user' | 'assistant' | 'runtime'>
  topics: string[]
  summary: string // bounded, redacted, derived; never sole evidence
  sourceDigest: string // SHA-256 over the linked session lines, checked before source display
  speechActs: Array<'asked' | 'stated' | 'considered' | 'preferred' | 'decided' | 'promised' | 'corrected' | 'retracted'>
  completion: 'completed' | 'interrupted' | 'uncertain'
  createdAt: string
}

interface ContinuityIndex {
  schemaVersion: 1
  generatedAt: string
  catalogComplete: boolean // a full rebuild saw all live session files
  sessions: Array<{ projectId: string; sessionId: string; sourceDigest: string; canonicalLineCount: number }>
  episodes: ContinuityEpisode[]
}

interface SemanticMemoryLink {
  memoryId: string
  sourceRefs: SourceRef[]
  observedAt: string
  validFrom?: string
  validUntil?: string
  scope: 'global' | 'project'
  projectId?: string // required for project scope; omitted for global scope
  status: 'candidate' | 'active' | 'flagged' | 'superseded' | 'rejected' | 'tombstoned'
  confidence: number
  speechAct: 'asked' | 'stated' | 'considered' | 'preferred' | 'decided' | 'promised' | 'corrected' | 'retracted'
  captureMode: 'explicit' | 'inferred'
  supersedes?: string[]
  sensitivity: 'ordinary' | 'sensitive'
}

interface SemanticMemoryRecord extends SemanticMemoryLink {
  schemaVersion: 1
  description: string
  supportingEpisodeIds: string[]
  supersedes: string[]
  supersededBy?: string
  createdAt: string
  updatedAt: string
  reviewedAt?: string
}

interface TimeRollup {
  schemaVersion: 1
  id: string
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year'
  periodStart: string
  periodEnd: string // exclusive local-calendar boundary
  timeZone: string
  summary: string
  sourceEpisodeIds: string[]
  sourceDigest: string
  generator: string
  createdAt: string
}
```

The user-authored statement is the Markdown body of the managed semantic-memory file;
the structured record above is serialized in validated frontmatter. Source text is not
copied into that file.

Avoid storing absolute paths in semantic records. Resolve source references through the
trusted local session/brain root and validate IDs. Summaries are bounded and redacted;
verbatim quotes stay in the source session. Existing `Memory` file metadata can hold
semantic links and validity in the memory-hygiene design; do not create a parallel
unstructured fact store.

## Storage and indexing

### Existing source identity and lifecycle audit

| Source | Current identity and scope | Current lifecycle | Continuity treatment |
|---|---|---|---|
| Session JSONL (`src/harness/sessions.ts`) | Session filename ID; each appended line gets a UUID and UTC timestamp. Schema version 3 adds optional top-level IANA timezone metadata; the reader accepts legacy lines without IDs or timezone. The project directory is `projectSlug(canonicalProjectPath)`, a local path-derived partition key. | Message/event appends are redacted. Checkpoint and rewind lines copy the reconstructed message array; a fork writes a checkpoint plus a `session-fork` event with source project/session/line identity. `athena session delete` writes a continuity tombstone and renames the file into project `.trash`; `athena session restore <id>` restores the source and reindexes it. | Canonical conversational source. Index message/event line IDs once; snapshots are reconstruction state, not duplicate episodes. Resolve nested fork ancestry through immutable boundaries. Skip `.trash`; persistent source tombstones prevent rebuild resurrection. For a legacy line without ID, derive the source key from physical line number and SHA-256 of the raw UTF-8 line. |
| RunTrace (`src/harness/traces.ts`) | `runId` plus `sequence` and hash; traces are partitioned by a `projectId` derived from `cwd`. | Hash-chained JSONL append; writer closes with a final event. No user-facing deletion flow was found in the current CLI. | Operational evidence only. Link a trace event when useful to a conversation episode; do not use trace text as user-confirmed personal memory. |
| User memory files (`src/tools/memory.ts`) | Legacy prose uses a relative file path; managed semantic records use a UUID and typed source references. `MEMORY.md` remains an index, not a record ID. | Legacy paths retain list/read/write/delete. Semantic records live under `memory/semantic/`; explicit remember, candidate generation/review, correction/supersession, and forget use `MemoryHygieneStore`. Managed records are not included in the injected `MEMORY.md` index. | `athena memory forget <id>`, `/memory forget <id>`, and the `Memory` tool clear the derived body and description; they drop source digests, timezones, support episode IDs, original observation/validity dates, and project scope. The terminal record keeps typed source identities plus required lifecycle metadata to suppress candidate regeneration from those lines. The original source remains available for explicit history recall. Source-session deletion remains distinct and uses the continuity tombstone ledger. |
| Experience (`src/experience/`) | Schema record ID, `projectScope`, creation time, and `evidenceRefs`. The evidence-ref strings are not a typed session-message contract. | JSONL snapshots keyed by record ID; append is idempotent for identical records and guidance has explicit review transitions. | Existing project-scoped task-outcome guidance; optionally rank for “similar work,” but do not treat it as conversation history or semantic personal memory. |
| Governed learning (`src/learning/`) | Claim/candidate IDs with source run IDs and trace hashes. | Append-updated claims use governed promotion/rejection/expiry and consolidation. | Keep its task-method claims and evaluation lifecycle separate from conversational semantic memory. |
| Self-reflection journal | `BrainPaths` reserves a `journalDir`; the linked wiki describes a proposal, but no journal store/tool implementation was found in the current source. | No implemented entry lifecycle or restore/delete path to reuse yet. | Not an available Phase 1 source. Integrate only after a concrete journal schema and stable entry identity exist. |

The initial index key is `(local project partition, session ID, source line ID)`. For a
legacy line without `id`, use the deterministic source key specified above; a changed
source digest invalidates the prior derived record during rebuild. The current project
partition is derived from the canonical local path: moving a checkout can yield a new
partition, and this release does not promise automatic re-keying. Store no absolute path
inside an episode or semantic-memory record. A later project-identity migration can be
added without changing session-line identity.

- Session JSONL remains canonical and append-only. Add the source-local IANA timezone to
  newly appended lines; legacy records have only UTC timestamps and must label the
  timezone fallback as inferred. A checkpoint is a reconstruction base,
  not a second occurrence of every message it contains. Index canonical source messages
  once and retain branch/lineage edges for forks and rewinds. A fork's inherited context
  links to the source session/checkpoint; only messages newly authored on the fork are
  new episodes. A rewind changes the active conversational branch but does not rewrite
  what was said on the earlier branch; historical recall may find it with its branch and
  rewind context clearly labeled.
- `src/continuity/session-catalog.ts` enumerates direct regular session files across valid
  project partitions, skips trash/locks/temp/hidden entries, excludes checkpoint and rewind
  snapshots from canonical source lines, and resolves nested fork lineage. If a legacy or
  missing boundary cannot be verified, it returns an incomplete lineage rather than
  inventing inherited context.
- `~/.athena/continuity/index.json` is a versioned JSON envelope
  (`formatVersion: 1`, `gzip+base64`) around the unchanged versioned local catalog. It
  stores a bounded, deterministic redacted summary, normalized topics/speech acts,
  session/project IDs, linked line IDs, source digest, and source-time metadata; no
  absolute paths or full transcript archive. Expanded JSON remains bounded by
  `maxIndexBytes`; the stored envelope has a separate size bound, canonical base64
  validation, and bounded gzip decompression. Legacy plain JSON is readable only within
  the expanded limit and migrates when a rebuild or session update writes a replacement.
  Temporary-file validation and post-write readback decode and compare the complete index
  before it is accepted. A full rebuild marks catalog coverage complete; live `turn-done`
  events update only the owning session's entries and leave an unbuilt archive explicitly
  partial. Source text is re-read and digest-checked before CLI/slash display.
  Malformed JSONL positions and invalid timestamps are excluded from summary/source text;
  if a damaged line crosses a turn boundary, the valid remainder is marked `uncertain`.
- `athena memory status|rebuild|timeline|search|show|rollup|rank|candidates|review` and the
  equivalent `/memory` actions use the same source-verification rules. `candidates` and
  `review` are explicit local semantic-memory operations; search/timeline/show use bounded
  time/topic matching. `~/.athena/settings.json`
  may set global `timeZone` to an IANA zone; project settings cannot override it. Without
  that setting, the OS local IANA zone is used and time resolution is labeled inferred. Rollups
  are generated on demand only from a complete catalog; they contain bounded episode-summary
  text, every covered episode ID, a source digest, the timezone, and generator version. They are
  not persisted, so index correction/deletion changes the next rollup immediately. Periods
  use a start-inclusive, end-exclusive local-calendar range. CLI output shows up to five
  covered episode IDs per rollup and keeps complete coverage in the index.
- The initial episode boundary is one submitted user turn through its persisted
  `turn-done` event. Its source refs include the initiating user message and the related
  assistant/tool messages and terminal event. A final turn without `turn-done` is an
  interrupted episode, not a completed one. If old or malformed data prevents reliable
  grouping, index source messages individually and mark the episode grouping uncertain.
- `session-catalog.ts` enumerates project-scoped session directories under the existing
  local `sessionsDir`; the continuity store writes versioned episode/index records below
  the dedicated continuity path with stable source IDs and atomic, idempotent updates.
  Time rollups are derived on demand and rebuildable from the current episode index; there is
  no separate cache to invalidate.
- Reuse existing local JSONL/Zod/redaction/atomic-write patterns. Add no database or
  external service in the first implementation. Measure index size and recall latency
  before choosing a different backend.
- Live indexing follows the session's `turn-done` signal and atomically replaces that
  session's derived entries; explicit rebuild scans all live sessions. Startup does not
  scan the archive. Optional indexing failure never blocks boot or the completed turn.

## Memory capture and promotion

- Persisted session roles and tool/runtime events are the source; the model may propose a
  candidate but cannot set source IDs, timestamps, status, or confidence without
  validation.
- Preserve modal language: “maybe,” “what if,” and questions remain tentative; “I decided”
  can be a decision; “I was wrong” or “that changed” creates correction/supersession.
- `Memory.remember` creates an active user-authored memory only when requested directly.
  The harness supplies the current persisted human-message reference; the model cannot
  choose the source identity or timestamp. Unpersisted sessions cannot create a linked
  record.
- The store accepts inferred records only as candidates and requires two distinct
  supporting episode IDs. `generateSemanticCandidates` runs only through an explicit local
  command and requires a ready catalog. It accepts a direct user preference, decision, or
  promise, or an indirect claim with a Jev label at confidence >= 0.98 validated against
  that exact user-message digest. The same normalized full claim must appear in at least two
  distinct `(project, session)` sources;
  each episode digest is verified before its user message is used. Tentative/question text,
  assistant messages, stale sources, incomplete catalogs, and oversized/truncated episode
  contexts are skipped. A message that the shared redactor would change is also excluded,
  so credential-shaped text in older sessions cannot enter an inferred candidate. Support
  is bounded to 32 source episodes, preserving the newest
  support for each project where possible. A candidate stays project-scoped until selected
  support crosses project boundaries, then it becomes global. Sensitive claims are skipped
  before semantic storage and remain in their original source sessions; explicit remember is
  a separate user-directed operation.
  Idempotent upsert merges support for the same speech act and normalized claim while
  preserving explicit, rejected, superseded, or tombstoned decisions. No candidate is
  promoted automatically. Immediately before promotion, every inferred source is checked
  again against a complete index, current episode digest, source line, user role, timestamp,
  speech act, and normalized claim. The stored observation time and project/global scope
  must still match those verified sources, and sensitive wording remains blocked even if
  record metadata was altered. Rejection remains available if a source has become stale.
- `athena memory candidates` / `/memory candidates` explicitly generate and list up to 20
  bounded review candidates, including a short claim excerpt, sensitivity, scope, and up to
  five supporting episode IDs. `athena memory review <memory-id> <promote|reject>` and its
  slash equivalent apply the user's explicit decision. Candidate text is shown only in
  this local review surface; it is not inserted into `MEMORY.md` or provider prompts.
  Promotion repeats source verification at decision time.
- `Memory.supersede` requires an explicit correction to an active record. The replacement
  is linked to the correction message; the prior statement and its source remain
  unchanged. Valid-time intervals are schema-validated, but automatic interval closure
  is not yet wired.
- `MemoryHygieneStore.forget` atomically writes a tombstoned record with an empty body and
  generic description, and records `forgottenAt`. It removes digests, timezones, episode
  IDs, original observation/validity dates, and project scope. Retained source IDs suppress
  those exact lines from future inferred-candidate scans, including after rebuild/restart. A later
  repeated claim from new, independent source lines can qualify as a new review candidate;
  it is never auto-promoted. The canonical source remains available for explicit recall.
  Session deletion remains the separate control for removing source episodes from recall.
  Source-session delete/restore is implemented through the persistent tombstone ledger;
  restore is explicit and reindexes only from the recovered source.

Episode records are built deterministically from persisted message/event metadata and
bounded redacted excerpts; no separate provider call runs during capture or indexing.
Weekly/monthly/yearly recall can use local rollups to find covered episodes and then answer
from reverified source text. No generated rollup summary is sent to the answer provider.
Persistent rollups remain optional and may be materialized only from an explicit user
request; they never trigger hidden background provider calls.

## Interfaces

The `Memory` tool provides explicit remember, review, correct/supersede, and user-requested
forget operations. The `athena memory` CLI and `/memory` provide status, rebuild, search,
timeline by time range, source/context inspection, ranking previews, candidate generation
and review, and `forget <memory-id>`. Forget erases only the derived semantic record while
preserving its source session and preventing the same source lines from regenerating it.
Session source deletion and restore use persistent continuity tombstones. Mutations validate targets. Do not
silently add continuity to every project prompt. Automatic source handoff occurs only in
response to a routed historical-recall request and uses the documented local filters and
payload caps.

## Failure behavior

Missing/corrupt derived index -> warn once with `athena memory rebuild`, return no
unvalidated records, and keep normal startup. Missing source -> mark source unavailable,
invalidate dependent rollups, and never promote the summary as a fact. Unknown timezone ->
use the documented fallback and label it. Failed atomic update -> preserve existing
index. Malformed source lines and invalid timestamps -> skip damaged records, keep valid
neighbors linked, mark an affected episode uncertain, and verify the surviving source refs
before showing any text.

## Alternatives considered

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Copy complete transcripts into a new global memory archive | Simple global lookup | Duplicates private data, creates competing deletion/retention authority | Reject |
| Keep only hand-written free-text memory | Low implementation cost | Cannot answer dated conversational questions or preserve episode context | Insufficient |
| Use one model-generated summary as the entire history | Compact prompt | Loses source context, tentative speech, and correction history | Reject |
| Source-linked local episodes plus derived rollups | Cross-project/time recall with inspectable evidence and rebuild | Requires index lifecycle and source-aware deletion | Choose |
| Cloud/vector database | Scales semantic lookup | New privacy boundary, cost, dependency, and account sync assumptions | Defer |

## Cross-cutting requirements

Security/privacy, tests, observability, error handling, performance, and accessibility are
normative in the linked package. Continuity is advisory; it cannot change permission,
trust, or runtime truth.
