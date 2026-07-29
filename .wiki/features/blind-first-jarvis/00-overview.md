# Blind-first Jarvis upgrade - objective overview

**Tier:** 3 - major / high-risk
**Date:** 2026-07-29
**Status:** implementation in progress (semantic truth and attention plane)
**Product contract:** [build specification](../../../docs/discovery/build-spec.md)
**Decision ledger:** [decision ledger](../../../docs/discovery/decision-ledger.md)

> **Single source of truth:** This directory, together with the linked build specification
> and decision ledger, is the only authoritative plan for the Jarvis upgrade. Voice and
> experiential learning are component designs inside this package, not independent
> roadmaps.

## What was asked

Research and develop the plan to upgrade Athena so she behaves like Jarvis, using the
exercise of designing for a blind person to force the interaction model to become truly
context-aware, conversational, and non-visual.

## What it really serves

The user should express outcomes and retain control while Athena carries the burden of
situational awareness. Blind-first design makes the requirement testable: no essential
state, action, risk, or recovery path may depend on watching a dynamic interface.

The target is not more personality. It is a trustworthy loop:

```text
observe -> reduce to semantic state -> prioritize -> announce or stay quiet
        -> act with permission -> verify -> preserve evidence -> remember selectively
```

## Twenty moves ahead

- **Next wants:** queryable status, calm proactive warnings, accessible permissions,
  durable objectives, relevant experience, foreground watchers, optional voice, and
  eventually consented between-session monitoring.
- **Breaks at edges:** screen readers interpret terminals differently; animated/cursor
  rewriting output becomes noisy; model-authored status can sound authoritative while
  being wrong; proactivity can become interruption; persistent processes add boot,
  privacy, and resource risks.
- **Unlocks:** the semantic contract becomes a shared control plane for the visual TUI,
  screen readers, Braille, JSONL automation, notifications, remote clients, and voice.
- **Doors kept open:** presentation adapters, versioned events, evidence links, explicit
  user preferences, and opt-in watchers preserve future platforms without forcing a
  voice or daemon dependency now.
- **Doors shut:** accessibility as a skin over the fullscreen TUI, disability detection
  by inference, voice-only operation, unverified self-reporting, and autonomy that evades
  existing permission gates.

## Scope line

### Building

- A versioned semantic interaction-state model derived from runtime evidence.
- A priority, coalescing, and redaction-aware announcement pipeline.
- A stable append-only screen-reader presentation and accessible permission flow.
- Query commands for status, repetition, detail, and interruption feedback.
- Deterministic proactive triggers inside active runs.
- A deterministic, bounded Experiential Layer for advisory retrieval.
- A staged foreground watcher and optional voice roadmap.
- Automated and manual assistive-technology release gates.

### Surfacing for Nico's call

- Whether the first final boundary is in-session or ambient between-session assistance.
- The release-blocking screen-reader/platform matrix.
- Whether the semantic/screen-reader foundation or tracked voice-daemon spike leads the
  implementation sequence.
- The pre-mortem priority: noise, false confidence, or incomplete real-world usability.

Recommended defaults are recorded in the
[decision ledger](../../../docs/discovery/decision-ledger.md), so none blocks Phase 1.

### Dropping

- A cinematic persona imitation.
- A large new TUI panel.
- A second memory/experience subsystem.
- Always-on background model calls.
- Automatic tool denial from experiential advice.
- Cross-machine credentials or accessibility-preference sync.

## Caliber and package

Tier 3 is required because this changes the customer-facing CLI and interaction contract,
touches permissions and potentially sensitive event data, spans more than ten files, and
has high trust cost if state or approvals are announced incorrectly.

Package:

- [Research basis](research.md)
- [Product requirements](../../../docs/discovery/build-spec.md)
- [PRD](prd.md)
- [Technical design](design.md)
- [Experiential Layer component](experience.md)
- [Voice component](voice.md)
- [ADR 001: semantic event plane](adr/0001-semantic-event-plane.md)
- [ADR 002: append-only screen-reader adapter](adr/0002-append-only-screen-reader-adapter.md)
- [Test strategy](test-strategy.md)
- [NFR budgets](nfr-budgets.md)
- [Observability](observability.md)
- [Rollout and runbook](rollout.md)
- [Threat model](threat-model.md)
- [Risk register](risks.md)
- [Implementation tasks](tasks.md)

## Implementation status

Phase 1 now has a passive semantic subscriber in the CLI composition root. Versioned,
bounded envelopes are derived from user objectives and runtime events, reduced into
per-run snapshots, and appended as redacted metadata through the existing hash-chained
run trace. `turn-done` carries its authoritative `RunResult`, so completion, limit,
failure, and abort state never need to be inferred from assistant prose.

Implemented and covered by deterministic tests: contracts and schemas, per-run/root-child
sequencing, the pure reducer and source-precedence rules, malformed/cross-run/order
rejection, trace metadata, deterministic announcement priority, coalescing, durable
blocking history, redacted plain-text status/detail formatters, and real `athena exec`
composition. The service exposes local status, repeat, detail, verbosity, acknowledgement,
and unresolved-blocker APIs without a model call or presentation output. A 20,000-event
regression fixture enforces the reducer-plus-policy p95 budget.

Adapter-neutral permission lifecycle events are now emitted around every engine `ask`
decision with stable pairing, fail-closed headless resolution, credential redaction, and
no raw tool input. They drive exact blocking attention and semantic phase restoration
outside React. The approved composition now carries the stable request into the existing
behavior-compatible Ink queue or the append-only accessible permission flow. Shared
diffs provide change counts and bounded redacted on-demand detail.

Phase 3 is now active end to end: global accessibility preferences receive
deep safe defaults, project `.athena/settings.json` values cannot override them, and a
malformed optional accessibility object warns with its file and recovery action while
falling back to standard presentation. `--accessibility screen-reader|standard` overrides
the global choice for one invocation. The screen-reader composition never mounts Ink,
uses serialized append-only line input/output, supports the shared local state commands,
and presents stable permission identity, change counts, choices, and detail routes. The
standard TUI remains the default. Screen-reader first-run auth uses fully silent hidden
entry, cancellation/resume and command parity are fixture-backed, and only human
assistive-technology validation remains open for Phase 3.

`athena exec --output jsonl` now externalizes the same validated semantic envelopes as
additive versioned `interaction-event` records. Source engine events remain compatible,
semantic facts follow their source event in stream order, the redacted objective precedes
the run, and terminal facts precede the unchanged final `exec-result` envelope.

Phase 4's deterministic situational-awareness core is also implemented: bounded
agent-authored objective/next-step assertions, unchanged-input repeated-failure advice,
gate invalidation after successful mutations, one-time 75%/90% budget advisories, and
coalesced child/background activity. Background start, completion, failure, awaited
retrieval, and shutdown abort are authoritative events; detectors retain bounded
metadata or hashes and never grant/deny tools or create verified outcomes.

Phase 5's canonical Experiential Layer is now implemented in `src/experience/` and wired
through the same semantic plane. Verified redacted traces compile into bounded local
experience plus provisional guidance; only explicitly reviewed, fresh, project-relevant
guidance qualifies during repeated unchanged failure. The semantic seam carries
metadata rather than retrieved prose, and cross-system tests prove irrelevant, stale,
or contradictory experience remains quiet and cannot replace current runtime truth.
Visible experience-management commands remain behind the existing frontend approval
gate.

The Phase 0 engineering baseline and Phase 4 detector dogfood are now executable. A
versioned proxy fixture covers all eleven core journey capabilities, a research-only
vocabulary contract freezes the seven semantic labels, and every deterministic detector
has exact helpful and quiet replay evidence through the production adapter. These remain
explicitly distinct from the open blind-participant and assistive-technology gates.

The append-only presentation is implemented under `src/presentation/` and composed from
`src/cli.ts`. It provides shared lifecycle/permission contracts, stable accessible
permission wording and IDs, serialized line input, byte-tested plain output, queued
announcements instead of prompt rewriting, and a line-oriented session selector. The
existing Ink queue remains behavior-compatible. Screen-reader auth is non-chattery; the
human assistive-technology gates remain open.

The Phase 6 watcher foundation is now implemented without starting anything from normal
Athena boot. Explicit user-created definitions are resource-policy scoped and atomically
stored; a real sentinel probe proves backend availability; foreground observation is
bounded, path-free, abortable, and nonfatal under corrupt state, backend failure, or
shutdown races. The visible foreground command and cross-platform dogfood remain open.

Phase 7 now composes that provider-neutral core into an opt-in Windows voice process.
Local `System.Speech` gates confidence-thresholded commands on “Athena”; the current
OpenAI Realtime WebSocket conductor provides PCM speech and bounded `delegate`/`status`
tools; a separate local confirmation runs the existing engine in a durable resumable
session. Keyboard input, vault/env auth, usage-only records, fake-server protocol tests,
and an interactive device/account probe are present. Nico's live probe, latency/cost and
false-positive measurements, retention review, and manual AT/voice validation remain.
