# Athena Wiki Index

[`AGENTS.md`](../AGENTS.md) at the repo root is the terse, imperative rule set for any
agent working in this repo, regardless of harness; `CLAUDE.md` is a five-line pointer to
it. This wiki is where the reasoning and design detail behind those rules live. The two
must not become duplicate copies of the same content: `AGENTS.md` states the rule and
links here for depth, this wiki explains it.

## Architecture

- [Blind-first Jarvis upgrade](features/blind-first-jarvis/00-overview.md) - Canonical Tier 3 package, now in implementation. Its shared semantic plane feeds deterministic attention, bounded experience guidance, accessible presentation, watchers, and an opt-in Windows voice path whose raw microphone-to-Realtime-to-Marin probe has passed. The [direct-harness voice specification](features/blind-first-jarvis/direct-harness-voice.md) replaces the intermediate conductor/delegation bridge with one persistent wake listener and one Athena-owned harness session; human AT, latency, retention, and cross-platform gates remain.
- [TUI fullscreen row budget](architecture/tui-fullscreen-row-budget.md) - The load-bearing layout invariant behind `src/tui/App.tsx`: only the Transcript box clips, every other sibling is unclipped and must be explicitly budgeted or Ink/Yoga corrupts the frame. Precedence order, the popup reserve-exactly-what-you-render rule, and transcript scrolling.
- [Credential storage and the OS vault](architecture/credential-storage.md) - Resolution order (env, file, vault), plaintext vs. vault-backed states and how the user is told which, the cross-machine story, Windows interpreter selection, and the standing rule that optional hardening must never be a fatal boot precondition.
- [Athena's self-reflection journal](architecture/self-reflection-journal.md) - Append-only operational journal grounded in evidence: auto-captured trace entries plus a model-authored channel for predictions scored against outcomes. Entry taxonomy, the mechanical guard against subjective self-narration being retrieved as fact, storage and rotation, and a phased build order.
- [Memory hygiene / anti-rot](architecture/memory-hygiene.md) - Event-driven citation verification, correction capture, contradiction detection, and count-triggered consolidation for the free-text brain-memory surface, distinct from the existing governed-learning MemoryClaim pipeline. Never deletes: proposes via flag/supersede/tombstone, reviewed in seconds via /memory review.
- [Environment staleness detection](architecture/environment-staleness.md) - Four filesystem/git signals (`stale-build`, `stale-deps`, `branch-behind`, `uncommitted-work`) that catch a stale `dist/` or `node_modules` running against fresh source on a two-machine workflow. Zero-subprocess boot checks versus git-backed doctor-only checks, the shared `VAULT_SPAWN_TIMEOUT_MS` and null-on-timeout lesson, and why every check degrades to `unknown` rather than ever blocking boot.

## Reference

- [TUI keybindings](reference/tui-keybindings.md) - Input box editing/cursor motion, `@`-mention and `/`-command popups, the second-level value picker, and fullscreen-only transcript scrolling (PageUp/PageDown, Ctrl+PageUp/PageDown).
- [TUI platform limits](reference/tui-platform-limits.md) - Mouse-wheel scrolling, Home/End, and Delete-as-forward-delete are unreachable given Ink's input layer; Ctrl+Backspace is gated on `WT_SESSION`. Investigated and deliberately not implemented — do not re-litigate.

## Findings (root cause analyses)

- [RCA 2026-07-27: DPAPI boot abort on PowerShell 5.1 and the credential re-auth loop](findings/RCA-2026-07-27-athena-dpapi-boot-abort-and-credential-reauth-loop.md) - Critical. Commit 621dda3 made vault migration a fatal boot precondition; the Windows DPAPI one-liner does not load System.Security, so PowerShell 5.1 fails and Athena exits 1 before reading the key that is already on disk. See [Credential storage and the OS vault](architecture/credential-storage.md) for the resulting design.
