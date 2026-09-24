# Memory hygiene / anti-rot

This page specifies how Athena keeps her own stored knowledge accurate: the free-text
brain-memory files under `~/.athena/memory/` written via the `Memory` tool, plus
source-linked semantic records stored in the same memory tree. The legacy free-text
`MEMORY.md` index and `LEARNED.md` view are injected into sessions through
`loadMemoryIndex` (`src/brain/loader.ts:70`); the new semantic records are deliberately
not indexed there or injected into provider prompts yet.

The broader cross-project conversation timeline and layered working/episodic/semantic
memory are specified separately in
[Conversational Continuity](../features/conversational-continuity/00-overview.md). The
semantic-memory implementation extends this tree under `memory/semantic/`; it does not
create a second root or a full-transcript archive.

## Implemented semantic-memory foundation

`src/continuity/schemas.ts` defines the strict versioned `SemanticMemoryRecordSchema`.
`src/brain/hygiene.ts` implements `MemoryHygieneStore` over
`~/.athena/memory/semantic/<memory-id>.md`, using validated JSON frontmatter and an
unchanged statement body capped at 2,000 characters. It supports explicit active records,
inferred candidates that need two distinct episode IDs and at least two source references,
candidate promotion/rejection, explicit correction links, supersession, and tombstoning.
Sensitive inferred records cannot be promoted. Rejected, superseded, and tombstoned
records cannot be reactivated by this store. Active retrieval excludes records outside
their valid-time interval.

The `Memory` tool exposes `remember`, `review`, and `supersede`. `remember` is reserved
for an explicit user request. Source IDs and timestamps are resolved by the harness from
the latest persisted human message; unpersisted sessions and damaged trailing session
records cannot create a source-linked memory. A correction is linked to the correction
message, and the old statement and its source remain unchanged. Generic free-text writes
and deletes cannot modify files under `memory/semantic/`.

Managed records are not added to `MEMORY.md`, and `loadMemoryIndex` does not load them.
`Memory.read` returns them through a model tool result when called. New session citations
carry a SHA-256 digest of the exact persisted JSONL line. Before returning text, it
recomputes that digest and checks the cited line ID, timestamp, kind, and user role; an
in-place edit suppresses the memory just like a missing or trashed source. Legacy
UUID-backed semantic citations have no digest and are suppressed from model-facing reads
until the memory is recreated from a currently persisted user message. ID-less legacy
citations remain content-bound because their stable line identity embeds the raw-line
digest. Candidate, flagged, rejected, and tombstoned content is also rejected. This is a
call-triggered provider handoff; it does not
auto-inject semantic records or authorize automatic episodic history retrieval.
`athena memory candidates` /
`/memory candidates` explicitly generate and list review-only records from repeated,
direct user preferences, decisions, and promises, plus indirect wording labeled by the
source-linked Jev speech-act event, in at least two digest-verified sessions. Jev labels are
content-free session events written only after the user message and linked by exact line
digest. Episode indexing and candidate promotion verify the event against the current source
line. Only `preferred`, `decided`, and `promised` labels can support candidate generation;
correction and retraction labels remain contextual and do not supersede memory by themselves.
`athena memory review <id> <promote|reject>` and its slash equivalent provide local
decisions; inferred promotion rechecks source lines, claims, timestamps, project scope, and
sensitive wording at decision time. The mixed-capability `Memory` tool classifies validated
`list` and `read` operations as read-only for permission hooks and gates; file writes,
deletes, remember, review, supersede, and forget stay mutating. Semantic records stay out of
automatically assembled
provider prompts; only the verified `Memory.read` tool path returns permitted record content
to the active conversation. Source-session forget/delete integration and citation-verification
hooks for legacy free-text files remain unfinished. The user has not yet selected the
semantic forget preserves the canonical session source while atomically clearing the
managed derived body and description, removing secondary source metadata, and retaining
typed source identities plus minimal lifecycle metadata to suppress candidate regeneration
from those lines. Use `athena memory forget <id>` or `/memory forget <id>`.

The [self-reflection journal](self-reflection-journal.md) remains operational evidence.
Continuity may consume it when implemented, but it is neither a transcript archive nor a
replacement for source-linked conversational episodes.

## Is this new, or an extension of "governed learning"?

Commit `621dda3` ("feat: implement harness parity and governed learning") added
`src/learning/` — a candidate to evaluation to canary to promotion pipeline
(`src/learning/candidates.ts`, `evaluation.ts`, `promotion.ts`) that turns immutable run
traces (`src/learning/warehouse.ts`, hash-chained JSONL under `~/.athena/runs/`) into
`LearningCandidate` patches, eval-gates them against held-out suites, and for
`target: 'memory'` candidates writes structured `MemoryClaim` records
(`src/learning/types.ts:112`) to `~/.athena/memory/learned.jsonl`, consolidated into
`~/.athena/memory/LEARNED.md` by `LearningMemoryStore.consolidate()`
(`src/learning/memory.ts:90`).

That system **already implements a meaningful slice of hygiene** — but only for its own
narrow slice of memory:

- `MemoryClaim.status` is exactly the provisional/active/contradicted/expired/rejected
  lifecycle this spec needs (`src/learning/types.ts:126`).
- `contradicts: string[]` link field already exists (`types.ts:127`).
- `consolidate()` already dedups by normalized statement, decays confidence
  (`decayedConfidence`, `memory.ts:19`), expires bounded claims, and **never resurrects a
  rejected claim** (`memory.ts:95` — "Rejection is a terminal human/governance
  decision").
- It writes a prompt-safe, active-only markdown view (`LEARNED.md`) separate from the
  full audit trail (`learned.jsonl`) — exactly the "deprioritize at retrieval, keep for
  audit" shape this spec needs.

But every `MemoryClaim` must trace back to `sourceRunIds` verified against an immutable,
hash-chained trace (`TraceWarehouse.requireEvidence`, `warehouse.ts:115`) and is meant to
be eval-suite-gated before being trusted. That is the right rigor for "should this
code/prompt/policy patch be promoted," and the wrong rigor for "does the file this note
cites still exist" or "the user just said the vault design changed."

Most facts in `~/.athena/memory/*.md` are plain prose written by the `Memory` tool
(`src/tools/memory.ts`), with **zero** status, citation, or supersession structure today.
`loadMemoryIndex` loads `MEMORY.md` (the index) and `LEARNED.md` (the governed claims)
side by side into every session's context (`loader.ts:70-76`) — so the ungoverned
free-text surface is the one actually driving most of what the model believes, and it is
the one with no hygiene machinery at all.

**Verdict: this is a new, lighter module that reuses governed-learning's proven *idioms*
(status enum, decay math, contradiction links, terminal-rejection rule,
audit-log-plus-prompt-safe-view split, `HookRunner`/`PostToolUse` event plumbing) but
targets the free-text `Memory`-tool surface, not the trace-gated `MemoryClaim`
pipeline.** The two systems stay independent. Deprioritization rules below apply to
`LEARNED.md`'s `contradicted`/`expired` claims for free, since `consolidate()` already
produces that state; no new code is needed there.

## What is stored, and in what shape

Each legacy free-text fact is one file under `<memoryDir>/*.md` (nested paths allowed,
per `walk()` in `src/tools/memory.ts`). Its body is unstructured prose with an optional
first line used as the index description. This citation-hygiene design adds **optional
frontmatter**, parsed with the same `parseFrontmatter()` already used for
skills/agents/commands (`src/brain/loader.ts:55`). A file with no frontmatter is legacy:
treated as `status: active` with no citations, never blocked from retrieval, just
unchecked until first touched.

This format describes the planned citation state for legacy prose files. Continuity
semantic records use a validated `athena-semantic-record` JSON frontmatter field and are
kept in `memory/semantic/`; they do not enter the legacy `MEMORY.md` index.

```
---
status: candidate | active | flagged | superseded | tombstoned | rejected
citations: ["src/brain/paths.ts:44", "flag:--force", "cmd:athena learn consolidate"]
verifiedAt: 2026-07-27T18:04:00Z
lastFlaggedAt: 2026-07-27T18:04:00Z
flagReason: "citation src/brain/paths.ts:44 no longer matches (line moved/changed)"
supersedes: relative/path/to/older-fact.md
supersededBy: relative/path/to/newer-fact.md
reviewedAt: 2026-07-27T18:10:00Z
sourceRefs: '[{"kind":"session-message","projectId":"project-id","sessionId":"session-id","recordId":"message-line-id","timestamp":"2026-07-27T18:04:00Z"}]'
scope: global | project
projectId:
observedAt: 2026-07-27T18:04:00Z
validFrom: 2026-07-27T18:04:00Z
validUntil:
speechAct: asked | considered | preferred | decided | promised | corrected | retracted
captureMode: explicit | inferred
confidence: 0.9
sensitivity: ordinary | sensitive
---
Free-text body, unchanged. This is the actual fact/lesson and is never rewritten by
the hygiene system — only frontmatter is patched, so a flag/supersede/tombstone
action is a pure metadata mutation, never a content edit.
```

Continuity-managed fields are optional for legacy files and required/validated for any
memory promoted from conversational episodes. `sourceRefs` is a JSON-encoded scalar in
the current simple frontmatter format; parse and validate it as data rather than free
text. `observedAt` records when Athena learned the claim; `validFrom`/`validUntil` record
when it applies. Speech-act, capture mode, scope, confidence, and sensitivity preserve
the distinction between direct instruction and inference. Confidence is not proof;
source references remain mandatory for promoted inferred memories.

Field notes:

- `citations` — extracted automatically at write/verify time; the agent may hand-author
  but does not need to.
- `status` transitions: `candidate` to `{active | rejected}`; `active` to `flagged` to
  `{active | superseded | tombstoned}`; `active` may also be superseded directly.
  Restoring a flagged citation-confirmation is distinct from promoting an inferred
  candidate. `rejected`, `tombstoned`, and `superseded` are terminal and never
  automatically reactivated — the terminal-decision rule reused from `memory.ts:95`.
- `supersedes`/`supersededBy` are a bidirectional pair. Both files stay on disk: the old
  file's body is exactly the "why it used to be true" record.
- Continuity `candidate` and `rejected` memories are omitted from `MEMORY.md`: candidates
  appear only in explicit review, while rejected memories remain in the audit store and
  are not retrieved. See the [continuity lifecycle](../features/conversational-continuity/design.md).
- Citation-state mutations never physically delete legacy memory files. The semantic
  store also preserves tombstoned bodies; generic `Memory delete` is blocked for managed
  semantic paths. Source-session deletion remains a separate `athena session delete` action
  and uses continuity tombstones; it is independent of semantic-memory forget.

`MEMORY.md`'s per-entry index line gains a status marker so retrieval-time scanning is
cheap without opening files:

```
- [path/to/fact.md](path/to/fact.md) — one-line description
- [path/to/old.md](path/to/old.md) — FLAGGED (citation missing): one-line description
- [path/to/older.md](path/to/older.md) — superseded by newer.md
```

`updateIndex()` (`src/tools/memory.ts:33`) is extended to render this marker by reading
each file's frontmatter status. That is the only change needed to `MEMORY.md` generation.

## Planned free-text citation hygiene extension

The current `src/brain/hygiene.ts` implements the semantic-memory foundation described
above. The following citation-checking functions and hooks remain planned work; they are
not present in the current module.

The planned citation extension would add the following to the existing
`src/brain/hygiene.ts`, alongside its current semantic-memory store:

- `extractCitations(body)` — the citation-verification algorithm below.
- `verifyCitations(paths, scope, touchedFiles?)` — mechanical, no LLM call.
- `flag()`, `supersede()`, `tombstone()`, `restore()` — pure frontmatter patches (read,
  `parseFrontmatter`, merge, `atomicWriteFileSync` — the same primitive already used by
  `Memory` tool writes) that also call `updateIndex()`.
- `detectDuplicateOrContradictingCitations(paths)` — mechanical pass.
- `consolidationDue(paths)` — count-based trigger check.
- `consolidate(paths)` — the slow-cadence, judgment-requiring pass. This one **does**
  invoke the model (via `HookAdapters.invokeAgent`, the shape already used for
  `agent`-type hooks, `src/harness/hooks.ts:229`), because merging several
  differently-worded memories into one rule is exactly the judgment call that needs it.

Pure logic, no TUI or CLI, exactly like `learning/memory.ts`. The CLI and hook wiring
call into it, matching the existing `cli.ts` `learn` subcommand pattern
(`cli.ts:957-1037`).

## Every trigger, what fires it, what it costs

All triggers attach to the existing `HookRunner` event surface (`src/harness/hooks.ts`,
`HookEventName` in `src/engine/types.ts:159`) — no new event bus. Each is an **internal
hook registration** (Athena's own harness subscribing the way a user hook would, not a
user-configurable `hooks.json` entry) so it cannot be silently disabled by editing
settings, and so no subprocess-spawn cost is paid for mechanical checks.

| Trigger | Event | Fires on | Cost |
|---|---|---|---|
| Scoped citation re-check | `PostToolUse`, matcher `Edit\|MultiEdit\|Write\|Bash` | Any tool call that could invalidate a citation: a file edit/write touching a path, or a `Bash` call resembling `git mv`/`git rm`/`rm`/`mv` (regex on the command string, same style as the safety-denial detector in `src/learning/warehouse.ts:64-69`) | Milliseconds, zero tokens. Scoped to citations mentioning the touched paths only. |
| Full citation sweep | `SessionStart` | Every session boundary — a real event, not a wall clock | Milliseconds to low hundreds of ms for a memory dir in the tens-to-low-hundreds of files; zero tokens. Catches drift from edits made outside Athena (manual renames, other tools, a second Athena session) that the scoped check cannot see. |
| Correction capture (explicit) | none — direct tool call | The agent recognizes mid-conversation that the user contradicted a stored fact and calls the new `Memory` ops itself | Zero extra cost; rides the turn already being generated. A system-prompt/tool-description behavioral contract, not new machinery. |
| Correction capture (safety net) | `UserPromptSubmit` | A cheap regex over the prompt for correction language ("that's wrong", "no longer", "actually it's", "outdated", explicit `/memory correct`) | Milliseconds; on a hit, returns `addedContext` (`engine/types.ts:174`) nudging the model to check whether a stored memory is invalidated. No extra model call. |
| Same-citation contradiction hint | Inside the citation pass | Two `active` files cite the exact same `file:line`/flag/command | Free; piggybacks on the existing per-file scan. A `Map<citation, filePath[]>` with length > 1 flagged for review. No semantic judgment attempted. |
| Count-triggered consolidation | Internal check after any `Memory` `write` | Number of `active` files created/modified since `lastConsolidatedAt` crosses a threshold (default 15) | One model call — the deliberately non-mechanical pass. **Count-based, not time-based.** Also runnable on demand via `/memory consolidate`. |

**Departure flagged:** the original framing allowed a slow periodic pass for
consolidation. This spec argues count-based (files since last consolidation) is strictly
better and still timer-free: a project that goes quiet for a month should not burn a pass
at hour two, and forty new memories in one busy afternoon should not wait for a clock.
The counter is persisted so it survives restarts and is checked where growth actually
happens, so no polling loop of any kind is needed.

## Citation-verification algorithm

**What counts as a citation**, extracted by `extractCitations`:

1. `path/like/this.ts:123` or `:123-145` — a repo-relative path resolved against the
   project's cwd **at verification time, not write time**, so a memory written from a
   different working directory still resolves. Recognized by a conservative regex
   requiring a known file extension, to avoid matching arbitrary `word:number` prose.
2. `flag:--some-flag` or a bare `--some-flag` inside backticks — verified against the
   actual parsed CLI arg definitions (`src/cli.ts`), not a static list, so a flag rename
   is caught like a file rename.
3. `athena <command> <subcommand>` inside backticks — verified against the CLI's command
   table.
4. A bare repo-relative path with no line number — existence only. A missing file is
   worth flagging; a changed-but-present file is not, since there is no line to have
   drifted.

**Verification logic:**

- *File:line* — compare against a **content fingerprint stored at write time**, not the
  literal line text (which shifts with unrelated edits above it). The fingerprint is a
  normalized-whitespace hash of the cited line, captured into
  `citations: [{ path, line, contentHash }]` when first written or first verified.
  Re-verification asks: does the file still exist, and does any line within roughly ±10
  of the recorded number hash-match? If yes, the citation is confirmed and a drifted line
  number is silently updated — that is "line moved, not deleted," no flag. If no line
  matches, flag with the specific reason "line moved or was edited beyond a rename"
  rather than a bare "not found," so the reviewer is not asked to prove a negative.
- *False-positive avoidance, the renamed-file case* — before concluding "file gone," run
  a **git-aware rename check** (`git log --follow --diff-filter=R -- <path>`). If git
  reports a rename target, the citation is verified-but-relocated: frontmatter
  auto-updates to the new path, no human involved, no flag, and the fingerprint is
  re-checked at the new location. Only when the file is absent from both the working tree
  *and* git's rename history is it flagged as genuinely gone.
- *Flag/command citations* — verified against the CLI's parsed definitions. A renamed
  flag with an obvious near-match (edit distance <= 2, or a documented alias) is treated
  as relocated, same rename tolerance. No git history involved. A deprecated-flag ledger
  would remove false positives on intentional renames — noted as a phase-2 extension, not
  built.
- *Bare path citations* — existence check plus the same git-rename fallback.

A verification run never mutates body text — only `citations[]`,
`verifiedAt`/`lastFlaggedAt`, and `status`.

## How flagged/superseded entries affect retrieval

Two retrieval surfaces, both handled:

1. **Session-context injection** (`loadMemoryIndex`, `src/brain/loader.ts:70`) loads
   `MEMORY.md` and `LEARNED.md` verbatim into every session. Extended to:
   - Render `flagged`/`superseded`/`tombstoned` entries with their marker, so the model
     sees that something needs review. No token cost increase — the description was
     already there.
   - Drop `tombstoned` entries from `MEMORY.md` after N days past confirmation
     (configurable, default off in phase 1). They remain readable via `Memory read` for
     audit. This is the only place growth control happens without ever deleting a file.
   - `LEARNED.md` needs no change: `consolidate()` already excludes non-`active` claims
     (`memory.ts:138-144`).
2. **On-demand file read** (`Memory` tool `read`, `src/tools/memory.ts:85-88`) — when the
   model opens a flagged/superseded/tombstoned file, the tool **prepends a banner**:
   "This memory is FLAGGED (citation missing since 2026-07-27): <reason>. Treat with
   reduced confidence." or "SUPERSEDED by <path> — read that instead." **This is where
   the benefit lands before the user reviews** — the downgrade signal arrives at the
   exact moment the model would otherwise trust stale content, not at index-scan time.

Index ordering (new; today's list is unordered walk order): `active` alphabetically, then
`flagged` most-recently-flagged first, then `superseded` grouped near their superseder,
then `tombstoned` at the bottom or omitted per the N-day rule.

## Planned free-text citation hygiene tool ops

These operations apply to citation flags on legacy free-text memory files. They are
separate from the currently implemented semantic `remember`/`review`/`supersede` actions.

`MemoryInput` could gain four ops alongside `list|read|write|delete`, each a thin frontmatter
patch that never touches the body:

- `flag` — `{ op: 'flag', path, description }` (description becomes `flagReason`)
- `supersede` — writes `supersededBy` on the old file and `supersedes` on the new one.
  The new file must already exist via a normal `write` first — the same two-step flow the
  agent already uses for any multi-file change.
- `tombstone` — `{ op: 'tombstone', path, description }`
- `restore` — clears `flagged`/`flagReason`, sets `active`, stamps `reviewedAt`.
  Explicitly **not** available from `superseded`/`tombstoned` — those are terminal,
  reusing `memory.ts`'s never-resurrect rule. Only a human, via the review surface's
  explicit un-tombstone action, can reverse those, and that writes an audit line rather
  than silently reverting.

All four are additive to the existing schema and route through the same
`safeResolve`/`updateIndex` machinery — no new path-traversal surface.

## Planned legacy citation review surface

This planned surface is for flagged legacy free-text files, distinct from the implemented
semantic candidate commands above. Its command syntax must coexist with
`/memory review <memory-id> <promote|reject>` rather than replace it. It would open an Ink
picker reusing the pattern
already shipped for `SessionPicker` (`src/tui/components/SessionPicker.tsx`) and the arg
picker (`src/tui/argPicker.ts`/`ArgPickerPopup.tsx`): a windowed keyboard-driven list,
not a fullscreen modal workflow.

- **List contents**: every `flagged` entry first (open questions), then same-citation
  contradiction hints, then pending supersede proposals, each one line:
  `path/to/fact.md — citation src/foo.ts:42 not found (renamed? deleted?)`.
- **Per-item detail**: Right/Enter expands in place (no navigation away) showing the flag
  reason, the cited line's last-known content, the file's current state at that line (or
  "file not found"), and for a supersede proposal a before/after of the two statements.
- **Actions**, one keypress each, mirroring the picker's existing vocabulary: keep
  (restore, clears the flag), tombstone, supersede (prompts for a one-line replacement if
  no candidate is staged), next/prev, Esc to exit leaving everything else untouched. No
  item auto-advances on decision, so a mis-press costs a keystroke, not data.
- **Time budget**: each item is a glance and a keypress; 5-10 flagged items should take
  under a minute. Nothing requires typing except the optional replacement statement.
- **CLI parity**: `athena memory review --list` / `--keep <path>` /
  `--tombstone <path> <reason>` mirrors the TUI actions for non-interactive use, matching
  the existing `athena learn <subcommand>` precedent, and is what a future pre-commit
  hook could call.

## Failure modes

- **Over-pruning context** — structural: nothing is ever deleted (tombstoned files stay
  on disk and remain `Memory read`-able), the index still lists tombstoned entries by
  default (dropping them is opt-in and time-delayed), and `supersede` keeps the old file
  precisely to preserve the "why." The only removal path remains the pre-existing
  human-invoked `Memory delete`.
- **Verification false positives** — addressed by the git-rename fallback and line-window
  content-hash matching. Residual risk: a file rewritten enough that no line in the
  window hash-matches while the fact remains true. Accepted — worst case is one quick,
  correct-to-dismiss review item, never a silently corrupted memory.
- **A correction that is itself wrong** — the `UserPromptSubmit` heuristic is never
  ground truth; it only adds context nudging the already-reasoning model, which can push
  back in-conversation. An agent-driven `supersede` moves the old file to `superseded`,
  never `tombstoned` — tombstoning requires either strong mechanical evidence (citation
  genuinely gone) or explicit human confirmation. If the correction was wrong, the old
  file is intact with links preserved and `restore` is one keypress.
- **Unbounded growth** — the tombstoned-drop rule bounds the *injected* index regardless
  of file count; count-triggered consolidation bounds the `active` count against restated
  duplicates. Unbounded growth of the directory on disk is intentional: it is the audit
  trail, disk is cheap, and superseding is explicitly preferred over deleting. This
  mirrors `learned.jsonl` being append-only forever while `LEARNED.md` stays small.

## Explicitly out of scope for v1

- Cross-project hygiene (dedup/contradiction across project-scoped and global memory
  roots). v1 verifies each root independently.
- A deprecated-flag/alias ledger for zero-false-positive flag renames.
- Any journal-derived trigger — interface assumption only.
- A standalone all-pairs LLM contradiction sweep; folded into consolidation instead.
- User-configurable hygiene hooks. v1 is internal; letting a project override thresholds
  is a small additive follow-up.

## Build sequence

**Phase 1 — citation verification only (mechanical, zero LLM cost, highest value per
token).**
1. `src/brain/hygiene.ts`: `extractCitations`, `verifyCitations` (file:line and bare-path
   only), content-hash fingerprinting, git-rename fallback.
2. Frontmatter helpers reusing `parseFrontmatter`; extend `Memory` with `flag`/`restore`
   only — supersede/tombstone wait for the review surface so they are reviewable before
   they are reachable.
3. Wire `PostToolUse` (scoped) and `SessionStart` (full sweep).
4. Extend `updateIndex()`/`MEMORY.md` with the FLAGGED marker and the `Memory read`
   banner.
5. `/memory review --list` read-only output, so flags are visible and actionable from day
   one before any TUI work.

*Evidence phase 1 generates for phase 2*: the real false-positive rate on this codebase's
own memory files (tunes window size and whether git-rename catches enough), real flag
volume (tunes review-list length and whether the default consolidation threshold of 15 is
right), and which citation type produces the most signal — informing whether flag/command
checking is worth building at all.

**Phase 2 — correction capture, supersede/tombstone, interactive review.**
6. `supersede`/`tombstone` ops.
7. `UserPromptSubmit` correction heuristic (added-context nudge only).
8. System-prompt/tool-description update instructing proactive `flag`/`supersede` on
   recognized corrections.
9. `/memory review` interactive picker reusing `SessionPicker`/`ArgPickerPopup`.
10. Same-citation contradiction hints.
11. Tombstoned-drop-after-N-days rule.

**Phase 3 — consolidation.**
12. Growth-counter persistence (`hygiene-state.json`), `consolidationDue` on
    `Memory write`.
13. `consolidate()` agent-invoked pass (semantic dedup/merge, contradiction detection
    across statements not sharing a citation).
14. `/memory consolidate` explicit trigger, mirroring `athena learn consolidate`.

Phase 1 alone is shippable and delivers the highest-value item with no new UI and no new
LLM spend.
