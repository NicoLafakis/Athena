# Source-linked project librarian

Implemented in source, disabled by default. The installed `dist/cli.js` has not been
rebuilt or activated. This module adds an operational-document library; it does not
replace personal `Memory`, the provisional journal, governed learning or the planned
cross-project conversational-continuity system.

The design comes from Nico's [categorized-note/keyring description](https://valuefirstteam.slack.com/archives/C0ACC0UBC5U/p1792759133185199)
and [verification/post-commit workflow](https://valuefirstteam.slack.com/archives/C0ACC0UBC5U/p1792797563169729).
Exact matching, four review stages, file schemas, budgets and recovery semantics below
are implementation choices. No TTL/decay, background provider, or OS scheduler is added.

## Harness integration

`HarnessSessionController` opens `LibraryRuntime` only for a trusted project with an
explicit enabled `.athena/library.config.json`. Missing/invalid opt-in fails soft.
Enabled sessions mount permission-gated `LibraryRead` and `LibraryWrite`; read-only
sandbox sessions mount only `LibraryRead` and do not write lifecycle checkpoints.
Child agents explicitly receive neither library tool, even when named in their tool
allowlist. The current tool instances own the parent's ephemeral selection; child
engines do not yet have independent librarian context adapters. Children ask the parent
for scoped evidence rather than mutating parent selection or receiving unusable IDs.

A working agent requests category keys. The librarian applies project scope, category
match, durable status, current original sources, committed-review integrity and check
receipts. Detailed source notes are returned unless `shape: summary` is explicit.
Whole records that exceed the result budget are omitted, never silently summarized.

`LibraryRead` returns selected IDs; detailed text is supplied through the engine's
existing request-time historical-context seam. It is revalidated for every outgoing
request, excluded from session history/compaction, and cleared at the next turn. While
an explicit library selection is active, provisional journal recall is not mixed into
that same request context. Startup personal-memory behavior remains unchanged. Library
writes do not copy notes into `MEMORY.md`, `LEARNED.md`, journal or experience stores.
Normal assistant answers and explicit source-reading tool results still follow the
existing transcript policy; their possible paraphrases are not automatically erased.

The shared engine event bus drives bounded metadata checkpoints for every presentation
using that controller, including CLI, Ink, screen-reader and voice entry points. This
avoids relying on compaction hooks, which manual and preflight compaction currently
bypass. Checkpoint failures warn without breaking ordinary turns.

## Positive content policy and storage

Source and review integrity use Git's canonical blob representation, including its
built-in text/EOL rules. A clean CRLF working copy and LF Git object are equivalent;
semantic edits still invalidate provenance. External clean filters and non-UTF8
working-tree encodings are refused before hashing, so retrieval does not execute
project filter commands. No object is written (`hash-object` is called without `-w`).
Raw-byte provenance records from the earlier inactive prototype require regeneration.

The opt-in names exact **public** project files. Tool submissions contain only approved
detail/summary/source paths and allowed categories, never arbitrary note text. Unknown
paths, outside paths, credential/environment/key paths, redirected paths, oversized
files, common secret formats, email/SSN patterns and explicit sensitive markers are
rejected before library persistence. A public-source allowlist is an explicit operator
classification, not automatic detection of all sensitive information. Do not approve
private files. Automated filters cannot prove that arbitrary prose is nonsensitive.

Detailed notes remain authoritative library material; summaries/categories are linked
by the same content-derived identity and original source revisions. Files are bounded
to 64 KB; detail to 32,000 characters; summary to 2,000 characters; each note to 32
sources/categories. Default retrieval is four items within 12,000 serialized characters,
with hard caps of 16 items/32,000 characters and 16 matching candidates validated.
A no-hit result is not proof that no relevant note exists beyond that bounded selection.

Project runtime state lives only at `.athena/library/library.json`. No personal-brain
location is selected by this implementation. At most 1,000 notes, 64 recovery metadata
records and 8 MB are accepted. Exclusive writer locks, schema/content-identity checks,
revision comparisons, fsync, temporary-file readback and atomic rename protect saves.
Corrupt state is preserved; a crashed writer lock requires operator inspection rather
than age-based lock stealing. This is a cooperative local store, not an OS sandbox or
adversarial-filesystem database. Filesystem crash durability across every OS is unproven.

## Reviews and durable promotion

Normal operational flow is plan, implement, test, review against the request, revise,
commit, then write/curate notation. Public note documents and review evidence can be
committed in a subsequent documentation commit. Candidate submission alone never
confers durable status. The library does not commit or push repositories.

Operator review imports four committed JSON evidence files: `request`, `implementation`,
`verification`, `librarian`. Each must approve the exact note identity and carry a
reviewer, rationale and distinct file digest. Example:

```json
{
  "schemaVersion": 1,
  "stage": "librarian",
  "noteId": "<64-character note ID>",
  "reviewer": "<actual reviewer identifier>",
  "verdict": "approve",
  "rationale": "<concrete evidence and limitations from this review>"
}
```

Promotion checks the actual Git objects and current files, requires the requested
commit to be HEAD, requires tracked files to match HEAD, validates all four committed
review files, and executes the configured local Node checks. Check entry scripts must
be tracked project JavaScript files. Success stores the checked Git tree, check IDs,
exit-success receipts and output hashes without retaining raw command output. Every
receipt binds a versioned definition digest covering check ID, exact argument array,
Node executable path/version, working directory and canonical entry-script revision. The
definition is captured before execution and must still match afterward. Changed
arguments or script content invalidate recall after restart even when the ID is the
same. Legacy receipts without this digest fail closed. Operator `reverify` reruns the
full source/review/commit/check gates and replaces receipts only on success. Sources,
HEAD, tracked tree, configuration and storage revision are rechecked before saving.
Later retrieval permits ancestor commits only while the original sources, reviews and
receipt identities remain eligible. This is historical evidence for the recorded commit, not proof that the current entire project passes its checks. Altered/deleted sources or review files fail closed.

Review identities/rationales are not authenticated human identity, and committed reviews
are not proof of semantic truth. Configured checks must meaningfully test the claim;
a trivial passing script is weak evidence. Check execution runs trusted project code as
the caller, with a reduced environment and no inherited provider keys; it is not an OS
sandbox. Receipts do not fingerprint the Node binary, environment values, or transitive imports/dependencies. This includes tracked dependencies outside the declared source set, as well as dependencies outside Git; changes to those inputs are not automatically covered by receipt validation.
Model-facing library tools expose neither promotion/review nor check execution.

## Recovery, corrections and rollback

Turn-start writes only run UUID, turn number, status and deterministic checkpoint ID.
Terminal completion/interruption updates that record; a crash leaves `active`, displayed
as `unresolved` after restart. Prompts and raw tool output are never copied into these
checkpoints. Existing sessions/traces remain the recovery source.

A specifically submitted recovery note is quarantined. Explicit operator release checks
its sources and resets it to an unreviewed candidate. It must pass all ordinary review
and commit gates. This fills an unspecified abandoned-run edge; Nico did not describe
an existing recovery algorithm in the Slack thread.

Promotion may atomically supersede an existing durable note. Rejection/supersession
exclude notes from recall without deleting audit history. Exact resubmission is
idempotent and never resurrects a rejected record; universal semantic deduplication is
not claimed. Rollback requires the expected current snapshot revision, rejects the new
promotion and restores its superseded predecessor's status. Restored stale sources
remain ineligible. There is no automatic expiry or arbitrary age-based deletion.

## Operator invocation and opt-in

The standalone source CLI uses the existing `tsx` dependency and leaves installed dist
alone. Run from the Athena repository:

```powershell
node --import tsx src/library/cli.ts status C:\path\to\project
node --import tsx src/library/cli.ts submit C:\path\to\project input.json
node --import tsx src/library/cli.ts review C:\path\to\project review-input.json
node --import tsx src/library/cli.ts promote C:\path\to\project promote-input.json
node --import tsx src/library/cli.ts retrieve C:\path\to\project query.json
node --import tsx src/library/cli.ts recheck C:\path\to\project
node --import tsx src/library/cli.ts reverify C:\path\to\project reverify-input.json
node --import tsx src/library/cli.ts rollback C:\path\to\project rollback-input.json
```

The final argument is a JSON file, capped at 64 KB. `release` and `reject` take `id`.
`reverify` takes `id`, `commit` for an existing durable note; `review` takes `id`, `commit`, `path`; `promote` takes `id`, `commit`, optional
`supersedes`; `rollback` takes `id`, `expectedRevision` from `status`.
Example opt-in (create only after public-file approval):

```json
{
  "enabled": true,
  "publicSources": ["docs/public-notes/detail.md", "docs/public-notes/summary.md", "src/example.ts"],
  "categories": ["context", "memory"],
  "checks": [{ "id": "project-tests", "args": ["scripts/verify-library.mjs"] }]
}
```

`submit` input:

```json
{"detailPath":"docs/public-notes/detail.md","summaryPath":"docs/public-notes/summary.md","sourcePaths":["src/example.ts"],"categories":["context"]}
```

`retrieve` input: `{"keys":["context"]}`; add `"shape":"summary"` only when wanted.
Changing/removing the opt-in immediately invalidates an already-open runtime; restart
to apply the new policy. Setting enabled false disables future sessions and operator
mutations while preserving state for review. Do not delete existing stores to disable.

No global activation is needed for this project-only path. Global `~/.athena/library`,
instructions, settings, hooks, skills, scheduler installation, lightweight-model note
generation, and the active CLI build remain separately unactivated. `recheck` is a
local operator command suitable for a future explicitly approved scheduler; no schedule
or paid model invocation is installed here. Global storage support is not implemented.

## Evidence

`tests/library/library.test.ts` exercises core state, sensitive-content rejection,
atomic-write failure, corruption, competing writers, tampering and rollback.
`tests/library/integration.test.ts` uses disposable Git repositories to test actual
post-commit verification, failed checks, review/source invalidation, tool interfaces,
operator CLI, default disablement, ephemeral controller retrieval, opt-in revocation,
interruption, restart, bounded recovery, core.autocrlf=true CRLF/multiline provenance, child-agent exclusion and exact-check-definition changes. Providers are mocked; no real memories or
credentials are read. Existing controller/context/journal/memory suites are regressions.
