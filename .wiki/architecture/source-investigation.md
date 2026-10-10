# Bounded source-text investigation

Implemented locally in the shared harness as `Investigation` plus the bundled
`Skill` named `source-investigation`. This is a finite source-text investigation
MVP. The separately implemented [self-reflection journal](self-reflection-journal.md)
provides provisional historical interpretations; it cannot satisfy this feature's
completion checks or supply missing behavioral providers.

## Workflow and contract

1. `start` declares a question and up to 16 project-relative files. The target
   retains the canonical project namespace, available Git HEAD, and SHA-256 of
   every declared file, including dirty source. Unreadable, missing, binary, and
   oversized files have a null hash and an explicit problem. Without Git, the
   content snapshot still identifies the finite source selection; the missing
   Git revision is reported as a limitation.
2. `read` invokes the existing `Read` implementation to retain a bounded line
   selection. Source bytes must match the recorded revision before and after
   reading. The observation retains its location, full-file hash, producer and
   contract version, run/tool-call identity, text, limitations, and independent
   origin group. Plain Read/Grep/Glob/Diagnostics remain navigation tools; they
   do not automatically populate this ledger.
3. `note` records a derived or inferred interpretation and its parent evidence
   IDs. The caller cannot create an observed record. Notes inherit origin IDs
   rather than adding independent corroboration.
4. `submit` records hypotheses, claims, discriminating tests, and unknowns using
   the strict Zod contract in `src/investigation/types.ts`. It requires the
   returned `expectedVersion`. All references must resolve inside this ledger.
   Status, completion, and confidence are server-owned. At least two hypotheses
   must each have a test. Required providers, claim scopes, counterevidence,
   and recorded unknowns cannot be silently removed to turn an incomplete
   report into a pass. Existing test predictions are immutable. Unknowns cannot
   be resolved in-place in this MVP; new scope or predictions, or a resolved
   unknown, require a new investigation with fresh evidence.
5. `complete` persists verification. `result` reloads history and computes fresh
   verification. Reading an old passed result after changed HEAD or changed
   declared bytes reports stale claims. Evidence cannot be transplanted into a
   new revision; start a new investigation.

The tool's advertised JSON Schema includes the operation branches and nested
result contract. Runtime parsing remains strict; malformed inputs, forged
outcomes, duplicate record IDs, missing references, and stale updates fail.

## What a pass means

The sole provider is `source-text`: an exact literal `present` or `absent`
predicate in a nonempty retained line selection. Its range is part of the
proof. Absence within that range says nothing about other lines, files, entry
points, or dependencies. Redacted, incomplete, or truncated selections cannot
pass. Retained observations are checked against actual current source bytes
again on report and completion, rather than treating a valid ledger hash as
an oracle.

Claim statements and hypotheses are authored interpretations. A passed claim
covers only its linked literal predicates, not the meaning of its free text.
`source-behavior`, runtime, and external claims cannot pass from source-text
checks. `unit`, `runtime`, and `external` verification providers are explicitly
unsupported in this phase; even a claimed unit result cannot verify runtime
or external effects. No binary provider, native engine, graph database, target
execution, or provider installation is included.

Completion requires all claims passed, no unknowns, no missing declared files,
and genuinely different outcomes for the declared alternatives: at least one
has passing source predictions and at least one has a failed prediction. Every
alternative's tests must be resolved; unsupported tests and counterevidence
against a passing alternative leave it unresolved. A failed alternative is
expected evidence in a discriminating investigation, rather than a reason to
require every competing prediction to pass. These outcomes still concern
declared predicates, not semantic proof of an arbitrary hypothesis.

Evidence count is a count of source origin groups, not a probability of truth.
Repeated reads return the same evidence ID without a new ledger version.
Overlapping selections and identical source-file bytes share an origin group;
derived and inferred repetitions do not increase it. Distinct artifacts are
not claimed to be statistically independent observations of behavior.

## Execution and storage

The shared `HarnessSessionController` registers the skill/tool for exec, TUI,
screen-reader, and voice compositions. Existing durable children inherit the
tool under their usual restrictions. The existing engine runs tool-owned
completion checks before `turn-done`; assistant prose cannot make an incomplete
investigation completed. Failed investigations produce an error run and an
explicit controller summary. A durable child's failure propagates as an error
Agent result. Checks are scoped to the run/turn, then released so an unrelated
next turn is unaffected. Permission-denied and failed-start attempts create no
phantom active investigation.

The tool is mutating because it writes harness metadata; ordinary permissions,
hooks, plan mode, and the read-only sandbox still govern invocation. Source
access uses the existing resource policy and canonical project containment.
Storage is fixed to the harness-owned brain root, with no model-supplied output
path; this does not grant Write/Edit access to the rest of the brain. Canonical
descendant revalidation rejects redirected ledger directories, and the existing
protected-system-path fence applies to the store as well.

```text
<brainDir>/investigations/<canonical-project-id>/<investigation-uuid>.jsonl
```

Each schema-v1 record contains an immutable snapshot version, sequence, previous
hash, and current hash. The ledger validates the complete history, links and
unchanged target/observations on reload. Append/fsync/readback happens on demand,
with an exclusive writer lock and no optional boot migration. A duplicate
request does not append a duplicate snapshot. Caps are 1 MB per source file,
200 lines / 20,000 retained characters per selection, 64 observations, 128
versions / 4 MB per ledger, and 8 active investigations per turn. Schema caps
also bound hypotheses, claims, tests, notes, and unknowns.

Partial, malformed, tampered, or over-limit history fails closed and is preserved.
A crash can leave a `.lock` file: preserve the ledger and remove only that lock
after confirming no Athena writer is running. There is no automatic lock
stealing, history repair, automatic expiry, or unknown-resolution provider.
Shared-workspace children can reload the same canonical project ledger. An
isolated temporary worktree has its own namespace; the parent and a later
temporary worktree cannot resume it by ID. Stable cross-worktree identity is
deferred and must not be claimed supported.

Run/tool events remain in the existing hash-chained run traces. Neither those
hashes nor ledger hashes authenticate historical tool provenance or prove the
truth of authored text. A fully rewritten and rehashed ledger can be internally
valid; rechecking source bytes prevents forged retained text from becoming proof
of current source content. No records are promoted into governed memory or
experience guidance automatically.

## Evaluation and reference

`tests/tools/investigation.test.ts` evaluates a small feature and a misleading
comment, repeated requests, derived/inferred evidence, contradiction, missing
providers, dirty and committed revision changes, persistence/reload, malformed
and rehashed history, unsupported alternatives, discarded unknowns, storage
redirects, namespace isolation, and failed-start recovery. Shared-controller
tests use a real home outside the project, actual tool dispatch, trace readback,
canonical directory aliases, denied permission, and durable child failure.
Provider responses in these integration tests are scripted: they establish
local harness behavior, not live model behavior or external effects.

Design reference: [morluto/rea at
2ec93ba1662ff0d61496d4d10337ae43ca03ccdf](https://github.com/morluto/rea/tree/2ec93ba1662ff0d61496d4d10337ae43ca03ccdf),
especially its evidence workflow, unknown registry boundary, and completion
ledger. Its [MIT license](https://github.com/morluto/rea/blob/2ec93ba1662ff0d61496d4d10337ae43ca03ccdf/LICENSE)
was checked. This implementation was written independently; no REA code was
copied or installed. Reference files are source material, not project instructions.
