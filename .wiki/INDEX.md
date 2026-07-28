# Athena Wiki Index

## Architecture

- [TUI fullscreen row budget](architecture/tui-fullscreen-row-budget.md) - The load-bearing layout invariant behind `src/tui/App.tsx`: only the Transcript box clips, every other sibling is unclipped and must be explicitly budgeted or Ink/Yoga corrupts the frame. Precedence order, the popup reserve-exactly-what-you-render rule, and transcript scrolling.
- [Credential storage and the OS vault](architecture/credential-storage.md) - Resolution order (env, file, vault), plaintext vs. vault-backed states and how the user is told which, the cross-machine story, Windows interpreter selection, and the standing rule that optional hardening must never be a fatal boot precondition.

## Reference

- [TUI keybindings](reference/tui-keybindings.md) - Input box editing/cursor motion, `@`-mention and `/`-command popups, the second-level value picker, and fullscreen-only transcript scrolling (PageUp/PageDown, Ctrl+PageUp/PageDown).
- [TUI platform limits](reference/tui-platform-limits.md) - Mouse-wheel scrolling, Home/End, and Delete-as-forward-delete are unreachable given Ink's input layer; Ctrl+Backspace is gated on `WT_SESSION`. Investigated and deliberately not implemented — do not re-litigate.

## Findings (root cause analyses)

- [RCA 2026-07-27: DPAPI boot abort on PowerShell 5.1 and the credential re-auth loop](findings/RCA-2026-07-27-athena-dpapi-boot-abort-and-credential-reauth-loop.md) - Critical. Commit 621dda3 made vault migration a fatal boot precondition; the Windows DPAPI one-liner does not load System.Security, so PowerShell 5.1 fails and Athena exits 1 before reading the key that is already on disk. See [Credential storage and the OS vault](architecture/credential-storage.md) for the resulting design.
