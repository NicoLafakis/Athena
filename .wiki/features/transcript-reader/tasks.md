# Reliable Transcript Reading — Implementation Plan

> [Objective overview](00-overview.md) · [Requirements](requirements.md) · [Technical design](design.md)

- [ ] 1. Prototype append-only transcript output — inspect Ink/static output capabilities and terminal control sequences; prove streamed updates preserve prior output in an actual Windows terminal before selecting the renderer shape. Files: `src/tui/`, focused tests. Done when: a long streamed fixture remains in scrollback and updates do not clear prior rows.
- [ ] 2. Implement terminal-owned history as the standard interactive presentation — separate finalized transcript rows from the mutable live item and input prompt; keep fullscreen explicit if retained. Files: `src/tui/`, composition in `src/cli.ts`. Done when: Requirements FR-1 through FR-3 pass in supported terminals.
- [ ] 3. Implement active-session local search — search stored message blocks for literal case-insensitive matches and return bounded, labeled chronological excerpts with pagination. Files: `src/harness/sessions.ts` or a focused search helper, CLI command routing, tests. Done when: Requirements FR-4 through FR-6 and FR-8 pass.
- [ ] 4. Reconcile content coverage — verify whether tool progress, child-agent output, and thinking are in the canonical session record; search only stored content and document any excluded transient events. Done when: no UI claim exceeds persisted evidence.
- [ ] 5. Add interaction and error handling — choose the search invocation and next/previous or pagination behavior; handle empty query, no matches, unreadable sessions, and high match counts without changing session state. Done when: acceptance cases are covered.
- [ ] 6. Update authoritative docs — revise TUI keybindings, fullscreen row-budget description, architecture map, and wiki index to describe the final behavior. Done when: code and docs agree and links resolve.
- [ ] 7. Run test strategy and project gates — verify interactive Windows Terminal, a POSIX terminal, redirected output, search, and retained fullscreen invariants; then run all four gates. Done when: evidence is recorded against the exact final tree.
