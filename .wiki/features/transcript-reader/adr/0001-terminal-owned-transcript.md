# 0001. Use terminal-owned scrollback for conversation history

**Status:** proposed
**Date:** 2026-09-24

> [Objective overview](../00-overview.md) · [Technical design](../design.md)

## Context

The standard Athena TUI enters an alternate screen and implements its own paged transcript. The user reports that PageUp/PageDown does not work and prefers the behavior of a normal CLI. Existing classic mode nominally restores native scrollback, but Ink can erase that history during redraw. A reader-only fix to the current key mapping would retain the mismatch with ordinary terminal scrolling.

Conversation content already has a canonical session record. Search should not create a competing transcript archive or leak local conversation content to an external service.

## Decision

Make append-only terminal output with terminal-owned scrollback the standard conversation-reading behavior. Keep fullscreen alternate-screen mode as an explicit opt-in if retained. Search the existing active-session records and return transient labeled excerpts; any acceleration data is derived and rebuildable.

The exact Ink/terminal implementation must be selected after a prototype demonstrates that repeated streaming updates do not erase scrollback or steal the viewport in real terminals.

## Alternatives considered

- **Fix custom paging in fullscreen:** insufficient because it still requires Athena to intercept terminal keys and does not match normal CLI scrollback.
- **Use current classic redraw path:** rejected until proven, because existing architecture notes document scrollback erasure.
- **Use the screen-reader presentation unchanged:** rejected because it has different prompt and semantic-announcement behavior; its append-only property is a reference, not a complete UI choice.
- **Persist a duplicate transcript index:** rejected because it adds privacy and deletion consistency risk.

## Consequences

- Normal terminal keys control historical scrolling and are not reserved by Athena.
- Rendering must distinguish finalized transcript rows from the live mutable tail and prompt.
- A real-terminal verification step is required; snapshot tests alone cannot prove native scrollback behavior.
- The fullscreen mode and its row-budget invariants can remain available but are no longer required for reliable reading.
- Search results are only as complete as content stored in the existing session record. Provider-omitted reasoning remains unavailable.
