# CLI contract repairs

## Outcome and authorization

Implement the three repair phases requested by Nico on 2026-10-13, following the
Athena CLI upgrade proposal and the source review at baseline
`fd75be91f9428556e78c40060c3ac659ebe945ba`. User instruction: "Create a 3 phased plan
with tasks within each ... Follow TDD and complete the implementation of all 3 phases".
This authorizes the implementation below; it does not claim separate approval of
details invented later. Status: implementation complete; final exact-tree/CI gate tracked in progress.

## Invariant

An action is authorized against the action actually executed; only fresh consent
can approve it. Blocked work never reports success. Visible controls own input,
and rendered physical rows agree with their budget.

## Phase 1: execution correctness

- [x] P1.1 Write failing parser-to-child tests for omitted and partial limits,
  invalid limits and zero tool allowance; resolve only defined validated overrides.
- [x] P1.2 Write failing blocked-hook tests through Engine and text/JSON/JSONL CLI;
  propagate a non-success reason without preventing turn teardown.
- [x] P1.3 Write failing Memory authorization tests for relative paths, linked
  targets, index writes and plan/read-only operations; share canonical target
  resolution between authorization and execution with explicit memory scope.
- [x] P1.4 Run focused suites, independently review security and result propagation,
  and reconcile documented behavior.

## Phase 2: consent correctness

- [x] P2.1 Add a shared safe permission-detail representation for effective input,
  cwd, target, reason, full available diff and exact session grant.
- [x] P2.2 Test then implement permission-local details while the same request
  remains pending, in Ink and append-only presentations, with no tool/model call.
- [x] P2.3 Test then isolate consent from buffered drafts, modified keys and stale
  requests; deny cancellation and missing approvers. Keep ordinary input buffering.
- [x] P2.4 Correct session-grant labels and disclose effective trust/sandbox
  consequences before consent. Preserve explicit denies and hook reauthorization.
- [x] P2.5 Review composition tests and documentation; retain voice's bounded
  allow-once semantics.

## Phase 3: terminal reading and input

- [x] P3.1 Test then wire local inspection of retained tool input/output, searchable
  paged content, accurate truncation notices and a plain-text export route.
- [x] P3.2 Test then share rendered/estimated tool rows and physical-row diff/input
  calculations. Bound the composer; provide a tiny-terminal fallback.
- [x] P3.3 Test then make cursor motion/deletion grapheme-safe and ensure invisible
  menus cannot consume keys. Preserve existing portable bindings.
- [x] P3.4 Keep local inspection usable during work without admitting a second model
  turn; distinguish streaming output from completed tools.
- [x] P3.5 Run every-frame layout tests, integration checks, independent review,
  then exact-staged-tree typecheck, lint, test and build; push topic PR and inspect CI.

## Acceptance criteria

### AC-1: child ceilings survive parsing
Omitted fields preserve all defaults, partial fields affect only themselves,
invalid numeric values fail clearly, zero tool calls remains valid.
Proof: parser/orchestrator/budget regression tests.
Paths: src/brain/loader.ts, src/harness/agents.ts, tests/brain/**, tests/harness/**.

### AC-2: blocked is not success
Denied prompt makes zero model calls, returns a non-success reason and exits
nonzero in text, JSON and JSONL. Busy state still clears.
Proof: Engine and real-process CLI tests.
Paths: src/engine/**, src/cli.ts, src/interaction/**, src/harness/agents.ts,
tests/engine/**, tests/cli/**, tests/interaction/**, tests/harness/**.

### AC-3: Memory target parity
Gate and execution agree on canonical targets, including index mutation. Links
cannot escape the explicitly permitted memory root. Read/list work in read-only
planning; writes remain subject to mutation policy.
Proof: filesystem-backed Memory and permission integration tests.
Paths: src/tools/**, src/harness/**, src/engine/**, tests/tools/**, tests/harness/**,
tests/engine/**.

### AC-4: inspectable consent
The distinguishing end of a long command or change after line 100 is reachable
before answering the same request. Effective target, cwd, reason and exact grant
scope are available; controls are sanitized and secret redactions explicit.
Proof: presentation and Ink integration tests.
Paths: src/presentation/**, src/tui/**, src/engine/**, src/cli.ts,
tests/presentation/**, tests/tui/**, tests/engine/**, tests/cli/**.

### AC-5: fresh consent and truthful trust
Pre-prompt buffered input, modified approval keys, cancellation and stale request
responses cannot approve a new action. Trust consequences appear before acceptance.
Proof: input/presentation/CLI regression tests, existing hook/deny tests.
Paths: src/presentation/**, src/tui/**, src/engine/**, src/cli.ts, src/harness/**,
tests/presentation/**, tests/tui/**, tests/engine/**, tests/cli/**, tests/harness/**, tests/voice/attention.test.ts.

### AC-6: retained output is reachable
An available 200-line result can be inspected, paged, searched and exported locally
with command and status. Omitted content is identified. Inspection works while busy
without a second engine turn; return preserves transcript position.
Proof: reader and App integration tests.
Paths: src/tui/**, src/presentation/**, src/tools/shell.ts, src/cli.ts,
tests/tui/**, tests/presentation/**, tests/tools/**, tests/cli/**.

### AC-7: safe terminal input/layout
40x12, 80x24 and 120x40 fixtures plus resize use physical-row budgets, preserve
graphemes, and never let invisible choices own keys. Unsupported tiny sizes have
an explicit fallback. Assert content signatures over every captured frame.
Proof: layout/input regression suites.
Paths: src/tui/**, tests/tui/**.

### AC-8: release evidence
All required gates pass on the exact staged tree; documentation matches code and
independent review has no unresolved blocking findings. CI is reported separately
from local, real-terminal, assistive-technology and live-provider evidence.
Proof: recorded commands/tree ID, PR CI results, review record.
Paths: .wiki/**, ARCHITECTURE.md, .longhaul/**.

## Fixed decisions and non-goals

Reuse HarnessSessionController, PermissionEngine, existing presentation contracts,
RunBudget and viewport wrapping helpers. Add no runtime dependency or database.
Do not implement whole-task accounting, durable steering, crash continuation,
cross-machine sync, deeper delegation, a new memory store, or broader voice features.
Do not claim real NVDA/Narrator or human usability acceptance from synthetic tests.
Do not acquire providers or spend live model tokens. Keep credentials out of git.
Do not merge before CI passes; this run delivers a reviewed topic PR.

## Change budget and open questions

Allowed paths are the acceptance-criterion paths above; maximum 90 changed files.
No blocking product question: use conservative local controls and existing patterns.
Human hardware/accessibility acceptance remains a disclosed release boundary.
Related design and evidence: [design](design.md), [progress](progress.md).
