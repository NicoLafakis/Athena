# Blind-first Jarvis upgrade - objective overview

**Tier:** 3 - major / high-risk
**Date:** 2026-07-29
**Status:** planning
**Product contract:** [build specification](../../../docs/discovery/build-spec.md)
**Decision ledger:** [decision ledger](../../../docs/discovery/decision-ledger.md)

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
- Explicit integration seams for the existing Experiential Layer plan.
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
- [ADR 001: semantic event plane](adr/0001-semantic-event-plane.md)
- [ADR 002: append-only screen-reader adapter](adr/0002-append-only-screen-reader-adapter.md)
- [Test strategy](test-strategy.md)
- [NFR budgets](nfr-budgets.md)
- [Observability](observability.md)
- [Rollout and runbook](rollout.md)
- [Threat model](threat-model.md)
- [Risk register](risks.md)
- [Implementation tasks](tasks.md)
