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
for a user’s explicit conversational recall. The active prompt receives a small retrieval
result only when the request calls for prior context. It does not receive the entire
archive or all project memory by default.

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

The answer should naturally identify time and context when that avoids ambiguity. A
source citation is available on request and in machine-readable results; the conversation
should not become a citation dump by default.

## Data model

The implemented contracts below are strict, versioned Zod schemas in
`src/continuity/schemas.ts`; semantic memory and time rollup contracts are foundations
for later phases.

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
  speechActs: Array<'asked' | 'considered' | 'preferred' | 'decided' | 'promised' | 'corrected' | 'retracted'>
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
  speechAct: 'asked' | 'considered' | 'preferred' | 'decided' | 'promised' | 'corrected' | 'retracted'
  captureMode: 'explicit' | 'inferred'
  supersedes?: string[]
  sensitivity: 'ordinary' | 'sensitive'
}

interface TimeRollup {
  schemaVersion: 1
  id: string
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year'
  periodStart: string
  periodEnd: string
  timeZone: string
  summary: string
  sourceEpisodeIds: string[]
  sourceDigest: string
  generator: string
  createdAt: string
}
```

Avoid storing absolute paths in semantic records. Resolve source references through the
trusted local session/brain root and validate IDs. Summaries are bounded and redacted;
verbatim quotes stay in the source session. Existing `Memory` file metadata can hold
semantic links and validity in the memory-hygiene design; do not create a parallel
unstructured fact store.

## Storage and indexing

### Existing source identity and lifecycle audit

| Source | Current identity and scope | Current lifecycle | Continuity treatment |
|---|---|---|---|
| Session JSONL (`src/harness/sessions.ts`) | Session filename ID; each appended line gets a UUID and UTC timestamp. Schema version 3 adds optional top-level IANA timezone metadata; the reader accepts legacy lines without IDs or timezone. The project directory is `projectSlug(canonicalProjectPath)`, a local path-derived partition key. | Message/event appends are redacted. Checkpoint and rewind lines copy the reconstructed message array; a fork writes a checkpoint plus a `session-fork` event with source project/session/line identity. `athena session delete` renames the file into project `.trash`; no user-facing restore command exists. | Canonical conversational source. Index message/event line IDs once; snapshots are reconstruction state, not duplicate episodes. Resolve nested fork ancestry through immutable boundaries. Skip `.trash`; source deletion adds suppression before derived cleanup. For a legacy line without ID, derive the source key from physical line number and SHA-256 of the raw UTF-8 line. |
| RunTrace (`src/harness/traces.ts`) | `runId` plus `sequence` and hash; traces are partitioned by a `projectId` derived from `cwd`. | Hash-chained JSONL append; writer closes with a final event. No user-facing deletion flow was found in the current CLI. | Operational evidence only. Link a trace event when useful to a conversation episode; do not use trace text as user-confirmed personal memory. |
| User memory files (`src/tools/memory.ts`) | Relative file path is the only current identity; `MEMORY.md` is an index, not a record ID. | Tool supports list/read/write/delete; writes overwrite, deletes physically remove the file, and the index is updated. `loadMemoryIndex` injects the memory and learned indexes into prompts today. | Extend this store with validated IDs, source/validity metadata, and lifecycle rules. Keep continuity candidates out of ordinary injected context. User-memory deletion and source-session deletion remain distinct operations. |
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
- `athena memory status|rebuild|timeline|search|show` and `/memory status|rebuild|timeline|search|show`
  use the same bounded time/topic search and source-verification rules. `~/.athena/settings.json`
  may set global `timeZone` to an IANA zone; project settings cannot override it. Without
  that setting, the OS local IANA zone is used and time resolution is labeled inferred.
- The initial episode boundary is one submitted user turn through its persisted
  `turn-done` event. Its source refs include the initiating user message and the related
  assistant/tool messages and terminal event. A final turn without `turn-done` is an
  interrupted episode, not a completed one. If old or malformed data prevents reliable
  grouping, index source messages individually and mark the episode grouping uncertain.
- Extend session discovery so one indexer can enumerate project-scoped session directories
  under the existing local `sessionsDir`.
- Store versioned episode/index records below a dedicated local continuity path in the
  existing brain. Use stable source IDs and atomic, idempotent writes. Keep rollups
  derived and rebuildable.
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
- Explicit remember commands create an active user-authored memory linked to its episode.
- Inferred stable preferences/facts begin as candidates. Promotion needs independent
  episodes on distinct occasions, no unresolved contradiction, acceptable sensitivity,
  and reviewability. Initial thresholds remain configuration/test data, not scattered
  constants.
- Current semantic memories are versioned with valid time. A new statement closes or
  supersedes an old one; it does not rewrite its source or imply the old statement was
  never true.

Episode records are built deterministically from persisted message/event metadata and
bounded redacted excerpts; no separate provider call runs during capture or indexing.
Once answer-time source handoff is authorized and implemented, a weekly/monthly/yearly
recap can synthesize from retrieved episode sources. Persistent rollups are optional
caches and may be materialized only from that user-requested synthesis or an explicit
summarize action; they never trigger hidden background provider calls.

## Interfaces

The local implementation extends the `/memory` command family and adds the `athena memory`
CLI. Available operations are status, rebuild, search, timeline by time range, and show
source/context. Remaining operations are
explicit remember, correct/supersede, review candidates, and forget. Automatic recall
uses the same read path as explicit recall. Mutations use one store/service, validate
targets, emit audit events, and are available through both interactive and noninteractive
CLI paths. Do not silently add continuity to every project prompt. Automatic answer-time
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
