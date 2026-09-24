# Reliable Transcript Reading — Test Strategy

> [Objective overview](00-overview.md) · [Requirements](requirements.md)

## What to test

| Requirement | Level | Evidence |
|---|---|---|
| Normal mode appends stable output rather than clearing old lines | Component/process | Capture terminal writes across many streamed updates; assert finalized text is emitted once and no scrollback-clear sequence is sent |
| Scrolling during streaming preserves the reader's position | Real-terminal manual | While a long response streams, scroll upward, wait for more output, confirm the visible historical content stays in place, then return to live end |
| Native scroll keys remain terminal-owned | Real-terminal manual | PowerShell + Windows Terminal, and a POSIX terminal in CI/manual environment; confirm PageUp/PageDown or terminal-configured equivalents reach terminal scrollback, not Athena input |
| Redirected output has no terminal controls | Real process | Run with redirected stdout and inspect output for cursor movement, alternate-screen, clear-screen, and scrollback erase sequences |
| Search covers stored content kinds | Unit + session integration | Fixtures containing user, assistant, stored thinking, redacted thinking, tool use, and tool result blocks; verify labels, literal case-insensitive matching, and chronological ordering |
| Search is bounded and read-only | Unit + integration | Empty query, no results, many results, malformed/unreadable record, and no provider/client invocation |
| Deleted sessions do not remain searchable | Session integration | Delete a fixture session and verify search no longer returns it, including if a derived index is introduced |
| Fullscreen remains safe if retained | UI regression | Run the existing every-frame content-signature checks and relevant viewport tests; row count alone is not evidence |

## Critical live verification

Native terminal scrollback cannot be established by a mocked Ink render alone. Record the tested terminal/OS, mode, whether the session was interactive, behavior while streaming, behavior after completion, and whether returning to the live end works. Verify redirected output separately.

## Required project gates

On the exact implementation state, run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. Any edit after a gate invalidates that gate. Do not push on red.
