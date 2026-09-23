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
for a user’s explicit conversational recall. The target behavior is a small retrieval
result only when a request calls for prior context; the current implementation stops at a
local ranked preview. Historical excerpts are not sent to a provider pending explicit
authorization.

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
  state fails closed and rebuild preserves it for recovery. Semantic-memory forget and its
  source-retention policy are a separate pending decision.
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

This preview does not yet expand selected IDs into answer context. A future provider
handoff must re-verify sources, preserve adjacent conversation context, apply project
disclosure rules, and pass prompt-isolation tests after explicit authorization.

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

For any non-`none` route, Athena adds a transient instruction to the active answer-model
system prompt. It directs the model to use messages already present in the conversation,
avoid inventing cross-session details, and ask the user to use local memory search when a
different session or project is needed. The route does not retrieve sources or transfer
historical content. It is removed after the turn and never enters persisted session
messages. Confidence and probabilities are retained for evaluation; there is no calibrated
confidence threshold yet. The user selected this rollout on 2026-09-23, so the route is
used while live quality results remain outstanding.

Global `jev.enabled` defaults to `true`; a project cannot override the user's setting.
The network path requires `TYPESAFE_API_KEY`. Without the key, the adapter makes no call
and the engine falls back to ordinary prompt handling. A user may disable the route with
`jev.enabled: false`. The TypeSafe JavaScript SDK is pinned at `0.6.0`, model `jev-1.13.0`;
SDK logging and retries are disabled, and the decision deadline is one second. Content-free
outcome, elapsed-time, and token-count telemetry is written to the local run trace.
Historical excerpts sent to the configured answer provider remain a separate decision
and are not part of the Jev authorization.

TypeSafe states that customer inputs are not used for model training; its privacy policy
also describes retention for service purposes, processing by service providers, and U.S.
hosting. Recheck current terms before material changes to the provider path. Source links
and the research snapshot are in ADR 0003.

### Jev speech-act intake (integrated)

The same current-request Jev call classifies both recall route and speech act. A
high-confidence (`>= 0.85`) `preferred`, `decided`, `promised`, `corrected`, or `retracted`
label is stored as a content-free local session event only after the user message has been
written. Athena resolves its source ID, timestamp, and SHA-256 line digest locally. Episode
indexing and retrieval attach the label only while the event still points to the exact
user-authored line and its current digest.

Verified `preferred`, `decided`, and `promised` labels can broaden candidate detection to
indirect wording. A candidate still requires the same normalized user text across at least
two independent sessions, local sensitivity and redaction checks, a complete catalog,
source-digest verification, and explicit user review. Promotion repeats source checks.
Correction and retraction labels stay attached to episode context for retrieval and never
automatically overwrite or remove existing memory. Jev cannot promote memory, alter source
history, or bypass scope, sensitivity, review, or permission gates. It is not the memory
store or the authority for what actually happened. The synthetic speech-act corpus and
live evaluator are documented in [ADR 0003](adr/0003-jev-decision-model.md); live model
quality remains unmeasured until a TypeSafe key is available.

### Target answer-time retrieval routing (not connected)

1. Read the current user request and active conversation state.
2. Determine likely intent: continuation/open loop, recall by time, recall by topic/person,
   preference/fact, historical decision, or similar prior task.
3. Parse explicit temporal language into a bounded interval in the user's configured
   IANA timezone (falling back to the OS local IANA timezone and labeling the inference).
   Preserve UTC event timestamps and any captured source-local date/zone; compare UTC
   instants against the resolved interval.
4. Restrict candidates by explicit scope, time, type, and retention/tombstone state.
   With no project named, search all locally indexed projects.
5. Rank deterministically using explicit-time match, source/subject match, lexical/topic
   relevance, active scope, source authority, confidence, and recency. A recency boost
   never overrides an explicit date or direct correction.
6. Load adjacent source turns around the best message references. Include the episode
   summary only as an orientation aid; use source text to answer exact questions.
7. Return a bounded bundle with source IDs, dates, scope, speech-act/status labels, and
   uncertainty. The response model must not claim unsupported details.
8. If no candidates meet the evidence threshold, return no-hit. If equally relevant
   sources conflict, present both with dates or ask a focused clarifying question.

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

The scoring implementation is a baseline, not calibrated relevance quality. Phase 4.3
requires representative multi-project dogfood and measured false-positive/no-hit review
before any automatic answer-time use.

The answer should naturally identify time and context when that avoids ambiguity. A
source citation is available on request and in machine-readable results; the conversation
should not become a citation dump by default.

## Data model

The implemented contracts below are strict, versioned Zod schemas in
`src/continuity/schemas.ts`. Source-linked semantic-memory storage and explicit remember,
review, and correction paths are implemented foundations; deterministic on-demand time
rollups are also implemented. Provider handoff remains pending explicit authorization.

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
| User memory files (`src/tools/memory.ts`) | Legacy prose uses a relative file path; managed semantic records use a UUID and typed source references. `MEMORY.md` remains an index, not a record ID. | Legacy paths retain list/read/write/delete. Semantic records live under `memory/semantic/`; explicit remember, candidate generation/review, and correction/supersession use `MemoryHygieneStore`. Managed records are not included in the injected `MEMORY.md` index. | Semantic-memory forget remains planned pending its source-retention choice. User-memory deletion and source-session deletion remain distinct; session-source deletion uses the continuity tombstone ledger. |
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
- `~/.athena/continuity/index.json` is a versioned local catalog. It stores a bounded,
  deterministic redacted summary, normalized topics/speech acts, session/project IDs,
  linked line IDs, source digest, and source-time metadata. It stores no absolute paths and
  no full transcript archive. A full rebuild marks catalog coverage complete; live
  `turn-done` events update only the owning session's entries and leave an unbuilt archive
  explicitly partial. Source text is re-read and digest-checked before CLI/slash display.
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
  promise, or an indirect claim with a high-confidence Jev label validated against that
  exact user-message digest. The same normalized full claim must appear in at least two
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
- Semantic-memory forget remains open pending selection of its source-retention behavior.
  Source-session delete/restore is implemented through the persistent tombstone ledger;
  restore is explicit and reindexes only from the recovered source.

Episode records are built deterministically from persisted message/event metadata and
bounded redacted excerpts; no separate provider call runs during capture or indexing.
Once answer-time source handoff is authorized and implemented, a weekly/monthly/yearly
recap can synthesize from retrieved episode sources. Persistent rollups are optional
caches and may be materialized only from that user-requested synthesis or an explicit
summarize action; they never trigger hidden background provider calls.

## Interfaces

The `Memory` tool provides explicit remember, review, and correct/supersede operations.
The `athena memory` CLI and `/memory` provide status, rebuild, search, timeline by time
range, source/context inspection, ranking previews, and explicit candidate generation and
review. Semantic-memory forget remains open pending its source-retention choice. Session
source deletion and restore use persistent continuity tombstones. Mutations validate
targets. Do not silently add continuity to every project prompt.
Automatic answer-time
source handoff to the configured model provider remains pending explicit user authorization;
until then, session-derived content stays in local CLI/slash results.

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
