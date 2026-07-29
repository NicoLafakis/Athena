# ADR 0001: Put a semantic event plane between runtime events and presentation

**Status:** proposed
**Date:** 2026-07-29
**Serves:** [PRD](../prd.md)

## Context

Athena's `EngineEvent` union is sufficient for current renderers but mixes streamed text,
tool mechanics, visual status, child output, and run lifecycle. A Jarvis-like experience
needs stable answers about objective, activity, attention, verification, and next action.
Deriving those independently in the TUI, screen-reader mode, JSONL, notifications, and
voice would create inconsistent truth and duplicate policy.

## Decision

Add a versioned semantic interaction layer that subscribes to ordered runtime and
permission events, reduces them into `InteractionSnapshot`, and emits bounded
`Announcement` objects. Each state field and announcement carries provenance and source
kind. Runtime evidence has deterministic precedence over agent assertions.

Renderers consume this layer but may continue consuming raw events for detailed content
during migration. Traces capture source events and semantic metadata, not a second raw
transcript. The reducer and announcement policy require no model call.

## Alternatives considered

1. **Teach each renderer to infer state from `EngineEvent`.** Rejected because semantics,
   deduplication, and truth precedence would drift.
2. **Ask the model to narrate its state.** Rejected because it fails when the provider
   fails, adds cost/latency, and can confidently misstate runtime truth.
3. **Replace `EngineEvent` wholesale.** Rejected because it creates unnecessary migration
   risk for TUI, JSONL, traces, and tests. Use an additive adapter first.

## Consequences

- State and attention become testable independently of presentation.
- New adapters inherit one truth and priority policy.
- Event ordering, IDs, provenance, and schema evolution become load-bearing contracts.
- Some duplicated raw/semantic events exist during migration and must be clearly named.
- High-level phases not determinable from runtime require labeled agent assertions; they
  cannot be silently presented as verified facts.
