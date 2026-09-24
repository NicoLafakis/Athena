# Reliable Transcript Reading — Test Strategy

> [Objective overview](00-overview.md) · [Requirements](requirements.md)

## What to test

| Requirement | Level | Evidence |
|---|---|---|
| Fullscreen transcript remains bounded | Ink TTY integration | Render a long transcript and verify only the viewport window renders while fixed chrome stays pinned |
| Scrolling during streaming preserves the reader's position | Ink TTY integration | Page into one long assistant entry, append rows to that same entry, and assert the first visible row is unchanged |
| Fullscreen paging bindings work | Ink TTY integration | Exercise PageUp/PageDown and Ctrl+PageUp/Ctrl+PageDown across the transcript and verify live-tail following resumes |
| Redirected output has no terminal controls | Real process | Run with redirected stdout and inspect output for cursor movement, alternate-screen, clear-screen, and scrollback erase sequences |
| Search covers stored content kinds | Unit + session integration | Fixtures containing user, assistant, stored thinking, redacted thinking, tool use, and tool result blocks; verify labels, literal case-insensitive matching, and chronological ordering |
| Search is bounded and read-only | Unit + integration | Empty query, no results, many results, malformed/unreadable record, and no provider/client invocation |
| Deleted sessions do not remain searchable | Session integration | Delete a fixture session and verify search no longer returns it, including if a derived index is introduced |
| Fullscreen chrome remains safe | UI regression | Run the existing every-frame content-signature checks and relevant viewport tests; row count alone is not evidence |

## Critical live verification

The scrolling contract is an in-app fullscreen pager, so Ink TTY integration coverage exercises the actual key path and frames. Verify redirected output separately for its existing non-interactive contract.

## Required project gates

On the exact implementation state, run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. Any edit after a gate invalidates that gate. Do not push on red.
