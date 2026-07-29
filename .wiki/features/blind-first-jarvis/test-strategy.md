# Blind-first Jarvis upgrade - test strategy

> [Objective overview](00-overview.md) | [Requirements](../../../docs/discovery/build-spec.md)

## Test principle

Automated tests prove ordering, completeness, and absence of known hazards. They do not
prove that a blind person can use Athena effectively. Each release combines deterministic
tests with manual keyboard, screen-reader, and user validation.

## Acceptance mapping

| Requirement | Level | Primary location |
|---|---|---|
| R-001 accessible presentation | unit + integration + manual AT | `tests/presentation/`, terminal matrix |
| R-002 semantic state | property/unit + trace replay | `tests/interaction/state.test.ts` |
| R-003 announcement policy | table/property tests | `tests/interaction/announcements.test.ts` |
| R-004 orientation/control | integration | `tests/cli/accessibility-commands.test.ts` |
| R-005 permissions | integration + manual AT | permission queue and screen-reader fixtures |
| R-006 keyboard parity | command matrix + manual | `tests/presentation/keyboard-parity.test.ts` |
| R-007 outcome behavior | scenario replay | `tests/interaction/journeys.test.ts` |
| R-008 proactivity | detector fixtures | `tests/interaction/detectors.test.ts` |
| R-009 watchers | platform-gated integration | `tests/harness/watchers.integration.test.ts` |
| R-010 voice | adapter contract + manual | later phase, separate matrix |
| R-011 privacy/evidence | redaction + trace verification | interaction/trace tests |
| R-012 release validation | CI + signed manual checklist | release artifact |

## Deterministic suites

### Reducer fixtures

Replay versioned sequences for:

- normal turn with several tools;
- failed then successful action;
- permission allowed, denied, queued, and canceled;
- child success/failure/limit interleaving;
- background output and completion;
- abort, provider error, run limit, and renderer failure;
- agent assertion contradicted by runtime result;
- out-of-order, duplicate, or malformed envelopes;
- parent and child run isolation.

Assert full snapshots, provenance, and invariant preservation after every event, not only
the settled state.

### Announcement fixtures

For each input sequence assert:

- exact priority;
- exact or pattern-bounded text;
- source references;
- dedupe/coalescing behavior;
- blocking retention and resolution;
- verbosity differences;
- no raw secret-shaped values;
- no routine animation/tool chatter in balanced mode.

### Output invariants

In screen-reader mode:

- output contains no alternate-screen, cursor-hide, erase-line, cursor-position, or
  spinner animation escape sequences;
- prior output is never overwritten;
- each permission, fatal error, and completion is emitted exactly once;
- prompts and announcements do not interleave into unreadable partial lines;
- all status meanings survive ANSI/color stripping;
- JSONL remains valid and schema-versioned.

### Existing TUI regression gates

Any visual TUI change must use current fullscreen budget primitives. Capture every frame
with large fixtures (including about 20 todos), and run `expectEveryFrameSound`-style
content signatures. A frame row count of `rows` is not evidence of correctness.

## Manual assistive-technology matrix

### Release-blocking initial cohort

- Windows Terminal + NVDA, current supported versions.
- Windows Terminal + Narrator.
- Keyboard-only with speech muted, validating Braille/text semantics.

### Cross-platform claim cohort

- macOS Terminal plus VoiceOver; add an alternative terminal if user research uses it.
- Supported Linux terminal plus Orca.
- SSH session from at least one screen-reader setup.
- At least one refreshable Braille display workflow before claiming Braille support.

Version numbers, terminal settings, verbosity, punctuation mode, and participant
experience are recorded with results. Failures are scoped to the tested combination.

## Core manual journeys

1. First run/authentication and provider error recovery.
2. Start, ask a broad objective, query status, request detail, interrupt, resume.
3. Read-only inspection followed by a multi-file edit permission.
4. Review a bounded diff and decide allow once/always/deny.
5. Parallel child agents with one failure and queued permissions.
6. Background task completion while input is active.
7. Run limit and provider failure with recovery.
8. Session resume, compaction, and final verified outcome.
9. Switch presentation mode without losing the durable session.
10. Foreground watcher failure and recovery once that phase exists.

## Blind-user evaluation

Recruit several experienced blind developers using varied screen readers and at least one
Braille workflow. Include them during prototype design and release evaluation. Measure:

- journey completion without sighted intervention;
- moments of disorientation and recovery path used;
- missed or duplicate blocking announcements;
- unnecessary interruptions;
- confidence calibration: whether participants correctly distinguish verified facts from
  advisory/agent assertions;
- qualitative workload and preferred verbosity.

Do not generalize a single participant's preference into the universal default. Record
the study scope and participant/AT characteristics.

## Gate sequence

For every implementation commit, run targeted tests. Before any push, run on the exact
state being pushed:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Accessibility release sign-off additionally requires the affected manual matrix rows and
blind-user journey gate. No localhost browser test is relevant or permitted; Athena is a
terminal product and manual validation runs in real installed terminal environments.
