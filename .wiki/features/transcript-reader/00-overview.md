# Reliable Transcript Reading — Objective Overview

**Tier:** 3 — changes the user-facing CLI interaction contract
**Date:** 2026-09-24
**Status:** planning

## What was asked

Keep the conversation stream available on screen so Nico can scroll and search through the full history: user messages, assistant replies, provider-supplied thinking, and tool activity. Scrolling should behave like a normal CLI terminal, not rely on Athena's currently unreliable PageUp/PageDown handling.

## What it really serves

Athena is a terminal coding agent, and its conversation is both the live working surface and the record the user needs to inspect. The user should be able to keep reading while output continues, return to the live end when ready, and find an earlier piece of conversation without losing the surrounding context.

## Load-bearing invariant

**The complete local session transcript remains the source of truth; the reading surface may window or index it, but must not silently discard content or create a competing transcript archive.** Scrolling must remain usable while the assistant streams.

## Twenty moves ahead

- **Next wants:** jump between search results, distinguish message kinds, and reopen a result in its original session context.
- **Breaks at scale / edges:** long-running sessions, large tool outputs, terminal resize, provider-dependent thinking blocks, alternate terminals that bind paging keys, and output arriving while the user is reading older content.
- **Unlocks:** local evidence lookup in prior work and later source-linked conversation continuity, without making every session part of one unbounded rendered component.
- **Doors kept open:** terminal-owned scrollback for reading, the existing session records as canonical content, a rebuildable local search path, and the current fullscreen interface as an optional mode.
- **Doors shut:** relying on custom PageUp/PageDown interception as the only way to read history, copying raw transcripts into another archive, and sending search queries or transcript content to a remote service.

## Scope line

### Building

- Make the standard conversation-reading experience append to ordinary terminal scrollback so terminal-native scrolling works while a turn is active and after it completes.
- Keep the live tail visible by default; when the user scrolls away, later output must not force the viewport back to the tail.
- Add local, case-insensitive search of the active session's stored conversation content, with result snippets and a way to move through matches.
- Cover user text, assistant text, stored provider-supplied thinking, and tool activity/output; label result kinds so they are distinguishable.
- Keep fullscreen as an explicit optional presentation if it remains useful; it must not be required for reliable history access.
- Preserve existing session persistence, redaction, permission behavior, and CLI command handling.

### Surfacing for Nico's call

- Whether search should also query every prior session in this first release. The initial package targets the active session; cross-session search belongs with the separate conversational-continuity plan unless the user expands scope.

### Dropping

- Cloud search, remote indexing, semantic/vector search, transcript export, retention changes, new transcript storage, and changes to model context or what is sent to providers.
- Any promise to display reasoning a provider does not return or Athena does not store.

## Caliber & package

Tier 3 because this changes the CLI reading and scrolling contract and has terminal-dependent behavior that needs an explicit rollout and verification plan. Package: requirements/PRD, technical design, ADR, implementation tasks, test strategy, rollout, threat model, observability, NFR budgets, and risk register.
