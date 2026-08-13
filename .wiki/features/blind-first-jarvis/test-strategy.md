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
| R-007 outcome behavior | scenario replay | `tests/interaction/journeys.test.ts` and `tests/fixtures/interaction/core-journeys.json` |
| R-008 proactivity | detector fixtures | `tests/interaction/attention-quality.test.ts` and `tests/fixtures/interaction/attention-quality.json` |
| R-009 watchers | platform-gated integration | `tests/harness/watchers.integration.test.ts` |
| R-010 voice | schema/unit + golden semantic context + manual | `tests/voice/`, later audio/AT matrix |
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

The versioned proxy baseline fixture covers authentication, broad objectives, local
status, tools, permissions, child/background work, failure, interruption, resume, and
completion. Its `proxy-baseline` marker is load-bearing: executable coverage is not a
claim that a blind participant or assistive-technology combination has validated the
journey.

The versioned presentation-parity fixture is separately checked against the live slash
command catalog and production screen-reader router. It records nonvisual prompt,
permission, resume, and interrupt paths. Cancellation tests cover active work, a pending
line/permission read, the next usable prompt, and idle exit; selector tests cover invalid,
selected, fresh/cancel, and no-session outcomes. This is reachability evidence only, not
manual keyboard, Braille, NVDA, or Narrator validation.

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

Attention-quality dogfood replays every deterministic detector through the production
event adapter with one helpful and one deliberate quiet case. Repeated failure,
verification invalidation, and budget thresholds assert exact advisories; delegated-work
aggregation asserts exact count transitions and duplicate-event silence. Fixtures retain
only redacted event shapes, never prompts, tool output, credentials, or local paths.

### Output invariants

In screen-reader mode:

- output contains no alternate-screen, cursor-hide, erase-line, cursor-position, or
  spinner animation escape sequences;
- prior output is never overwritten;
- each permission, fatal error, and completion is emitted exactly once;
- prompts and announcements do not interleave into unreadable partial lines;
- all status meanings survive ANSI/color stripping;
- JSONL remains valid and schema-versioned.

The presentation-neutral adapter enforces these byte-level invariants in
`tests/presentation/screen-reader.test.ts`; `tests/cli/exec.integration.test.ts` also runs
the real CLI composition with a deterministic model, permissions, commands, and redirected
line input. The suites assert single assistant/completion/permission output, reject
terminal control bytes, and exercise announcement/input serialization. This proves
adapter and composition mechanics, not behavior in NVDA,
Narrator, VoiceOver, Orca, or Braille hardware; those manual rows remain open.

Watcher integration tests use the real Node filesystem backend to round-trip a temporary
sentinel and observe a known file; executable/platform presence is not accepted as
evidence. Separate fault tests inject probe/startup failure, a corrupt optional index,
and an event racing with shutdown. They assert bounded recovery warnings, unchanged
persisted state, and no post-abort observation.

Voice golden tests prove context comes only from bounded redacted semantic state,
session ambiguity produces clarification, screen-reader ownership suppresses duplicate
routine direct speech, recognition failure is a no-op, and consequential calls require a
separate local confirmation. A fake WebSocket exercises session configuration, audio,
tool-call output, continuation, errors, and usage. Subprocess seams prove a probed local
recognizer/voice rather than platform inference, wake gating, temporary PCM playback,
vault readback/rollback, and keyboard-equivalent confirmation.

Since 2026-08-13 the direct-harness seam is covered end to end rather than stubbed. A fake
socket speaking the real Realtime wire protocol drives `submit_turn` into a REAL
`HarnessSessionController` on a deterministic model, and the test asserts both the run
trace and the spoken result — a stub on either side would have proved only that the mock
was called. The redaction test is deliberately built so it cannot pass on an empty pipe: it
drives a fake API key, a real absolute Windows path, and a distinctive nonsense phrase
through the wake transcript, the submitted text, provider usage, and the model's answer,
then asserts none of them reach the telemetry ledger while the phrase DOES reach the run
trace. Permission refusals (same-turn, stale, unknown, ambiguous, closed-bridge) and turn
idempotency under reconnect are asserted directly.

The persistent wake listener is proven against the production PowerShell script under a
win32 gate, using a locally synthesized WAV sentinel rather than a microphone, and the
probe test asserts the child process exits so no orphan `powershell.exe` survives. Per
AGENTS.md rule 4, stub-only coverage of a subprocess-backed module is not coverage.

None of this proves the actual microphone, playback device, paid Realtime account, latency,
false-positive rate, or assistive-technology behavior. The raw microphone -> paid Realtime
-> Marin playback probe passed on Nico's laptop on 2026-07-29; latency, additional
machines, live wake false-positive rate, and manual AT gates remain open and are exactly
what the [acceptance runbook](acceptance-runbook.md) exists to close.

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
